import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import type { Config } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import {
  aggregateStats,
  getIsoWeek,
  getSeriesOrTitle,
  getStats,
  type ConsumptionEvent,
  type StatsResult,
} from "../src/server/aggregate.ts";

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

describe("getIsoWeek and getSeriesOrTitle pure helpers", () => {
  test("getIsoWeek calculates ISO weeks correctly around year boundaries", () => {
    // Normal date
    expect(getIsoWeek("2026-10-17")).toBe("2026-W42");

    // Month boundary / week 44
    expect(getIsoWeek("2026-10-31")).toBe("2026-W44");
    expect(getIsoWeek("2026-11-01")).toBe("2026-W44");

    // Jan 1 2026 (Thursday) -> 2026-W01
    expect(getIsoWeek("2026-01-01")).toBe("2026-W01");

    // Dec 30 2024 (Monday) -> belongs to 2025-W01
    expect(getIsoWeek("2024-12-30")).toBe("2025-W01");

    // Dec 29 2024 (Sunday) -> belongs to 2024-W52
    expect(getIsoWeek("2024-12-29")).toBe("2024-W52");

    // Jan 1 2027 (Friday) -> belongs to 2026-W53
    expect(getIsoWeek("2027-01-01")).toBe("2026-W53");
  });

  test("getSeriesOrTitle returns parent_title for episodes/shows/podcasts and title otherwise", () => {
    const episode: ConsumptionEvent = {
      id: 1,
      source: "simkl",
      source_kind: "watch",
      media_type: "episode",
      title: "Ozymandias",
      parent_title: "Breaking Bad",
      season: 5,
      episode: 14,
      started_at: "2026-10-10T20:00:00.000Z",
    };
    expect(getSeriesOrTitle(episode)).toBe("Breaking Bad");

    const podcast: ConsumptionEvent = {
      id: 2,
      source: "manual",
      source_kind: "history_item",
      media_type: "podcast_episode",
      title: "Episode 120",
      parent_title: "Tech Podcast",
      started_at: "2026-10-10T20:00:00.000Z",
    };
    expect(getSeriesOrTitle(podcast)).toBe("Tech Podcast");

    const audiobook: ConsumptionEvent = {
      id: 3,
      source: "audiobookshelf",
      source_kind: "listening_session",
      media_type: "audiobook",
      title: "Dune",
      parent_title: "Frank Herbert", // author, not a series
      started_at: "2026-10-10T20:00:00.000Z",
    };
    expect(getSeriesOrTitle(audiobook)).toBe("Dune");

    const movie: ConsumptionEvent = {
      id: 4,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Inception",
      parent_title: null,
      started_at: "2026-10-10T20:00:00.000Z",
    };
    expect(getSeriesOrTitle(movie)).toBe("Inception");

    const untitled: ConsumptionEvent = {
      id: 5,
      source: "manual",
      source_kind: "history_item",
      media_type: "video",
      title: null,
      parent_title: null,
      started_at: "2026-10-10T20:00:00.000Z",
    };
    expect(getSeriesOrTitle(untitled)).toBe("Untitled");
  });
});

describe("aggregateStats pure aggregation", () => {
  test("aggregates by week, by month, and top items", () => {
    const events: ConsumptionEvent[] = [
      {
        id: 1,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Book Alpha",
        started_at: "2026-10-12T10:00:00.000Z", // 2026-W42, 2026-10
        duration_seconds: 3600, // 60 min
      },
      {
        id: 2,
        source: "manual",
        source_kind: "history_item",
        media_type: "movie",
        title: "Movie Beta",
        started_at: "2026-10-15T18:00:00.000Z", // 2026-W42, 2026-10
        duration_seconds: 7200, // 120 min
      },
      {
        id: 3,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Book Alpha",
        started_at: "2026-10-20T10:00:00.000Z", // 2026-W43, 2026-10
        duration_seconds: 1800, // 30 min
      },
    ];

    const stats = aggregateStats(events, { tz: TZ });
    expect(stats.total_items).toBe(3);
    expect(stats.total_minutes).toBe(210);

    // by_week
    expect(stats.by_week).toHaveLength(2);
    expect(stats.by_week[0]).toEqual({
      week: "2026-W42",
      by_source: { audiobookshelf: 60, manual: 120 },
      minutes: 180,
      count: 2,
      count_by_source: { audiobookshelf: 1, manual: 1 },
    });
    expect(stats.by_week[1]).toEqual({
      week: "2026-W43",
      by_source: { audiobookshelf: 30 },
      minutes: 30,
      count: 1,
      count_by_source: { audiobookshelf: 1 },
    });

    // by_month
    expect(stats.by_month).toHaveLength(1);
    expect(stats.by_month[0]).toEqual({
      month: "2026-10",
      by_source: { audiobookshelf: 90, manual: 120 },
      minutes: 210,
      count: 3,
      count_by_source: { audiobookshelf: 2, manual: 1 },
    });

    // top_items: Movie Beta (120 min, count 1), Book Alpha (90 min, count 2)
    expect(stats.top_items).toHaveLength(2);
    expect(stats.top_items[0]).toEqual({
      title: "Movie Beta",
      source: "manual",
      media_type: "movie",
      category: "film",
      minutes: 120,
      count: 1,
    });
    expect(stats.top_items[1]).toEqual({
      title: "Book Alpha",
      source: "audiobookshelf",
      media_type: "audiobook",
      category: "audiobook",
      minutes: 90,
      count: 2,
    });
  });

  test("week/month bucketing near month boundary and local-time midnight", () => {
    // 2026-10-31T23:30:00.000Z in Europe/Bratislava (CET, UTC+1) lands at 2026-11-01 00:30:00 local!
    const events: ConsumptionEvent[] = [
      {
        id: 1,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Late October Listening",
        started_at: "2026-10-31T23:30:00.000Z",
        duration_seconds: 1800, // 30 min
      },
    ];

    const stats = aggregateStats(events, { tz: TZ });
    // Local date is 2026-11-01, month is 2026-11, week is 2026-W44
    expect(stats.by_month).toHaveLength(1);
    expect(stats.by_month[0]?.month).toBe("2026-11");
    expect(stats.by_month[0]?.minutes).toBe(30);

    expect(stats.by_week).toHaveLength(1);
    expect(stats.by_week[0]?.week).toBe("2026-W44");
    expect(stats.by_week[0]?.minutes).toBe(30);
  });

  test("top_items groups TV episodes by series title and caps at top 10", () => {
    const events: ConsumptionEvent[] = [];

    // Series A with 3 episodes: 3 x 40m = 120m
    for (let i = 1; i <= 3; i++) {
      events.push({
        id: i,
        source: "simkl",
        source_kind: "watch",
        media_type: "episode",
        title: `Episode ${i}`,
        parent_title: "Series A",
        season: 1,
        episode: i,
        started_at: `2026-10-0${i}T20:00:00.000Z`,
        duration_seconds: 2400, // 40m
      });
    }

    // 12 other standalone movies with durations 10m .. 120m
    for (let i = 1; i <= 12; i++) {
      events.push({
        id: 10 + i,
        source: "manual",
        source_kind: "history_item",
        media_type: "movie",
        title: `Movie ${i}`,
        started_at: `2026-10-10T12:00:00.000Z`,
        duration_seconds: i * 600, // i * 10m
      });
    }

    const stats = aggregateStats(events, { tz: TZ });
    // Exactly 10 items in top_items
    expect(stats.top_items).toHaveLength(10);

    // Series A (120m) and Movie 12 (120m) are top
    const top2Minutes = stats.top_items.slice(0, 2).map((x) => x.minutes);
    expect(top2Minutes).toEqual([120, 120]);

    // Series A grouped under parent_title with count 3
    const seriesA = stats.top_items.find((x) => x.title === "Series A");
    expect(seriesA).toBeDefined();
    expect(seriesA?.minutes).toBe(120);
    expect(seriesA?.count).toBe(3);
    expect(seriesA?.source).toBe("simkl");
    expect(seriesA?.media_type).toBe("episode");

    // Items are in strictly descending order of minutes
    for (let i = 0; i < stats.top_items.length - 1; i++) {
      expect(stats.top_items[i]!.minutes).toBeGreaterThanOrEqual(
        stats.top_items[i + 1]!.minutes
      );
    }
  });

  test("filters by from, to, and source", () => {
    const events: ConsumptionEvent[] = [
      {
        id: 1,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Book Oct 5",
        started_at: "2026-10-05T10:00:00.000Z",
        duration_seconds: 3600,
      },
      {
        id: 2,
        source: "manual",
        source_kind: "history_item",
        media_type: "movie",
        title: "Movie Oct 15",
        started_at: "2026-10-15T10:00:00.000Z",
        duration_seconds: 7200,
      },
      {
        id: 3,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Book Oct 25",
        started_at: "2026-10-25T10:00:00.000Z",
        duration_seconds: 1800,
      },
    ];

    // Filter by source
    const absOnly = aggregateStats(events, { source: "audiobookshelf", tz: TZ });
    expect(absOnly.total_items).toBe(2);
    expect(absOnly.total_minutes).toBe(90);
    expect(absOnly.by_source["manual"]).toBeUndefined();

    // Filter by from
    const fromOct10 = aggregateStats(events, { from: "2026-10-10", tz: TZ });
    expect(fromOct10.total_items).toBe(2); // Oct 15, Oct 25
    expect(fromOct10.total_minutes).toBe(150);

    // Filter by to
    const toOct15 = aggregateStats(events, { to: "2026-10-15", tz: TZ });
    expect(toOct15.total_items).toBe(2); // Oct 5, Oct 15
    expect(toOct15.total_minutes).toBe(180);

    // Filter by from and to
    const range = aggregateStats(events, { from: "2026-10-10", to: "2026-10-20", tz: TZ });
    expect(range.total_items).toBe(1); // Oct 15 only
    expect(range.total_minutes).toBe(120);
    expect(range.top_items[0]?.title).toBe("Movie Oct 15");
  });
});

describe("Database integration: reading events_latest only and getStats", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  function seedRun(eventsToInsert: NewEvent[]): void {
    const runId = startRun(db, "test-sync");
    insertEvents(db, runId, eventsToInsert);
    finishRun(db, runId, {
      status: "ok",
      rowsSeen: eventsToInsert.length,
      rowsInserted: eventsToInsert.length,
    });
  }

  test("a session synced three times with growing duration counts once with the latest duration", () => {
    const baseEvent = {
      source: "audiobookshelf",
      source_kind: "listening_session",
      source_id: "abs-session-grow-42",
      media_type: "audiobook" as const,
      title: "Growing Book",
      started_at: "2026-10-17T08:00:00.000Z",
    };

    seedRun([{ ...baseEvent, duration_seconds: 600 }]);
    seedRun([{ ...baseEvent, duration_seconds: 1200 }]);
    seedRun([{ ...baseEvent, duration_seconds: 1800 }]);

    const stats = getStats(db, { tz: TZ });
    expect(stats.total_items).toBe(1);
    expect(stats.total_minutes).toBe(30); // 1800s / 60
    expect(stats.by_source["audiobookshelf"]?.count).toBe(1);
    expect(stats.by_source["audiobookshelf"]?.minutes).toBe(30);

    expect(stats.by_week).toHaveLength(1);
    expect(stats.by_week[0]?.minutes).toBe(30);

    expect(stats.by_month).toHaveLength(1);
    expect(stats.by_month[0]?.minutes).toBe(30);

    expect(stats.top_items).toHaveLength(1);
    expect(stats.top_items[0]?.title).toBe("Growing Book");
    expect(stats.top_items[0]?.minutes).toBe(30);
  });

  test("totals match a small fixture across 2 sources", () => {
    seedRun([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-f1",
        media_type: "audiobook",
        title: "Dune",
        started_at: "2026-10-10T10:00:00.000Z",
        duration_seconds: 3600, // 60 min
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-f2",
        media_type: "audiobook",
        title: "Dune",
        started_at: "2026-10-11T10:00:00.000Z",
        duration_seconds: 1800, // 30 min
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-f1",
        media_type: "movie",
        title: "The Matrix",
        started_at: "2026-10-12T19:00:00.000Z",
        duration_seconds: 7200, // 120 min
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-f2",
        media_type: "book",
        title: "Clean Code",
        started_at: "2026-10-13T09:00:00.000Z",
        duration_seconds: 1800, // 30 min
      },
      {
        source: "audiobookshelf",
        source_kind: "daily_stat", // Non-consumption kind must be ignored!
        source_id: "abs-stat-1",
        media_type: "audiobook",
        title: "Daily Stat",
        started_at: "2026-10-13T00:00:00.000Z",
        duration_seconds: 99999,
      },
    ]);

    const stats = getStats(db, { tz: TZ });
    expect(stats.total_items).toBe(4);
    expect(stats.total_minutes).toBe(240); // 60 + 30 + 120 + 30

    expect(stats.by_source["audiobookshelf"]).toEqual({
      count: 2,
      items: 2,
      minutes: 90,
    });
    expect(stats.by_source["manual"]).toEqual({
      count: 2,
      items: 2,
      minutes: 150,
    });

    expect(stats.by_media_type["audiobook"]).toEqual({
      count: 2,
      items: 2,
      minutes: 90,
    });
    expect(stats.by_media_type["movie"]).toEqual({
      count: 1,
      items: 1,
      minutes: 120,
    });
    expect(stats.by_media_type["book"]).toEqual({
      count: 1,
      items: 1,
      minutes: 30,
    });

    // top_items
    expect(stats.top_items).toHaveLength(3);
    expect(stats.top_items[0]?.title).toBe("The Matrix");
    expect(stats.top_items[0]?.minutes).toBe(120);
    expect(stats.top_items[1]?.title).toBe("Dune");
    expect(stats.top_items[1]?.minutes).toBe(90);
    expect(stats.top_items[1]?.count).toBe(2);
    expect(stats.top_items[2]?.title).toBe("Clean Code");
    expect(stats.top_items[2]?.minutes).toBe(30);
  });
});

describe("API endpoint GET /api/stats via createApp", () => {
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

  test("GET /api/stats returns complete response with backwards compatible fields and new ones", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-api-1",
        media_type: "audiobook",
        title: "Test Book",
        started_at: "2026-10-10T10:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);

    const res = await app.request("/api/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsResult;

    expect(body.total_items).toBe(1);
    expect(body.total_minutes).toBe(60);
    expect(body.by_source["audiobookshelf"]).toBeDefined();
    expect(body.by_media_type["audiobook"]).toBeDefined();
    expect(Array.isArray(body.by_week)).toBe(true);
    expect(Array.isArray(body.by_month)).toBe(true);
    expect(Array.isArray(body.top_items)).toBe(true);
    expect(body.by_week[0]?.week).toBe("2026-W41");
    expect(body.by_month[0]?.month).toBe("2026-10");
    expect(body.top_items[0]?.title).toBe("Test Book");
  });

  test("filters via query params: from, to, source", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Book 1",
        started_at: "2026-10-05T10:00:00.000Z",
        duration_seconds: 1800,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Movie 1",
        started_at: "2026-10-15T18:00:00.000Z",
        duration_seconds: 7200,
      },
    ]);

    const resFiltered = await app.request(
      "/api/stats?from=2026-10-10&to=2026-10-20&source=manual"
    );
    expect(resFiltered.status).toBe(200);
    const bodyFiltered = (await resFiltered.json()) as StatsResult;
    expect(bodyFiltered.total_items).toBe(1);
    expect(bodyFiltered.total_minutes).toBe(120);
    expect(bodyFiltered.top_items[0]?.title).toBe("Movie 1");
  });

  test("returns 400 on bad date format and unknown query params", async () => {
    const app = createApp({ db, config });

    // Bad from format
    const badFrom = await app.request("/api/stats?from=2026-13-01");
    expect(badFrom.status).toBe(400);
    const badFromJson = (await badFrom.json()) as { error: string };
    expect(badFromJson.error).toContain("Invalid from date format");

    // Invalid calendar date
    const badCal = await app.request("/api/stats?to=2026-02-30");
    expect(badCal.status).toBe(400);
    const badCalJson = (await badCal.json()) as { error: string };
    expect(badCalJson.error).toContain("Invalid to date format");

    // Malformed string
    const malformed = await app.request("/api/stats?from=invalid");
    expect(malformed.status).toBe(400);

    // Unknown query param
    const unknownParam = await app.request("/api/stats?foo=bar");
    expect(unknownParam.status).toBe(400);
    const unknownJson = (await unknownParam.json()) as { error: string };
    expect(unknownJson.error).toContain("Unknown query parameter");
  });
});
