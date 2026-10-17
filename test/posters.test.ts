import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import { coverUrlFor } from "../src/server/aggregate.ts";
import { createApp } from "../src/server/app.ts";
import {
  getCachedRemoteImage,
  getSimklPoster,
  isValidSimklPoster,
  SIMKL_POSTER_RE,
  simklPosterCacheDir,
} from "../src/server/posters.ts";

const SOURCE_ID = "ep:900001:1:3:2026-10-17T08:00:00.000Z";
const POSTER_PATH = "74/74415673dcdc9cdd";
const IMAGE_BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3]); // "RIFF" + padding

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface FakeFetchOptions {
  calls: FetchCall[];
  /** Response used for a successful call (defaults to a small `image/webp`). */
  response?: Response;
  /** Whenever set, the fake rejects with this error instead of responding. */
  error?: Error;
}

/** Records every call; never touches the network. */
function fakeFetch(opts: FakeFetchOptions): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    opts.calls.push({ url, init });
    if (opts.error) {
      throw opts.error;
    }
    return (
      opts.response ??
      new Response(IMAGE_BYTES, {
        status: 200,
        headers: { "content-type": "image/webp" },
      })
    );
  }) as typeof fetch;
}

function mockConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
  const cfg = {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: dbPath,
      backup_dir: join(dirname(dbPath), "backups"),
      backup_keep: 14,
    },
    audiobookshelf: {
      url: "http://abs.invalid:13378",
      token: "SYNTHETIC-ABS-TOKEN",
      timeout_s: 20,
    },
    simkl: {
      client_id: "synthetic-client",
      base_url: "https://api.simkl.test",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    notify: { desktop: false, ntfy_url: "" },
    toJSON: () => ({}),
    toString: () => "",
    ...overrides,
  } as Config;
  return cfg;
}

function seedRun(db: Database, events: NewEvent[]): void {
  const runId = startRun(db, "test-seed");
  insertEvents(db, runId, events);
  finishRun(db, runId, {
    status: "ok",
    rowsSeen: events.length,
    rowsInserted: events.length,
  });
}

describe("isValidSimklPoster / SIMKL_POSTER_RE", () => {
  test("accepts lowercase alphanumeric path pairs", () => {
    expect(SIMKL_POSTER_RE.test(POSTER_PATH)).toBe(true);
    expect(isValidSimklPoster(POSTER_PATH)).toBe(true);
    expect(isValidSimklPoster("12/12345678abcdef01")).toBe(true);
  });

  test("rejects traversal, uppercase, extra segments and empty values", () => {
    for (const bad of ["../etc", "74/ABC", "74/abc/def", "abc", "", "74/", "/74", "74/abc?x=1", 42, null]) {
      expect(isValidSimklPoster(bad)).toBe(false);
    }
  });
});

describe("GET /api/poster/simkl/:dir/:name", () => {
  let db: Database;
  let tempDir: string;
  let dbPath: string;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-poster-"));
    dbPath = join(tempDir, "inputtracker.db");
    config = mockConfig(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fetches once with a plain GET, then serves from the disk cache", async () => {
    const calls: FetchCall[] = [];
    const app = createApp({ db, config, fetchImage: fakeFetch({ calls }) });

    const res1 = await app.request(`/api/poster/simkl/${POSTER_PATH}`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toBe("image/webp");
    expect(res1.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(new Uint8Array(await res1.arrayBuffer())).toEqual(IMAGE_BYTES);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://simkl.in/posters/74/74415673dcdc9cdd_m.webp"
    );
    expect(calls[0]?.init?.method).toBe("GET");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);

    // Second request is a cache hit: the fake is not called again.
    const res2 = await app.request(`/api/poster/simkl/${POSTER_PATH}`);
    expect(res2.status).toBe(200);
    expect(new Uint8Array(await res2.arrayBuffer())).toEqual(IMAGE_BYTES);
    expect(calls).toHaveLength(1);

    // Cache layout: <db dir>/posters/simkl/<key>.img + .type
    const cacheDir = simklPosterCacheDir(config);
    expect(readFileSync(join(cacheDir, "74_74415673dcdc9cdd.type"), "utf8")).toBe(
      "image/webp"
    );
    expect(new Uint8Array(readFileSync(join(cacheDir, "74_74415673dcdc9cdd.img")))).toEqual(
      IMAGE_BYTES
    );
  });

  test("invalid paths return 400 and never fetch", async () => {
    const calls: FetchCall[] = [];
    const app = createApp({ db, config, fetchImage: fakeFetch({ calls }) });

    const badPaths = [
      "/api/poster/simkl/74/ABC",
      "/api/poster/simkl/74/abc/def",
      "/api/poster/simkl/abc",
      "/api/poster/simkl/74/74415673dcdc9cdd?extra=1",
      "/api/poster/simkl/..%2Fetc",
    ];

    for (const path of badPaths) {
      const res = await app.request(path);
      expect(res.status).toBe(400);
    }

    // A literal `..` is normalized away by the URL parser; it still never fetches.
    const normalized = await app.request("/api/poster/simkl/../etc");
    expect([400, 404]).toContain(normalized.status);

    expect(calls).toHaveLength(0);
  });

  test("a 404 from the origin yields 404 JSON and caches nothing", async () => {
    const calls: FetchCall[] = [];
    const app = createApp({
      db,
      config,
      fetchImage: fakeFetch({
        calls,
        response: new Response("nope", { status: 404 }),
      }),
    });

    const res1 = await app.request(`/api/poster/simkl/${POSTER_PATH}`);
    expect(res1.status).toBe(404);
    const body = (await res1.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(existsSync(simklPosterCacheDir(config))).toBe(false);

    // Not cached: the next request fetches again.
    const res2 = await app.request(`/api/poster/simkl/${POSTER_PATH}`);
    expect(res2.status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  test("a non-image content type yields 404 JSON and caches nothing", async () => {
    const calls: FetchCall[] = [];
    const app = createApp({
      db,
      config,
      fetchImage: fakeFetch({
        calls,
        response: new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      }),
    });

    const res = await app.request(`/api/poster/simkl/${POSTER_PATH}`);
    expect(res.status).toBe(404);
    expect(existsSync(join(simklPosterCacheDir(config), "74_74415673dcdc9cdd.img"))).toBe(false);

    await app.request(`/api/poster/simkl/${POSTER_PATH}`);
    expect(calls).toHaveLength(2);
  });

  test("a throwing fetch yields 404 and caches nothing", async () => {
    const calls: FetchCall[] = [];
    const app = createApp({
      db,
      config,
      fetchImage: fakeFetch({ calls, error: new Error("connection refused") }),
    });

    const res = await app.request(`/api/poster/simkl/${POSTER_PATH}`);
    expect(res.status).toBe(404);
    expect(existsSync(simklPosterCacheDir(config))).toBe(false);
  });

  test("uses the configured poster_base_url", async () => {
    const calls: FetchCall[] = [];
    const custom = mockConfig(dbPath, {
      simkl: {
        client_id: "synthetic-client",
        base_url: "https://api.simkl.test",
        poster_base_url: "https://posters.example/base",
        timeout_s: 20,
      },
    });
    const app = createApp({ db, config: custom, fetchImage: fakeFetch({ calls }) });

    const res = await app.request(`/api/poster/simkl/${POSTER_PATH}`);
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe(
      "https://posters.example/base/74/74415673dcdc9cdd_m.webp"
    );
  });
});

describe("getCachedRemoteImage", () => {
  test("a request that never resolves times out to null", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "inputtracker-timeout-"));
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      })) as typeof fetch;

    try {
      const result = await getCachedRemoteImage({
        url: "https://example.invalid/img.webp",
        cacheDir: join(tempDir, "posters"),
        key: "k",
        fetch: hanging,
        timeoutMs: 10,
      });
      expect(result).toBeNull();
      expect(existsSync(join(tempDir, "posters"))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("getSimklPoster", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-simkl-poster-"));
    config = mockConfig(join(tempDir, "inputtracker.db"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rejects an invalid path without fetching", async () => {
    const calls: FetchCall[] = [];
    const result = await getSimklPoster("../etc", {
      config,
      fetch: fakeFetch({ calls }),
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("coverUrlFor", () => {
  test("points Simkl events with simkl_poster at /api/poster/simkl/<path>", () => {
    expect(
      coverUrlFor({
        source: "simkl",
        source_kind: "watch",
        external_ids: { simkl: 900001, simkl_poster: POSTER_PATH },
      })
    ).toBe(`/api/poster/simkl/${POSTER_PATH}`);
  });

  test("returns null for a malformed or missing Simkl poster", () => {
    expect(
      coverUrlFor({
        source: "simkl",
        source_kind: "watch",
        external_ids: { simkl_poster: "74/ABC" },
      })
    ).toBeNull();
    expect(
      coverUrlFor({
        source: "simkl",
        source_kind: "watch",
        external_ids: { simkl: 900001 },
      })
    ).toBeNull();
    expect(coverUrlFor({ source: "simkl", source_kind: "watch" })).toBeNull();
  });

  test("keeps Audiobookshelf behaviour unchanged", () => {
    expect(
      coverUrlFor({
        source: "audiobookshelf",
        source_kind: "listening_session",
        external_ids: { abs_item: "absItem_1" },
      })
    ).toBe("/api/cover/absItem_1");
    expect(
      coverUrlFor({
        source: "audiobookshelf",
        source_kind: "media_progress",
        source_id: "prog-1",
      })
    ).toBe("/api/cover/prog-1");
    expect(
      coverUrlFor({ source: "manual", source_kind: "history_item" })
    ).toBeNull();
  });
});

describe("GET /api/calendar with a Simkl episode", () => {
  let db: Database;
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-simkl-cal-"));
    config = mockConfig(join(tempDir, "inputtracker.db"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns the title, season/episode and poster cover_url", async () => {
    seedRun(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: SOURCE_ID,
        external_ids: { simkl: 900001, simkl_poster: POSTER_PATH },
        media_type: "episode",
        title: "Synthetic Show",
        parent_title: null,
        season: 1,
        episode: 3,
        started_at: "2026-10-17T08:00:00.000Z",
        ended_at: null,
        duration_seconds: 1800,
      },
    ]);

    const app = createApp({ db, config });
    const res = await app.request("/api/calendar?month=2026-10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: {
        items: {
          title: string | null;
          season: number | null;
          episode: number | null;
          cover_url: string | null;
        }[];
      }[];
    };

    const items = body.days[0]?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Synthetic Show");
    expect(items[0]?.season).toBe(1);
    expect(items[0]?.episode).toBe(3);
    expect(items[0]?.cover_url).toBe(`/api/poster/simkl/${POSTER_PATH}`);
  });
});
