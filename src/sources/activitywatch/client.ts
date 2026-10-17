/**
 * ActivityWatch API client (GET-only).
 *
 * Enforces GET-only access to local ActivityWatch REST endpoints with
 * timeout handling, injectable fetch, and sanitized error messages that
 * never contain URL query strings.
 */

import type { ActivityWatchConfig, Config } from "../../core/config.ts";
import type { AwBucket, AwRawEvent } from "./types.ts";

export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface ActivityWatchClientOptions {
  fetch?: typeof fetch | FetchFn;
}

export interface ActivityWatchClient {
  getBuckets(): Promise<Record<string, AwBucket>>;
  getEvents(bucketId: string, startIso: string, endIso: string): Promise<AwRawEvent[]>;
  get<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
}

export type ActivityWatchClientConfig =
  | ActivityWatchConfig
  | Partial<ActivityWatchConfig>
  | undefined
  | Config["activitywatch"]
  | { activitywatch?: ActivityWatchConfig };

function extractConfig(
  cfg?: ActivityWatchClientConfig
): Partial<ActivityWatchConfig> {
  if (!cfg) return {};
  if ("activitywatch" in cfg && cfg.activitywatch) {
    return cfg.activitywatch;
  }
  return cfg as Partial<ActivityWatchConfig>;
}

export function createActivityWatchClient(
  cfg?: ActivityWatchClientConfig,
  opts?: ActivityWatchClientOptions
): ActivityWatchClient {
  const awCfg = extractConfig(cfg);
  const baseUrl = (awCfg.url || "http://127.0.0.1:5600").replace(/\/+$/, "");
  const timeout_s = awCfg.timeout_s ?? 20;
  const fetchFn = opts?.fetch ?? globalThis.fetch;

  async function executeGet(
    path: string,
    query?: Record<string, string | number | boolean>
  ): Promise<Response> {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${baseUrl}${cleanPath}`);

    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const controller = new AbortController();
    const timeoutMs = timeout_s * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        controller.abort(new DOMException(`Timeout after ${timeout_s}s`, "TimeoutError"));
      }, timeoutMs);
    }

    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });
    } catch {
      // ActivityWatch unreachable on connection error or timeout; error message
      // contains no URL query strings.
      throw new Error("activitywatch unreachable");
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (!response.ok) {
      // Short error message containing status code and no URL query strings.
      throw new Error(`activitywatch HTTP ${response.status}`);
    }

    return response;
  }

  async function get<T>(
    path: string,
    query?: Record<string, string | number | boolean>
  ): Promise<T> {
    const response = await executeGet(path, query);
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error("activitywatch unreachable");
    }
  }

  async function getBuckets(): Promise<Record<string, AwBucket>> {
    return await get<Record<string, AwBucket>>("/api/0/buckets/");
  }

  async function getEvents(
    bucketId: string,
    startIso: string,
    endIso: string
  ): Promise<AwRawEvent[]> {
    const encodedBucket = encodeURIComponent(bucketId);
    return await get<AwRawEvent[]>(`/api/0/buckets/${encodedBucket}/events`, {
      start: startIso,
      end: endIso,
      limit: -1,
    });
  }

  return {
    getBuckets,
    getEvents,
    get,
  };
}
