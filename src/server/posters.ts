/**
 * Remote image proxy helper and Simkl poster fetch with an on-disk cache.
 *
 * The `getCachedRemoteImage` helper is source-neutral, so YouTube thumbnails
 * (task Y03) can reuse it. Nothing but image bytes and a normalized `image/*`
 * content type ever leaves this module. Failures are never cached: a missing or
 * unreachable image just means "no image".
 *
 * Cache layout, under a per-source cache directory:
 * - `<key>.img`  — the raw image bytes
 * - `<key>.type` — the normalized content type (e.g. `image/webp`)
 *
 * Simkl posters are fetched directly from `simkl.in` (GET, no auth header, no
 * cookies). No third-party proxy (e.g. wsrv.nl) is ever used, so viewing data
 * never leaks to anyone but Simkl.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../core/config.ts";
import { normalizeImageType } from "./covers.ts";

/** Simkl poster paths look like `74/74415673dcdc9cdd`. */
export const SIMKL_POSTER_RE = /^[0-9a-z]+\/[0-9a-z]+$/;

/** True when `path` is a safe Simkl poster path (no traversal, no uppercase). */
export function isValidSimklPoster(path: unknown): path is string {
  return typeof path === "string" && SIMKL_POSTER_RE.test(path);
}

/** Hard cap on a proxied image body, so a hostile server cannot fill the disk. */
export const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024;

export interface RemoteImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface GetCachedRemoteImageOptions {
  /** Absolute URL to fetch (GET, no auth, no cookies). */
  url: string;
  /** Directory holding `<key>.img` and `<key>.type`. */
  cacheDir: string;
  /** Cache file stem (must already be safe to use as a filename). */
  key: string;
  /** Fetch implementation; injectable so tests never touch the network. */
  fetch: typeof fetch;
  /** Abort the request after this many milliseconds (default 20 s). */
  timeoutMs?: number;
}

function cachePaths(
  cacheDir: string,
  key: string
): { imgPath: string; typePath: string } {
  return {
    imgPath: join(cacheDir, `${key}.img`),
    typePath: join(cacheDir, `${key}.type`),
  };
}

function readCachedImage(
  imgPath: string,
  typePath: string
): RemoteImage | null {
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

function writeCachedImage(
  imgPath: string,
  typePath: string,
  image: RemoteImage
): void {
  try {
    mkdirSync(dirname(imgPath), { recursive: true });
    writeFileSync(imgPath, image.bytes);
    writeFileSync(typePath, image.contentType, "utf8");
  } catch {
    // The cache is best-effort; a write failure must not break the response.
  }
}

/**
 * Return `url` as an image, reading the on-disk cache first and otherwise
 * fetching it once with a plain GET (no auth header, no cookies). Returns
 * `null` for a non-OK response, a non-image content type, an oversized body, or
 * any error/timeout — never caching a failure.
 */
export async function getCachedRemoteImage(
  opts: GetCachedRemoteImageOptions
): Promise<RemoteImage | null> {
  const { url, cacheDir, key, fetch, timeoutMs = 20_000 } = opts;
  const { imgPath, typePath } = cachePaths(cacheDir, key);

  const cached = readCachedImage(imgPath, typePath);
  if (cached !== null) {
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      return null;
    }
    const contentType = normalizeImageType(res.headers.get("content-type"));
    if (contentType === null) {
      return null;
    }
    // Reject an oversized body before buffering it when the size is known.
    const lengthHeader = res.headers.get("content-length");
    if (lengthHeader !== null) {
      const length = Number(lengthHeader);
      if (Number.isFinite(length) && length > MAX_REMOTE_IMAGE_BYTES) {
        return null;
      }
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) {
      return null;
    }
    const image: RemoteImage = { bytes, contentType };
    writeCachedImage(imgPath, typePath, image);
    return image;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `<dirname(db_path)>/posters/simkl`; created lazily on the first cache write. */
export function simklPosterCacheDir(config: Config): string {
  return join(dirname(config.storage.db_path), "posters", "simkl");
}

export interface SimklPosterDeps {
  config: Config;
  /** Injectable fetch; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Fetch a Simkl poster by its path (`74/74415673dcdc9cdd`). Validates the path
 * first, builds `"<poster_base_url>/<path>_m.webp"` and caches under
 * `<dirname(db_path)>/posters/simkl/<path with '/' as '_'>`.
 */
export async function getSimklPoster(
  path: string,
  deps: SimklPosterDeps
): Promise<RemoteImage | null> {
  if (!isValidSimklPoster(path)) {
    return null;
  }
  const base = String(deps.config.simkl.poster_base_url ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (base === "") {
    return null;
  }
  return getCachedRemoteImage({
    url: `${base}/${path}_m.webp`,
    cacheDir: simklPosterCacheDir(deps.config),
    key: path.replace(/\//g, "_"),
    fetch: deps.fetch ?? fetch,
    timeoutMs: (deps.config.simkl.timeout_s ?? 20) * 1000,
  });
}
