import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudiobookshelfConfig } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";
import {
  createAbsClient,
  fetchAllSessions,
  getAllSessions,
  SourceUnavailable,
} from "../src/sources/audiobookshelf/client.ts";

const FAKE_TOKEN = "FAKE-TOKEN-123";
const FAKE_URL = "http://abs.test:13378";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

const allSuiteRecordedCalls: RecordedCall[] = [];

function createRecordingFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>
) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    allSuiteRecordedCalls.push({ url: urlStr, init });
    return handler(urlStr, init);
  };
}

describe("Audiobookshelf client", () => {
  const baseCfg: AudiobookshelfConfig = {
    url: FAKE_URL,
    token: FAKE_TOKEN,
    timeout_s: 5,
  };

  test("GET-only and Bearer auth on all calls", async () => {
    const recorded: RecordedCall[] = [];
    const mockFetch = createRecordingFetch(async () => {
      recorded.push(allSuiteRecordedCalls[allSuiteRecordedCalls.length - 1]);
      return new Response(JSON.stringify({ username: "alice" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = createAbsClient(baseCfg, { fetch: mockFetch });
    const me = await client.get<{ username: string }>("/api/me");

    expect(me).toEqual({ username: "alice" });
    expect(recorded.length).toBe(1);
    expect(recorded[0].init?.method).toBe("GET");

    const authHeader = (recorded[0].init?.headers as Record<string, string>)?.Authorization;
    expect(authHeader).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  describe("Path allow-list", () => {
    const forbiddenPaths = [
      "/api/users",
      "/api/me/../users",
      "/api/items/x/y/cover",
      "http://evil/api/me",
      "https://evil/api/me",
      "//evil/api/me",
      "/api/me/extra",
      "/api/items//cover",
      "/api/items/cover",
      "/api/items/item.name/cover",
      "/api/items/123/cover/more",
      "/api/items/123",
    ];

    for (const forbidden of forbiddenPaths) {
      test(`rejects forbidden path "${forbidden}" without calling fetch`, async () => {
        let fetchCalled = false;
        const mockFetch = createRecordingFetch(async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        });

        const client = createAbsClient(baseCfg, { fetch: mockFetch });

        await expect(client.get(forbidden)).rejects.toThrow();
        expect(fetchCalled).toBe(false);
      });
    }

    test("allows valid exact endpoints and cover paths", async () => {
      const allowedPaths = [
        "/api/me",
        "/api/me/listening-sessions",
        "/api/me/listening-stats",
        "/api/items/book-123_abc/cover",
        "/api/items/item_ABC-999/cover",
      ];

      for (const path of allowedPaths) {
        let calledUrl = "";
        const mockFetch = createRecordingFetch(async (url) => {
          calledUrl = url;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });

        const client = createAbsClient(baseCfg, { fetch: mockFetch });
        const res = await client.get<{ ok: boolean }>(path);
        expect(res).toEqual({ ok: true });
        expect(calledUrl).toBe(`${FAKE_URL}${path}`);
      }
    });

    test("getBinary only allows cover paths", async () => {
      let fetchCalled = false;
      const mockFetch = createRecordingFetch(async () => {
        fetchCalled = true;
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      });

      const client = createAbsClient(baseCfg, { fetch: mockFetch });

      // /api/me is allow-listed for JSON, but forbidden for binary
      await expect(client.getBinary("/api/me")).rejects.toThrow(/binary/i);
      expect(fetchCalled).toBe(false);

      // Non-allow-listed path throws
      await expect(client.getBinary("/api/users")).rejects.toThrow();
      expect(fetchCalled).toBe(false);

      // Valid cover path succeeds
      const result = await client.getBinary("/api/items/item123/cover");
      expect(fetchCalled).toBe(true);
      expect(result.contentType).toBe("image/jpeg");
      expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    });

    test("rejects paths containing fragment identifiers", async () => {
      let fetchCalled = false;
      const mockFetch = createRecordingFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      const client = createAbsClient(baseCfg, { fetch: mockFetch });
      await expect(client.get("/api/me#frag")).rejects.toThrow(/fragment/i);
      expect(fetchCalled).toBe(false);
    });
  });

  describe("Query params serialization", () => {
    test("serializes string, number, and boolean query params correctly", async () => {
      let requestedUrl = "";
      const mockFetch = createRecordingFetch(async (url) => {
        requestedUrl = url;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const client = createAbsClient(baseCfg, { fetch: mockFetch });
      await client.get("/api/me/listening-sessions", {
        itemsPerPage: 50,
        page: 2,
        active: true,
        filter: "test tag",
      });

      const parsed = new URL(requestedUrl);
      expect(parsed.pathname).toBe("/api/me/listening-sessions");
      expect(parsed.searchParams.get("itemsPerPage")).toBe("50");
      expect(parsed.searchParams.get("page")).toBe("2");
      expect(parsed.searchParams.get("active")).toBe("true");
      expect(parsed.searchParams.get("filter")).toBe("test tag");
    });

    test("strips trailing slash from base URL", async () => {
      let requestedUrl = "";
      const mockFetch = createRecordingFetch(async (url) => {
        requestedUrl = url;
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = createAbsClient(
        { ...baseCfg, url: "http://abs.test:13378///" },
        { fetch: mockFetch }
      );
      await client.get("/api/me");
      expect(requestedUrl).toBe("http://abs.test:13378/api/me");
    });
  });

  describe("Pagination helper", () => {
    test("collects all pages across 3 pages (0-based) and requests pages 0, 1, 2 only", async () => {
      const requestedPages: number[] = [];

      const mockFetch = createRecordingFetch(async (url) => {
        const parsed = new URL(url);
        const page = Number(parsed.searchParams.get("page"));
        requestedPages.push(page);

        if (page === 0) {
          return new Response(
            JSON.stringify({
              total: 5,
              numPages: 3,
              page: 0,
              itemsPerPage: 2,
              sessions: [{ id: "sess-1" }, { id: "sess-2" }],
            }),
            { status: 200 }
          );
        }
        if (page === 1) {
          return new Response(
            JSON.stringify({
              total: 5,
              numPages: 3,
              page: 1,
              itemsPerPage: 2,
              sessions: [{ id: "sess-3" }, { id: "sess-4" }],
            }),
            { status: 200 }
          );
        }
        if (page === 2) {
          return new Response(
            JSON.stringify({
              total: 5,
              numPages: 3,
              page: 2,
              itemsPerPage: 2,
              sessions: [{ id: "sess-5" }],
            }),
            { status: 200 }
          );
        }

        throw new Error(`Unexpected page request: ${page}`);
      });

      const client = createAbsClient(baseCfg, { fetch: mockFetch });
      const sessions = await fetchAllSessions<{ id: string }>(client, 2);

      expect(requestedPages).toEqual([0, 1, 2]);
      expect(sessions).toEqual([
        { id: "sess-1" },
        { id: "sess-2" },
        { id: "sess-3" },
        { id: "sess-4" },
        { id: "sess-5" },
      ]);
    });

    test("client methods getAllSessions and fetchAllSessions work identically", async () => {
      const mockFetch = createRecordingFetch(async () => {
        return new Response(
          JSON.stringify({
            total: 1,
            numPages: 1,
            page: 0,
            itemsPerPage: 100,
            sessions: [{ id: "single-sess" }],
          }),
          { status: 200 }
        );
      });

      const client = createAbsClient(baseCfg, { fetch: mockFetch });
      const res1 = await client.getAllSessions<{ id: string }>();
      const res2 = await client.fetchAllSessions<{ id: string }>();
      const res3 = await getAllSessions<{ id: string }>(client);

      expect(res1).toEqual([{ id: "single-sess" }]);
      expect(res2).toEqual([{ id: "single-sess" }]);
      expect(res3).toEqual([{ id: "single-sess" }]);
    });

    test("single page or empty sessions terminates immediately", async () => {
      let callCount = 0;
      const mockFetch = createRecordingFetch(async () => {
        callCount++;
        return new Response(
          JSON.stringify({
            total: 0,
            numPages: 0,
            page: 0,
            itemsPerPage: 100,
            sessions: [],
          }),
          { status: 200 }
        );
      });

      const client = createAbsClient(baseCfg, { fetch: mockFetch });
      const sessions = await fetchAllSessions(client);

      expect(sessions).toEqual([]);
      expect(callCount).toBe(1);
    });

    test("handles malformed non-array sessions in envelope defensively", async () => {
      const mockFetch = createRecordingFetch(async () => {
        return new Response(
          JSON.stringify({
            total: 1,
            numPages: 1,
            page: 0,
            itemsPerPage: 100,
            sessions: null,
          }),
          { status: 200 }
        );
      });

      const client = createAbsClient(baseCfg, { fetch: mockFetch });
      const sessions = await fetchAllSessions(client);
      expect(sessions).toEqual([]);
    });
  });

  describe("Error handling and retries", () => {
    test("negative retries clamps to 0 (at least one attempt)", async () => {
      let attempts = 0;
      const mockFetch = createRecordingFetch(async () => {
        attempts++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const client = createAbsClient(baseCfg, { fetch: mockFetch, retries: -1 });
      const res = await client.get<{ ok: boolean }>("/api/me");
      expect(res.ok).toBe(true);
      expect(attempts).toBe(1);
    });
    test("fetch rejecting (connection refused) throws SourceUnavailable immediately", async () => {
      let attempts = 0;
      const mockFetch = createRecordingFetch(async () => {
        attempts++;
        throw new Error("connect ECONNREFUSED 127.0.0.1:13378");
      });

      const client = createAbsClient(baseCfg, {
        fetch: mockFetch,
        retries: 2,
        retryDelayMs: 0,
      });

      let caught: unknown;
      try {
        await client.get("/api/me");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SourceUnavailable);
      expect((caught as SourceUnavailable).name).toBe("SourceUnavailable");
      expect((caught as SourceUnavailable).message).toContain("Audiobookshelf unreachable");
      expect(attempts).toBe(1);
    });

    test("persistent 500 throws SourceUnavailable after retries", async () => {
      let attempts = 0;
      const mockFetch = createRecordingFetch(async () => {
        attempts++;
        return new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        });
      });

      const client = createAbsClient(baseCfg, {
        fetch: mockFetch,
        retries: 2,
        retryDelayMs: 0,
      });

      let caught: unknown;
      try {
        await client.get("/api/me");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SourceUnavailable);
      expect((caught as SourceUnavailable).name).toBe("SourceUnavailable");
      expect((caught as SourceUnavailable).message).toContain("500");
      expect(attempts).toBe(3); // 1 initial + 2 retries
    });

    test("a 500 then 200 succeeds after retry", async () => {
      let attempts = 0;
      const mockFetch = createRecordingFetch(async () => {
        attempts++;
        if (attempts === 1) {
          return new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          });
        }
        return new Response(JSON.stringify({ recovered: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const client = createAbsClient(baseCfg, {
        fetch: mockFetch,
        retries: 2,
        retryDelayMs: 0,
      });

      const result = await client.get<{ recovered: boolean }>("/api/me");
      expect(result).toEqual({ recovered: true });
      expect(attempts).toBe(2);
    });

    test("401 throws Error with status without retry", async () => {
      let attempts = 0;
      const mockFetch = createRecordingFetch(async () => {
        attempts++;
        return new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        });
      });

      const client = createAbsClient(baseCfg, {
        fetch: mockFetch,
        retries: 2,
        retryDelayMs: 0,
      });

      let caught: unknown;
      try {
        await client.get("/api/me");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(SourceUnavailable);
      expect((caught as Error).message).toContain("401");
      expect(attempts).toBe(1);
    });

    test("404 throws Error without retry", async () => {
      let attempts = 0;
      const mockFetch = createRecordingFetch(async () => {
        attempts++;
        return new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        });
      });

      const client = createAbsClient(baseCfg, {
        fetch: mockFetch,
        retries: 2,
        retryDelayMs: 0,
      });

      await expect(client.get("/api/me")).rejects.toThrow(/404/);
      expect(attempts).toBe(1);
    });

    test("timeout path (abort) throws SourceUnavailable", async () => {
      const mockFetch = createRecordingFetch(async (_url, init) => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });

      const client = createAbsClient(
        { ...baseCfg, timeout_s: 0.01 },
        { fetch: mockFetch }
      );

      let caught: unknown;
      try {
        await client.get("/api/me");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SourceUnavailable);
      expect((caught as SourceUnavailable).name).toBe("SourceUnavailable");
      expect((caught as SourceUnavailable).message).toContain("timed out");
    });
  });

  describe("Token redaction", () => {
    test("token never appears in any thrown error message", async () => {
      const errorsToTest: (() => Promise<unknown>)[] = [
        // 1. Fetch failure mentioning token in message
        async () => {
          const client = createAbsClient(baseCfg, {
            fetch: createRecordingFetch(async () => {
              throw new Error(`Failed authorization for token ${FAKE_TOKEN}`);
            }),
            retries: 0,
          });
          return client.get("/api/me");
        },
        // 2. 401 error
        async () => {
          const client = createAbsClient(baseCfg, {
            fetch: createRecordingFetch(async () => {
              return new Response(`Bad token ${FAKE_TOKEN}`, {
                status: 401,
                statusText: "Unauthorized",
              });
            }),
            retries: 0,
          });
          return client.get("/api/me");
        },
        // 3. 500 error after retries
        async () => {
          const client = createAbsClient(baseCfg, {
            fetch: createRecordingFetch(async () => {
              return new Response(`Internal server error with token ${FAKE_TOKEN}`, {
                status: 500,
                statusText: "Server Error",
              });
            }),
            retries: 1,
            retryDelayMs: 0,
          });
          return client.get("/api/me");
        },
        // 4. Bad JSON mentioning token
        async () => {
          const client = createAbsClient(baseCfg, {
            fetch: createRecordingFetch(async () => {
              return new Response(`Invalid JSON payload containing ${FAKE_TOKEN}`, {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }),
          });
          return client.get("/api/me");
        },
      ];

      for (const fn of errorsToTest) {
        let caughtErr: unknown;
        try {
          await fn();
        } catch (err) {
          caughtErr = err;
        }

        expect(caughtErr).toBeDefined();
        const caughtMessage =
          caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
        expect(caughtMessage.length).toBeGreaterThan(0);
        expect(caughtMessage).not.toContain(FAKE_TOKEN);

        if (caughtErr instanceof Error) {
          expect(caughtErr.stack ?? "").not.toContain(FAKE_TOKEN);
          const cause = (caughtErr as { cause?: unknown }).cause;
          if (cause instanceof Error) {
            expect(cause.message).not.toContain(FAKE_TOKEN);
            expect(cause.stack ?? "").not.toContain(FAKE_TOKEN);
          } else if (cause) {
            expect(String(cause)).not.toContain(FAKE_TOKEN);
          }
        }
      }
    });

    test("disallowed path error message redacts token if present in path", async () => {
      const client = createAbsClient(baseCfg, {
        fetch: createRecordingFetch(async () => new Response("{}", { status: 200 })),
      });
      let caughtMsg = "";
      try {
        await client.get(`/api/${FAKE_TOKEN}`);
      } catch (err) {
        caughtMsg = err instanceof Error ? err.message : String(err);
      }
      expect(caughtMsg).not.toContain(FAKE_TOKEN);
      expect(caughtMsg).toContain("***");
    });

    test("reads non-enumerable token from loaded Config object correctly", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-abs-"));
      try {
        const configPath = join(dir, "config.toml");
        writeFileSync(
          configPath,
          `[audiobookshelf]\nurl = "${FAKE_URL}"\ntoken = "${FAKE_TOKEN}"\ntimeout_s = 5\n`
        );
        const loaded = loadConfig({ path: configPath });

        let capturedAuth = "";
        const mockFetch = createRecordingFetch(async (_url, init) => {
          capturedAuth =
            (init?.headers as Record<string, string>)?.Authorization ?? "";
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        });

        // Pass full config object
        const client = createAbsClient(loaded, { fetch: mockFetch });
        await client.get("/api/me");

        expect(capturedAuth).toBe(`Bearer ${FAKE_TOKEN}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("assert over all recorded calls across the suite: method is GET and has Bearer auth", () => {
    expect(allSuiteRecordedCalls.length).toBeGreaterThan(10);
    for (const call of allSuiteRecordedCalls) {
      expect(call.init?.method).toBe("GET");
      const headers = call.init?.headers as Record<string, string>;
      expect(headers).toBeDefined();
      expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    }
  });
});
