/**
 * Audiobookshelf cover proxy with an on-disk cache and multi-step fallback.
 *
 * The ABS token and base URL never reach the browser: callers only ever see
 * image bytes plus a plain `image/<subtype>` content type. Covers are fetched
 * through the GET-only ABS client or Open Library GET requests.
 *
 * Fallback chain in `getCover`:
 * 1. ABS `/api/items/<id>/cover` (as today).
 * 2. Same book in the current ABS library: `GET /api/libraries` then
 *    `GET /api/libraries/<libraryId>/search?q=<title>&limit=5` (book libraries only).
 *    Accept a result only when `normalize(title)` matches exactly and, if both have
 *    an author, `normalize(author)` matches too. Then fetch `/api/items/<newId>/cover`.
 * 3. Open Library (free, no key): search.json → first doc with a `cover_i` whose
 *    normalized title matches → `/b/id/<cover_i>-M.jpg`. Only when `covers.external` is true.
 *
 * Cache layout, under `<dirname(db_path)>/covers/`:
 * - `<itemId>.img`  — raw image bytes
 * - `<itemId>.type` — normalized content type (e.g. `image/jpeg`)
 * - `<itemId>.src`  — text: `abs`, `abs-relinked:<newId>` or `openlibrary:<cover_i>`
 * - `<itemId>.none` — timestamp of definitive absence; retried after 7 days
 *
 * Network errors, timeouts and 5xx are never cached.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { categoryOf } from "../core/category.ts";
import type { Config } from "../core/config.ts";
import {
  type AbsBinaryResponse,
  createAbsClient,
  SourceUnavailable,
} from "../sources/audiobookshelf/client.ts";
import type { SyncClient } from "../sources/audiobookshelf/sync.ts";
import { parseExternalIds, parseJsonObject } from "./aggregate.ts";
import { upscaleItunesArtwork } from "./metadata/itunes.ts";
import { resolveMetadataConfig } from "./metadata/types.ts";
import { normalizeForSearch } from "./search.ts";
import {
  authorMatches,
  defaultOpenLibraryLimiter,
  fetchOpenLibraryCover,
  OPEN_LIBRARY_MAX_BYTES,
  OPEN_LIBRARY_TIMEOUT_MS,
  searchOpenLibrary,
} from "./openlibrary.ts";
import { readYoutubeEnrichmentByVideoId } from "./youtube-filter.ts";

/** Library-item ids we are willing to turn into a filename and ABS path. */
export const COVER_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Time-to-live for a definitive "no cover anywhere" entry: 7 days. */
export const NONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The ABS client subset a cover fetch needs (easy to fake in tests). */
export interface CoverClient {
  getBinary(path: string): Promise<AbsBinaryResponse>;
  get?<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
}

/**
 * ABS client factory accepted by `getCover`. The real `createAbsClient`
 * satisfies it, and so does the narrower `SyncClient`-returning factory that
 * `AppDeps` exposes.
 */
export type CoverClientFactory = (
  config: Config
) => SyncClient & Partial<CoverClient>;

export interface CoverDeps {
  config: Config;
  db?: Database;
  /** Injectable ABS client factory; defaults to the real GET-only client. */
  createAbsClient?: CoverClientFactory;
  /** Injectable fetch for Open Library; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Wall clock for 7-day .none expiration; defaults to Date.now. */
  now?: () => number;
}

export interface CoverResult {
  bytes: Uint8Array;
  contentType: string;
}

/** True when `itemId` is safe to embed in a cache filename and ABS path. */
export function isValidCoverId(itemId: unknown): itemId is string {
  return typeof itemId === "string" && COVER_ID_RE.test(itemId);
}

/** `<dirname(db_path)>/covers`; created lazily on the first cache write. */
export function coverCacheDir(config: Config): string {
  return join(dirname(config.storage.db_path), "covers");
}

/**
 * Normalize an image content-type to a bare `image/<subtype>` media type.
 * Parameters (`; charset=…`) are dropped and anything that is not a well-formed
 * image type returns `null`, so nothing injected can reach the browser.
 */
export function normalizeImageType(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const base = (raw.split(";")[0] ?? "").trim().toLowerCase();
  if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(base)) {
    return null;
  }
  return base;
}

const absMissMemory = new Map<string, number>();

function cachePaths(
  config: Config,
  itemId: string
): {
  imgPath: string;
  typePath: string;
  srcPath: string;
  nonePath: string;
  absMissPath: string;
} {
  const dir = coverCacheDir(config);
  return {
    imgPath: join(dir, `${itemId}.img`),
    typePath: join(dir, `${itemId}.type`),
    srcPath: join(dir, `${itemId}.src`),
    nonePath: join(dir, `${itemId}.none`),
    absMissPath: join(dir, `${itemId}.abs404`),
  };
}

function readCachedCover(
  imgPath: string,
  typePath: string
): CoverResult | null {
  if (!existsSync(imgPath) || !existsSync(typePath)) {
    return null;
  }
  try {
    const contentType = normalizeImageType(readFileSync(typePath, "utf8"));
    if (contentType === null) {
      return null;
    }
    return { bytes: new Uint8Array(readFileSync(imgPath)), contentType };
  } catch {
    return null;
  }
}

function readCachedNone(nonePath: string, nowMs: number): boolean {
  if (!existsSync(nonePath)) {
    return false;
  }
  try {
    const raw = readFileSync(nonePath, "utf8").trim();
    const ts = Number(raw) || Date.parse(raw);
    if (Number.isFinite(ts) && nowMs - ts < NONE_TTL_MS) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function writeCachedNone(nonePath: string, nowMs: number): void {
  try {
    mkdirSync(dirname(nonePath), { recursive: true });
    writeFileSync(nonePath, `${nowMs}\n`, "utf8");
  } catch {
    // The cache is best-effort.
  }
}

function readCachedAbsMiss(absMissPath: string, nowMs: number): boolean {
  const memTs = absMissMemory.get(absMissPath);
  if (memTs !== undefined && nowMs - memTs < NONE_TTL_MS && nowMs >= memTs) {
    return true;
  }
  if (readCachedNone(absMissPath, nowMs)) {
    return true;
  }
  absMissMemory.delete(absMissPath);
  return false;
}

function writeCachedAbsMiss(absMissPath: string, nowMs: number): void {
  absMissMemory.set(absMissPath, nowMs);
  writeCachedNone(absMissPath, nowMs);
}

function writeCachedCover(
  imgPath: string,
  typePath: string,
  srcPath: string,
  nonePath: string,
  cover: CoverResult,
  srcText: string,
  absMissPath?: string
): void {
  try {
    mkdirSync(dirname(imgPath), { recursive: true });
    writeFileSync(imgPath, cover.bytes);
    writeFileSync(typePath, cover.contentType, "utf8");
    writeFileSync(srcPath, `${srcText}\n`, "utf8");
    if (existsSync(nonePath)) {
      try {
        unlinkSync(nonePath);
      } catch {}
    }
    if (absMissPath) {
      absMissMemory.delete(absMissPath);
      if (existsSync(absMissPath)) {
        try {
          unlinkSync(absMissPath);
        } catch {}
      }
    }
  } catch {
    // The cache is best-effort; a write failure must not break the response.
  }
}

export type TitleCoverCategory = "book" | "audiobook" | "music";

export interface TitleCoverTarget {
  category: TitleCoverCategory;
  title: string;
  creator: string | null;
}

const titleCoverRegistry = new Map<string, TitleCoverTarget>();

/**
 * Deterministic cover id for a work looked up by title (+ author/artist).
 * Safe to use in `/api/cover/<id>` and `<dirname(db_path)>/covers/<id>.img`.
 */
export function titleCoverId(
  category: TitleCoverCategory,
  title: string,
  creator?: string | null
): string {
  const normTitle = normalizeForSearch(title);
  const normCreator = normalizeForSearch(creator ?? "");
  const hash = createHash("sha256")
    .update(`${category}\0${normTitle}\0${normCreator}`)
    .digest("hex")
    .slice(0, 24);
  const id = `t_${category}_${hash}`;
  titleCoverRegistry.set(id, {
    category,
    title: title.trim(),
    creator: creator && creator.trim() !== "" ? creator.trim() : null,
  });
  return id;
}

export function isTitleCoverId(itemId: string): boolean {
  return /^t_(?:book|audiobook|music)_[0-9a-f]{24}$/.test(itemId);
}

/** True when `<itemId>.img` and `<itemId>.type` exist in the permanent cover cache. */
export function hasCachedCover(config: Config, itemId: string): boolean {
  if (!isValidCoverId(itemId)) return false;
  const { imgPath, typePath } = cachePaths(config, itemId);
  return existsSync(imgPath) && existsSync(typePath);
}

/** True when `<itemId>.none` exists and has not expired. */
export function hasCachedCoverNone(
  config: Config,
  itemId: string,
  nowMs: number = Date.now()
): boolean {
  if (!isValidCoverId(itemId)) return false;
  const { nonePath } = cachePaths(config, itemId);
  return readCachedNone(nonePath, nowMs);
}

/**
 * Clean a music track title, stripping common YouTube suffixes like
 * "(Official Video)", "(Official Audio)", "(Lyrics)", and splitting
 * "Artist - Track" when present.
 */
export function cleanMusicTitle(rawTitle: string): {
  cleanTrack: string;
  embeddedArtist: string | null;
} {
  let s = rawTitle.trim();
  // Strip trailing video/audio tags in (...) or [...]
  s = s
    .replace(
      /\s*[\(\[](?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visualizer)|music\s*video|lyric\s*video|lyrics?|audio|visualizer|hd|hq|4k|remastered(?:\s+\d{4})?)[\]\)]\s*$/gi,
      ""
    )
    .trim();

  const sepMatch = /^(.+?)\s+[-–—]\s+(.+)$/.exec(s);
  if (sepMatch && sepMatch[1] && sepMatch[2]) {
    return {
      embeddedArtist: sepMatch[1].trim(),
      cleanTrack: sepMatch[2].trim(),
    };
  }
  return {
    cleanTrack: s,
    embeddedArtist: null,
  };
}

/** Clean a YouTube Music channel / artist name (e.g. "Daft Punk - Topic" -> "Daft Punk"). */
export function cleanMusicArtist(rawArtist: string | null | undefined): string {
  if (typeof rawArtist !== "string") return "";
  return rawArtist
    .trim()
    .replace(/\s+-\s*Topic$/i, "")
    .replace(/\s+VEVO$/i, "")
    .trim();
}

function normalizeTrackForMatch(s: string): string {
  const withoutFeat = s
    .replace(/\s*[\(\[](?:feat\.?|ft\.?|with)\s+[^)\]]+[\]\)]/gi, "")
    .replace(/\s+-\s+(?:single|ep|remastered.*)$/i, "");
  return normalizeForSearch(withoutFeat)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function artistWords(name: string): string[] {
  return normalizeForSearch(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

export function artistMatches(
  targetArtist: string | null | undefined,
  candidateArtist: string | null | undefined
): boolean {
  const targetClean = cleanMusicArtist(targetArtist);
  const candClean = cleanMusicArtist(candidateArtist);
  if (!targetClean || !candClean) return false;

  const normTarget = normalizeTrackForMatch(targetClean);
  const normCand = normalizeTrackForMatch(candClean);
  if (!normTarget || !normCand) return false;
  if (normTarget === normCand) return true;

  // Compare primary artist (before comma, &, feat.)
  const primaryTarget = (targetClean.split(/,|&|;|\band\b|\bfeat\.?\b|\bft\.?\b/i)[0] ?? "").trim();
  const primaryCand = (candClean.split(/,|&|;|\band\b|\bfeat\.?\b|\bft\.?\b/i)[0] ?? "").trim();
  const tWords = artistWords(primaryTarget);
  const cWords = artistWords(primaryCand);
  if (tWords.length === 0 || cWords.length === 0) return false;

  const cSet = new Set(artistWords(candClean));
  if (tWords.every((w) => cSet.has(w))) return true;

  const tSet = new Set(artistWords(targetClean));
  if (cWords.every((w) => tSet.has(w))) return true;

  return authorMatches(targetClean, [candClean]);
}

interface ItunesCoverHit {
  id: string;
  artworkUrl: string;
}

async function fetchExternalImage(
  url: string,
  fetchFn: typeof fetch
): Promise<CoverResult | null> {
  return defaultOpenLibraryLimiter.run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Cover image request timed out", "TimeoutError"));
    }, OPEN_LIBRARY_TIMEOUT_MS);
    try {
      const response = await fetchFn(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500) {
          throw new Error(`Cover image server error: HTTP ${response.status}`);
        }
        return null;
      }
      const contentType = normalizeImageType(response.headers.get("content-type"));
      if (contentType === null) {
        return null;
      }
      const clHeader = response.headers.get("content-length");
      if (clHeader) {
        const cl = Number(clHeader);
        if (Number.isFinite(cl) && cl > OPEN_LIBRARY_MAX_BYTES) {
          return null;
        }
      }
      const arrayBuf = await response.arrayBuffer();
      if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > OPEN_LIBRARY_MAX_BYTES) {
        return null;
      }
      return {
        bytes: new Uint8Array(arrayBuf),
        contentType,
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

async function searchItunesAudiobook(
  title: string,
  author: string,
  config: Config,
  fetchFn: typeof fetch
): Promise<ItunesCoverHit | null> {
  const itunesBase = resolveMetadataConfig(config).itunes_url;
  const url = new URL(`${itunesBase}/search`);
  url.searchParams.set("media", "audiobook");
  url.searchParams.set("entity", "audiobook");
  url.searchParams.set("term", author ? `${title} ${author}` : title);
  url.searchParams.set("limit", "10");

  return defaultOpenLibraryLimiter.run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("iTunes request timed out", "TimeoutError"));
    }, OPEN_LIBRARY_TIMEOUT_MS);
    try {
      const response = await fetchFn(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500) {
          throw new Error(`iTunes server error: HTTP ${response.status}`);
        }
        return null;
      }
      let data: any;
      try {
        data = await response.json();
      } catch {
        return null;
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      const normQuery = normalizeTrackForMatch(cleanTitle(title));
      const queryColonIdx = title.indexOf(":");
      const normStripped =
        queryColonIdx >= 4 ? normalizeTrackForMatch(title.slice(0, queryColonIdx)) : "";

      for (const item of results) {
        if (!item || typeof item !== "object") continue;
        const rawId = item.collectionId ?? item.trackId;
        if (typeof rawId !== "number" || rawId <= 0) continue;

        const itemTitleRaw = String(item.collectionName ?? item.trackName ?? "").trim();
        const itemAuthorRaw = String(item.artistName ?? "").trim();
        if (!itemTitleRaw || !itemAuthorRaw) continue;

        const cleanedItemTitle = cleanTitle(itemTitleRaw);
        const normItem = normalizeTrackForMatch(cleanedItemTitle);
        const itemColonIdx = cleanedItemTitle.indexOf(":");
        const normItemStripped =
          itemColonIdx >= 4
            ? normalizeTrackForMatch(cleanedItemTitle.slice(0, itemColonIdx))
            : "";

        const titleMatch =
          normItem === normQuery ||
          (normStripped.length >= 4 && normItem === normStripped) ||
          (normItemStripped.length >= 4 && normItemStripped === normQuery);
        if (!titleMatch) continue;

        if (!authorMatches(author, [itemAuthorRaw]) && !artistMatches(author, itemAuthorRaw)) {
          continue;
        }

        const artworkUrl = upscaleItunesArtwork(item.artworkUrl100 ?? item.artworkUrl60);
        if (artworkUrl) {
          return { id: String(rawId), artworkUrl };
        }
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

async function searchItunesSong(
  rawTitle: string,
  rawArtist: string | null | undefined,
  config: Config,
  fetchFn: typeof fetch
): Promise<ItunesCoverHit | null> {
  const { cleanTrack, embeddedArtist } = cleanMusicTitle(rawTitle);
  const effectiveArtist = cleanMusicArtist(rawArtist) || cleanMusicArtist(embeddedArtist);
  const trackToSearch = cleanTrack || rawTitle.trim();
  if (!trackToSearch) return null;

  const itunesBase = resolveMetadataConfig(config).itunes_url;
  const url = new URL(`${itunesBase}/search`);
  url.searchParams.set("media", "music");
  url.searchParams.set("entity", "song");
  url.searchParams.set(
    "term",
    effectiveArtist ? `${trackToSearch} ${effectiveArtist}` : trackToSearch
  );
  url.searchParams.set("limit", "10");

  return defaultOpenLibraryLimiter.run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("iTunes request timed out", "TimeoutError"));
    }, OPEN_LIBRARY_TIMEOUT_MS);
    try {
      const response = await fetchFn(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500) {
          throw new Error(`iTunes server error: HTTP ${response.status}`);
        }
        return null;
      }
      let data: any;
      try {
        data = await response.json();
      } catch {
        return null;
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      const normTargetTrack = normalizeTrackForMatch(trackToSearch);
      const normFullTitle = normalizeTrackForMatch(rawTitle);
      if (!normTargetTrack) return null;

      for (const item of results) {
        if (!item || typeof item !== "object") continue;
        const rawId = item.trackId ?? item.collectionId;
        if (typeof rawId !== "number" || rawId <= 0) continue;

        const itemTrack = String(item.trackName ?? item.collectionName ?? "").trim();
        const itemArtist = String(item.artistName ?? "").trim();
        if (!itemTrack) continue;

        const normItemTrack = normalizeTrackForMatch(itemTrack);
        const trackMatched =
          normItemTrack === normTargetTrack || normItemTrack === normFullTitle;
        if (!trackMatched) continue;

        if (effectiveArtist) {
          if (!artistMatches(effectiveArtist, itemArtist)) {
            continue;
          }
        } else {
          // Without a known artist, require a distinctive multi-word or >= 8 char title
          const words = normTargetTrack.split(" ").filter(Boolean);
          if (words.length < 2 && normTargetTrack.length < 8) {
            continue;
          }
        }

        const artworkUrl = upscaleItunesArtwork(item.artworkUrl100 ?? item.artworkUrl60);
        if (artworkUrl) {
          return { id: String(rawId), artworkUrl };
        }
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

function findTitleCoverTargetInDb(
  db: Database,
  itemId: string
): TitleCoverTarget | null {
  const fromMem = titleCoverRegistry.get(itemId);
  if (fromMem) return fromMem;

  const enrichmentMap = readYoutubeEnrichmentByVideoId(db);
  const rows = db
    .query<
      {
        source: string;
        source_kind: string;
        media_type: string;
        title: string | null;
        parent_title: string | null;
        external_ids: string | null;
        raw: string | null;
      },
      []
    >(
      `SELECT source, source_kind, media_type, title, parent_title, external_ids, raw
       FROM events_latest
       ORDER BY id DESC;`
    )
    .all();

  for (const row of rows) {
    const cat = categoryOf(row);
    if (cat !== "book" && cat !== "audiobook" && cat !== "music") {
      continue;
    }
    const rawObj = parseJsonObject(row.raw);
    const workSnap = parseJsonObject(rawObj?.["work"]);
    const rawMeta = parseJsonObject(rawObj?.["mediaMetadata"]);

    let title = (
      (typeof workSnap?.["title"] === "string" ? workSnap["title"] : null) ??
      (typeof rawMeta?.["title"] === "string" ? rawMeta["title"] : null) ??
      (typeof rawObj?.["displayTitle"] === "string" ? rawObj["displayTitle"] : null) ??
      row.title ??
      ""
    ).trim();
    if (!title) continue;

    let creator: string | null = null;
    if (Array.isArray(workSnap?.["creators"]) && workSnap["creators"].length > 0) {
      const cList = (workSnap["creators"] as unknown[]).filter(
        (c): c is string => typeof c === "string" && c.trim() !== ""
      );
      if (cList.length > 0) creator = cList.join(", ");
    }
    if (!creator && typeof rawMeta?.["authorName"] === "string" && rawMeta["authorName"].trim() !== "") {
      creator = rawMeta["authorName"].trim();
    }
    if (!creator && typeof rawObj?.["displayAuthor"] === "string" && rawObj["displayAuthor"].trim() !== "") {
      creator = rawObj["displayAuthor"].trim();
    }
    if (!creator && row.parent_title && row.parent_title.trim() !== "") {
      creator = row.parent_title.trim();
    }
    if (!creator && row.source === "youtube") {
      const ext = parseExternalIds(row.external_ids);
      const vid = ext?.["youtube_video"];
      if (typeof vid === "string") {
        const enr = enrichmentMap.get(vid);
        if (enr?.channel && enr.channel.trim() !== "") {
          creator = enr.channel.trim();
        }
      }
    }
    if (cat === "music") {
      const cleanedArtist = cleanMusicArtist(creator);
      if (cleanedArtist) {
        creator = cleanedArtist;
      } else {
        const { embeddedArtist } = cleanMusicTitle(title);
        if (embeddedArtist) creator = embeddedArtist;
      }
    }

    const candidateId = titleCoverId(cat, title, creator);
    if (candidateId === itemId) {
      return { category: cat, title, creator };
    }
    // Also register with null creator in case the caller built the id before enrichment
    const bareId = titleCoverId(cat, title, null);
    if (bareId === itemId) {
      return { category: cat, title, creator };
    }
  }

  return null;
}

/**
 * Strip trailing "(Unabridged)" / "(1 of 5)"-style suffixes and leading series
 * prefixes like "The Stormlight Archive 2: " for the fallback lookup try.
 */
export function cleanTitle(title: string, seriesName?: string): string {
  let cleaned = title;

  // 1. Strip trailing suffix: e.g. " (Unabridged)", "(Abridged)", "(1 of 5)", "[1 of 5]", "(Part 1)", etc.
  cleaned = cleaned
    .replace(
      /\s*[\(\[](?:unabridged|abridged|\d+\s*(?:of|\/)\s*\d+[^)\]]*|part\s+\d+(?:\s*(?:of|\/)\s*\d+)?|book\s+\d+(?:\s*(?:of|\/)\s*\d+)?)[\]\)]\s*$/i,
      ""
    )
    .trim();

  // 2. Strip leading series prefix:
  // If seriesName is known and non-empty:
  if (seriesName && seriesName.trim()) {
    const escaped = seriesName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const seriesRe = new RegExp(
      `^${escaped}(?:[\\s,]+(?:Book|Vol|Volume|Part|#)?\\s*\\d+)?\\s*:\\s*`,
      "i"
    );
    cleaned = cleaned.replace(seriesRe, "").trim();
  }

  // Also handle generic series prefix with a number: e.g. "Series Name 2: Title" or "Series Name, Book 2: Title"
  cleaned = cleaned
    .replace(/^.+?(?:[,\s]+(?:Book|Vol|Volume|Part|#)?\s*\d+)\s*:\s*/i, "")
    .trim();

  return cleaned;
}

function isNetworkOrServerError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof SourceUnavailable) return true;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("404") || msg.includes("not found")) return false;
    if (
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("server error") ||
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("unreachable") ||
      msg.includes("offline") ||
      msg.includes("refused") ||
      msg.includes("network") ||
      msg.includes("econnrefused") ||
      msg.includes("failed to fetch")
    ) {
      return true;
    }
    if (!/\b4\d\d\b/.test(msg)) {
      return true;
    }
  }
  return false;
}

function isAuthError(err: unknown): boolean {
  return err instanceof Error && /^HTTP 40[13]\b/.test(err.message);
}

const inFlight = new Map<string, Promise<CoverResult | null>>();

/**
 * Return the cover for `itemId`, reading the on-disk cache first and otherwise
 * executing the fallback chain. Concurrent lookups for the same id trigger only
 * a single lookup.
 */
export async function getCover(
  itemId: string,
  deps: CoverDeps
): Promise<CoverResult | null> {
  if (!isValidCoverId(itemId)) {
    return null;
  }

  const existing = inFlight.get(itemId);
  if (existing) {
    return existing;
  }

  const lookup = (async () => {
    try {
      return await getCoverInternal(itemId, deps);
    } finally {
      inFlight.delete(itemId);
    }
  })();

  inFlight.set(itemId, lookup);
  return lookup;
}

async function resolveExternalBookOrAudiobookCover(
  titleCandidates: readonly string[],
  targetAuthor: string,
  deps: CoverDeps,
  imgPath: string,
  typePath: string,
  srcPath: string,
  nonePath: string
): Promise<{ cover: CoverResult | null; hadNetworkError: boolean }> {
  const coversConfig = deps.config.covers ?? {
    external: true,
    openlibrary_url: "https://openlibrary.org",
    openlibrary_covers_url: "https://covers.openlibrary.org",
  };
  if (!coversConfig.external || targetAuthor === "") {
    return { cover: null, hadNetworkError: false };
  }

  let hadNetworkError = false;
  const fetchFn = deps.fetch ?? globalThis.fetch;

  // 1. Open Library
  for (const titleCandidate of titleCandidates) {
    try {
      const coverId = await searchOpenLibrary(titleCandidate, targetAuthor, {
        fetch: fetchFn,
        baseUrl: coversConfig.openlibrary_url,
      });

      if (coverId !== null) {
        const fetched = await fetchOpenLibraryCover(coverId, {
          fetch: fetchFn,
          coversBaseUrl: coversConfig.openlibrary_covers_url,
        });

        if (fetched !== null) {
          writeCachedCover(
            imgPath,
            typePath,
            srcPath,
            nonePath,
            fetched,
            `openlibrary:${coverId}`
          );
          return { cover: fetched, hadNetworkError };
        }
      }
    } catch (err) {
      if (isNetworkOrServerError(err)) {
        hadNetworkError = true;
      }
    }
  }

  // 2. iTunes Audiobook search fallback when Open Library did not have the cover
  if (!hadNetworkError) {
    for (const titleCandidate of titleCandidates) {
      try {
        const hit = await searchItunesAudiobook(
          titleCandidate,
          targetAuthor,
          deps.config,
          fetchFn
        );
        if (hit !== null) {
          const fetched = await fetchExternalImage(hit.artworkUrl, fetchFn);
          if (fetched !== null) {
            writeCachedCover(
              imgPath,
              typePath,
              srcPath,
              nonePath,
              fetched,
              `itunes:${hit.id}`
            );
            return { cover: fetched, hadNetworkError };
          }
        }
      } catch (err) {
        if (isNetworkOrServerError(err)) {
          hadNetworkError = true;
        }
      }
    }
  }

  return { cover: null, hadNetworkError };
}

async function getCoverInternal(
  itemId: string,
  deps: CoverDeps
): Promise<CoverResult | null> {
  const { imgPath, typePath, srcPath, nonePath, absMissPath } = cachePaths(
    deps.config,
    itemId
  );
  const nowMs = deps.now ? deps.now() : Date.now();

  const cached = readCachedCover(imgPath, typePath);
  if (cached !== null) {
    return cached;
  }

  if (readCachedNone(nonePath, nowMs)) {
    return null;
  }

  // Handle title-based cover IDs (`t_music_<hash>`, `t_book_<hash>`, `t_audiobook_<hash>`):
  // never contact Audiobookshelf for these.
  if (isTitleCoverId(itemId)) {
    const coversConfig = deps.config.covers ?? {
      external: true,
      openlibrary_url: "https://openlibrary.org",
      openlibrary_covers_url: "https://covers.openlibrary.org",
    };
    if (!coversConfig.external) {
      writeCachedNone(nonePath, nowMs);
      return null;
    }

    const target = deps.db
      ? findTitleCoverTargetInDb(deps.db, itemId)
      : (titleCoverRegistry.get(itemId) ?? null);
    if (!target || !target.title) {
      return null;
    }

    const fetchFn = deps.fetch ?? globalThis.fetch;

    if (target.category === "music") {
      let hadNetworkError = false;
      try {
        const hit = await searchItunesSong(
          target.title,
          target.creator,
          deps.config,
          fetchFn
        );
        if (hit !== null) {
          const fetched = await fetchExternalImage(hit.artworkUrl, fetchFn);
          if (fetched !== null) {
            writeCachedCover(
              imgPath,
              typePath,
              srcPath,
              nonePath,
              fetched,
              `itunes:${hit.id}`
            );
            return fetched;
          }
        }
      } catch (err) {
        if (isNetworkOrServerError(err)) {
          hadNetworkError = true;
        }
      }
      if (!hadNetworkError) {
        writeCachedNone(nonePath, nowMs);
      }
      return null;
    }

    const exactTitle = target.title;
    const cleaned = cleanTitle(exactTitle);
    const candidates = [exactTitle];
    if (cleaned !== exactTitle && cleaned.length > 0) {
      candidates.push(cleaned);
    }

    const { cover, hadNetworkError } = await resolveExternalBookOrAudiobookCover(
      candidates,
      target.creator ?? "",
      deps,
      imgPath,
      typePath,
      srcPath,
      nonePath
    );
    if (cover !== null) {
      return cover;
    }
    if (!hadNetworkError) {
      writeCachedNone(nonePath, nowMs);
    }
    return null;
  }

  let hadNetworkError = false;

  const factory: CoverClientFactory =
    deps.createAbsClient ?? ((cfg) => createAbsClient(cfg));

  // If this itemId is already known to be missing on ABS (from a previous 404),
  // never contact Audiobookshelf again (neither Step 1 nor Step 2).
  const alreadyKnownAbsMiss = readCachedAbsMiss(absMissPath, nowMs);

  // --- Step 1: ABS /api/items/<id>/cover ---
  if (!alreadyKnownAbsMiss) {
    try {
      const client = factory(deps.config);
      if (typeof client.getBinary === "function") {
        const fetched = await client.getBinary(`/api/items/${itemId}/cover`);
        const contentType = normalizeImageType(fetched?.contentType);
        if (contentType !== null) {
          const bytes =
            fetched.bytes instanceof Uint8Array
              ? fetched.bytes
              : new Uint8Array();
          const cover: CoverResult = { bytes, contentType };
          writeCachedCover(
            imgPath,
            typePath,
            srcPath,
            nonePath,
            cover,
            "abs",
            absMissPath
          );
          return cover;
        }
      }
    } catch (err) {
      // A rejected token on the item's own cover is not "the book is gone": stop
      // and cache nothing, so a bad token never turns into Open Library covers or
      // `.none` entries. (A 401 later, on `/api/libraries`, only skips step 2: an
      // API key without library access still fetches covers.)
      if (isNetworkOrServerError(err) || isAuthError(err)) {
        hadNetworkError = true;
        // ABS offline / 5xx / auth: do not query further, do not cache failure
        return null;
      }
      // 404: item or cover not found on ABS -> remember the miss so we do not
      // ask ABS for this itemId again, then proceed to Step 2.
      writeCachedAbsMiss(absMissPath, nowMs);
    }
  }

  // Without a DB connection, steps 2 & 3 cannot discover title/author
  if (!deps.db) {
    return null;
  }

  // --- Read title/author from newest session in events_latest ---
  let targetTitle = "";
  let targetAuthor = "";
  let seriesName = "";

  try {
    const row = deps.db
      .query<
        { raw: string | null; title: string | null; parent_title: string | null },
        [string, string, string, string]
      >(
        `SELECT raw, title, parent_title
           FROM events_latest
          WHERE source = 'audiobookshelf'
            AND (
              (source_kind = 'listening_session' AND json_extract(external_ids, '$.abs_item') = ?1)
              OR (source_kind = 'listening_session' AND source_id = ?2)
              OR (json_extract(external_ids, '$.abs_item') = ?3)
              OR (source_id = ?4)
            )
          ORDER BY (CASE WHEN source_kind = 'listening_session' THEN 0 ELSE 1 END), started_at DESC
          LIMIT 1;`
      )
      .get(itemId, itemId, itemId, itemId);

    if (row) {
      let rawObj: any = null;
      if (typeof row.raw === "string") {
        try {
          rawObj = JSON.parse(row.raw);
        } catch {}
      }
      const meta = rawObj?.mediaMetadata;
      const rawTitle = (meta?.title ?? rawObj?.displayTitle ?? row.title ?? "").trim();
      // A media_progress row without a real title stores the itemId as row.title;
      // do not treat the opaque itemId as a book title to search for.
      targetTitle =
        rawTitle === itemId && !meta?.title && !rawObj?.displayTitle
          ? ""
          : rawTitle;
      targetAuthor = (meta?.authorName ?? rawObj?.displayAuthor ?? row.parent_title ?? "").trim();
      if (typeof meta?.seriesName === "string" && meta.seriesName.trim()) {
        seriesName = meta.seriesName.trim();
      }
    }
  } catch {
    // Best-effort metadata retrieval
  }

  if (!targetTitle) {
    if (!hadNetworkError) {
      writeCachedNone(nonePath, nowMs);
    }
    return null;
  }

  const exactTitle = targetTitle;
  const cleanedTitle = cleanTitle(targetTitle, seriesName);
  const titleCandidates = [exactTitle];
  if (cleanedTitle !== exactTitle && cleanedTitle.length > 0) {
    titleCandidates.push(cleanedTitle);
  }

  // --- Step 2: Same book in current ABS library (only on first miss, never when already known missing) ---
  if (!alreadyKnownAbsMiss) {
    try {
      const client = factory(deps.config);
      if (typeof client.get === "function" && typeof client.getBinary === "function") {
        let libRes: any;
        try {
          libRes = await client.get("/api/libraries");
        } catch (err) {
          if (isNetworkOrServerError(err)) {
            hadNetworkError = true;
          }
        }

        const libraries = Array.isArray(libRes)
          ? libRes
          : Array.isArray(libRes?.libraries)
          ? libRes.libraries
          : [];
        const bookLibraries = libraries.filter(
          (lib: any) => lib?.mediaType === "book" && typeof lib?.id === "string"
        );

        for (const titleCandidate of titleCandidates) {
          for (const lib of bookLibraries) {
            let searchRes: any;
            try {
              searchRes = await client.get(`/api/libraries/${lib.id}/search`, {
                q: titleCandidate,
                limit: 5,
              });
            } catch (err) {
              if (isNetworkOrServerError(err)) {
                hadNetworkError = true;
              }
              continue;
            }

            const bookResults: any[] = Array.isArray(searchRes?.book)
              ? searchRes.book
              : Array.isArray(searchRes?.books)
              ? searchRes.books
              : Array.isArray(searchRes)
              ? searchRes
              : [];

            for (const item of bookResults) {
              const candidateId = item?.libraryItem?.id ?? item?.id;
              if (!isValidCoverId(candidateId)) continue;
              const cTitle =
                item?.libraryItem?.media?.metadata?.title ??
                item?.media?.metadata?.title ??
                item?.libraryItem?.title ??
                item?.title ??
                "";
              const cAuthor =
                item?.libraryItem?.media?.metadata?.authorName ??
                item?.media?.metadata?.authorName ??
                item?.libraryItem?.media?.metadata?.authors?.[0]?.name ??
                item?.author ??
                "";

              // Title must match normalized title candidate
              if (normalizeForSearch(cTitle) !== normalizeForSearch(titleCandidate)) {
                continue;
              }

              // Author match: if both have an author, normalize(author) matches too
              const hasTargetAuthor = Boolean(targetAuthor && targetAuthor.trim().length > 0);
              const hasCandidateAuthor = Boolean(cAuthor && cAuthor.trim().length > 0);
              if (hasTargetAuthor && hasCandidateAuthor) {
                if (normalizeForSearch(cAuthor) !== normalizeForSearch(targetAuthor)) {
                  continue; // Relink rejected on author mismatch!
                }
              }

              // Match! Fetch cover for candidateId (unless it is the same itemId or known 404)
              if (candidateId === itemId) {
                continue;
              }
              const candidateMissPath = cachePaths(deps.config, candidateId).absMissPath;
              if (readCachedAbsMiss(candidateMissPath, nowMs)) {
                continue;
              }
              try {
                const fetched = await client.getBinary(`/api/items/${candidateId}/cover`);
                const contentType = normalizeImageType(fetched?.contentType);
                if (contentType !== null) {
                  const bytes =
                    fetched.bytes instanceof Uint8Array ? fetched.bytes : new Uint8Array();
                  const cover: CoverResult = { bytes, contentType };
                  writeCachedCover(
                    imgPath,
                    typePath,
                    srcPath,
                    nonePath,
                    cover,
                    `abs-relinked:${candidateId}`,
                    absMissPath
                  );
                  return cover;
                }
              } catch (err) {
                if (isNetworkOrServerError(err)) {
                  hadNetworkError = true;
                } else if (!isAuthError(err)) {
                  writeCachedAbsMiss(candidateMissPath, nowMs);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      if (isNetworkOrServerError(err)) {
        hadNetworkError = true;
      }
    }
  }

  // --- Step 3: Open Library then iTunes Audiobooks ---
  const extRes = await resolveExternalBookOrAudiobookCover(
    titleCandidates,
    targetAuthor,
    deps,
    imgPath,
    typePath,
    srcPath,
    nonePath
  );
  if (extRes.cover !== null) {
    return extRes.cover;
  }
  if (extRes.hadNetworkError) {
    hadNetworkError = true;
  }

  // Definitive "no cover anywhere"
  if (!hadNetworkError) {
    writeCachedNone(nonePath, nowMs);
  }

  return null;
}

/** Upper bound of covers one prefetch may request, so a sync never stalls on covers. */
export const PREFETCH_LIMIT = 100;

/**
 * Library item ids worth caching after a sync: items of the rows inserted by
 * run `runId`, plus every item that has a progress row. Invalid ids are dropped.
 */
export function coverIdsToPrefetch(db: Database, runId: number): string[] {
  const rows = db
    .query<{ item: string | null }, [number]>(
      `SELECT json_extract(external_ids, '$.abs_item') AS item
         FROM events_latest
        WHERE source = 'audiobookshelf' AND ingest_run_id = ?
       UNION
       SELECT source_id AS item
         FROM events_latest
        WHERE source = 'audiobookshelf' AND source_kind = 'media_progress';`
    )
    .all(runId);
  const ids = new Set<string>();
  for (const row of rows) {
    if (isValidCoverId(row.item)) ids.add(row.item);
  }
  return [...ids].sort();
}

/**
 * Cache covers right after a sync, while the items still exist on the server:
 * Audiobookshelf drops a deleted book's cover, but its sessions stay in the
 * archive. Best-effort and GET-only (via `getCover`); never throws. Returns the
 * number of items that have a cached cover afterwards.
 */
export async function prefetchCovers(
  db: Database,
  runId: number,
  deps: CoverDeps,
  limit: number = PREFETCH_LIMIT
): Promise<number> {
  let available = 0;
  try {
    for (const itemId of coverIdsToPrefetch(db, runId).slice(0, limit)) {
      if ((await getCover(itemId, { ...deps, db: deps.db ?? db })) !== null) available += 1;
    }
  } catch {
    // Covers are a nicety; a failure here must never affect the sync.
  }
  return available;
}

export interface BackfillCoversOptions extends CoverDeps {
  limit?: number;
  onlyCategories?: ReadonlyArray<TitleCoverCategory>;
}

export interface BackfillCoversResult {
  attempted: number;
  resolved: number;
  notFound: number;
}

/**
 * Discover all uncached cover candidates in `db` (Audiobookshelf items without
 * a cached cover, plus music tracks and books/audiobooks without a cover) and
 * resolve up to `limit` of them via `getCover`.
 *
 * Items already known missing on Audiobookshelf (`<id>.abs404`) skip ABS and
 * go straight to the Open Library / iTunes title fallback.
 */
export async function backfillCovers(
  db: Database,
  opts: BackfillCoversOptions
): Promise<BackfillCoversResult> {
  const limit = opts.limit ?? PREFETCH_LIMIT;
  if (limit <= 0) {
    return { attempted: 0, resolved: 0, notFound: 0 };
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  const candidateIds: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (id: string) => {
    if (!isValidCoverId(id) || seen.has(id)) return;
    const { imgPath, typePath, nonePath } = cachePaths(opts.config, id);
    if (readCachedCover(imgPath, typePath) !== null) return;
    if (readCachedNone(nonePath, nowMs)) return;
    seen.add(id);
    candidateIds.push(id);
  };

  // 1. Audiobookshelf items (unless restricted to specific categories like ["music"])
  if (!opts.onlyCategories || opts.onlyCategories.includes("audiobook")) {
    const absRows = db
      .query<{ item: string | null }, []>(
        `SELECT DISTINCT COALESCE(json_extract(external_ids, '$.abs_item'), source_id) AS item
           FROM events_latest
          WHERE source = 'audiobookshelf'
          ORDER BY id DESC;`
      )
      .all();
    for (const r of absRows) {
      if (r.item && isValidCoverId(r.item)) {
        addCandidate(r.item);
      }
    }
  }

  // 2. Music tracks and books/audiobooks without a cover
  const enrichmentMap = readYoutubeEnrichmentByVideoId(db);
  const rows = db
    .query<
      {
        source: string;
        source_kind: string;
        media_type: string;
        title: string | null;
        parent_title: string | null;
        external_ids: string | null;
        raw: string | null;
      },
      []
    >(
      `SELECT source, source_kind, media_type, title, parent_title, external_ids, raw
       FROM events_latest
       ORDER BY id DESC;`
    )
    .all();

  for (const row of rows) {
    const cat = categoryOf(row);
    if (cat !== "book" && cat !== "audiobook" && cat !== "music") {
      continue;
    }
    if (opts.onlyCategories && !opts.onlyCategories.includes(cat)) {
      continue;
    }

    const ext = parseExternalIds(row.external_ids);
    // Skip items that already have an ABS item id or metadata provider id
    if (cat !== "music" && (ext?.["abs_item"] || ext?.["meta_id"])) {
      continue;
    }

    const rawObj = parseJsonObject(row.raw);
    const workSnap = parseJsonObject(rawObj?.["work"]);
    const rawMeta = parseJsonObject(rawObj?.["mediaMetadata"]);

    const title = (
      (typeof workSnap?.["title"] === "string" ? workSnap["title"] : null) ??
      (typeof rawMeta?.["title"] === "string" ? rawMeta["title"] : null) ??
      (typeof rawObj?.["displayTitle"] === "string" ? rawObj["displayTitle"] : null) ??
      row.title ??
      ""
    ).trim();
    if (!title) continue;

    let creator: string | null = null;
    if (Array.isArray(workSnap?.["creators"]) && workSnap["creators"].length > 0) {
      const cList = (workSnap["creators"] as unknown[]).filter(
        (c): c is string => typeof c === "string" && c.trim() !== ""
      );
      if (cList.length > 0) creator = cList.join(", ");
    }
    if (!creator && typeof rawMeta?.["authorName"] === "string" && rawMeta["authorName"].trim() !== "") {
      creator = rawMeta["authorName"].trim();
    }
    if (!creator && typeof rawObj?.["displayAuthor"] === "string" && rawObj["displayAuthor"].trim() !== "") {
      creator = rawObj["displayAuthor"].trim();
    }
    if (!creator && row.parent_title && row.parent_title.trim() !== "") {
      creator = row.parent_title.trim();
    }
    if (!creator && row.source === "youtube") {
      const vid = ext?.["youtube_video"];
      if (typeof vid === "string") {
        const enr = enrichmentMap.get(vid);
        if (enr?.channel && enr.channel.trim() !== "") {
          creator = enr.channel.trim();
        }
      }
    }
    if (cat === "music") {
      const cleanedArtist = cleanMusicArtist(creator);
      if (cleanedArtist) {
        creator = cleanedArtist;
      } else {
        const { embeddedArtist } = cleanMusicTitle(title);
        if (embeddedArtist) creator = embeddedArtist;
      }
    }

    const id = titleCoverId(cat, title, creator);
    addCandidate(id);
  }

  let attempted = 0;
  let resolved = 0;
  let notFound = 0;

  for (const id of candidateIds.slice(0, limit)) {
    attempted += 1;
    const res = await getCover(id, { ...opts, db });
    if (res !== null) {
      resolved += 1;
    } else {
      notFound += 1;
    }
  }

  return { attempted, resolved, notFound };
}
