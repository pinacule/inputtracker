import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import { createApp } from "../src/server/app.ts";
import type {
  CalendarResult,
  HeatmapDaysResult,
  HeatmapHoursResult,
  InProgressItem,
  StatsResult,
} from "../src/server/aggregate.ts";

const TZ = "Europe/Bratislava";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://localhost:13378", token: "secret", timeout_s: 20 },
    simkl: { client_id: "", base_url: "https://api.simkl.test", timeout_s: 20 },
    notify: { desktop: false, ntfy_url: "" },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

function seedRun(db: Database, eventsToInsert: NewEvent[]): void {
  const runId = startRun(db, "test-seed");
  insertEvents(db, runId, eventsToInsert);
  finishRun(db, runId, {
    status: "ok",
    rowsSeen: eventsToInsert.length,
    rowsInserted: eventsToInsert.length,
  });
}

describe("HTTP API", () => {
  let db: Database;
  let config: Config;
  let tempWebDir: string;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();
    tempWebDir = mkdtempSync(join(tmpdir(), "inputtracker-test-web-"));
    writeFileSync(join(tempWebDir, "index.html"), "<html><body>SPA App</body></html>");
    writeFileSync(join(tempWebDir, "style.css"), "body { color: red; }");
  });

  afterEach(() => {
    rmSync(tempWebDir, { recursive: true, force: true });
  });

  test("GET /api/health", async () => {
    const app = createApp({ db, config });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    // Unknown query param rejected with 400
    const badRes = await app.request("/api/health?extra=1");
    expect(badRes.status).toBe(400);
  });

  describe("GET /api/calendar", () => {
    test("validation: missing or invalid month or unknown params return 400", async () => {
      const app = createApp({ db, config });

      const resMissing = await app.request("/api/calendar");
      expect(resMissing.status).toBe(400);

      const resBadMonth = await app.request("/api/calendar?month=invalid");
      expect(resBadMonth.status).toBe(400);

      const resBadMonthNum = await app.request("/api/calendar?month=2026-13");
      expect(resBadMonthNum.status).toBe(400);

      const resUnknownParam = await app.request("/api/calendar?month=2026-10&foo=bar");
      expect(resUnknownParam.status).toBe(400);
    });

    test("local-day bucketing, day boundaries, and item sorting", async () => {
      const app = createApp({ db, config });

      seedRun(db, [
        {
          source: "audiobookshelf",
          source_kind: "listening_session",
          source_id: "abs-1",
          media_type: "audiobook",
          title: "Book Morning",
          parent_title: "Author A",
          started_at: "2026-10-17T08:15:00.000Z", // 10:15 local
          duration_seconds: 1200,
        },
        {
          source: "manual",
          source_kind: "history_item",
          source_id: "man-1",
          media_type: "movie",
          title: "Movie Evening",
          started_at: "2026-10-17T18:00:00.000Z", // 20:00 local
          duration_seconds: 7200,
        },
        // Event at 23:30 UTC on CEST day lands on NEXT local day (2026-10-18 01:30)
        {
          source: "simkl",
          source_kind: "watch",
          source_id: "simkl-1",
          media_type: "episode",
          title: "Late Show",
          parent_title: "Series S",
          season: 1,
          episode: 2,
          started_at: "2026-10-17T23:30:00.000Z", // 2026-10-18 01:30 CEST local
          duration_seconds: 1800,
        },
      ]);

      const res = await app.request("/api/calendar?month=2026-10");
      expect(res.status).toBe(200);
      const body = (await res.json()) as CalendarResult;
      expect(body.month).toBe("2026-10");
      expect(body.days).toHaveLength(2);

      const day1 = body.days[0]!;
      expect(day1.date).toBe("2026-10-17");
      expect(day1.count).toBe(2);
      expect(day1.minutes).toBe(140); // (1200 + 7200) / 60
      expect(day1.items).toHaveLength(2);
      expect(day1.items[0]?.title).toBe("Book Morning");
      expect(day1.items[0]?.local_time).toBe("10:15");
      expect(day1.items[1]?.title).toBe("Movie Evening");
      expect(day1.items[1]?.local_time).toBe("20:00");

      const day2 = body.days[1]!;
      expect(day2.date).toBe("2026-10-18");
      expect(day2.count).toBe(1);
      expect(day2.minutes).toBe(30);
      expect(day2.items[0]?.title).toBe("Late Show");
      expect(day2.items[0]?.local_time).toBe("01:30");
      expect(day2.items[0]?.season).toBe(1);
      expect(day2.items[0]?.episode).toBe(2);
    });

    test("source filter isolates calendar activity", async () => {
      const app = createApp({ db, config });

      seedRun(db, [
        {
          source: "audiobookshelf",
          source_kind: "listening_session",
          source_id: "abs-1",
          media_type: "audiobook",
          title: "ABS Title",
          started_at: "2026-10-17T08:00:00.000Z",
          duration_seconds: 1800,
        },
        {
          source: "manual",
          source_kind: "history_item",
          source_id: "man-1",
          media_type: "book",
          title: "Manual Title",
          started_at: "2026-10-17T12:00:00.000Z",
          duration_seconds: 3600,
        },
      ]);

      const resAbs = await app.request("/api/calendar?month=2026-10&source=audiobookshelf");
      const bodyAbs = (await resAbs.json()) as CalendarResult;
      expect(bodyAbs.days[0]?.count).toBe(1);
      expect(bodyAbs.days[0]?.items[0]?.title).toBe("ABS Title");

      const resMan = await app.request("/api/calendar?month=2026-10&source=manual");
      const bodyMan = (await resMan.json()) as CalendarResult;
      expect(bodyMan.days[0]?.count).toBe(1);
      expect(bodyMan.days[0]?.items[0]?.title).toBe("Manual Title");
    });
  });

  describe("GET /api/heatmap/days", () => {
    test("validation: missing or bad year returns 400", async () => {
      const app = createApp({ db, config });

      const resMissing = await app.request("/api/heatmap/days");
      expect(resMissing.status).toBe(400);

      const resBad = await app.request("/api/heatmap/days?year=26");
      expect(resBad.status).toBe(400);

      const resUnknown = await app.request("/api/heatmap/days?year=2026&bad=1");
      expect(resUnknown.status).toBe(400);
    });

    test("counts and minutes across DST changes (2026-03-29, 2026-10-25)", async () => {
      const app = createApp({ db, config });

      seedRun(db, [
        // Spring forward
        {
          source: "audiobookshelf",
          source_kind: "listening_session",
          source_id: "s1",
          media_type: "audiobook",
          started_at: "2026-03-29T00:30:00.000Z", // 01:30 local CET
          duration_seconds: 1200,
        },
        {
          source: "audiobookshelf",
          source_kind: "listening_session",
          source_id: "s2",
          media_type: "audiobook",
          started_at: "2026-03-29T01:30:00.000Z", // 03:30 local CEST
          duration_seconds: 1800,
        },
        // Fall back
        {
          source: "manual",
          source_kind: "history_item",
          source_id: "s3",
          media_type: "movie",
          started_at: "2026-10-25T01:30:00.000Z", // 02:30 local CET
          duration_seconds: 3600,
        },
      ]);

      const res = await app.request("/api/heatmap/days?year=2026");
      expect(res.status).toBe(200);
      const body = (await res.json()) as HeatmapDaysResult;
      expect(body.year).toBe("2026");
      expect(body.days).toHaveLength(2);

      expect(body.days[0]).toEqual({
        date: "2026-03-29",
        count: 2,
        minutes: 50, // (1200 + 1800) / 60
      });

      expect(body.days[1]).toEqual({
        date: "2026-10-25",
        count: 1,
        minutes: 60, // 3600 / 60
      });
    });
  });

  describe("GET /api/heatmap/hours", () => {
    test("validation and cell aggregation (weekday 0-6, hour 0-23)", async () => {
      const app = createApp({ db, config });

      const resBad = await app.request("/api/heatmap/hours?year=bad");
      expect(resBad.status).toBe(400);

      const resEmptyYear = await app.request("/api/heatmap/hours?year=");
      expect(resEmptyYear.status).toBe(400);

      // 2026-10-17 is Saturday (weekday 5)
      // 08:15 UTC is 10:15 CEST (hour 10)
      seedRun(db, [
        {
          source: "audiobookshelf",
          source_kind: "listening_session",
          source_id: "sat-1",
          media_type: "audiobook",
          started_at: "2026-10-17T08:15:00.000Z",
          duration_seconds: 1800,
        },
      ]);

      const res = await app.request("/api/heatmap/hours?year=2026");
      expect(res.status).toBe(200);
      const body = (await res.json()) as HeatmapHoursResult;
      expect(body.cells).toHaveLength(1);
      expect(body.cells[0]).toEqual({
        weekday: 5,
        hour: 10,
        count: 1,
        minutes: 30,
      });

      // Query without year works and includes all years
      const resNoYear = await app.request("/api/heatmap/hours");
      expect(resNoYear.status).toBe(200);
      const bodyNoYear = (await resNoYear.json()) as HeatmapHoursResult;
      expect(bodyNoYear.cells).toHaveLength(1);
    });
  });

  describe("GET /api/stats", () => {
    test("returns total items, total minutes, by_source, by_media_type", async () => {
      const app = createApp({ db, config });

      seedRun(db, [
        {
          source: "audiobookshelf",
          source_kind: "listening_session",
          source_id: "abs-s1",
          media_type: "audiobook",
          started_at: "2026-10-01T10:00:00.000Z",
          duration_seconds: 3600,
        },
        {
          source: "manual",
          source_kind: "history_item",
          source_id: "man-s1",
          media_type: "movie",
          started_at: "2026-10-02T10:00:00.000Z",
          duration_seconds: 7200,
        },
      ]);

      const res = await app.request("/api/stats");
      expect(res.status).toBe(200);
      const body = (await res.json()) as StatsResult;
      expect(body.total_items).toBe(2);
      expect(body.total_minutes).toBe(180);
      expect(body.by_source["audiobookshelf"]).toEqual({
        count: 1,
        items: 1,
        minutes: 60,
      });
      expect(body.by_media_type["movie"]).toEqual({
        count: 1,
        items: 1,
        minutes: 120,
      });

      // Filter by source
      const resFiltered = await app.request("/api/stats?source=manual");
      const bodyFiltered = (await resFiltered.json()) as StatsResult;
      expect(bodyFiltered.total_items).toBe(1);
      expect(bodyFiltered.total_minutes).toBe(120);
    });
  });

  describe("GET /api/in-progress", () => {
    test("returns latest media_progress rows with 0 < progress < 1", async () => {
      const app = createApp({ db, config });

      seedRun(db, [
        {
          source: "audiobookshelf",
          source_kind: "media_progress",
          source_id: "item-1",
          media_type: "audiobook",
          title: "Book In Progress",
          parent_title: "Author One",
          started_at: "2026-10-17T08:00:00.000Z",
          progress: 0.35,
        },
        {
          source: "audiobookshelf",
          source_kind: "media_progress",
          source_id: "item-2",
          media_type: "audiobook",
          title: "Book Completed",
          started_at: "2026-10-17T09:00:00.000Z",
          progress: 1.0,
        },
        {
          source: "audiobookshelf",
          source_kind: "media_progress",
          source_id: "item-3",
          media_type: "audiobook",
          title: "Book Not Started",
          started_at: "2026-10-17T10:00:00.000Z",
          progress: 0.0,
        },
      ]);

      const res = await app.request("/api/in-progress");
      expect(res.status).toBe(200);
      const body = (await res.json()) as InProgressItem[];
      expect(body).toHaveLength(1);
      expect(body[0]?.title).toBe("Book In Progress");
      expect(body[0]?.parent_title).toBe("Author One");
      expect(body[0]?.progress).toBe(0.35);

      // Source filter
      const resAbs = await app.request("/api/in-progress?source=audiobookshelf");
      expect(resAbs.status).toBe(200);
      expect((await resAbs.json()) as InProgressItem[]).toHaveLength(1);

      const resOther = await app.request("/api/in-progress?source=other");
      expect(resOther.status).toBe(200);
      expect((await resOther.json()) as InProgressItem[]).toHaveLength(0);
    });
  });

  describe("Counting rule: session synced three times", () => {
    test("one session synced three times with growing duration is counted once with latest duration", async () => {
      const app = createApp({ db, config });

      const base = {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "session-growth",
        media_type: "audiobook" as const,
        title: "Growing Session",
        started_at: "2026-10-17T12:00:00.000Z",
      };

      seedRun(db, [{ ...base, duration_seconds: 600 }]);
      seedRun(db, [{ ...base, duration_seconds: 1200 }]);
      seedRun(db, [{ ...base, duration_seconds: 2400 }]);

      // Calendar
      const calRes = await app.request("/api/calendar?month=2026-10");
      const cal = (await calRes.json()) as CalendarResult;
      expect(cal.days).toHaveLength(1);
      expect(cal.days[0]?.count).toBe(1);
      expect(cal.days[0]?.minutes).toBe(40); // 2400 / 60

      // Heatmap days
      const daysRes = await app.request("/api/heatmap/days?year=2026");
      const days = (await daysRes.json()) as HeatmapDaysResult;
      expect(days.days).toHaveLength(1);
      expect(days.days[0]?.count).toBe(1);
      expect(days.days[0]?.minutes).toBe(40);

      // Heatmap hours
      const hoursRes = await app.request("/api/heatmap/hours?year=2026");
      const hours = (await hoursRes.json()) as HeatmapHoursResult;
      expect(hours.cells).toHaveLength(1);
      expect(hours.cells[0]?.count).toBe(1);
      expect(hours.cells[0]?.minutes).toBe(40);

      // Stats
      const statsRes = await app.request("/api/stats");
      const stats = (await statsRes.json()) as StatsResult;
      expect(stats.total_items).toBe(1);
      expect(stats.total_minutes).toBe(40);
    });
  });

  describe("POST /api/events (manual entry)", () => {
    test("adds manual entry and reflects at the right local day", async () => {
      const app = createApp({ db, config });

      // started_at is a LOCAL time ("2026-10-17 21:30" CEST)
      const res = await app.request("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "movie",
          title: "Watched Movie",
          started_at: "2026-10-17 21:30",
          duration_seconds: 7200,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; inserted: number };
      expect(body.inserted).toBe(1);
      expect(typeof body.id).toBe("string");

      // Verify it appears in calendar on 2026-10-17 with local_time 21:30
      const calRes = await app.request("/api/calendar?month=2026-10");
      const cal = (await calRes.json()) as CalendarResult;
      expect(cal.days).toHaveLength(1);
      expect(cal.days[0]?.date).toBe("2026-10-17");
      expect(cal.days[0]?.items[0]?.title).toBe("Watched Movie");
      expect(cal.days[0]?.items[0]?.local_time).toBe("21:30");
      expect(cal.days[0]?.items[0]?.duration_seconds).toBe(7200);
    });

    test("validation error returns 400 with error message", async () => {
      const app = createApp({ db, config });

      const res = await app.request("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "invalid_type",
          title: "Bad Movie",
          started_at: "2026-10-17 21:30",
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/media_type/i);
    });

    test("malformed JSON body returns 400", async () => {
      const app = createApp({ db, config });

      const res = await app.request("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/json/i);
    });
  });

  describe("Export and Import routes", () => {
    test("GET /api/export.json and GET /api/export.csv return full archive with attachment header", async () => {
      const app = createApp({ db, config });

      seedRun(db, [
        {
          source: "audiobookshelf",
          source_kind: "listening_session",
          source_id: "s-exp-1",
          media_type: "audiobook",
          title: "Exported Title",
          started_at: "2026-10-17T08:00:00.000Z",
          duration_seconds: 900,
        },
      ]);

      // JSON export
      const resJson = await app.request("/api/export.json");
      expect(resJson.status).toBe(200);
      expect(resJson.headers.get("content-disposition")).toContain("attachment");
      expect(resJson.headers.get("content-type")).toContain("application/json");
      const textJson = await resJson.text();
      const parsedJson = JSON.parse(textJson);
      expect(parsedJson.format).toBe("inputtracker-export");
      expect(parsedJson.events).toHaveLength(1);
      expect(parsedJson.events[0].title).toBe("Exported Title");

      // CSV export
      const resCsv = await app.request("/api/export.csv");
      expect(resCsv.status).toBe(200);
      expect(resCsv.headers.get("content-disposition")).toContain("attachment");
      expect(resCsv.headers.get("content-type")).toContain("text/csv");
      const textCsv = await resCsv.text();
      expect(textCsv).toContain("record_hash");
      expect(textCsv).toContain("Exported Title");
    });

    test("POST /api/import via multipart form works and re-import inserts 0", async () => {
      const app = createApp({ db, config });

      seedRun(db, [
        {
          source: "manual",
          source_kind: "history_item",
          source_id: "imp-test-1",
          media_type: "book",
          title: "Original Book",
          started_at: "2026-10-17T08:00:00.000Z",
          duration_seconds: 1200,
        },
      ]);

      // Export json
      const resExport = await app.request("/api/export.json");
      const exportContent = await resExport.text();

      // Open a fresh second DB for import test
      const db2 = openDb(":memory:");
      const app2 = createApp({ db: db2, config });

      // First import into db2: 1 inserted
      const formData1 = new FormData();
      formData1.append(
        "file",
        new Blob([exportContent], { type: "application/json" }),
        "export.json"
      );

      const resImport1 = await app2.request("/api/import", {
        method: "POST",
        body: formData1,
      });
      expect(resImport1.status).toBe(200);
      const body1 = (await resImport1.json()) as { seen: number; inserted: number };
      expect(body1.seen).toBe(1);
      expect(body1.inserted).toBe(1);

      // Re-import into db2: 0 inserted
      const formData2 = new FormData();
      formData2.append(
        "file",
        new Blob([exportContent], { type: "application/json" }),
        "export.json"
      );

      const resImport2 = await app2.request("/api/import", {
        method: "POST",
        body: formData2,
      });
      expect(resImport2.status).toBe(200);
      const body2 = (await resImport2.json()) as { seen: number; inserted: number };
      expect(body2.seen).toBe(1);
      expect(body2.inserted).toBe(0);

      // Bad file content -> 400
      const badForm = new FormData();
      badForm.append("file", new Blob(["not-valid-json"], { type: "text/plain" }), "bad.txt");
      const resBad = await app2.request("/api/import", {
        method: "POST",
        body: badForm,
      });
      expect(resBad.status).toBe(400);

      // Missing file field -> 400
      const emptyForm = new FormData();
      emptyForm.append("other", "value");
      const resMissingFile = await app2.request("/api/import", {
        method: "POST",
        body: emptyForm,
      });
      expect(resMissingFile.status).toBe(400);

      // Query params on POST /api/import rejected -> 400
      const resImportBadQuery = await app2.request("/api/import?extra=1", {
        method: "POST",
        body: formData1,
      });
      expect(resImportBadQuery.status).toBe(400);

      // CSV export import test
      const resCsvExport = await app.request("/api/export.csv");
      const csvContent = await resCsvExport.text();
      const db3 = openDb(":memory:");
      const app3 = createApp({ db: db3, config });

      const formCsv = new FormData();
      formCsv.append("file", new Blob([csvContent], { type: "text/csv" }), "export.csv");
      const resCsvImport = await app3.request("/api/import", {
        method: "POST",
        body: formCsv,
      });
      expect(resCsvImport.status).toBe(200);
      const csvImportBody = (await resCsvImport.json()) as { seen: number; inserted: number };
      expect(csvImportBody.seen).toBe(1);
      expect(csvImportBody.inserted).toBe(1);
    });

    test("POST /api/events rejects unknown query params", async () => {
      const app = createApp({ db, config });
      const res = await app.request("/api/events?foo=bar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "movie",
          title: "Watched Movie",
          started_at: "2026-10-17 21:30",
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Static serving and SPA fallback", () => {
    test("serves file, performs SPA fallback, rejects traversal, returns 404 when dir missing", async () => {
      const app = createApp({ db, config, webDist: tempWebDir });

      // Static file served
      const resFile = await app.request("/style.css");
      expect(resFile.status).toBe(200);
      expect(await resFile.text()).toBe("body { color: red; }");

      // Root serves index.html
      const resRoot = await app.request("/");
      expect(resRoot.status).toBe(200);
      expect(await resRoot.text()).toContain("SPA App");

      // SPA fallback on non-existent path
      const resSpa = await app.request("/calendar/view");
      expect(resSpa.status).toBe(200);
      expect(await resSpa.text()).toContain("SPA App");

      // Path traversal rejected
      const resTraversal = await app.request("/..%2fsecret.txt");
      expect(resTraversal.status).toBe(403);

      const resTraversalEncoded = await app.request("/%2e%2e%2fsecret.txt");
      expect(resTraversalEncoded.status).toBe(403);

      // Unknown /api and /api/* routes return 404 JSON, does not fall back to SPA index.html
      const resApi = await app.request("/api");
      expect(resApi.status).toBe(404);
      expect(((await resApi.json()) as { error: string }).error).toBe("Not found");

      const resApiNotFound = await app.request("/api/does-not-exist");
      expect(resApiNotFound.status).toBe(404);
      const apiBody = (await resApiNotFound.json()) as { error: string };
      expect(apiBody.error).toBe("Not found");

      // When webDist directory is missing: returns 404 text
      const appMissingDist = createApp({
        db,
        config,
        webDist: join(tmpdir(), "nonexistent-dir-" + Date.now()),
      });
      const resMissing = await appMissingDist.request("/anything");
      expect(resMissing.status).toBe(404);
      expect(await resMissing.text()).toBe("Not found");
    });
  });
});
