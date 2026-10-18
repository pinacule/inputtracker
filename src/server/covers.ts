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
  /** When true, ignore cached `.none` negative entries once for this lookup. */
  retryMissing?: boolean;
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

export type CoverResolvedSource = "abs" | "openlibrary" | "itunes";

interface CoverLookupOutcome {
  title: string;
  found: boolean;
  source: CoverResolvedSource | null;
  reason: string | null;
}

const lastCoverOutcomes = new Map<string, CoverLookupOutcome>();

const MOJIBAKE_SENTINEL = "\uE000";

/**
 * True when `s` contains a corrupted character such as `¿` (U+00BF), `\uFFFD`,
 * or an intra-word `?` between letters (e.g. `Sh¿gun` or `Sh?gun`).
 */
export function hasMojibake(s: string): boolean {
  return /[¿\uFFFD]|(?<=\p{L})\?(?=\p{L})/u.test(s);
}

function replaceMojibakeWithSentinel(s: string): string {
  return s
    .replace(/[¿\uFFFD]+/gu, MOJIBAKE_SENTINEL)
    .replace(/(?<=\p{L})\?+(?=\p{L})/gu, MOJIBAKE_SENTINEL);
}

/**
 * Obvious non-author values stored in folder-derived or publisher-derived
 * audiobook metadata (e.g. `GraphicAudio`, `Downloads`).
 */
const NON_AUTHOR_NAMES = new Set([
  "graphicaudio",
  "graphic audio",
  "downloads",
  "download",
  "incoming",
  "audiobooks",
  "audiobook",
  "books",
  "book",
  "podcasts",
  "podcast",
  "media",
  "music",
  "audio",
  "documents",
  "files",
  "folder",
  "unknown",
  "unknown author",
  "anonymous",
  "various",
  "various authors",
  "na",
  "n a",
  "none",
  "null",
  "undefined",
  "audible",
  "audible studios",
  "audible originals",
  "bbc",
  "bbc audio",
  "bbc radio",
  "bbc worldwide",
  "full cast",
  "dramatized",
  "unabridged",
  "abridged",
  "tantor",
  "tantor audio",
  "tantor media",
  "podium",
  "podium audio",
  "blackstone",
  "blackstone audio",
  "blackstone publishing",
  "recorded books",
  "brilliance",
  "brilliance audio",
  "penguin audio",
  "random house audio",
  "macmillan audio",
  "harperaudio",
  "hachette audio",
]);

const ROLE_SEGMENT_RE =
  /(?:[-–—]\s*(?:translator|narrator|editor|illustrator|adapter|reader|foreword|introduction|afterword|contributor|abridger|performer)s?\b|[\(\[](?:translator|narrator|editor|illustrator|adapter|reader|foreword|introduction|afterword|contributor|abridger|performer|read\s+by|narrated\s+by|translated\s+by)[^)\]]*[\]\)]|^(?:read|narrated|translated|edited|illustrated|adapted|performed|foreword|introduction|afterword)\s+by\b|\b(?:translator|narrator|editor|illustrator|adapter|reader)\s*$)/i;

export function isIgnoredNonAuthor(name: string): boolean {
  const norm = normalizeForSearch(name)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return true;
  if (NON_AUTHOR_NAMES.has(norm)) return true;
  if (/^(?:graphicaudio|graphic\s+audio)\b/i.test(norm)) return true;
  return false;
}

/**
 * Split an author string on `,`, `&`, `;`, `/`, ` and `, drop role segments
 * (`- translator`, `(narrator)`, `read by ...`) and obvious non-authors
 * (`GraphicAudio`, `Downloads`), and drop known narrators when other authors
 * are listed.
 */
export function parseBookAuthors(
  rawAuthor: string | null | undefined,
  knownNarrators?: readonly string[]
): string[] {
  if (typeof rawAuthor !== "string" || !rawAuthor.trim()) {
    return [];
  }
  const trimmed = rawAuthor.trim();

  // Detect single "Surname, Given" when there is 1 comma, no & / and / role, and the first part is 1 word
  const commaParts = trimmed.split(",");
  if (
    commaParts.length === 2 &&
    !/&|;|\band\b/i.test(trimmed) &&
    !ROLE_SEGMENT_RE.test(trimmed)
  ) {
    const p0 = commaParts[0]!.trim();
    const p1 = commaParts[1]!.trim();
    const p0Words = p0.split(/\s+/).filter(Boolean);
    const p1Words = p1.split(/\s+/).filter(Boolean);
    if (
      p0Words.length === 1 &&
      !p0.includes(".") &&
      p1Words.length >= 1 &&
      p1Words.length <= 2 &&
      !isIgnoredNonAuthor(p0) &&
      !isIgnoredNonAuthor(p1)
    ) {
      return [`${p1} ${p0}`.trim()];
    }
  }

  const rawParts = trimmed.split(/\s*(?:,|;|&|\/|\band\b)\s*/i);
  const cleaned: string[] = [];

  for (const part of rawParts) {
    const s = part.trim();
    if (!s) continue;
    if (ROLE_SEGMENT_RE.test(s)) continue;
    const strippedParens = s.replace(/\s*[\(\[][^)\]]*[\]\)]\s*/g, " ").trim();
    if (!strippedParens || isIgnoredNonAuthor(strippedParens)) continue;
    cleaned.push(strippedParens);
  }

  if (knownNarrators && knownNarrators.length > 0 && cleaned.length > 1) {
    const narratorNorms = new Set(
      knownNarrators
        .map((n) =>
          normalizeForSearch(n)
            .replace(/[^\p{L}\p{N}\s]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim()
        )
        .filter(Boolean)
    );
    const withoutNarrators = cleaned.filter((c) => {
      const nc = normalizeForSearch(c)
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      return !narratorNorms.has(nc);
    });
    if (withoutNarrators.length > 0) {
      return withoutNarrators;
    }
  }

  return cleaned;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else {
      edits++;
      if (edits > 1) return false;
      if (la > lb) {
        i++;
      } else if (lb > la) {
        j++;
      } else {
        i++;
        j++;
      }
    }
  }
  if (i < la || j < lb) edits++;
  return edits <= 1;
}

function personTokens(name: string): {
  words: string[];
  collapsedWords: string[];
  surname: string;
  collapsedSurname: string;
  firstGiven: string | null;
} {
  const trimmed = name.trim();
  // Handle "Surname, Given" inside candidate lists (e.g. Open Library ["Novak, Ana"])
  if (
    trimmed.includes(",") &&
    !trimmed.includes("&") &&
    !/\band\b/i.test(trimmed)
  ) {
    const parts = trimmed.split(",");
    if (parts.length === 2) {
      const surRaw = parts[0]!.trim();
      const givRaw = parts[1]!.trim();
      const surWords = artistWords(surRaw);
      const surCollapsed = artistWords(surRaw.replace(/['’ʻ]/gu, ""));
      const givWords = artistWords(givRaw);
      if (surWords.length > 0 && givWords.length > 0) {
        return {
          words: [...givWords, ...surWords],
          collapsedWords: [...givWords, ...surCollapsed],
          surname: surWords[surWords.length - 1]!,
          collapsedSurname:
            surCollapsed[surCollapsed.length - 1] ?? surWords[surWords.length - 1]!,
          firstGiven: givWords[0] ?? null,
        };
      }
    }
  }

  const words = artistWords(trimmed);
  const collapsedWords = artistWords(trimmed.replace(/['’ʻ]/gu, ""));
  const surname = words[words.length - 1] ?? "";
  const collapsedSurname =
    collapsedWords[collapsedWords.length - 1] ?? surname;
  const firstGiven = words.length > 1 ? (words[0] ?? null) : null;
  return { words, collapsedWords, surname, collapsedSurname, firstGiven };
}

function singlePersonAuthorMatches(targetName: string, candName: string): boolean {
  const t = personTokens(targetName);
  const c = personTokens(candName);
  if (!t.surname || !c.surname) return false;

  const surnameMatched =
    t.surname === c.surname ||
    t.collapsedSurname === c.collapsedSurname ||
    c.words.includes(t.surname) ||
    c.collapsedWords.includes(t.collapsedSurname) ||
    t.words.includes(c.surname) ||
    t.collapsedWords.includes(c.collapsedSurname);
  if (!surnameMatched) return false;

  if (t.firstGiven && c.firstGiven) {
    if (t.firstGiven[0] !== c.firstGiven[0]) {
      return false;
    }
    if (t.firstGiven.length >= 3 && c.firstGiven.length >= 3) {
      if (
        t.firstGiven !== c.firstGiven &&
        !t.firstGiven.startsWith(c.firstGiven) &&
        !c.firstGiven.startsWith(t.firstGiven) &&
        !editDistanceAtMostOne(t.firstGiven, c.firstGiven)
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * True when ANY parsed target author matches ANY candidate author string.
 */
export function bookAuthorsMatch(
  targetAuthors: readonly string[],
  candidateAuthorsRaw: readonly string[]
): boolean {
  if (targetAuthors.length === 0 || candidateAuthorsRaw.length === 0) {
    return false;
  }

  const expandedCandidates: string[] = [];
  for (const raw of candidateAuthorsRaw) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    expandedCandidates.push(raw.trim());
    const parsed = parseBookAuthors(raw);
    for (const p of parsed) {
      if (!expandedCandidates.includes(p)) {
        expandedCandidates.push(p);
      }
    }
  }

  for (const t of targetAuthors) {
    for (const c of expandedCandidates) {
      if (singlePersonAuthorMatches(t, c) || authorMatches(t, [c])) {
        return true;
      }
    }
  }
  return false;
}

const SUMMARY_AUTHOR_RE =
  /\b(?:bright\s*summaries|swift\s*reads|abbey\s*beathan|everest\s*media|instaread|blinkist|worth\s*books|50minutes|super\s*summary|spark\s*notes|cliff\s*notes|cliffs\s*notes|bookcaps|litcharts|bookhabits|zip\s*reads|smart\s*reads|in\s*30\s*minutes)\b/i;

const SUMMARY_TITLE_RE =
  /(?:^\s*summary\s+of\b|\bsummary\s+of\s+.|\bbook\s+analysis\b|\bbook\s+summary\b|\bstudy\s+guide\b|\breading\s+guide\b|\bspark\s*notes\b|\bcliff\s*notes\b|\bcliffs\s*notes\b|\bsuper\s*summary\b|\blitcharts\b|\bkey\s+takeaways\b|\banalysis\s+of\b|\bworkbook\s+for\b|\bcompanion\s+to\b|^\s*concise\s+)/i;

/**
 * Reject third-party summaries, study guides, and book analyses ("Summary of …",
 * "Book Analysis", "by Bright Summaries") unless the target title itself asks for one.
 */
export function isSummaryOrAnalysis(
  candidateTitle: string,
  candidateAuthors: readonly string[],
  queryTitle?: string
): boolean {
  const qNorm = normalizeForSearch(queryTitle ?? "");
  for (const a of candidateAuthors) {
    if (typeof a === "string" && SUMMARY_AUTHOR_RE.test(a)) {
      return true;
    }
  }
  if (!SUMMARY_TITLE_RE.test(candidateTitle)) {
    // Also reject titles containing " by <Author>" when the query does not contain " by "
    if (
      /\bby\s+[A-Z][\p{L}.'-]+\s+[A-Z][\p{L}.'-]+/u.test(candidateTitle) &&
      !/\bby\b/i.test(qNorm)
    ) {
      return true;
    }
    return false;
  }
  if (
    qNorm.includes("summary") ||
    qNorm.includes("analysis") ||
    qNorm.includes("study guide")
  ) {
    return false;
  }
  return true;
}

function normalizeBookTitleWithSentinel(s: string): string {
  const withSentinel = replaceMojibakeWithSentinel(s);
  return normalizeForSearch(withSentinel)
    .replace(/['’ʻ]/gu, "")
    .replace(new RegExp(`[^\\p{L}\\p{N}\\s${MOJIBAKE_SENTINEL}]+`, "gu"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingArticle(normTitle: string): string {
  const stripped = normTitle.replace(/^(?:the|a|an)\s+/i, "").trim();
  const words = stripped.split(" ").filter(Boolean);
  if (words.length >= 2 || stripped.length >= 6) {
    return stripped;
  }
  return normTitle;
}

function stripCompleteTrilogyNoise(normTitle: string): string {
  return normTitle
    .replace(/^(the\s+)?complete\s+(.+)$/i, "$1$2")
    .replace(/\s+(?:trilogy|omnibus|boxed\s+set|box\s+set|collection)$/i, "")
    .trim();
}

/**
 * Clean a store-returned book/audiobook title, stripping edition/part/series suffixes.
 */
function cleanStoreBookTitleVariants(rawStoreTitle: string): {
  fullForms: string[];
  preColonForms: string[];
  postColonForms: string[];
} {
  let s = rawStoreTitle.trim();
  // Strip repeated trailing (...) or [...] tags for edition / part / format
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s
      .replace(
        /\s*[\(\[](?:unabridged|abridged|\d+\s*(?:of|\/)\s*\d+[^)\]]*|part\s+(?:\d+|one|two|three|four|five|i|ii|iii|iv)[^)\]]*|book\s+(?:\d+|one|two|three|four|five|i|ii|iii|iv)[^)\]]*|vol(?:ume|\.)?\s*\d+(?:\.\d+)?[^)\]]*|dramatized[^)\]]*|booktrack\s*edition[^)\]]*|light\s*novel[^)\]]*|the\s+young\s+adult\s+adaptation[^)\]]*)[\]\)]\s*$/i,
        ""
      )
      .trim();
  }

  // Strip trailing ", Part One", " Vol. 1", " - Booktrack Edition", " – Osa 1", etc.
  const stripTrailingPartAndEdition = (val: string): string => {
    let v = val.trim();
    let p = "";
    while (v !== p) {
      p = v;
      v = v
        .replace(
          /\s*[\(\[](?:light\s*novel|booktrack\s*edition|dramatized\s*adaptation|unabridged|abridged)[\]\)]\s*/gi,
          " "
        )
        .replace(
          /(?:[,:\s]+|\s+[-–—]\s+)(?:part\s+(?:\d+|one|two|three|four|five|i|ii|iii|iv)|vol(?:ume|\.)?\s*\d+(?:\.\d+)?|book\s+(?:\d+|one|two|three|four|five|i|ii|iii|iv)|tome\s+\d+.*|osa\s+\d+.*|booktrack\s+edition.*)$/i,
          ""
        )
        .replace(/\s+/g, " ")
        .trim();
    }
    return v;
  };

  const baseClean = stripTrailingPartAndEdition(cleanTitle(s));
  // Also variant without a trailing parenthetical series tag like "(Earthsea Cycle)" or "(The Asian Saga)"
  const withoutTrailingParens = stripTrailingPartAndEdition(
    s.replace(/\s*\([^()]+\)\s*$/, "").trim()
  );

  const fullFormsSet = new Set<string>();
  for (const cand of [s, baseClean, withoutTrailingParens]) {
    if (cand.length > 0) {
      fullFormsSet.add(cand);
    }
  }

  const preColonFormsSet = new Set<string>();
  const postColonFormsSet = new Set<string>();
  for (const f of fullFormsSet) {
    const colonIdx = f.indexOf(":");
    if (colonIdx > 0) {
      const before = stripTrailingPartAndEdition(cleanTitle(f.slice(0, colonIdx)));
      if (before.length >= 3) {
        preColonFormsSet.add(before);
      }
      const after = stripTrailingPartAndEdition(cleanTitle(f.slice(colonIdx + 1)));
      if (after.length >= 3) {
        postColonFormsSet.add(after);
      }
    }
  }

  return {
    fullForms: [...fullFormsSet],
    preColonForms: [...preColonFormsSet],
    postColonForms: [...postColonFormsSet],
  };
}

function normFormsMatch(queryNorm: string, candNorm: string): boolean {
  if (!queryNorm || !candNorm) return false;
  if (queryNorm.includes(MOJIBAKE_SENTINEL)) {
    const buildMojibakeRegex = (patternNorm: string): RegExp => {
      const escaped = patternNorm
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(new RegExp(`${MOJIBAKE_SENTINEL}+`, "g"), "[a-z0-9]{1,2}");
      return new RegExp(`^${escaped}$`, "i");
    };
    const candPlain = candNorm.replaceAll(MOJIBAKE_SENTINEL, "");
    if (buildMojibakeRegex(queryNorm).test(candPlain)) return true;
    const qNoArt = stripLeadingArticle(queryNorm);
    const cNoArt = stripLeadingArticle(candPlain);
    return buildMojibakeRegex(qNoArt).test(cNoArt);
  }

  if (queryNorm === candNorm) return true;
  const qNoArt = stripLeadingArticle(queryNorm);
  const cNoArt = stripLeadingArticle(candNorm);
  if (qNoArt === cNoArt) return true;

  const qNoTrilogy = stripCompleteTrilogyNoise(qNoArt);
  const cNoTrilogy = stripCompleteTrilogyNoise(cNoArt);
  if (qNoTrilogy.length >= 5 && qNoTrilogy === cNoTrilogy) return true;

  return false;
}

export function bookTitleMatches(
  queryTitle: string,
  candidateTitle: string,
  opts: { hasAuthor: boolean; allowSubtitleMatch?: boolean }
): boolean {
  const qVariants = cleanStoreBookTitleVariants(queryTitle);
  const cVariants = cleanStoreBookTitleVariants(candidateTitle);

  const qFullNorms = qVariants.fullForms
    .map(normalizeBookTitleWithSentinel)
    .filter(Boolean);
  const cFullNorms = cVariants.fullForms
    .map(normalizeBookTitleWithSentinel)
    .filter(Boolean);

  for (const qn of qFullNorms) {
    for (const cn of cFullNorms) {
      if (normFormsMatch(qn, cn)) return true;
    }
  }

  if (opts.hasAuthor) {
    const qPreNorms = qVariants.preColonForms
      .map(normalizeBookTitleWithSentinel)
      .filter((s) => s.length >= 4 || s.includes(MOJIBAKE_SENTINEL));
    const cPreNorms = cVariants.preColonForms
      .map(normalizeBookTitleWithSentinel)
      .filter((s) => s.length >= 4 || s.includes(MOJIBAKE_SENTINEL));

    for (const qn of [...qFullNorms, ...qPreNorms]) {
      for (const cn of [...cFullNorms, ...cPreNorms]) {
        if (normFormsMatch(qn, cn)) return true;
      }
    }

    if (opts.allowSubtitleMatch) {
      const cPostNorms = cVariants.postColonForms
        .map(normalizeBookTitleWithSentinel)
        .filter(Boolean);
      for (const qn of qFullNorms) {
        for (const cn of cPostNorms) {
          if (normFormsMatch(qn, cn)) return true;
        }
      }
    }
  }

  return false;
}

/**
 * True when a title has enough distinctive structure to be searched without a
 * known author. Single-word titles (`me`, `shadow`, `Communication`, `Focus`)
 * are rejected so they never get a random cover.
 */
export function isDistinctiveTitleWithoutAuthor(title: string): boolean {
  const cleaned = cleanTitle(title);
  const norm = normalizeBookTitleWithSentinel(cleaned).replaceAll(
    MOJIBAKE_SENTINEL,
    ""
  );
  if (!norm || norm.length < 6) return false;
  const withoutArticle = norm.replace(/^(?:the|a|an)\s+/i, "").trim();
  const words = withoutArticle.split(" ").filter((w) => w.length > 0);
  if (words.length < 2) return false;
  return words.some((w) => w.length >= 3);
}

export interface BookTitleCandidate {
  title: string;
  requiredEmbeddedAuthor?: string;
  allowSubtitleMatch?: boolean;
}

const EDITION_DASH_SUFFIX_RE =
  /\s+[-–—]\s+(?:bbc\b.*|.*?\bradio\s+drama\b.*|.*?\baudio\s+drama\b.*|booktrack\s+edition\b.*|dramatized\b.*|unabridged\b.*|abridged\b.*|full\s+cast\b.*)$/i;

function looksLikeAuthorPrefix(prefix: string): boolean {
  const s = prefix.trim();
  if (!s || s.length < 3 || s.length > 60) return false;
  if (/\d/.test(s)) return false;
  if (/^(?:the|a|an)\s+/i.test(s)) return false;
  if (isIgnoredNonAuthor(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4;
}

/**
 * Build ordered title search candidates from a stored title, parsed authors,
 * and optional series name.
 */
export function buildBookTitleCandidates(
  rawTitle: string,
  parsedAuthors: readonly string[],
  seriesName?: string
): BookTitleCandidate[] {
  const candidates: BookTitleCandidate[] = [];
  const seen = new Set<string>();

  const add = (cand: BookTitleCandidate) => {
    const t = cand.title.trim();
    if (!t) return;
    const key = `${normalizeForSearch(t)}\0${normalizeForSearch(cand.requiredEmbeddedAuthor ?? "")}\0${cand.allowSubtitleMatch ? "1" : "0"}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ ...cand, title: t });
  };

  const trimmed = rawTitle.trim();
  if (!trimmed) return [];

  // Check for "Author - Title" prefix (e.g. "Laura Hillenbrand - Unbroken")
  const withoutEditionDash = trimmed.replace(EDITION_DASH_SUFFIX_RE, "").trim();
  const dashMatch = /^(.+?)\s+[-–—]\s+(.+)$/.exec(withoutEditionDash);
  if (dashMatch && dashMatch[1] && dashMatch[2]) {
    const left = dashMatch[1].trim();
    const right = cleanTitle(dashMatch[2].trim(), seriesName);
    if (right.length >= 3 && looksLikeAuthorPrefix(left)) {
      if (parsedAuthors.length === 0) {
        add({ title: right, requiredEmbeddedAuthor: left });
      } else if (bookAuthorsMatch(parsedAuthors, [left])) {
        add({ title: right });
      }
    }
  }

  const cleaned = cleanTitle(trimmed, seriesName);
  if (cleaned) {
    add({ title: cleaned });
  }

  // Strip subtitle after ":" (e.g. "Iron Prince: Warformed: Stormweaver, Book 1" -> "Iron Prince")
  for (const base of [cleaned, trimmed]) {
    const colonIdx = base.indexOf(":");
    if (colonIdx >= 3) {
      const beforeColon = cleanTitle(base.slice(0, colonIdx), seriesName);
      if (beforeColon.length >= 3) {
        add({ title: beforeColon });
      }
    }
  }

  // Strip trailing "Trilogy", "Omnibus", "Box Set", "Collection" (e.g. "The Poppy War Trilogy" -> "The Poppy War")
  for (const existing of [...candidates]) {
    const strippedSeriesSuffix = existing.title
      .replace(/\s+(?:trilogy|omnibus|boxed\s+set|box\s+set|collection)$/i, "")
      .trim();
    if (
      strippedSeriesSuffix.length >= 3 &&
      strippedSeriesSuffix !== existing.title
    ) {
      add({
        title: strippedSeriesSuffix,
        requiredEmbeddedAuthor: existing.requiredEmbeddedAuthor,
      });
    }
  }

  // Expand light-novel shorthand "Y2" -> "Year 2" when an author is known
  if (parsedAuthors.length > 0) {
    const yMatch = /^Y(\d+)(?:\s*V(?:ol\.?)?\s*(\d+(?:\.\d+)?))?$/i.exec(cleaned);
    if (yMatch && yMatch[1]) {
      add({ title: `Year ${yMatch[1]}`, allowSubtitleMatch: true });
    }
    if (seriesName && seriesName.trim().length >= 3) {
      add({ title: cleanTitle(seriesName.trim()) });
    }
  }

  if (trimmed !== cleaned) {
    add({ title: trimmed });
  }

  return candidates;
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

interface StoreSearchOutcome<T> {
  hit: T | null;
  sawSummary: boolean;
  sawAuthorMismatch: boolean;
}

async function queryOpenLibraryDocs(
  queryTitle: string | null,
  queryAuthor: string | null,
  limit: number,
  baseUrl: string,
  fetchFn: typeof fetch
): Promise<any[]> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/search.json`);
  if (queryTitle && queryTitle.trim()) {
    url.searchParams.set("title", queryTitle.trim());
  }
  if (queryAuthor && queryAuthor.trim()) {
    url.searchParams.set("author", queryAuthor.trim());
  }
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", "key,title,author_name,cover_i");

  return defaultOpenLibraryLimiter.run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Open Library request timed out", "TimeoutError"));
    }, OPEN_LIBRARY_TIMEOUT_MS);
    try {
      const response = await fetchFn(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500) {
          throw new Error(`Open Library server error: HTTP ${response.status}`);
        }
        return [];
      }
      let data: any;
      try {
        data = await response.json();
      } catch (err) {
        throw new Error(`Failed to parse Open Library JSON: ${err}`);
      }
      return Array.isArray(data?.docs) ? data.docs : [];
    } finally {
      clearTimeout(timer);
    }
  });
}

function matchOpenLibraryDocs(
  docs: any[],
  cand: BookTitleCandidate,
  effectiveAuthors: readonly string[]
): StoreSearchOutcome<number> {
  let sawSummary = false;
  let sawAuthorMismatch = false;
  const hasAuthor = effectiveAuthors.length > 0;

  interface ValidOlDoc {
    coverId: number;
    title: string;
    authors: string[];
  }
  const validDocs: ValidOlDoc[] = [];

  for (const doc of docs) {
    if (typeof doc?.cover_i !== "number" || doc.cover_i <= 0) continue;
    if (typeof doc?.title !== "string" || !doc.title.trim()) continue;
    const docAuthors = Array.isArray(doc.author_name)
      ? doc.author_name.filter((a: unknown): a is string => typeof a === "string")
      : [];
    if (isSummaryOrAnalysis(doc.title, docAuthors, cand.title)) {
      sawSummary = true;
      continue;
    }
    validDocs.push({
      coverId: doc.cover_i,
      title: doc.title.trim(),
      authors: docAuthors,
    });
  }

  if (hasAuthor) {
    for (const doc of validDocs) {
      if (
        bookTitleMatches(cand.title, doc.title, {
          hasAuthor: true,
          allowSubtitleMatch: cand.allowSubtitleMatch,
        })
      ) {
        if (bookAuthorsMatch(effectiveAuthors, doc.authors)) {
          return { hit: doc.coverId, sawSummary, sawAuthorMismatch };
        }
        sawAuthorMismatch = true;
      }
    }
    return { hit: null, sawSummary, sawAuthorMismatch };
  }

  // Authorless match: require a strong title match and either the top result
  // matches or there is a single clear result (all matches share an author).
  const matching = validDocs.filter((doc) =>
    bookTitleMatches(cand.title, doc.title, { hasAuthor: false })
  );
  if (matching.length === 0) {
    return { hit: null, sawSummary, sawAuthorMismatch };
  }
  if (validDocs[0] && matching.includes(validDocs[0])) {
    return { hit: validDocs[0].coverId, sawSummary, sawAuthorMismatch };
  }
  if (matching.length === 1) {
    return { hit: matching[0]!.coverId, sawSummary, sawAuthorMismatch };
  }
  const firstAuthors = matching[0]!.authors;
  if (
    firstAuthors.length > 0 &&
    matching.every((m) => bookAuthorsMatch(firstAuthors, m.authors))
  ) {
    return { hit: matching[0]!.coverId, sawSummary, sawAuthorMismatch };
  }
  return { hit: null, sawSummary, sawAuthorMismatch };
}

async function searchOpenLibraryCandidate(
  cand: BookTitleCandidate,
  effectiveAuthors: readonly string[],
  baseUrl: string,
  fetchFn: typeof fetch
): Promise<StoreSearchOutcome<number>> {
  const primaryAuthor = effectiveAuthors[0] ?? null;
  const docs1 = await queryOpenLibraryDocs(
    cand.title,
    primaryAuthor,
    5,
    baseUrl,
    fetchFn
  );
  const res1 = matchOpenLibraryDocs(docs1, cand, effectiveAuthors);
  if (res1.hit !== null) return res1;

  let sawSummary = res1.sawSummary;
  let sawAuthorMismatch = res1.sawAuthorMismatch;

  // If title has mojibake (e.g. "Sh¿gun") and an author is known, Open Library's
  // title= index cannot match the corrupted token: search by author and match locally.
  if (hasMojibake(cand.title) && primaryAuthor) {
    const cleanWords = cand.title
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !hasMojibake(w))
      .join(" ");
    const docs2 = await queryOpenLibraryDocs(
      cleanWords || null,
      primaryAuthor,
      15,
      baseUrl,
      fetchFn
    );
    const res2 = matchOpenLibraryDocs(docs2, cand, effectiveAuthors);
    sawSummary = sawSummary || res2.sawSummary;
    sawAuthorMismatch = sawAuthorMismatch || res2.sawAuthorMismatch;
    if (res2.hit !== null) {
      return { hit: res2.hit, sawSummary, sawAuthorMismatch };
    }
  }

  // If multiple people were listed and the first person was a narrator (not on Open Library),
  // search by title and verify any listed person locally.
  if (docs1.length === 0 && effectiveAuthors.length > 1) {
    const docs3 = await queryOpenLibraryDocs(cand.title, null, 10, baseUrl, fetchFn);
    const res3 = matchOpenLibraryDocs(docs3, cand, effectiveAuthors);
    sawSummary = sawSummary || res3.sawSummary;
    sawAuthorMismatch = sawAuthorMismatch || res3.sawAuthorMismatch;
    if (res3.hit !== null) {
      return { hit: res3.hit, sawSummary, sawAuthorMismatch };
    }
  }

  return { hit: null, sawSummary, sawAuthorMismatch };
}

async function queryItunesAudiobookItems(
  term: string,
  limit: number,
  config: Config,
  fetchFn: typeof fetch
): Promise<any[]> {
  const itunesBase = resolveMetadataConfig(config).itunes_url;
  const url = new URL(`${itunesBase}/search`);
  url.searchParams.set("media", "audiobook");
  url.searchParams.set("entity", "audiobook");
  url.searchParams.set("term", term);
  url.searchParams.set("limit", String(limit));

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
        return [];
      }
      let data: any;
      try {
        data = await response.json();
      } catch {
        return [];
      }
      return Array.isArray(data?.results) ? data.results : [];
    } finally {
      clearTimeout(timer);
    }
  });
}

function matchItunesAudiobookResults(
  results: any[],
  cand: BookTitleCandidate,
  effectiveAuthors: readonly string[]
): StoreSearchOutcome<ItunesCoverHit> {
  let sawSummary = false;
  let sawAuthorMismatch = false;
  const hasAuthor = effectiveAuthors.length > 0;

  interface ValidItunesItem {
    id: string;
    title: string;
    author: string;
    artworkUrl: string;
  }
  const validItems: ValidItunesItem[] = [];

  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const rawId = item.collectionId ?? item.trackId;
    if (typeof rawId !== "number" || rawId <= 0) continue;

    const itemTitleRaw = String(item.collectionName ?? item.trackName ?? "").trim();
    const itemAuthorRaw = String(item.artistName ?? "").trim();
    if (!itemTitleRaw || !itemAuthorRaw) continue;

    if (isSummaryOrAnalysis(itemTitleRaw, [itemAuthorRaw], cand.title)) {
      sawSummary = true;
      continue;
    }

    const artworkUrl = upscaleItunesArtwork(item.artworkUrl100 ?? item.artworkUrl60);
    if (!artworkUrl) continue;

    validItems.push({
      id: String(rawId),
      title: itemTitleRaw,
      author: itemAuthorRaw,
      artworkUrl,
    });
  }

  if (hasAuthor) {
    for (const item of validItems) {
      if (
        bookTitleMatches(cand.title, item.title, {
          hasAuthor: true,
          allowSubtitleMatch: cand.allowSubtitleMatch,
        })
      ) {
        if (
          bookAuthorsMatch(effectiveAuthors, [item.author]) ||
          effectiveAuthors.some((a) => artistMatches(a, item.author))
        ) {
          return {
            hit: { id: item.id, artworkUrl: item.artworkUrl },
            sawSummary,
            sawAuthorMismatch,
          };
        }
        sawAuthorMismatch = true;
      }
    }
    return { hit: null, sawSummary, sawAuthorMismatch };
  }

  // Authorless match: require a strong title match and either the top non-summary
  // result matches or there is a single clear result.
  const matching = validItems.filter((item) =>
    bookTitleMatches(cand.title, item.title, { hasAuthor: false })
  );
  if (matching.length === 0) {
    return { hit: null, sawSummary, sawAuthorMismatch };
  }
  if (validItems[0] && matching.includes(validItems[0])) {
    return {
      hit: { id: validItems[0].id, artworkUrl: validItems[0].artworkUrl },
      sawSummary,
      sawAuthorMismatch,
    };
  }
  if (matching.length === 1) {
    return {
      hit: { id: matching[0]!.id, artworkUrl: matching[0]!.artworkUrl },
      sawSummary,
      sawAuthorMismatch,
    };
  }
  const firstAuthor = matching[0]!.author;
  if (matching.every((m) => bookAuthorsMatch([firstAuthor], [m.author]))) {
    return {
      hit: { id: matching[0]!.id, artworkUrl: matching[0]!.artworkUrl },
      sawSummary,
      sawAuthorMismatch,
    };
  }
  return { hit: null, sawSummary, sawAuthorMismatch };
}

async function searchItunesAudiobookCandidate(
  cand: BookTitleCandidate,
  effectiveAuthors: readonly string[],
  config: Config,
  fetchFn: typeof fetch
): Promise<StoreSearchOutcome<ItunesCoverHit>> {
  const primaryAuthor = effectiveAuthors[0] ?? "";
  const term1 = primaryAuthor ? `${cand.title} ${primaryAuthor}` : cand.title;
  const results1 = await queryItunesAudiobookItems(term1, 10, config, fetchFn);
  const res1 = matchItunesAudiobookResults(results1, cand, effectiveAuthors);
  if (res1.hit !== null) return res1;

  let sawSummary = res1.sawSummary;
  let sawAuthorMismatch = res1.sawAuthorMismatch;

  if (hasMojibake(cand.title) && primaryAuthor) {
    const cleanWords = cand.title
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !hasMojibake(w))
      .join(" ");
    const term2 = cleanWords ? `${cleanWords} ${primaryAuthor}` : primaryAuthor;
    if (term2 !== term1) {
      const results2 = await queryItunesAudiobookItems(term2, 20, config, fetchFn);
      const res2 = matchItunesAudiobookResults(results2, cand, effectiveAuthors);
      sawSummary = sawSummary || res2.sawSummary;
      sawAuthorMismatch = sawAuthorMismatch || res2.sawAuthorMismatch;
      if (res2.hit !== null) {
        return { hit: res2.hit, sawSummary, sawAuthorMismatch };
      }
    }
  }

  if ( results1.length === 0 && effectiveAuthors.length > 1) {
    const results3 = await queryItunesAudiobookItems(cand.title, 10, config, fetchFn);
    const res3 = matchItunesAudiobookResults(results3, cand, effectiveAuthors);
    sawSummary = sawSummary || res3.sawSummary;
    sawAuthorMismatch = sawAuthorMismatch || res3.sawAuthorMismatch;
    if (res3.hit !== null) {
      return { hit: res3.hit, sawSummary, sawAuthorMismatch };
    }
  }

  return { hit: null, sawSummary, sawAuthorMismatch };
}

async function searchItunesSong(
  rawTitle: string,
  rawArtist: string | null | undefined,
  config: Config,
  fetchFn: typeof fetch
): Promise<{ hit: ItunesCoverHit | null; reason: string }> {
  const { cleanTrack, embeddedArtist } = cleanMusicTitle(rawTitle);
  const effectiveArtist = cleanMusicArtist(rawArtist) || cleanMusicArtist(embeddedArtist);
  const trackToSearch = cleanTrack || rawTitle.trim();
  if (!trackToSearch) return { hit: null, reason: "no title" };

  const normTargetTrack = normalizeTrackForMatch(trackToSearch);
  const normFullTitle = normalizeTrackForMatch(rawTitle);
  if (!normTargetTrack) return { hit: null, reason: "no title" };

  if (!effectiveArtist) {
    const words = normTargetTrack.split(" ").filter(Boolean);
    if (words.length < 2 && normTargetTrack.length < 8) {
      return { hit: null, reason: "title too generic without author" };
    }
  }

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
        return { hit: null, reason: "no match in itunes" };
      }
      let data: any;
      try {
        data = await response.json();
      } catch {
        return { hit: null, reason: "no match in itunes" };
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      let sawArtistMismatch = false;

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
            sawArtistMismatch = true;
            continue;
          }
        }

        const artworkUrl = upscaleItunesArtwork(item.artworkUrl100 ?? item.artworkUrl60);
        if (artworkUrl) {
          return { hit: { id: String(rawId), artworkUrl }, reason: "" };
        }
      }
      return {
        hit: null,
        reason: sawArtistMismatch ? "author mismatch" : "no match in itunes",
      };
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
 * Strip trailing "(Unabridged)" / "(1 of 5)"-style suffixes, "- BBC 1996 Radio Drama..."
 * adaptation noise, "[01]"-style series markers, and leading series prefixes like
 * "The Stormlight Archive 2: " for the fallback lookup try.
 */
export function cleanTitle(title: string, seriesName?: string): string {
  let cleaned = title.trim();

  // 1. Strip trailing suffix: e.g. " (Unabridged)", "(Abridged)", "(1 of 5)", "[1 of 5]", "(Part 1)", etc.
  cleaned = cleaned
    .replace(
      /\s*[\(\[](?:unabridged|abridged|\d+\s*(?:of|\/)\s*\d+[^)\]]*|part\s+\d+(?:\s*(?:of|\/)\s*\d+)?|book\s+\d+(?:\s*(?:of|\/)\s*\d+)?)[\]\)]\s*$/i,
      ""
    )
    .trim();

  // 2. Strip trailing adaptation / radio drama / edition dash suffixes:
  // e.g. "A Wizard of Earthsea - BBC 1996 Radio Drama J…"
  cleaned = cleaned.replace(EDITION_DASH_SUFFIX_RE, "").trim();

  // 3. Strip "[01]"-style bracketed series markers:
  // e.g. "The Stormlight Archive [01] The Way Of Kings " -> "The Way Of Kings"
  const midBracketMatch =
    /^(.+?)\s*\[\s*(?:book|vol\.?|volume|part|#)?\s*\d+(?:\.\d+)?\s*\]\s*[-–—:]?\s*(.+)$/i.exec(
      cleaned
    );
  if (midBracketMatch && midBracketMatch[2]?.trim()) {
    cleaned = midBracketMatch[2].trim();
  } else {
    cleaned = cleaned
      .replace(
        /^\[\s*(?:book|vol\.?|volume|part|#)?\s*\d+(?:\.\d+)?\s*\]\s*[-–—:]?\s*/i,
        ""
      )
      .replace(
        /\s*\[\s*(?:book|vol\.?|volume|part|#)?\s*\d+(?:\.\d+)?\s*\]$/i,
        ""
      )
      .trim();
  }

  // 4. Strip leading series prefix:
  // If seriesName is known and non-empty:
  if (seriesName && seriesName.trim()) {
    const escaped = seriesName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const seriesRe = new RegExp(
      `^${escaped}(?:[\\s,]+(?:Book|Vol|Volume|Part|#)?\\s*\\d+)?\\s*:\\s*`,
      "i"
    );
    cleaned = cleaned.replace(seriesRe, "").trim();
  }

  // Also handle generic series prefix with a number before the first colon:
  // e.g. "Series Name 2: Title" or "Series Name, Book 2: Title"
  cleaned = cleaned
    .replace(/^[^:]+?(?:[,\s]+(?:Book|Vol|Volume|Part|#)?\s*\d+)\s*:\s*/i, "")
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
  rawTitle: string,
  targetAuthor: string,
  deps: CoverDeps,
  imgPath: string,
  typePath: string,
  srcPath: string,
  nonePath: string,
  extra?: { seriesName?: string; knownNarrators?: readonly string[] }
): Promise<{
  cover: CoverResult | null;
  source: "openlibrary" | "itunes" | null;
  hadNetworkError: boolean;
  reason: string;
}> {
  const coversConfig = deps.config.covers ?? {
    external: true,
    openlibrary_url: "https://openlibrary.org",
    openlibrary_covers_url: "https://covers.openlibrary.org",
  };
  if (!coversConfig.external) {
    return {
      cover: null,
      source: null,
      hadNetworkError: false,
      reason: "external covers disabled",
    };
  }

  const parsedAuthors = parseBookAuthors(targetAuthor, extra?.knownNarrators);
  const allCandidates = buildBookTitleCandidates(
    rawTitle,
    parsedAuthors,
    extra?.seriesName
  );
  if (allCandidates.length === 0) {
    return {
      cover: null,
      source: null,
      hadNetworkError: false,
      reason: "no title",
    };
  }

  // Filter out candidates that have neither a valid author nor a distinctive multi-word title
  const viableCandidates = allCandidates.filter((cand) => {
    const effAuthors = cand.requiredEmbeddedAuthor
      ? [cand.requiredEmbeddedAuthor]
      : parsedAuthors;
    if (effAuthors.length > 0) return true;
    return isDistinctiveTitleWithoutAuthor(cand.title);
  });

  if (viableCandidates.length === 0) {
    return {
      cover: null,
      source: null,
      hadNetworkError: false,
      reason: "title too generic without author",
    };
  }

  let hadNetworkError = false;
  let sawSummary = false;
  let sawAuthorMismatch = false;
  const fetchFn = deps.fetch ?? globalThis.fetch;

  // 1. Open Library
  for (const cand of viableCandidates) {
    const effectiveAuthors = cand.requiredEmbeddedAuthor
      ? [cand.requiredEmbeddedAuthor]
      : parsedAuthors;
    try {
      const olRes = await searchOpenLibraryCandidate(
        cand,
        effectiveAuthors,
        coversConfig.openlibrary_url,
        fetchFn
      );
      sawSummary = sawSummary || olRes.sawSummary;
      sawAuthorMismatch = sawAuthorMismatch || olRes.sawAuthorMismatch;

      if (olRes.hit !== null) {
        const fetched = await fetchOpenLibraryCover(olRes.hit, {
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
            `openlibrary:${olRes.hit}`
          );
          return {
            cover: fetched,
            source: "openlibrary",
            hadNetworkError,
            reason: "",
          };
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
    for (const cand of viableCandidates) {
      const effectiveAuthors = cand.requiredEmbeddedAuthor
        ? [cand.requiredEmbeddedAuthor]
        : parsedAuthors;
      try {
        const itunesRes = await searchItunesAudiobookCandidate(
          cand,
          effectiveAuthors,
          deps.config,
          fetchFn
        );
        sawSummary = sawSummary || itunesRes.sawSummary;
        sawAuthorMismatch = sawAuthorMismatch || itunesRes.sawAuthorMismatch;

        if (itunesRes.hit !== null) {
          const fetched = await fetchExternalImage(
            itunesRes.hit.artworkUrl,
            fetchFn
          );
          if (fetched !== null) {
            writeCachedCover(
              imgPath,
              typePath,
              srcPath,
              nonePath,
              fetched,
              `itunes:${itunesRes.hit.id}`
            );
            return {
              cover: fetched,
              source: "itunes",
              hadNetworkError,
              reason: "",
            };
          }
        }
      } catch (err) {
        if (isNetworkOrServerError(err)) {
          hadNetworkError = true;
        }
      }
    }
  }

  let reason = "no match in openlibrary or itunes";
  if (hadNetworkError) {
    reason = "network error";
  } else if (sawAuthorMismatch) {
    reason = "author mismatch";
  } else if (sawSummary) {
    reason = "only summary/analysis found";
  }

  return { cover: null, source: null, hadNetworkError, reason };
}

function extractAbsMetadataFromRow(
  row: { raw: string | null; title: string | null; parent_title: string | null },
  itemId: string
): {
  title: string;
  author: string;
  seriesName: string;
  narrators: string[];
} {
  let rawObj: any = null;
  if (typeof row.raw === "string") {
    try {
      rawObj = JSON.parse(row.raw);
    } catch {}
  }
  const meta = rawObj?.mediaMetadata;
  const rawTitle = (meta?.title ?? rawObj?.displayTitle ?? row.title ?? "").trim();
  const title =
    rawTitle === itemId && !meta?.title && !rawObj?.displayTitle
      ? ""
      : rawTitle;

  let author = (meta?.authorName ?? rawObj?.displayAuthor ?? row.parent_title ?? "").trim();
  if (!author && Array.isArray(meta?.authors)) {
    const names = (meta.authors as unknown[])
      .map((a) =>
        typeof a === "string"
          ? a.trim()
          : a && typeof a === "object" && typeof (a as any).name === "string"
            ? String((a as any).name).trim()
            : ""
      )
      .filter(Boolean);
    if (names.length > 0) {
      author = names.join(", ");
    }
  }

  let seriesName = "";
  if (typeof meta?.seriesName === "string" && meta.seriesName.trim()) {
    seriesName = meta.seriesName.trim();
  } else if (Array.isArray(meta?.series) && meta.series.length > 0) {
    const firstSeries = meta.series[0];
    if (typeof firstSeries === "string" && firstSeries.trim()) {
      seriesName = firstSeries.trim();
    } else if (
      firstSeries &&
      typeof firstSeries === "object" &&
      typeof (firstSeries as any).name === "string"
    ) {
      seriesName = String((firstSeries as any).name).trim();
    }
  }

  const narrators: string[] = [];
  if (Array.isArray(meta?.narrators)) {
    for (const n of meta.narrators) {
      if (typeof n === "string" && n.trim()) {
        narrators.push(n.trim());
      } else if (n && typeof n === "object" && typeof (n as any).name === "string") {
        narrators.push(String((n as any).name).trim());
      }
    }
  }

  return { title, author, seriesName, narrators };
}

function readCachedSourceLabel(srcPath: string): CoverResolvedSource {
  try {
    if (existsSync(srcPath)) {
      const raw = readFileSync(srcPath, "utf8").trim().toLowerCase();
      if (raw.startsWith("openlibrary")) return "openlibrary";
      if (raw.startsWith("itunes")) return "itunes";
    }
  } catch {}
  return "abs";
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
    lastCoverOutcomes.set(itemId, {
      title: lastCoverOutcomes.get(itemId)?.title ?? itemId,
      found: true,
      source: readCachedSourceLabel(srcPath),
      reason: null,
    });
    return cached;
  }

  if (!deps.retryMissing && readCachedNone(nonePath, nowMs)) {
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
    const target = deps.db
      ? findTitleCoverTargetInDb(deps.db, itemId)
      : (titleCoverRegistry.get(itemId) ?? null);
    const displayTitle = target?.title || itemId;

    if (!coversConfig.external) {
      writeCachedNone(nonePath, nowMs);
      lastCoverOutcomes.set(itemId, {
        title: displayTitle,
        found: false,
        source: null,
        reason: "external covers disabled",
      });
      return null;
    }

    if (!target || !target.title) {
      lastCoverOutcomes.set(itemId, {
        title: displayTitle,
        found: false,
        source: null,
        reason: "no title",
      });
      return null;
    }

    const fetchFn = deps.fetch ?? globalThis.fetch;

    if (target.category === "music") {
      let hadNetworkError = false;
      let notFoundReason = "no match in itunes";
      try {
        const songRes = await searchItunesSong(
          target.title,
          target.creator,
          deps.config,
          fetchFn
        );
        notFoundReason = songRes.reason || "no match in itunes";
        if (songRes.hit !== null) {
          const fetched = await fetchExternalImage(songRes.hit.artworkUrl, fetchFn);
          if (fetched !== null) {
            writeCachedCover(
              imgPath,
              typePath,
              srcPath,
              nonePath,
              fetched,
              `itunes:${songRes.hit.id}`
            );
            lastCoverOutcomes.set(itemId, {
              title: target.title,
              found: true,
              source: "itunes",
              reason: null,
            });
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
      lastCoverOutcomes.set(itemId, {
        title: target.title,
        found: false,
        source: null,
        reason: hadNetworkError ? "network error" : notFoundReason,
      });
      return null;
    }

    const extRes = await resolveExternalBookOrAudiobookCover(
      target.title,
      target.creator ?? "",
      deps,
      imgPath,
      typePath,
      srcPath,
      nonePath
    );
    if (extRes.cover !== null) {
      lastCoverOutcomes.set(itemId, {
        title: target.title,
        found: true,
        source: extRes.source ?? "openlibrary",
        reason: null,
      });
      return extRes.cover;
    }
    if (!extRes.hadNetworkError) {
      writeCachedNone(nonePath, nowMs);
    }
    lastCoverOutcomes.set(itemId, {
      title: target.title,
      found: false,
      source: null,
      reason: extRes.reason,
    });
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
          lastCoverOutcomes.set(itemId, {
            title: itemId,
            found: true,
            source: "abs",
            reason: null,
          });
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
        lastCoverOutcomes.set(itemId, {
          title: itemId,
          found: false,
          source: null,
          reason: "network error",
        });
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
  let knownNarrators: string[] = [];

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
      const extracted = extractAbsMetadataFromRow(row, itemId);
      targetTitle = extracted.title;
      targetAuthor = extracted.author;
      seriesName = extracted.seriesName;
      knownNarrators = extracted.narrators;
    }
  } catch {
    // Best-effort metadata retrieval
  }

  if (!targetTitle) {
    if (!hadNetworkError) {
      writeCachedNone(nonePath, nowMs);
    }
    lastCoverOutcomes.set(itemId, {
      title: itemId,
      found: false,
      source: null,
      reason: "no title",
    });
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
                  lastCoverOutcomes.set(itemId, {
                    title: targetTitle,
                    found: true,
                    source: "abs",
                    reason: null,
                  });
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
    targetTitle,
    targetAuthor,
    deps,
    imgPath,
    typePath,
    srcPath,
    nonePath,
    { seriesName, knownNarrators }
  );
  if (extRes.cover !== null) {
    lastCoverOutcomes.set(itemId, {
      title: targetTitle,
      found: true,
      source: extRes.source ?? "openlibrary",
      reason: null,
    });
    return extRes.cover;
  }
  if (extRes.hadNetworkError) {
    hadNetworkError = true;
  }

  // Definitive "no cover anywhere"
  if (!hadNetworkError) {
    writeCachedNone(nonePath, nowMs);
  }
  lastCoverOutcomes.set(itemId, {
    title: targetTitle,
    found: false,
    source: null,
    reason: hadNetworkError ? "network error" : extRes.reason,
  });

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

export interface BackfillCoverItem {
  id: string;
  title: string;
  found: boolean;
  source: CoverResolvedSource | null;
  reason: string | null;
}

export interface BackfillCoversOptions extends CoverDeps {
  limit?: number;
  onlyCategories?: ReadonlyArray<TitleCoverCategory>;
  /** Report callback invoked once per attempted work in order. */
  onItem?: (item: BackfillCoverItem) => void;
}

export interface BackfillCoversResult {
  attempted: number;
  resolved: number;
  notFound: number;
  items?: BackfillCoverItem[];
}

/**
 * Discover all uncached cover candidates in `db` (Audiobookshelf items without
 * a cached cover, plus music tracks and books/audiobooks without a cover) and
 * resolve up to `limit` of them via `getCover`.
 *
 * Items already known missing on Audiobookshelf (`<id>.abs404`) skip ABS and
 * go straight to the Open Library / iTunes title fallback.
 * When `retryMissing` is true, cached `.none` negative entries are ignored once.
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
  const candidates: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();

  const addCandidate = (id: string, title: string) => {
    if (!isValidCoverId(id) || seen.has(id)) return;
    const { imgPath, typePath, nonePath } = cachePaths(opts.config, id);
    if (readCachedCover(imgPath, typePath) !== null) return;
    if (!opts.retryMissing && readCachedNone(nonePath, nowMs)) return;
    seen.add(id);
    candidates.push({ id, title: title.trim() || id });
  };

  // 1. Audiobookshelf book/audiobook items (never daily_stat or untitled orphan progress rows)
  if (!opts.onlyCategories || opts.onlyCategories.includes("audiobook")) {
    const absRows = db
      .query<
        {
          item: string | null;
          raw: string | null;
          title: string | null;
          parent_title: string | null;
          source_kind: string;
        },
        []
      >(
        `SELECT COALESCE(json_extract(external_ids, '$.abs_item'), source_id) AS item,
                raw, title, parent_title, source_kind
           FROM events_latest
          WHERE source = 'audiobookshelf'
            AND source_kind IN ('listening_session', 'media_progress')
            AND media_type IN ('audiobook', 'book')
          ORDER BY (CASE WHEN source_kind = 'listening_session' THEN 0 ELSE 1 END), id DESC;`
      )
      .all();
    for (const r of absRows) {
      if (!r.item || !isValidCoverId(r.item)) continue;
      const extracted = extractAbsMetadataFromRow(r, r.item);
      if (!extracted.title) continue;
      addCandidate(r.item, extracted.title);
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
       WHERE source_kind != 'daily_stat'
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
    // Skip items that already come from Audiobookshelf or have an ABS/metadata provider id
    if (
      cat !== "music" &&
      (row.source === "audiobookshelf" || ext?.["abs_item"] || ext?.["meta_id"])
    ) {
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
    addCandidate(id, title);
  }

  let attempted = 0;
  let resolved = 0;
  let notFound = 0;

  for (const cand of candidates.slice(0, limit)) {
    attempted += 1;
    const res = await getCover(cand.id, { ...opts, db });
    const outcome = lastCoverOutcomes.get(cand.id);
    const { srcPath } = cachePaths(opts.config, cand.id);
    if (res !== null) {
      resolved += 1;
      opts.onItem?.({
        id: cand.id,
        title: cand.title,
        found: true,
        source: outcome?.source ?? readCachedSourceLabel(srcPath),
        reason: null,
      });
    } else {
      notFound += 1;
      opts.onItem?.({
        id: cand.id,
        title: cand.title,
        found: false,
        source: null,
        reason: outcome?.reason ?? "no match",
      });
    }
  }

  return { attempted, resolved, notFound };
}
