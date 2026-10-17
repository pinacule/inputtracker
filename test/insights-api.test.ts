import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import type { Config } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import type { InsightsResult } from "../src/server/insights.ts";

const TZ = "Europe/Bratislava";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://localhost:13378", token: "secret", timeout_s: 20 },
    simkl: { client_id: "", base_url: "https://api.simkl.test", poster_base_url: "https://simkl.in/posters", timeout_s: 20 },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: { desktop: false, ntfy_url: "" },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

describe("API endpoint GET /api/insights via createApp", () => {
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

  test("returns streaks and on_this_day for a fixed date", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Fake Book",
        started_at: "2026-10-16T10:00:00.000Z",
        duration_seconds: 1800,
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-2",
        media_type: "audiobook",
        title: "Fake Book",
        started_at: "2026-10-17T10:00:00.000Z",
        duration_seconds: 1800,
      },
      // One year ago, same calendar day -> "On this day".
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2025-10-17T20:00:00.000Z",
        duration_seconds: 7200,
      },
    ]);

    const res = await app.request("/api/insights?date=2026-10-17");
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsightsResult;

    expect(body.streaks.today).toBe("2026-10-17");
    expect(body.streaks.overall.current).toBe(2);
    expect(body.streaks.overall.longest).toBe(2);
    expect(body.streaks.by_source["audiobookshelf"]?.current).toBe(2);
    // The manual event is a year old: no current streak, but a 1-day longest.
    expect(body.streaks.by_source["manual"]?.current).toBe(0);
    expect(body.streaks.by_source["manual"]?.longest).toBe(1);

    expect(body.on_this_day.date).toBe("2026-10-17");
    expect(body.on_this_day.years).toHaveLength(1);
    expect(body.on_this_day.years[0]?.year).toBe(2025);
    expect(body.on_this_day.years[0]?.years_ago).toBe(1);
    expect(body.on_this_day.years[0]?.items[0]?.title).toBe("Fake Movie");
  });

  test("source= filters both streaks and on this day", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Fake Book",
        started_at: "2025-10-17T10:00:00.000Z",
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2025-10-17T20:00:00.000Z",
      },
    ]);

    const res = await app.request("/api/insights?date=2026-10-17&source=manual");
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsightsResult;

    expect(Object.keys(body.streaks.by_source)).toEqual(["manual"]);
    expect(body.on_this_day.years).toHaveLength(1);
    expect(body.on_this_day.years[0]?.items).toHaveLength(1);
    expect(body.on_this_day.years[0]?.items[0]?.title).toBe("Fake Movie");
  });

  test("without date= it uses the current local day in the configured timezone", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/insights");
    expect(res.status).toBe(200);
    const body = (await res.json()) as InsightsResult;

    // The route computes today from config.timezone; just check the shape and
    // that it is a plausible local YYYY-MM-DD near the real current time.
    expect(/^\d{4}-\d{2}-\d{2}$/.test(body.streaks.today)).toBe(true);
    expect(body.on_this_day.date).toBe(body.streaks.today);
    expect(body.streaks.overall.current).toBe(0);
    expect(body.on_this_day.years).toEqual([]);
  });

  test("bad date returns 400", async () => {
    const app = createApp({ db, config });

    const bad = await app.request("/api/insights?date=2026-13-01");
    expect(bad.status).toBe(400);
    const badJson = (await bad.json()) as { error: string };
    expect(badJson.error).toContain("Invalid date format");

    const malformed = await app.request("/api/insights?date=nonsense");
    expect(malformed.status).toBe(400);

    const invalidCal = await app.request("/api/insights?date=2026-02-30");
    expect(invalidCal.status).toBe(400);
  });

  test("unknown query parameter returns 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/insights?foo=bar");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Unknown query parameter");
  });
});
