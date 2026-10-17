/**
 * Audiobookshelf cover proxy with an on-disk cache.
 *
 * The ABS token and base URL never reach the browser: callers only ever see
 * image bytes plus a plain `image/<subtype>` content type. Covers are fetched
 * through the GET-only ABS client (never `fetch` directly), so the client's
 * path allow-list still applies.
 *
 * Cache layout, under `<dirname(db_path)>/covers/`:
 * - `<itemId>.img`  — the raw image bytes
 * - `<itemId>.type` — the normalized content type (e.g. `image/jpeg`)
 *
 * Failures are never cached: a missing/unreachable ABS just means "no cover".
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../core/config.ts";
import {
  type AbsBinaryResponse,
  createAbsClient,
} from "../sources/audiobookshelf/client.ts";
import type { SyncClient } from "../sources/audiobookshelf/sync.ts";

/** Library-item ids we are willing to turn into a filename and ABS path. */
export const COVER_ID_RE = /^[A-Za-z0-9_-]+$/;

/** The ABS client subset a cover fetch needs (easy to fake in tests). */
export interface CoverClient {
  getBinary(path: string): Promise<AbsBinaryResponse>;
}

/**
 * ABS client factory accepted by `getCover`. The real `createAbsClient`
 * satisfies it, and so does the narrower `SyncClient`-returning factory that
 * `AppDeps` exposes (whose `getBinary` is optional here).
 */
export type CoverClientFactory = (
  config: Config
) => SyncClient & Partial<CoverClient>;

export interface CoverDeps {
  config: Config;
  /** Injectable ABS client factory; defaults to the real GET-only client. */
  createAbsClient?: CoverClientFactory;
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
 * Normalize an ABS content-type to a bare `image/<subtype>` media type.
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

function cachePaths(
  config: Config,
  itemId: string
): { imgPath: string; typePath: string } {
  const dir = coverCacheDir(config);
  return {
    imgPath: join(dir, `${itemId}.img`),
    typePath: join(dir, `${itemId}.type`),
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

function writeCachedCover(
  imgPath: string,
  typePath: string,
  cover: CoverResult
): void {
  try {
    mkdirSync(dirname(imgPath), { recursive: true });
    writeFileSync(imgPath, cover.bytes);
    writeFileSync(typePath, cover.contentType, "utf8");
  } catch {
    // The cache is best-effort; a write failure must not break the response.
  }
}

/**
 * Return the cover for `itemId`, reading the on-disk cache first and otherwise
 * fetching it once from Audiobookshelf. Returns `null` for an invalid id, a
 * non-image response, or any ABS error/timeout — never caching a failure.
 */
export async function getCover(
  itemId: string,
  deps: CoverDeps
): Promise<CoverResult | null> {
  if (!isValidCoverId(itemId)) {
    return null;
  }

  const { imgPath, typePath } = cachePaths(deps.config, itemId);

  const cached = readCachedCover(imgPath, typePath);
  if (cached !== null) {
    return cached;
  }

  const factory: CoverClientFactory =
    deps.createAbsClient ?? ((cfg) => createAbsClient(cfg));

  let fetched: AbsBinaryResponse;
  try {
    const client = factory(deps.config);
    if (typeof client.getBinary !== "function") {
      return null;
    }
    fetched = await client.getBinary(`/api/items/${itemId}/cover`);
  } catch {
    // ABS offline / SourceUnavailable / 404 / bad response: no cover, no cache.
    return null;
  }

  const contentType = normalizeImageType(fetched?.contentType);
  if (contentType === null) {
    return null;
  }

  const bytes =
    fetched.bytes instanceof Uint8Array ? fetched.bytes : new Uint8Array();

  const cover: CoverResult = { bytes, contentType };
  writeCachedCover(imgPath, typePath, cover);
  return cover;
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
      if ((await getCover(itemId, deps)) !== null) available += 1;
    }
  } catch {
    // Covers are a nicety; a failure here must never affect the sync.
  }
  return available;
}
