import { describe, expect, test } from "bun:test";
import type { SimklConfig } from "../src/core/config.ts";
import {
  createSimklClient,
  SimklApiError,
  SimklAuthError,
  SimklLimitError,
  SourceUnavailable,
  type FetchFn,
} from "../src/sources/simkl/client.ts";
import type { SimklToken } from "../src/sources/simkl/token.ts";

const FAKE_CLIENT_ID = "test-client-id";
const FAKE_ACCESS_1 = "simkl_at_FAKE_ACCESS_1";
const FAKE_ACCESS_2 = "simkl_at_FAKE_ACCESS_2";
const FAKE_REFRESH_1 = "simkl_rt_FAKE_REFRESH_1";
const FAKE_REFRESH_2 = "simkl_rt_FAKE_REFRESH_2";
const FAKE_DEVICE_CODE = "FAKE-DEVICE-CODE-1";
const FAKE_BASE_URL = "https://api.simkl.test";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

const allSuiteThrownMessages: string[] = [];

async function captureThrownAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    allSuiteThrownMessages.push(msg);
    throw err;
  }
}

describe("Simkl API client", () => {
  const baseConfig: SimklConfig = {
    client_id: FAKE_CLIENT_ID,
    base_url: FAKE_BASE_URL,
    timeout_s: 5,
  };

  const freshToken: SimklToken = {
    access_token: FAKE_ACCESS_1,
    refresh_token: FAKE_REFRESH_1,
    scope: "media:read",
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    obtained_at: new Date().toISOString(),
  };

  describe("Allow-list and HTTP methods", () => {
    test("rejects non-allow-listed methods before fetch", async () => {
      let fetchCalled = false;
      const client = createSimklClient(baseConfig, {
        fetch: async (): Promise<Response> => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        },
        readToken: () => freshToken,
      });

      // SimklClient does not export PUT/DELETE/PATCH, but calling get with forbidden paths/traversals throws
      await expect(
        captureThrownAsync(() => client.get("/sync/history"))
      ).rejects.toThrow();
      expect(fetchCalled).toBe(false);

      await expect(
        captureThrownAsync(() => client.get("/users/settings"))
      ).rejects.toThrow();
      expect(fetchCalled).toBe(false);

      await expect(
        captureThrownAsync(() => client.get("/sync/all-items/books"))
      ).rejects.toThrow();
      expect(fetchCalled).toBe(false);

      await expect(
        captureThrownAsync(() => client.get("/sync/all-items/shows/../movies"))
      ).rejects.toThrow();
      expect(fetchCalled).toBe(false);

      await expect(
        captureThrownAsync(() => client.get("/sync/activities#section"))
      ).rejects.toThrow();
      expect(fetchCalled).toBe(false);

      await expect(
        captureThrownAsync(() => client.get("//api.simkl.test/sync/activities"))
      ).rejects.toThrow();
      expect(fetchCalled).toBe(false);

      await expect(
        captureThrownAsync(() => client.get("/sync/activities?extended=full"))
      ).rejects.toThrow(/query/i);
      expect(fetchCalled).toBe(false);
    });

    test("allows valid GET paths", async () => {
      const allowedPaths = [
        "/sync/activities",
        "/sync/all-items",
        "/sync/all-items/shows",
        "/sync/all-items/movies",
        "/sync/all-items/anime",
        "/sync/all-items/shows/watching",
        "/sync/all-items/movies/completed",
        "/sync/all-items/anime/dropped",
        "/sync/all-items/shows/plantowatch",
        "/sync/all-items/shows/hold",
      ];

      for (const path of allowedPaths) {
        let calledUrl = "";
        const client = createSimklClient(baseConfig, {
          fetch: async (input: string | URL | Request): Promise<Response> => {
            calledUrl = input.toString();
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
          readToken: () => freshToken,
        });

        const res = await client.get<{ ok: boolean }>(path);
        expect(res.ok).toBe(true);
        expect(calledUrl).toContain(`${FAKE_BASE_URL}${path}`);
      }
    });
  });

  describe("Request headers and URL parameters", () => {
    test("every request carries client_id, app-name, app-version params and User-Agent", async () => {
      const calls: RecordedCall[] = [];
      const client = createSimklClient(
        { ...baseConfig, base_url: `${FAKE_BASE_URL}///` }, // trailing slashes should be stripped
        {
          fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            calls.push({ url: input.toString(), init });
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
          readToken: () => freshToken,
        }
      );

      await client.get("/sync/activities", { extended: "full" });

      expect(calls.length).toBe(1);
      const parsedUrl = new URL(calls[0].url);
      expect(parsedUrl.origin).toBe(FAKE_BASE_URL);
      expect(parsedUrl.pathname).toBe("/sync/activities");
      expect(parsedUrl.searchParams.get("client_id")).toBe(FAKE_CLIENT_ID);
      expect(parsedUrl.searchParams.get("app-name")).toBe("inputtracker");
      expect(parsedUrl.searchParams.get("app-version")).toBe("0.1.0");
      expect(parsedUrl.searchParams.get("extended")).toBe("full");

      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe("inputtracker/0.1.0");
      expect(headers["Authorization"]).toBe(`Bearer ${FAKE_ACCESS_1}`);
    });

    test("query parameter cannot override client_id, app-name, or app-version", async () => {
      let requestedUrl = "";
      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request): Promise<Response> => {
          requestedUrl = input.toString();
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        readToken: () => freshToken,
      });

      await client.get("/sync/activities", {
        client_id: "evil-client-id",
        "app-name": "evil-app",
        "app-version": "9.9.9",
        custom_key: "custom_val",
      });

      const parsed = new URL(requestedUrl);
      expect(parsed.searchParams.get("client_id")).toBe(FAKE_CLIENT_ID);
      expect(parsed.searchParams.get("app-name")).toBe("inputtracker");
      expect(parsed.searchParams.get("app-version")).toBe("0.1.0");
      expect(parsed.searchParams.get("custom_key")).toBe("custom_val");
    });

    test("POST /oauth2/* calls do not carry Bearer header and send exact form body", async () => {
      const calls: RecordedCall[] = [];
      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          calls.push({ url: input.toString(), init });
          return new Response(
            JSON.stringify({
              device_code: FAKE_DEVICE_CODE,
              user_code: "BDWP-HQPK",
              verification_uri: "https://simkl.com/pin",
              verification_uri_complete: "https://simkl.com/pin?user_code=BDWP-HQPK",
              expires_in: 900,
              interval: 5,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        },
        readToken: () => freshToken,
      });

      await client.requestDeviceCode();

      expect(calls.length).toBe(1);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(headers["User-Agent"]).toBe("inputtracker/0.1.0");

      const form = new URLSearchParams(calls[0].init?.body as string);
      expect(form.get("client_id")).toBe(FAKE_CLIENT_ID);
      expect(form.get("scope")).toBe("media:read");
      expect(Array.from(form.keys()).sort()).toEqual(["client_id", "scope"]);
    });

    test("pollToken sends form body with grant_type=device_code, client_id, and device_code", async () => {
      let capturedBody = "";
      const client = createSimklClient(baseConfig, {
        fetch: async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          capturedBody = init?.body as string;
          return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
        },
      });

      const result = await client.pollToken(FAKE_DEVICE_CODE);
      expect(result.kind).toBe("pending");

      const form = new URLSearchParams(capturedBody);
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
      expect(form.get("client_id")).toBe(FAKE_CLIENT_ID);
      expect(form.get("device_code")).toBe(FAKE_DEVICE_CODE);
      expect(Array.from(form.keys()).sort()).toEqual(["client_id", "device_code", "grant_type"]);
    });

    test("refreshToken sends form body with grant_type=refresh_token, client_id, and refresh_token", async () => {
      let capturedBody = "";
      const client = createSimklClient(baseConfig, {
        fetch: async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          capturedBody = init?.body as string;
          return new Response(
            JSON.stringify({
              access_token: FAKE_ACCESS_2,
              refresh_token: FAKE_REFRESH_2,
              expires_in: 604800,
              scope: "media:read",
            }),
            { status: 200 }
          );
        },
      });

      await client.refreshToken(FAKE_REFRESH_1);

      const form = new URLSearchParams(capturedBody);
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("client_id")).toBe(FAKE_CLIENT_ID);
      expect(form.get("refresh_token")).toBe(FAKE_REFRESH_1);
      expect(Array.from(form.keys()).sort()).toEqual(["client_id", "grant_type", "refresh_token"]);
    });
  });

  describe("Proactive token refresh before /sync/*", () => {
    test("token expiring in < 1 day is refreshed before the call", async () => {
      const nearExpiryToken: SimklToken = {
        access_token: FAKE_ACCESS_1,
        refresh_token: FAKE_REFRESH_1,
        scope: "media:read",
        expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString(), // 12 hours left (< 24h)
        obtained_at: new Date().toISOString(),
      };

      let writtenToken: SimklToken | null = null;
      const calls: RecordedCall[] = [];

      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const urlStr = input.toString();
          calls.push({ url: urlStr, init });
          if (urlStr.includes("/oauth2/token")) {
            return new Response(
              JSON.stringify({
                access_token: FAKE_ACCESS_2,
                refresh_token: FAKE_REFRESH_2,
                expires_in: 604800,
                scope: "media:read",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ synced: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
        readToken: () => writtenToken ?? nearExpiryToken,
        writeToken: (t: SimklToken) => {
          writtenToken = t;
        },
      });

      const res = await client.get<{ synced: boolean }>("/sync/activities");
      expect(res.synced).toBe(true);

      // Call 1 should be refresh (/oauth2/token), Call 2 should be /sync/activities with NEW token
      expect(calls.length).toBe(2);
      expect(calls[0].url).toContain("/oauth2/token");
      expect(calls[1].url).toContain("/sync/activities");
      const authHeader = (calls[1].init?.headers as Record<string, string>)?.Authorization;
      expect(authHeader).toBe(`Bearer ${FAKE_ACCESS_2}`);
      expect((writtenToken as SimklToken | null)?.access_token).toBe(FAKE_ACCESS_2);
    });

    test("fresh token (> 1 day remaining) is not refreshed before call", async () => {
      let refreshCalled = false;
      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request): Promise<Response> => {
          if (input.toString().includes("/oauth2/token")) {
            refreshCalled = true;
          }
          return new Response(JSON.stringify({ synced: true }), { status: 200 });
        },
        readToken: () => freshToken,
      });

      await client.get("/sync/activities");
      expect(refreshCalled).toBe(false);
    });

    test("proactive refresh checks re-read token first if another process refreshed", async () => {
      const nearExpiryToken: SimklToken = {
        access_token: FAKE_ACCESS_1,
        refresh_token: FAKE_REFRESH_1,
        scope: "media:read",
        expires_at: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
        obtained_at: new Date().toISOString(),
      };

      let readCount = 0;
      let refreshCalled = false;

      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request): Promise<Response> => {
          if (input.toString().includes("/oauth2/token")) {
            refreshCalled = true;
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        readToken: () => {
          readCount++;
          if (readCount > 1) {
            // Second read returns fresh token refreshed by peer process
            return freshToken;
          }
          return nearExpiryToken;
        },
      });

      await client.get("/sync/activities");
      expect(refreshCalled).toBe(false);
    });
  });

  describe("401 handling on /sync/* calls", () => {
    test("one 401 triggers refresh once + retry once with new token", async () => {
      let getAttempts = 0;
      let refreshAttempts = 0;
      let currentToken = freshToken;

      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request): Promise<Response> => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/token")) {
            refreshAttempts++;
            return new Response(
              JSON.stringify({
                access_token: FAKE_ACCESS_2,
                refresh_token: FAKE_REFRESH_2,
                expires_in: 604800,
                scope: "media:read",
              }),
              { status: 200 }
            );
          }

          getAttempts++;
          if (getAttempts === 1) {
            return new Response("Unauthorized", { status: 401 });
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        },
        readToken: () => currentToken,
        writeToken: (t: SimklToken) => {
          currentToken = t;
        },
      });

      const res = await client.get<{ success: boolean }>("/sync/activities");
      expect(res.success).toBe(true);
      expect(getAttempts).toBe(2);
      expect(refreshAttempts).toBe(1);
      expect(currentToken.access_token).toBe(FAKE_ACCESS_2);
    });

    test("401 when file holds a different token retries without refreshing", async () => {
      let getAttempts = 0;
      let refreshCalled = false;
      let readCount = 0;

      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/token")) {
            refreshCalled = true;
            return new Response("{}", { status: 200 });
          }

          getAttempts++;
          if (getAttempts === 1) {
            return new Response("Unauthorized", { status: 401 });
          }
          const auth = (init?.headers as Record<string, string>)?.Authorization;
          expect(auth).toBe(`Bearer ${FAKE_ACCESS_2}`);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
        readToken: () => {
          readCount++;
          if (readCount === 1) {
            return freshToken;
          }
          return {
            ...freshToken,
            access_token: FAKE_ACCESS_2,
          };
        },
      });

      const res = await client.get<{ ok: boolean }>("/sync/activities");
      expect(res.ok).toBe(true);
      expect(refreshCalled).toBe(false);
      expect(getAttempts).toBe(2);
    });

    test("refresh failure on 401 throws SimklAuthError", async () => {
      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request): Promise<Response> => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/token")) {
            return new Response("Invalid refresh token", { status: 400 });
          }
          return new Response("Unauthorized", { status: 401 });
        },
        readToken: () => freshToken,
      });

      await expect(
        captureThrownAsync(() => client.get("/sync/activities"))
      ).rejects.toThrow(SimklAuthError);
      await expect(
        captureThrownAsync(() => client.get("/sync/activities"))
      ).rejects.toThrow("Simkl authorisation expired or revoked: run 'it auth simkl' again");
    });

    test("retry still 401 after successful refresh throws SimklAuthError", async () => {
      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request): Promise<Response> => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/token")) {
            return new Response(
              JSON.stringify({
                access_token: FAKE_ACCESS_2,
                refresh_token: FAKE_REFRESH_2,
                expires_in: 604800,
              }),
              { status: 200 }
            );
          }
          return new Response("Unauthorized", { status: 401 });
        },
        readToken: () => freshToken,
      });

      await expect(
        captureThrownAsync(() => client.get("/sync/activities"))
      ).rejects.toThrow(SimklAuthError);
    });

    test("network error during refresh throws SourceUnavailable, not SimklAuthError", async () => {
      let getAttempts = 0;
      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request): Promise<Response> => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/token")) {
            return new Response("Simkl outage", { status: 503 });
          }
          getAttempts++;
          return new Response("Unauthorized", { status: 401 });
        },
        readToken: () => freshToken,
      });

      await expect(
        captureThrownAsync(() => client.get("/sync/activities"))
      ).rejects.toThrow(SourceUnavailable);
      await expect(
        captureThrownAsync(() => client.get("/sync/activities"))
      ).rejects.not.toThrow(SimklAuthError);
      expect(getAttempts).toBeGreaterThan(0);
    });

    test("rate limit (429 user_limit_exceeded) during refresh rethrows SimklLimitError, not SimklAuthError", async () => {
      const client = createSimklClient(baseConfig, {
        fetch: async (input: string | URL | Request): Promise<Response> => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/token")) {
            return new Response(JSON.stringify({ error: "user_limit_exceeded" }), {
              status: 429,
              headers: { "Retry-After": "120" },
            });
          }
          return new Response("Unauthorized", { status: 401 });
        },
        readToken: () => freshToken,
      });

      let caught: unknown;
      try {
        await captureThrownAsync(() => client.get("/sync/activities"));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SimklLimitError);
      expect((caught as SimklLimitError).retryAfterSeconds).toBe(120);
      expect(caught).not.toBeInstanceOf(SimklAuthError);
    });
  });

  describe("429 rate limit and error handling", () => {
    test("429 rate_limit sleeps ~1s and retries once", async () => {
      let attempts = 0;
      const sleepCalls: number[] = [];

      const client = createSimklClient(baseConfig, {
        fetch: async (): Promise<Response> => {
          attempts++;
          if (attempts === 1) {
            return new Response(JSON.stringify({ error: "rate_limit" }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ recovered: true }), { status: 200 });
        },
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
        readToken: () => freshToken,
      });

      const res = await client.get<{ recovered: boolean }>("/sync/activities");
      expect(res.recovered).toBe(true);
      expect(attempts).toBe(2);
      expect(sleepCalls).toEqual([1000]);
    });

    test("429 user_limit_exceeded throws SimklLimitError without retry", async () => {
      let attempts = 0;
      const sleepCalls: number[] = [];

      const client = createSimklClient(baseConfig, {
        fetch: async (): Promise<Response> => {
          attempts++;
          return new Response(JSON.stringify({ error: "user_limit_exceeded" }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "3600",
            },
          });
        },
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
        readToken: () => freshToken,
      });

      let caught: unknown;
      try {
        await captureThrownAsync(() => client.get("/sync/activities"));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SimklLimitError);
      expect((caught as SimklLimitError).retryAfterSeconds).toBe(3600);
      expect(attempts).toBe(1);
      expect(sleepCalls.length).toBe(0);
    });

    test("5xx retries up to 2 times with backoff, then throws SourceUnavailable", async () => {
      let attempts = 0;
      const sleepCalls: number[] = [];

      const client = createSimklClient(baseConfig, {
        fetch: async (): Promise<Response> => {
          attempts++;
          return new Response("Server error", { status: 503 });
        },
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
        readToken: () => freshToken,
      });

      await expect(
        captureThrownAsync(() => client.get("/sync/activities"))
      ).rejects.toThrow(SourceUnavailable);
      expect(attempts).toBe(3); // 1 original + 2 retries
      expect(sleepCalls.length).toBe(2);
    });

    test("400 max_items throws SimklApiError with status 400 and code max_items", async () => {
      const client = createSimklClient(baseConfig, {
        fetch: async (): Promise<Response> => {
          return new Response(JSON.stringify({ error: "max_items" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        },
        readToken: () => freshToken,
      });

      let caught: unknown;
      try {
        await captureThrownAsync(() => client.get("/sync/all-items/shows"));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SimklApiError);
      expect((caught as SimklApiError).status).toBe(400);
      expect((caught as SimklApiError).code).toBe("max_items");
    });

    test("timeout throws SourceUnavailable", async () => {
      const client = createSimklClient(
        { ...baseConfig, timeout_s: 0.001 },
        {
          fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            return new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            });
          }) as FetchFn,
          readToken: () => freshToken,
        }
      );

      await expect(
        captureThrownAsync(() => client.get("/sync/activities"))
      ).rejects.toThrow(SourceUnavailable);
    });
  });

  describe("Secrecy in client errors", () => {
    test("no thrown error message contains fake tokens or device code", () => {
      expect(allSuiteThrownMessages.length).toBeGreaterThan(5);
      for (const msg of allSuiteThrownMessages) {
        expect(msg).not.toContain(FAKE_ACCESS_1);
        expect(msg).not.toContain(FAKE_ACCESS_2);
        expect(msg).not.toContain(FAKE_REFRESH_1);
        expect(msg).not.toContain(FAKE_REFRESH_2);
        expect(msg).not.toContain(FAKE_DEVICE_CODE);
      }
    });
  });
});
