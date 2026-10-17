/**
 * Simkl API client.
 *
 * Security rules:
 * - Data calls are GET only. The only POSTs allowed are /oauth2/device and /oauth2/token.
 * - Enforces method + path allow-list before calling fetch; anything else throws.
 * - Never writes to the user's Simkl account.
 * - Access token, refresh token and device_code are secrets: they must never appear
 *   in error messages, logs, or string representations.
 */

import { APP_VERSION } from "../../core/version.ts";
import type { Config, SimklConfig } from "../../core/config.ts";
import { SourceUnavailable } from "../audiobookshelf/client.ts";
import {
  createStoredToken,
  readSimklToken,
  writeSimklToken,
  type SimklToken,
  type SimklTokenResponse,
} from "./token.ts";

export { SourceUnavailable } from "../audiobookshelf/client.ts";

/**
 * Thrown when Simkl rate limits requests.
 * user_limit_exceeded (daily quota) specifies retryAfterSeconds.
 */
export class SimklLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message?: string) {
    super(message ?? `Simkl rate limit exceeded: retry after ${retryAfterSeconds}s`);
    this.name = "SimklLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown on 4xx API errors (e.g. 400 max_items).
 */
export class SimklApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? `Simkl API error ${status}: ${code}`);
    this.name = "SimklApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Thrown when authorization fails or is revoked.
 */
export class SimklAuthError extends Error {
  constructor(message = "Simkl authorisation expired or revoked: run 'it auth simkl' again") {
    super(message);
    this.name = "SimklAuthError";
  }
}

export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface SimklClientDeps {
  fetch?: typeof fetch | FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  tokenPath?: string;
  readToken?: () => SimklToken | null;
  writeToken?: (token: SimklToken) => void;
}

export interface SimklDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type SimklPollResult =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "invalid_client" }
  | { kind: "success"; token: SimklTokenResponse };

export interface SimklClient {
  get<T = unknown>(path: string, query?: Record<string, string | number | boolean>): Promise<T>;
  requestDeviceCode(): Promise<SimklDeviceCodeResponse>;
  pollToken(deviceCode: string): Promise<SimklPollResult>;
  refreshToken(refreshToken: string): Promise<SimklToken>;
}

const ALLOWED_TYPES = new Set(["shows", "movies", "anime"]);
const ALLOWED_STATUSES = new Set([
  "watching",
  "plantowatch",
  "hold",
  "completed",
  "dropped",
]);

interface ParsedPath {
  cleanPath: string;
  inlineQuery?: string;
}

function validateMethodAndPath(method: string, path: string): ParsedPath {
  if (path.includes("#")) {
    throw new Error(`Path contains forbidden fragment identifier`);
  }
  if (path.includes("..") || path.includes("\\")) {
    throw new Error(`Path contains forbidden traversal`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`Path must be an absolute path starting with /`);
  }
  if (path.startsWith("//")) {
    throw new Error(`Path contains forbidden double slash`);
  }

  if (method === "POST") {
    const [cleanPath, inlineQuery] = path.split("?");
    if (cleanPath === "/oauth2/device" || cleanPath === "/oauth2/token") {
      return { cleanPath, inlineQuery };
    }
    throw new Error(`POST method not allowed for path "${cleanPath}"`);
  }

  if (method === "GET") {
    if (path.includes("?")) {
      throw new Error(`Path must not contain query parameters; pass them via query argument`);
    }

    const cleanPath = path;

    if (cleanPath === "/sync/activities" || cleanPath === "/sync/all-items") {
      return { cleanPath };
    }

    const allItemsPrefix = "/sync/all-items/";
    if (cleanPath.startsWith(allItemsPrefix)) {
      const rest = cleanPath.slice(allItemsPrefix.length).split("/");
      if (rest.length === 1 && ALLOWED_TYPES.has(rest[0])) {
        return { cleanPath };
      }
      if (rest.length === 2 && ALLOWED_TYPES.has(rest[0]) && ALLOWED_STATUSES.has(rest[1])) {
        return { cleanPath };
      }
    }

    throw new Error(`GET path "${cleanPath}" is not in the allow-list`);
  }

  throw new Error(`HTTP method "${method}" is not allowed`);
}

function sanitizeError(msg: string, secrets: string[]): string {
  let result = msg;
  for (const s of secrets) {
    if (s && s.length > 0) {
      result = result.split(s).join("***");
    }
  }
  return result;
}

export function createSimklClient(
  cfg: SimklConfig,
  deps: SimklClientDeps = {}
): SimklClient {
  const clientId = cfg.client_id.trim();
  const baseUrl = (cfg.base_url || "https://api.simkl.com").replace(/\/+$/, "");
  const timeout_s = cfg.timeout_s;

  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleepFn =
    deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowFn = deps.now ?? (() => Date.now());

  const readToken =
    deps.readToken ??
    (deps.tokenPath ? () => readSimklToken(deps.tokenPath!) : () => null);
  const writeToken =
    deps.writeToken ??
    (deps.tokenPath ? (t: SimklToken) => writeSimklToken(deps.tokenPath!, t) : () => {});

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
      for (const [k, v] of Object.entries(query)) {
        if (
          k !== "client_id" &&
          k !== "app-name" &&
          k !== "app-version" &&
          v !== undefined &&
          v !== null
        ) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    // Set mandatory params after query so query cannot override them
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("app-name", "inputtracker");
    url.searchParams.set("app-version", APP_VERSION);

    return url;
  }

  async function executeRequest(
    method: "GET" | "POST",
    path: string,
    options: {
      body?: string;
      accessToken?: string;
      query?: Record<string, string | number | boolean>;
      secrets?: string[];
    } = {}
  ): Promise<Response> {
    const { cleanPath, inlineQuery } = validateMethodAndPath(method, path);
    const targetUrl = buildUrl(cleanPath, inlineQuery, options.query);
    const secrets = options.secrets ?? [];
    if (options.accessToken) {
      secrets.push(options.accessToken);
    }

    const maxRetries = 2;
    let rateLimitRetried = false;

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

      const headers: Record<string, string> = {
        "User-Agent": `inputtracker/${APP_VERSION}`,
      };

      if (method === "POST") {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }

      if (cleanPath.startsWith("/sync/") && options.accessToken) {
        headers["Authorization"] = `Bearer ${options.accessToken}`;
      }

      let response: Response;
      try {
        response = await fetchFn(targetUrl.toString(), {
          method,
          headers,
          body: options.body,
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
        const safeMsg = sanitizeError(rawMsg, secrets);
        throw new SourceUnavailable(`Simkl unreachable: ${safeMsg}`);
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }

      if (response.status === 429) {
        let bodyJson: { error?: string } = {};
        try {
          bodyJson = (await response.json()) as { error?: string };
        } catch {
          // ignore parse error
        }

        if (bodyJson.error === "user_limit_exceeded") {
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfter = retryAfterHeader ? Number(retryAfterHeader) || 60 : 60;
          throw new SimklLimitError(retryAfter);
        }

        if (bodyJson.error === "rate_limit") {
          if (!rateLimitRetried) {
            rateLimitRetried = true;
            await sleepFn(1000);
            attempt--; // Do not count 429 against 5xx retry budget
            continue;
          }
        }

        throw new SimklApiError(429, bodyJson.error || "rate_limit");
      }

      if (response.status >= 500 && response.status < 600) {
        if (attempt < maxRetries) {
          try {
            await response.text();
          } catch {
            // ignore drain errors
          }
          await sleepFn(100 * (attempt + 1));
          continue;
        }

        throw new SourceUnavailable(
          `HTTP ${response.status}: Simkl server error after ${maxRetries} retries`
        );
      }

      return response;
    }

    throw new SourceUnavailable(
      `Simkl server error after ${maxRetries} retries`
    );
  }

  async function requestDeviceCode(): Promise<SimklDeviceCodeResponse> {
    const body = new URLSearchParams({
      client_id: clientId,
      scope: "media:read",
    }).toString();

    const response = await executeRequest("POST", "/oauth2/device", { body });
    if (!response.ok) {
      let code = response.statusText || "Error";
      try {
        const json = (await response.json()) as { error?: string };
        if (json.error) code = json.error;
      } catch {}
      throw new SimklApiError(response.status, code);
    }

    try {
      return (await response.json()) as SimklDeviceCodeResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse Simkl device response: ${msg}`);
    }
  }

  async function pollToken(deviceCode: string): Promise<SimklPollResult> {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: deviceCode,
    }).toString();

    const response = await executeRequest("POST", "/oauth2/token", {
      body,
      secrets: [deviceCode],
    });

    if (response.ok) {
      try {
        const data = (await response.json()) as SimklTokenResponse;
        return { kind: "success", token: data };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse Simkl token response: ${msg}`);
      }
    }

    let errorStr = "";
    try {
      const data = (await response.json()) as { error?: string };
      if (data && typeof data.error === "string") {
        errorStr = data.error;
      }
    } catch {}

    if (response.status === 400) {
      if (errorStr === "authorization_pending") {
        return { kind: "pending" };
      }
      if (errorStr === "slow_down") {
        return { kind: "slow_down" };
      }
      if (errorStr === "expired_token") {
        return { kind: "expired" };
      }
      throw new SimklApiError(400, errorStr || "Bad Request");
    }

    if (response.status === 401) {
      if (errorStr === "invalid_client") {
        return { kind: "invalid_client" };
      }
      throw new SimklApiError(401, errorStr || "Unauthorized");
    }

    throw new SimklApiError(response.status, errorStr || response.statusText);
  }

  async function refreshToken(tokenToRefresh: string): Promise<SimklToken> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokenToRefresh,
    }).toString();

    const response = await executeRequest("POST", "/oauth2/token", {
      body,
      secrets: [tokenToRefresh],
    });

    if (!response.ok) {
      let code = response.statusText || "Error";
      try {
        const json = (await response.json()) as { error?: string };
        if (json.error) code = json.error;
      } catch {}
      throw new SimklApiError(response.status, code);
    }

    try {
      const data = (await response.json()) as SimklTokenResponse;
      return createStoredToken(data, {
        oldRefreshToken: tokenToRefresh,
        now: nowFn(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse Simkl refresh response: ${msg}`);
    }
  }

  async function get<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean>
  ): Promise<T> {
    // Path validation
    const { cleanPath } = validateMethodAndPath("GET", path);

    // Read stored token
    let currentToken = readToken();
    if (!currentToken || !currentToken.access_token) {
      throw new SimklAuthError(
        "Simkl authorisation expired or revoked: run 'it auth simkl' again"
      );
    }

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const nowMs = nowFn();
    const expiresAtMs = Date.parse(currentToken.expires_at);

    function handleRefreshError(err: unknown): never {
      if (err instanceof SimklApiError && (err.status === 400 || err.status === 401)) {
        throw new SimklAuthError(
          "Simkl authorisation expired or revoked: run 'it auth simkl' again"
        );
      }
      throw err;
    }

    // Proactive refresh if expiring in < 1 day
    if (expiresAtMs - nowMs < ONE_DAY_MS) {
      // Re-read file to check if another process refreshed
      const reRead = readToken();
      if (reRead && Date.parse(reRead.expires_at) - nowMs >= ONE_DAY_MS) {
        currentToken = reRead;
      } else {
        try {
          const refreshed = await refreshToken(currentToken.refresh_token);
          writeToken(refreshed);
          currentToken = refreshed;
        } catch (err) {
          handleRefreshError(err);
        }
      }
    }

    const secrets = [currentToken.access_token, currentToken.refresh_token];
    let response = await executeRequest("GET", cleanPath, {
      query,
      accessToken: currentToken.access_token,
      secrets,
    });

    if (response.status === 401) {
      // 401 handling: first re-read token file
      const reRead = readToken();
      if (reRead && reRead.access_token !== currentToken.access_token) {
        currentToken = reRead;
        secrets.push(currentToken.access_token, currentToken.refresh_token);
        response = await executeRequest("GET", cleanPath, {
          query,
          accessToken: currentToken.access_token,
          secrets,
        });
        if (response.status === 401) {
          throw new SimklAuthError(
            "Simkl authorisation expired or revoked: run 'it auth simkl' again"
          );
        }
      } else {
        // Refresh once and retry once
        try {
          const refreshed = await refreshToken(currentToken.refresh_token);
          writeToken(refreshed);
          currentToken = refreshed;
        } catch (err) {
          handleRefreshError(err);
        }

        secrets.push(currentToken.access_token, currentToken.refresh_token);
        response = await executeRequest("GET", cleanPath, {
          query,
          accessToken: currentToken.access_token,
          secrets,
        });

        if (response.status === 401) {
          throw new SimklAuthError(
            "Simkl authorisation expired or revoked: run 'it auth simkl' again"
          );
        }
      }
    }

    if (!response.ok) {
      let code = response.statusText || "Client Error";
      try {
        const body = (await response.json()) as { error?: string };
        if (body && typeof body.error === "string") {
          code = body.error;
        }
      } catch {}
      throw new SimklApiError(response.status, code);
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse Simkl JSON: ${msg}`);
    }
  }

  return {
    get,
    requestDeviceCode,
    pollToken,
    refreshToken,
  };
}
