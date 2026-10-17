/**
 * YouTube video thumbnail proxy with an on-disk cache.
 *
 * Reuses the source-neutral `getCachedRemoteImage` helper from `posters.ts`, so
 * the same guarantees hold: a plain GET with no auth header and no cookies, only
 * `image/*` content types, a 5 MB cap, a timeout that returns "no image", and
 * failures are never cached. No third-party proxy is used.
 *
 * Cache layout, under `<dirname(db_path)>/thumbs/youtube/`:
 * - `<videoId>.img`  — the raw image bytes
 * - `<videoId>.type` — the normalized content type (e.g. `image/jpeg`)
 */

import { dirname, join } from "node:path";
import type { Config } from "../core/config.ts";
import { getCachedRemoteImage, type RemoteImage } from "./posters.ts";

/** YouTube video ids are always 11 URL-safe base64 characters. */
export const YOUTUBE_VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;

/** True when `id` is a safe YouTube video id (also usable as a cache filename). */
export function isValidYoutubeVideoId(id: unknown): id is string {
  return typeof id === "string" && YOUTUBE_VIDEO_RE.test(id);
}

/** `<dirname(db_path)>/thumbs/youtube`; created lazily on the first cache write. */
export function youtubeThumbCacheDir(config: Config): string {
  return join(dirname(config.storage.db_path), "thumbs", "youtube");
}

export interface YoutubeThumbDeps {
  config: Config;
  /** Injectable fetch; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Fetch a YouTube thumbnail by its video id. Validates the id first, builds
 * `"<thumb_base_url without trailing slash>/<videoId>/mqdefault.jpg"` and caches
 * under `<dirname(db_path)>/thumbs/youtube/<videoId>`.
 */
export async function getYoutubeThumb(
  videoId: string,
  deps: YoutubeThumbDeps
): Promise<RemoteImage | null> {
  if (!isValidYoutubeVideoId(videoId)) {
    return null;
  }
  const base = String(deps.config.youtube?.thumb_base_url ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (base === "") {
    return null;
  }
  return getCachedRemoteImage({
    url: `${base}/${videoId}/mqdefault.jpg`,
    cacheDir: youtubeThumbCacheDir(deps.config),
    key: videoId,
    fetch: deps.fetch ?? fetch,
  });
}
