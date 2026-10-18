/**
 * Open Library client for fallback cover lookups.
 *
 * Rules:
 * - GET requests only, using an injectable fetch function.
 * - Base URLs from config: `covers.openlibrary_url` (default https://openlibrary.org)
 *   and `covers.openlibrary_covers_url` (default https://covers.openlibrary.org).
 * - Concurrency capped at 2 external requests, 10 s timeout per request.
 * - Only valid image content types accepted (via normalizeImageType), max 5 MB.
 * - Server errors (5xx) and timeouts throw so the caller never caches them as .none.
 */

import { normalizeForSearch } from "./search.ts";
import { normalizeImageType } from "./covers.ts";

export const OPEN_LIBRARY_TIMEOUT_MS = 10_000;
export const OPEN_LIBRARY_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(public readonly maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.active--;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}

export const defaultOpenLibraryLimiter = new Limiter(2);

/**
 * One GET through the limiter. The timeout and the concurrency slot cover the
 * whole exchange, body included, so a slow body can neither hang a cover
 * request nor hold a slot past `timeoutMs`.
 */
function timedGet<T>(
  fetchFn: typeof fetch,
  url: string,
  limiter: Limiter,
  timeoutMs: number,
  read: (response: Response) => Promise<T>
): Promise<T> {
  return limiter.run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Open Library request timed out", "TimeoutError"));
    }, timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "GET",
        signal: controller.signal,
      });
      return await read(response);
    } finally {
      clearTimeout(timer);
    }
  });
}

export interface OpenLibrarySearchOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  limiter?: Limiter;
  timeoutMs?: number;
}

export interface OpenLibraryCoverOptions {
  fetch?: typeof fetch;
  coversBaseUrl?: string;
  limiter?: Limiter;
  timeoutMs?: number;
}

/**
 * True when the first listed author's surname (last word, normalized) is a word
 * of one of the doc's `author_name` entries. Open Library's `author` query is
 * fuzzy and author strings vary ("Alfred Lansing", "Lansing, Alfred", "A. Lansing"),
 * so the surname is the reliable part. No target author never matches.
 */
function authorWords(name: string): string[] {
  return normalizeForSearch(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

export function authorMatches(author: string | undefined, docAuthors: unknown): boolean {
  const first = (author ?? "").split(/,|&|;|\band\b/i)[0] ?? "";
  const words = authorWords(first);
  const surname = words[words.length - 1];
  if (surname === undefined || !Array.isArray(docAuthors)) {
    return false;
  }
  return docAuthors.some(
    (name) =>
      typeof name === "string" &&
      authorWords(name).includes(surname)
  );
}

/**
 * Search Open Library for a book with matching title (and author if given).
 * Returns the cover_i integer ID of the first doc with a cover_i whose
 * normalized title matches, or null if no match found.
 * Throws on 5xx or timeout.
 */
export async function searchOpenLibrary(
  title: string,
  author: string | undefined,
  options: OpenLibrarySearchOptions = {}
): Promise<number | null> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "https://openlibrary.org").replace(/\/+$/, "");
  const limiter = options.limiter ?? defaultOpenLibraryLimiter;
  const timeoutMs = options.timeoutMs ?? OPEN_LIBRARY_TIMEOUT_MS;

  const url = new URL(`${baseUrl}/search.json`);
  url.searchParams.set("title", title);
  if (author && author.trim()) {
    url.searchParams.set("author", author.trim());
  }
  url.searchParams.set("limit", "5");
  url.searchParams.set("fields", "key,title,author_name,cover_i");

  return timedGet(fetchFn, url.toString(), limiter, timeoutMs, async (response) => {
    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error(`Open Library server error: HTTP ${response.status}`);
      }
      return null;
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err) {
      throw new Error(`Failed to parse Open Library JSON: ${err}`);
    }

    const docs = Array.isArray(data?.docs) ? data.docs : [];
    const normalizedQueryTitle = normalizeForSearch(title);

    for (const doc of docs) {
      if (typeof doc?.cover_i === "number" && doc.cover_i > 0) {
        if (
          typeof doc.title === "string" &&
          normalizeForSearch(doc.title) === normalizedQueryTitle &&
          authorMatches(author, doc.author_name)
        ) {
          return doc.cover_i;
        }
      }
    }

    return null;
  });
}

/**
 * Fetch a cover image from Open Library by cover_i ID.
 * Returns bytes and normalized content type, or null if 404, non-image or > 5 MB.
 * Throws on 5xx or timeout.
 */
export async function fetchOpenLibraryCover(
  coverId: number,
  options: OpenLibraryCoverOptions = {}
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const coversBaseUrl = (options.coversBaseUrl ?? "https://covers.openlibrary.org").replace(/\/+$/, "");
  const limiter = options.limiter ?? defaultOpenLibraryLimiter;
  const timeoutMs = options.timeoutMs ?? OPEN_LIBRARY_TIMEOUT_MS;

  const url = `${coversBaseUrl}/b/id/${coverId}-M.jpg`;

  return timedGet(fetchFn, url, limiter, timeoutMs, async (response) => {
    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error(`Open Library server error: HTTP ${response.status}`);
      }
      return null;
    }

    const rawContentType = response.headers.get("content-type");
    const contentType = normalizeImageType(rawContentType);
    if (contentType === null) {
      // Non-image response rejected
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
  });
}
