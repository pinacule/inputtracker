/**
 * Audiobookshelf API client (GET-only).
 *
 * Enforces GET-only access, Bearer auth, path allow-listing, timeout handling,
 * retries on 5xx server errors, typed SourceUnavailable error on host unreachability,
 * and secret token redaction so tokens never appear in logs or error messages.
 */

import type { AudiobookshelfConfig, Config } from "../../core/config.ts";
import { redact } from "../../core/config.ts";

/**
 * Thrown when the host is unreachable (fetch rejects / timeout / connection refused)
 * or still 5xx after retries.
 */
export class SourceUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceUnavailable";
  }
}

export type AbsClientConfig =
  | Config["audiobookshelf"]
  | { audiobookshelf: Config["audiobookshelf"] };

export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface AbsClientOptions {
  fetch?: typeof fetch | FetchFn;
  retries?: number;
  retryDelayMs?: number;
}

export interface AbsBinaryResponse {
  bytes: Uint8Array;
  contentType: string;
}

export interface AbsListeningSessionsResponse {
  total?: number;
  numPages?: number;
  page?: number;
  itemsPerPage?: number;
  sessions?: unknown[];
}

export interface AbsClient {
  get<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
  getBinary(path: string): Promise<AbsBinaryResponse>;
  getAllSessions<T = unknown>(itemsPerPage?: number): Promise<T[]>;
  fetchAllSessions<T = unknown>(itemsPerPage?: number): Promise<T[]>;
}

const EXACT_PATHS = new Set([
  "/api/me",
  "/api/me/listening-sessions",
  "/api/me/listening-stats",
  "/api/libraries",
]);

const ITEM_COVER_RE = /^\/api\/items\/[A-Za-z0-9_-]+\/cover$/;
const LIBRARY_SEARCH_RE = /^\/api\/libraries\/[A-Za-z0-9_-]+\/search$/;

interface ParsedPath {
  cleanPath: string;
  inlineQuery?: string;
}

function validatePath(path: string, token: string, coverOnly = false): ParsedPath {
  if (path.includes("#")) {
    const safePath = maskSecret(path, token);
    throw new Error(`Path "${safePath}" contains forbidden fragment identifier`);
  }

  // Check exact path before query parameters
  const [cleanPath, inlineQuery] = path.split("?");
  const isCover = ITEM_COVER_RE.test(cleanPath);
  const isLibrarySearch = LIBRARY_SEARCH_RE.test(cleanPath);

  if (coverOnly) {
    if (!isCover) {
      const safePath = maskSecret(cleanPath, token);
      throw new Error(`Path "${safePath}" is not allowed for binary download (covers only)`);
    }
    return { cleanPath, inlineQuery };
  }

  if (!EXACT_PATHS.has(cleanPath) && !isCover && !isLibrarySearch) {
    const safePath = maskSecret(cleanPath, token);
    throw new Error(`Path "${safePath}" is not in the allow-list`);
  }

  return { cleanPath, inlineQuery };
}

function maskSecret(text: string, token: string): string {
  let masked = text;
  if (token && token.trim() !== "") {
    masked = masked.split(token).join("***");
  }
  return redact(masked);
}

function extractAbsConfig(cfg: AbsClientConfig): AudiobookshelfConfig {
  if ("audiobookshelf" in cfg && cfg.audiobookshelf) {
    return cfg.audiobookshelf;
  }
  return cfg as AudiobookshelfConfig;
}

/**
 * Creates a GET-only Audiobookshelf client with allow-listed paths,
 * Bearer authentication, timeout and 5xx retry handling.
 */
export function createAbsClient(
  cfg: AbsClientConfig,
  opts?: AbsClientOptions
): AbsClient {
  const absCfg = extractAbsConfig(cfg);
  const baseUrl = (absCfg.url || "http://localhost:13378").replace(/\/+$/, "");
  const token = absCfg.token ?? "";
  const timeout_s = absCfg.timeout_s ?? 20;

  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const maxRetries = Math.max(0, opts?.retries ?? 2);
  const retryDelayMs = Math.max(0, opts?.retryDelayMs ?? 100);

  function buildUrl(
    cleanPath: string,
    inlineQuery?: string,
    query?: Record<string, string | number | boolean>
  ): URL {
    const url = new URL(`${baseUrl}${cleanPath}`);
    if (inlineQuery) {
      const inlineParams = new URLSearchParams(inlineQuery);
      for (const [k, v] of inlineParams) {
        url.searchParams.set(k, v);
      }
    }
    if (query) {
      for (const [key, val] of Object.entries(query)) {
        if (val !== undefined && val !== null) {
          url.searchParams.set(key, String(val));
        }
      }
    }
    return url;
  }

  async function executeGet(
    path: string,
    coverOnly: boolean,
    query?: Record<string, string | number | boolean>
  ): Promise<Response> {
    const { cleanPath, inlineQuery } = validatePath(path, token, coverOnly);
    const targetUrl = buildUrl(cleanPath, inlineQuery, query);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutMs = timeout_s * 1000;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timeoutId = setTimeout(() => {
          controller.abort(
            new DOMException(`Request timed out after ${timeout_s}s`, "TimeoutError")
          );
        }, timeoutMs);
      }

      let response: Response;
      try {
        response = await fetchFn(targetUrl.toString(), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof Error &&
            (err.name === "AbortError" || err.name === "TimeoutError"))
        ) {
          throw new SourceUnavailable(`Request timed out after ${timeout_s}s`);
        }
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = maskSecret(rawMsg, token);
        // Do not attach unredacted err as cause to prevent secret leaks via err.cause
        throw new SourceUnavailable(`Audiobookshelf unreachable: ${msg}`);
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }

      if (response.ok) {
        return response;
      }

      if (response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status}: ${response.statusText || "Client Error"}`);
      }

      if (response.status >= 500 && response.status < 600) {
        if (attempt < maxRetries) {
          try {
            await response.text();
          } catch {
            // ignore drain errors
          }
          if (retryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
          continue;
        }

        throw new SourceUnavailable(
          `HTTP ${response.status}: Audiobookshelf server error after ${maxRetries} ${maxRetries === 1 ? "retry" : "retries"}`
        );
      }

      throw new Error(`HTTP ${response.status}: ${response.statusText || "Unexpected Status"}`);
    }

    throw new SourceUnavailable(
      `Audiobookshelf server error after ${maxRetries} ${maxRetries === 1 ? "retry" : "retries"}`
    );
  }

  async function get<T>(
    path: string,
    query?: Record<string, string | number | boolean>
  ): Promise<T> {
    const response = await executeGet(path, false, query);
    try {
      return (await response.json()) as T;
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = maskSecret(rawMsg, token);
      throw new Error(`Failed to parse Audiobookshelf JSON: ${msg}`);
    }
  }

  async function getBinary(path: string): Promise<AbsBinaryResponse> {
    const response = await executeGet(path, true);
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    return { bytes, contentType };
  }

  const client: AbsClient = {
    get,
    getBinary,
    getAllSessions: <T = unknown>(itemsPerPage = 100) =>
      fetchAllSessions<T>(client, itemsPerPage),
    fetchAllSessions: <T = unknown>(itemsPerPage = 100) =>
      fetchAllSessions<T>(client, itemsPerPage),
  };

  return client;
}

/**
 * Loops GET /api/me/listening-sessions?itemsPerPage=N&page=P (0-based)
 * until page >= numPages - 1; returns all sessions concatenated.
 */
export async function fetchAllSessions<T = unknown>(
  client: Pick<AbsClient, "get">,
  itemsPerPage = 100
): Promise<T[]> {
  const allSessions: T[] = [];
  let page = 0;

  while (true) {
    const res = await client.get<AbsListeningSessionsResponse>(
      "/api/me/listening-sessions",
      { itemsPerPage, page }
    );

    const sessions = Array.isArray(res?.sessions) ? (res.sessions as T[]) : [];
    allSessions.push(...sessions);

    const numPages = res?.numPages ?? 1;
    if (page >= numPages - 1 || sessions.length === 0) {
      break;
    }
    page++;
  }

  return allSessions;
}

export const getAllSessions = fetchAllSessions;
