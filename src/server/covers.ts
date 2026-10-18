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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../core/config.ts";
import {
  type AbsBinaryResponse,
  createAbsClient,
  SourceUnavailable,
} from "../sources/audiobookshelf/client.ts";
import type { SyncClient } from "../sources/audiobookshelf/sync.ts";
import { normalizeForSearch } from "./search.ts";
import { fetchOpenLibraryCover, searchOpenLibrary } from "./openlibrary.ts";

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

  let hadNetworkError = false;

  const factory: CoverClientFactory =
    deps.createAbsClient ?? ((cfg) => createAbsClient(cfg));

  // --- Step 1: ABS /api/items/<id>/cover ---
  if (!readCachedAbsMiss(absMissPath, nowMs)) {
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

  // --- Step 2: Same book in current ABS library ---
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

  // --- Step 3: Open Library ---
  const coversConfig = deps.config.covers ?? {
    external: true,
    openlibrary_url: "https://openlibrary.org",
    openlibrary_covers_url: "https://covers.openlibrary.org",
  };

  // A title alone is too generic to trust ("Focus" matched an unrelated book),
  // so Open Library is only asked when the author is known.
  if (coversConfig.external && targetAuthor !== "") {
    for (const titleCandidate of titleCandidates) {
      try {
        const coverId = await searchOpenLibrary(titleCandidate, targetAuthor, {
          fetch: deps.fetch,
          baseUrl: coversConfig.openlibrary_url,
        });

        if (coverId !== null) {
          const fetched = await fetchOpenLibraryCover(coverId, {
            fetch: deps.fetch,
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
            return fetched;
          }
        }
      } catch (err) {
        if (isNetworkOrServerError(err)) {
          hadNetworkError = true;
        }
      }
    }
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
