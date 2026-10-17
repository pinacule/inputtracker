import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import type { Config } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import type { YearReview } from "../src/server/year-review.ts";

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

describe("API endpoint GET /api/year-review via createApp", () => {
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

  test("returns the requested year with year= and date=", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Fake Book",
        started_at: "2025-03-01T12:00:00.000Z",
        duration_seconds: 1800,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2024-07-01T12:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);

    const res = await app.request("/api/year-review?year=2025&date=2026-10-17");
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearReview;

    expect(body.year).toBe(2025);
    expect(body.partial).toBe(false);
    expect(body.days_in_range).toBe(365);
    expect(body.totals).toEqual({
      items: 1,
      minutes: 30,
      active_days: 1,
      titles: 1,
    });
    // 2024 has one manual event, so the previous year is filled.
    expect(body.previous).toEqual({
      items: 1,
      minutes: 60,
      active_days: 1,
      titles: 1,
    });
    expect(body.available_years).toEqual([2025, 2024]);
  });

  test("previous holds the totals of the year before", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2025-03-01T12:00:00.000Z",
        duration_seconds: 1800,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-2",
        media_type: "movie",
        title: "Other Fake Movie",
        started_at: "2024-03-01T12:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);

    const res = await app.request("/api/year-review?year=2025&date=2026-10-17");
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearReview;

    expect(body.year).toBe(2025);
    expect(body.previous).toEqual({
      items: 1,
      minutes: 60,
      active_days: 1,
      titles: 1,
    });
  });

  test("source= filters everything, including available_years", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Fake Book",
        started_at: "2025-03-01T12:00:00.000Z",
        duration_seconds: 1800,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2024-07-01T12:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);

    const res = await app.request(
      "/api/year-review?year=2025&date=2026-10-17&source=manual"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearReview;

    // Only manual events are visible: 2025 has none of them.
    expect(body.totals.items).toBe(0);
    expect(body.available_years).toEqual([2024]);
    // The year before (2024) has one manual event, so previous is filled.
    expect(body.previous).toEqual({
      items: 1,
      minutes: 60,
      active_days: 1,
      titles: 1,
    });
  });

  test("without year= it defaults to the local year of date= (or now)", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2025-02-01T12:00:00.000Z",
        duration_seconds: 600,
      },
    ]);

    const res = await app.request("/api/year-review?date=2025-06-15");
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearReview;

    expect(body.year).toBe(2025);
    expect(body.partial).toBe(true);
    // Jan 1 .. Jun 15 inclusive.
    expect(body.days_in_range).toBe(166);
    expect(body.totals.items).toBe(1);
  });

  test("without any params it returns a valid (zero) shape for the current year", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/year-review");
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearReview;

    expect(typeof body.year).toBe("number");
    expect(body.partial).toBe(true);
    expect(body.days_in_range).toBeGreaterThanOrEqual(1);
    expect(body.totals).toEqual({
      items: 0,
      minutes: 0,
      active_days: 0,
      titles: 0,
    });
    expect(body.available_years).toEqual([]);
    expect(body.previous).toBeNull();
    expect(body.by_month).toHaveLength(12);
    expect(body.by_weekday).toHaveLength(7);
    expect(body.top_titles).toEqual([]);
    expect(body.top_channels).toEqual([]);
    expect(body.busiest_day).toBeNull();
    expect(body.busiest_month).toBeNull();
  });

  test("a future year returns an empty result with days_in_range 0", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/year-review?year=9999&date=2026-10-17");
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearReview;

    expect(body.year).toBe(9999);
    expect(body.partial).toBe(false);
    expect(body.days_in_range).toBe(0);
    expect(body.totals.items).toBe(0);
  });

  test("bad year returns 400", async () => {
    const app = createApp({ db, config });

    const bad = await app.request("/api/year-review?year=20x6");
    expect(bad.status).toBe(400);
    const json = (await bad.json()) as { error: string };
    expect(json.error).toContain("Invalid year format");

    const tooLong = await app.request("/api/year-review?year=20266");
    expect(tooLong.status).toBe(400);
  });

  test("bad date returns 400", async () => {
    const app = createApp({ db, config });

    const invalid = await app.request("/api/year-review?date=2026-02-30");
    expect(invalid.status).toBe(400);
    const json = (await invalid.json()) as { error: string };
    expect(json.error).toContain("Invalid date format");

    const nonsense = await app.request("/api/year-review?date=nonsense");
    expect(nonsense.status).toBe(400);
  });

  test("unknown query parameter returns 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/year-review?foo=bar");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Unknown query parameter");
  });
});
