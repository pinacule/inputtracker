/**
 * HTTP helpers with concurrency limiting and timeouts for metadata providers.
 *
 * Follows the same pattern as `Limiter` and `timedGet` in `src/server/openlibrary.ts`.
 * Every request is GET except AniList's read-only GraphQL query (POST by protocol).
 */

import { normalizeImageType } from "../covers.ts";
import { Limiter } from "../openlibrary.ts";
import { type MetaProvider, type ProviderContext, ProviderError } from "./types.ts";

export { Limiter };

/** Default per-provider request timeout: 8 seconds (per docs/v2-spec.md). */
export const METADATA_TIMEOUT_MS = 8_000;

/** Maximum allowed size for a metadata cover image: 5 MB. */
export const MAX_META_COVER_BYTES = 5 * 1024 * 1024;

export const defaultMetadataLimiter = new Limiter(4);

export interface RemoteImageResult {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Execute one HTTP request through the concurrency limiter with a timeout that
 * covers both the connection and reading the body.
 */
export function timedRequest<T>(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  limiter: Limiter,
  timeoutMs: number,
  read: (response: Response) => Promise<T>
): Promise<T> {
  return limiter.run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Metadata provider request timed out", "TimeoutError"));
    }, timeoutMs);
    try {
      const response = await fetchFn(url, {
        ...init,
        signal: controller.signal,
      });
      return await read(response);
    } finally {
      clearTimeout(timer);
    }
  });
}

/**
 * Perform a GET (or POST for AniList GraphQL) and parse JSON.
 * - Returns `{ status: 404, data: null }` on HTTP 404.
 * - Throws `ProviderError` on timeout, network error, non-OK status (5xx, 401, 403, 429, 400), or invalid JSON.
 */
export async function fetchProviderJson<T = any>(
  ctx: ProviderContext,
  provider: MetaProvider,
  url: string,
  init: RequestInit = { method: "GET" }
): Promise<{ status: number; data: T | null }> {
  try {
    return await timedRequest(
      ctx.fetch,
      url,
      init,
      ctx.limiter,
      ctx.timeoutMs,
      async (response) => {
        if (response.status === 404) {
          return { status: 404, data: null };
        }
        if (!response.ok) {
          throw new ProviderError(
            provider,
            `${provider} HTTP ${response.status}`,
            response.status
          );
        }
        let data: T;
        try {
          data = (await response.json()) as T;
        } catch (err) {
          throw new ProviderError(
            provider,
            `Failed to parse ${provider} JSON: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return { status: response.status, data };
      }
    );
  } catch (err) {
    if (err instanceof ProviderError) {
      throw err;
    }
    throw new ProviderError(
      provider,
      `${provider} request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Fetch an image with GET, validating `image/*` content-type and <= 5 MB size.
 * Returns `null` if non-OK, non-image, empty, oversized, or network error.
 */
export async function fetchRemoteCoverImage(
  ctx: ProviderContext,
  url: string
): Promise<RemoteImageResult | null> {
  try {
    return await timedRequest(
      ctx.fetch,
      url,
      { method: "GET" },
      ctx.limiter,
      ctx.timeoutMs,
      async (response) => {
        if (!response.ok) {
          return null;
        }
        return readValidatedImageResponse(response);
      }
    );
  } catch {
    return null;
  }
}

/**
 * Validate and read an HTTP `Response` as an image (normalized `image/*` type,
 * non-empty, at most 5 MB).
 */
export async function readValidatedImageResponse(
  response: Response
): Promise<RemoteImageResult | null> {
  const contentType = normalizeImageType(response.headers.get("content-type"));
  if (contentType === null) {
    return null;
  }
  const clHeader = response.headers.get("content-length");
  if (clHeader !== null) {
    const length = Number(clHeader);
    if (Number.isFinite(length) && length > MAX_META_COVER_BYTES) {
      return null;
    }
  }
  const buf = await response.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_META_COVER_BYTES) {
    return null;
  }
  return {
    bytes: new Uint8Array(buf),
    contentType,
  };
}
