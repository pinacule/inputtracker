import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import type { Config } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import type { SearchResult, TitleHistory } from "../src/server/search.ts";

const TZ = "Europe/Bratislava";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://localhost:13378", token: "secret", timeout_s: 20 },
    simkl: { client_id: "", base_url: "https://api.simkl.test", poster_base_url: "https://simkl.in/posters", timeout_s: 20 },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: {
      desktop: false,
      ntfy_url: "",
      ntfy_token: "",
      app_url: "",
      weekly_summary: false,
    },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

describe("API endpoint GET /api/search via createApp", () => {
  let db: Database;
  const config = mockConfig();

  beforeEach(() => {
    db = openDb(":memory:");
  });

  function seed(eventsToInsert: NewEvent[]): void {
    const runId = startRun(db, "test-api");
    insertEvents(db, runId, eventsToInsert);
    finishRun(db, runId, {
      status: "ok",
      rowsSeen: eventsToInsert.length,
      rowsInserted: eventsToInsert.length,
    });
  }

  function standardSeed(): void {
    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Fake Book",
        parent_title: "Fake Author",
        started_at: "2026-03-01T12:00:00.000Z",
        duration_seconds: 1800,
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-2",
        media_type: "audiobook",
        title: "Fake Book",
        parent_title: "Fake Author",
        started_at: "2026-03-02T12:00:00.000Z",
        duration_seconds: 600,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2026-03-03T12:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);
  }

  test("happy path groups sessions and returns hits", async () => {
    const app = createApp({ db, config });
    standardSeed();

    const res = await app.request("/api/search?q=book");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResult;

    expect(body.query).toBe("book");
    expect(body.total).toBe(1);
    expect(body.hits).toHaveLength(1);
    const hit = body.hits[0]!;
    expect(hit.key).toBe("audiobookshelf\u0000Fake Book");
    expect(hit.title).toBe("Fake Book");
    expect(hit.source).toBe("audiobookshelf");
    expect(hit.media_type).toBe("audiobook");
    expect(hit.count).toBe(2);
    expect(hit.minutes).toBe(40);
    expect(hit.subtitle).toBe("Fake Author");
    expect(hit.matched).toEqual(["title"]);
    expect(hit.first_date).toBe("2026-03-01");
    expect(hit.last_date).toBe("2026-03-02");
    expect(hit.cover_url).toBeNull();
  });

  test("source filter and media_type filter narrow the results", async () => {
    const app = createApp({ db, config });
    standardSeed();

    const bySource = await app.request("/api/search?q=fake&source=manual");
    expect(bySource.status).toBe(200);
    const sourceBody = (await bySource.json()) as SearchResult;
    expect(sourceBody.total).toBe(1);
    expect(sourceBody.hits[0]!.title).toBe("Fake Movie");

    const byType = await app.request("/api/search?q=fake&media_type=audiobook");
    expect(byType.status).toBe(200);
    const typeBody = (await byType.json()) as SearchResult;
    expect(typeBody.total).toBe(1);
    expect(typeBody.hits[0]!.title).toBe("Fake Book");
  });

  test("limit and offset paginate with the full total", async () => {
    const app = createApp({ db, config });
    standardSeed();

    const res = await app.request("/api/search?q=fake&limit=1&offset=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResult;
    expect(body.total).toBe(2);
    expect(body.hits).toHaveLength(1);
  });

  test("a 1-character query is fine and returns an empty result", async () => {
    const app = createApp({ db, config });
    standardSeed();

    const res = await app.request("/api/search?q=a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResult;
    expect(body.total).toBe(0);
    expect(body.hits).toEqual([]);
  });

  test("missing q returns 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/search");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Missing required query parameter: q");

    const empty = await app.request("/api/search?q=");
    expect(empty.status).toBe(400);
  });

  test("a q longer than 200 characters returns 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request(`/api/search?q=${"x".repeat(201)}`);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("too long");
  });

  test("bad limit values return 400", async () => {
    const app = createApp({ db, config });

    for (const limit of ["0", "101", "abc", "1.5", "-5"]) {
      const res = await app.request(`/api/search?q=fake&limit=${limit}`);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("Invalid limit");
    }
  });

  test("bad offset values return 400", async () => {
    const app = createApp({ db, config });

    for (const offset of ["-1", "x", "1.5"]) {
      const res = await app.request(`/api/search?q=fake&offset=${offset}`);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("Invalid offset");
    }
  });

  test("an unknown media_type returns 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/search?q=fake&media_type=vhs");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Invalid media_type");
  });

  test("unknown query parameters return 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/search?q=fake&foo=bar");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Unknown query parameter");
  });
});

describe("API endpoint GET /api/title-history via createApp", () => {
  let db: Database;
  const config = mockConfig();

  beforeEach(() => {
    db = openDb(":memory:");
  });

  function seed(eventsToInsert: NewEvent[]): void {
    const runId = startRun(db, "test-api");
    insertEvents(db, runId, eventsToInsert);
    finishRun(db, runId, {
      status: "ok",
      rowsSeen: eventsToInsert.length,
      rowsInserted: eventsToInsert.length,
    });
  }

  test("happy path returns the full history of a search hit", async () => {
    const app = createApp({ db, config });
    seed([
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2026-03-01T12:00:00.000Z",
        duration_seconds: 1800,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-2",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2026-03-05T12:00:00.000Z",
        duration_seconds: 600,
      },
    ]);

    const searchRes = await app.request("/api/search?q=fake movie");
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as SearchResult;
    const key = searchBody.hits[0]!.key;
    expect(key).toBe("manual\u0000Fake Movie");

    const res = await app.request(
      `/api/title-history?key=${encodeURIComponent(key)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TitleHistory;

    expect(body.key).toBe(key);
    expect(body.title).toBe("Fake Movie");
    expect(body.count).toBe(2);
    expect(body.minutes).toBe(40);
    expect(body.items).toHaveLength(2);
    // Newest first, with local date/time (12:00Z -> 13:00 in March, CET).
    expect(body.items[0]!.local_date).toBe("2026-03-05");
    expect(body.items[0]!.local_time).toBe("13:00");
    expect(body.items[0]!.minutes).toBe(10);
    expect(body.items[1]!.local_date).toBe("2026-03-01");
  });

  test("a YouTube channel key returns the channel's views", async () => {
    const app = createApp({ db, config });
    seed([
      {
        source: "youtube",
        source_kind: "watch",
        source_id: "yt-1",
        media_type: "video",
        title: "Fake Video One",
        parent_title: "Fake Channel",
        started_at: "2026-04-01T10:00:00.000Z",
      },
      {
        source: "youtube",
        source_kind: "watch",
        source_id: "yt-2",
        media_type: "video",
        title: "Fake Video Two",
        parent_title: "Fake Channel",
        started_at: "2026-04-02T10:00:00.000Z",
      },
    ]);

    const searchRes = await app.request("/api/search?q=fake channel");
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as SearchResult;
    const channel = searchBody.hits.find((h) =>
      h.key.startsWith("youtube-channel\u0000")
    );
    expect(channel).toBeDefined();
    expect(channel!.count).toBe(2);
    expect(channel!.subtitle).toBe("YouTube channel");

    const res = await app.request(
      `/api/title-history?key=${encodeURIComponent(channel!.key)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TitleHistory;
    expect(body.title).toBe("Fake Channel");
    expect(body.count).toBe(2);
    expect(body.items.map((i) => i.event_title)).toEqual([
      "Fake Video Two",
      "Fake Video One",
    ]);
  });

  test("missing key returns 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/title-history");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Missing required query parameter: key");
  });

  test("a key longer than 500 characters returns 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request(
      `/api/title-history?key=${encodeURIComponent("x".repeat(501))}`
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("too long");
  });

  test("an unknown key returns 404 with the usual error shape", async () => {
    const app = createApp({ db, config });

    const res = await app.request(
      `/api/title-history?key=${encodeURIComponent("manual\u0000No Such Title")}`
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(typeof json.error).toBe("string");
    expect(json.error).not.toBe("");
  });

  test("unknown query parameters return 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/title-history?key=a&foo=bar");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Unknown query parameter");
  });
});
