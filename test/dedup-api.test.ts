import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import type { Config } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import type { CalendarResult, StatsResult } from "../src/server/aggregate.ts";
import type { SearchResult } from "../src/server/search.ts";
import type { ExportEnvelope } from "../src/io/export-json.ts";

const TZ = "Europe/Bratislava";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://localhost:13378", token: "secret", timeout_s: 20 },
    simkl: {
      client_id: "",
      base_url: "https://api.simkl.test",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: { desktop: false, ntfy_url: "", ntfy_token: "", app_url: "", weekly_summary: false },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

describe("Cross-source dedup API tests", () => {
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

  test("manual + Simkl pair on the same day: calendar shows one item with also_from, stats counts once, search returns one group, export has both rows", async () => {
    const app = createApp({ db, config });

    seed([
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "simkl-m1",
        external_ids: { simkl_poster: "movies/12/34.jpg" },
        media_type: "movie",
        title: "Synthetic Movie",
        started_at: "2026-10-17T20:00:00.000Z",
        duration_seconds: 7200,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-m1",
        media_type: "movie",
        title: "Synthetic Movie",
        started_at: "2026-10-17T20:10:00.000Z",
        duration_seconds: 7200,
      },
    ]);

    // 1. /api/calendar shows one item with also_from: ["manual"]
    const calRes = await app.request("/api/calendar?month=2026-10");
    expect(calRes.status).toBe(200);
    const calBody = (await calRes.json()) as CalendarResult;
    expect(calBody.days).toHaveLength(1);
    expect(calBody.days[0]?.date).toBe("2026-10-17");
    expect(calBody.days[0]?.count).toBe(1);
    expect(calBody.days[0]?.minutes).toBe(120);
    expect(calBody.days[0]?.items).toHaveLength(1);
    const item = calBody.days[0]?.items[0]!;
    expect(item.source).toBe("simkl");
    expect(item.title).toBe("Synthetic Movie");
    expect(item.also_from).toEqual(["manual"]);

    // 2. /api/stats counts it once
    const statsRes = await app.request("/api/stats?from=2026-10-01&to=2026-10-31");
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as StatsResult;
    expect(statsBody.total_items).toBe(1);
    expect(statsBody.total_minutes).toBe(120);
    expect(statsBody.by_source["simkl"]?.count).toBe(1);
    expect(statsBody.by_source["manual"]).toBeUndefined();
    expect(statsBody.top_items).toHaveLength(1);
    expect(statsBody.top_items[0]?.count).toBe(1);
    expect(statsBody.top_items[0]?.title).toBe("Synthetic Movie");

    // 3. /api/search returns one group
    const searchRes = await app.request("/api/search?q=Synthetic");
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as SearchResult;
    expect(searchBody.total).toBe(1);
    expect(searchBody.hits).toHaveLength(1);
    expect(searchBody.hits[0]?.title).toBe("Synthetic Movie");
    expect(searchBody.hits[0]?.source).toBe("simkl");
    expect(searchBody.hits[0]?.count).toBe(1);

    // 4. JSON export still contains both rows
    const exportRes = await app.request("/api/export.json");
    expect(exportRes.status).toBe(200);
    const exportBody = (await exportRes.json()) as ExportEnvelope;
    expect(exportBody.format).toBe("inputtracker-export");
    expect(exportBody.events).toHaveLength(2);
    const sources = exportBody.events.map((e) => e.source).sort();
    expect(sources).toEqual(["manual", "simkl"]);
  });
});
