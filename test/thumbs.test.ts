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
  getYoutubeThumb,
  isValidYoutubeVideoId,
  YOUTUBE_VIDEO_RE,
  youtubeThumbCacheDir,
} from "../src/server/thumbs.ts";

const VIDEO_ID = "AbCdEfGhI_1";
const VIDEO_ID_2 = "Zz-9Yy8Xx7w";
const IMAGE_BYTES = new Uint8Array([255, 216, 255, 1, 2, 3]); // JPEG-ish magic

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface FakeFetchOptions {
  calls: FetchCall[];
  /** Response used for a successful call (defaults to a small `image/jpeg`). */
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
        headers: { "content-type": "image/jpeg" },
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
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: { desktop: false, ntfy_url: "" },
    toJSON: () => ({}),
    toString: () => "",
    ...overrides,
  } as Config;
  return cfg;
}

function seedRun(db: Database, events: NewEvent[]): void {
  const runId = startRun(db, "youtube-takeout");
  insertEvents(db, runId, events);
  finishRun(db, runId, {
    status: "ok",
    rowsSeen: events.length,
    rowsInserted: events.length,
  });
}

/** A synthetic YouTube history item; `duration_seconds` is always null. */
function youtubeEvent(index: number, iso: string): NewEvent {
  const id = `B${String(index).padStart(10, "0")}`;
  return {
    source: "youtube",
    source_kind: "history_item",
    source_id: `${id}:${iso}`,
    external_ids: {
      youtube_video: id,
      youtube_channel: "UCsyntheticchannel000001",
    },
    media_type: "video",
    title: `Synthetic Video ${index}`,
    parent_title: "Synthetic Channel",
    started_at: iso,
    ended_at: null,
    duration_seconds: null,
  };
}

describe("isValidYoutubeVideoId / YOUTUBE_VIDEO_RE", () => {
  test("accepts 11-character URL-safe ids", () => {
    expect(YOUTUBE_VIDEO_RE.test(VIDEO_ID)).toBe(true);
    expect(isValidYoutubeVideoId(VIDEO_ID)).toBe(true);
    expect(isValidYoutubeVideoId(VIDEO_ID_2)).toBe(true);
  });

  test("rejects wrong lengths, separators and non-strings", () => {
    for (const bad of [
      "AbCdEfGhI", // 10
      "AbCdEfGhIjKl", // 12
      "../etc/pass",
      "abc$defghij",
      "AbCdEfGhI_1/extra",
      "",
      42,
      null,
      undefined,
    ]) {
      expect(isValidYoutubeVideoId(bad)).toBe(false);
    }
  });
});

describe("GET /api/thumb/youtube/:videoId", () => {
  let db: Database;
  let tempDir: string;
  let dbPath: string;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-thumb-"));
    dbPath = join(tempDir, "inputtracker.db");
    config = mockConfig(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fetches once with a plain GET, then serves from the disk cache", async () => {
    const calls: FetchCall[] = [];
    const app = createApp({ db, config, fetchImage: fakeFetch({ calls }) });

    const res1 = await app.request(`/api/thumb/youtube/${VIDEO_ID}`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toBe("image/jpeg");
    expect(res1.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(new Uint8Array(await res1.arrayBuffer())).toEqual(IMAGE_BYTES);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://i.ytimg.com/vi/${VIDEO_ID}/mqdefault.jpg`
    );
    expect(calls[0]?.init?.method).toBe("GET");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);

    // Second request is a cache hit: the fake is not called again.
    const res2 = await app.request(`/api/thumb/youtube/${VIDEO_ID}`);
    expect(res2.status).toBe(200);
    expect(new Uint8Array(await res2.arrayBuffer())).toEqual(IMAGE_BYTES);
    expect(calls).toHaveLength(1);

    // Cache layout: <db dir>/thumbs/youtube/<videoId>.img + .type
    const cacheDir = youtubeThumbCacheDir(config);
    expect(readFileSync(join(cacheDir, `${VIDEO_ID}.type`), "utf8")).toBe(
      "image/jpeg"
    );
    expect(
      new Uint8Array(readFileSync(join(cacheDir, `${VIDEO_ID}.img`)))
    ).toEqual(IMAGE_BYTES);
  });

  test("invalid ids and shapes return 400 and never fetch", async () => {
    const calls: FetchCall[] = [];
    const app = createApp({ db, config, fetchImage: fakeFetch({ calls }) });

    const badPaths = [
      "/api/thumb/youtube/AbCdEfGhI", // 10
      "/api/thumb/youtube/AbCdEfGhIjKl", // 12
      "/api/thumb/youtube/..%2Fetc%2Fpass", // encoded traversal
      "/api/thumb/youtube/abc$defghij", // illegal char
      `/api/thumb/youtube/${VIDEO_ID}?extra=1`, // query string
      `/api/thumb/youtube/${VIDEO_ID}/extra`, // extra segment
    ];

    for (const path of badPaths) {
      const res = await app.request(path);
      expect(res.status).toBe(400);
    }

    // A literal `..` is normalized away by the URL parser; it still never fetches.
    const normalized = await app.request("/api/thumb/youtube/../etc/pass");
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

    const res1 = await app.request(`/api/thumb/youtube/${VIDEO_ID}`);
    expect(res1.status).toBe(404);
    const body = (await res1.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(existsSync(youtubeThumbCacheDir(config))).toBe(false);

    // Not cached: the next request fetches again.
    const res2 = await app.request(`/api/thumb/youtube/${VIDEO_ID}`);
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

    const res = await app.request(`/api/thumb/youtube/${VIDEO_ID}`);
    expect(res.status).toBe(404);
    expect(
      existsSync(join(youtubeThumbCacheDir(config), `${VIDEO_ID}.img`))
    ).toBe(false);

    await app.request(`/api/thumb/youtube/${VIDEO_ID}`);
    expect(calls).toHaveLength(2);
  });

  test("a throwing fetch yields 404 and caches nothing", async () => {
    const calls: FetchCall[] = [];
    const app = createApp({
      db,
      config,
      fetchImage: fakeFetch({ calls, error: new Error("connection refused") }),
    });

    const res = await app.request(`/api/thumb/youtube/${VIDEO_ID}`);
    expect(res.status).toBe(404);
    expect(existsSync(youtubeThumbCacheDir(config))).toBe(false);
  });

  test("uses the configured thumb_base_url (trailing slash stripped)", async () => {
    const calls: FetchCall[] = [];
    const custom = mockConfig(dbPath, {
      youtube: { thumb_base_url: "https://thumbs.example/base/" },
    });
    const app = createApp({ db, config: custom, fetchImage: fakeFetch({ calls }) });

    const res = await app.request(`/api/thumb/youtube/${VIDEO_ID}`);
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe(
      `https://thumbs.example/base/${VIDEO_ID}/mqdefault.jpg`
    );
  });
});

describe("getYoutubeThumb", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-yt-thumb-"));
    config = mockConfig(join(tempDir, "inputtracker.db"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rejects an invalid id without fetching", async () => {
    const calls: FetchCall[] = [];
    const result = await getYoutubeThumb("../etc", {
      config,
      fetch: fakeFetch({ calls }),
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("coverUrlFor", () => {
  test("points YouTube events with youtube_video at /api/thumb/youtube/<id>", () => {
    expect(
      coverUrlFor({
        source: "youtube",
        source_kind: "history_item",
        external_ids: { youtube_video: VIDEO_ID, youtube_channel: null },
      })
    ).toBe(`/api/thumb/youtube/${VIDEO_ID}`);
  });

  test("returns null for a malformed or missing youtube_video", () => {
    expect(
      coverUrlFor({
        source: "youtube",
        source_kind: "history_item",
        external_ids: { youtube_video: "too-short" },
      })
    ).toBeNull();
    expect(
      coverUrlFor({
        source: "youtube",
        source_kind: "history_item",
        external_ids: { youtube_channel: "UCsynthetic" },
      })
    ).toBeNull();
    expect(
      coverUrlFor({ source: "youtube", source_kind: "history_item" })
    ).toBeNull();
  });

  test("keeps Simkl and Audiobookshelf behaviour unchanged", () => {
    expect(
      coverUrlFor({
        source: "simkl",
        source_kind: "watch",
        external_ids: { simkl_poster: "74/74415673dcdc9cdd" },
      })
    ).toBe("/api/poster/simkl/74/74415673dcdc9cdd");
    expect(
      coverUrlFor({
        source: "audiobookshelf",
        source_kind: "listening_session",
        external_ids: { abs_item: "absItem_1" },
      })
    ).toBe("/api/cover/absItem_1");
  });
});

describe("GET /api/calendar with a YouTube item", () => {
  let db: Database;
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-yt-cal-"));
    config = mockConfig(join(tempDir, "inputtracker.db"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns title, parent_title (channel) and the thumb cover_url", async () => {
    seedRun(db, [
      {
        source: "youtube",
        source_kind: "history_item",
        source_id: `${VIDEO_ID}:2026-10-17T08:15:00.000Z`,
        external_ids: {
          youtube_video: VIDEO_ID,
          youtube_channel: "UCsyntheticchannel000001",
        },
        media_type: "video",
        title: "Synthetic Video 1",
        parent_title: "Synthetic Channel",
        started_at: "2026-10-17T08:15:00.000Z",
        ended_at: null,
        duration_seconds: null,
      },
    ]);

    const app = createApp({ db, config });
    const res = await app.request("/api/calendar?month=2026-10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: {
        items: {
          title: string | null;
          parent_title: string | null;
          duration_seconds: number | null;
          cover_url: string | null;
        }[];
      }[];
    };

    const items = body.days[0]?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Synthetic Video 1");
    expect(items[0]?.parent_title).toBe("Synthetic Channel");
    expect(items[0]?.duration_seconds).toBeNull();
    expect(items[0]?.cover_url).toBe(`/api/thumb/youtube/${VIDEO_ID}`);
  });
});

describe("heat map and stats count YouTube views", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig("/tmp/synthetic-inputtracker.db");
  });

  function seedYoutube(): void {
    seedRun(db, [
      youtubeEvent(1, "2026-10-17T08:15:00.000Z"),
      youtubeEvent(2, "2026-10-17T09:45:00.000Z"),
    ]);
  }

  test("heat map days count views while minutes stay 0", async () => {
    seedYoutube();
    const app = createApp({ db, config });

    const res = await app.request("/api/heatmap/days?year=2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: { date: string; count: number; minutes: number }[];
    };
    expect(body.days).toEqual([
      { date: "2026-10-17", count: 2, minutes: 0 },
    ]);
  });

  test("heat map hour cells count views while minutes stay 0", async () => {
    seedYoutube();
    const app = createApp({ db, config });

    const res = await app.request("/api/heatmap/hours?year=2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cells: { weekday: number; hour: number; count: number; minutes: number }[];
    };
    // 2026-10-17 is Saturday (cell weekday 5); 08:15/09:45 UTC -> 10:15/11:45 CEST.
    expect(body.cells).toEqual([
      { weekday: 5, hour: 10, count: 1, minutes: 0 },
      { weekday: 5, hour: 11, count: 1, minutes: 0 },
    ]);
  });

  test("stats buckets carry count and count_by_source for YouTube", async () => {
    seedYoutube();
    const app = createApp({ db, config });

    const res = await app.request("/api/stats?source=youtube");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_items: number;
      total_minutes: number;
      by_source: Record<string, { count: number; items: number; minutes: number }>;
      by_week: {
        week: string;
        minutes: number;
        count: number;
        count_by_source: Record<string, number>;
      }[];
      by_month: {
        month: string;
        minutes: number;
        count: number;
        count_by_source: Record<string, number>;
      }[];
      top_items: { title: string; minutes: number; count: number }[];
    };

    expect(body.total_items).toBe(2);
    expect(body.total_minutes).toBe(0);
    expect(body.by_source["youtube"]).toEqual({
      count: 2,
      items: 2,
      minutes: 0,
    });

    expect(body.by_week).toHaveLength(1);
    expect(body.by_week[0]?.week).toBe("2026-W42");
    expect(body.by_week[0]?.minutes).toBe(0);
    expect(body.by_week[0]?.count).toBe(2);
    expect(body.by_week[0]?.count_by_source).toEqual({ youtube: 2 });

    expect(body.by_month).toHaveLength(1);
    expect(body.by_month[0]?.month).toBe("2026-10");
    expect(body.by_month[0]?.minutes).toBe(0);
    expect(body.by_month[0]?.count).toBe(2);
    expect(body.by_month[0]?.count_by_source).toEqual({ youtube: 2 });

    expect(body.top_items).toHaveLength(2);
    for (const item of body.top_items) {
      expect(item.minutes).toBe(0);
      expect(item.count).toBe(1);
    }
  });
});
