import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { openDb } from "../src/core/db.ts";
import type { Config } from "../src/core/config.ts";
import { insertEvents, type NewEvent } from "../src/core/events.ts";
import { intervalDayRecords, shortformDay } from "../src/core/shortform.ts";
import { LocalDbSink } from "../src/core/sink.ts";
import { createActivityWatchClient, type FetchFn } from "../src/sources/activitywatch/client.ts";
import { backfillActivityWatch, syncActivityWatch } from "../src/sources/activitywatch/sync.ts";
import { mapBucketEvents, mergePlaysByVideoDay } from "../src/sources/activitywatch/map.ts";
import { mergeStoredShortformDays } from "../src/sources/activitywatch/shortform.ts";
import { importYoutubeTakeout, applyTakeoutGapRule } from "../src/sources/youtube/takeout.ts";
import { getCalendar, getHeatmapDays, getHeatmapHours, getStats } from "../src/server/aggregate.ts";
import { getLibrary } from "../src/server/library.ts";
import { getMonthReview, getSeries, getYearReviewV2 } from "../src/server/review.ts";
import { computeYearReview } from "../src/server/year-review.ts";
import { getTop } from "../src/server/top.ts";
import { parseWorkEdit } from "../src/server/overrides.ts";
import { saveArchiveEntry } from "../src/server/archive.ts";
import { handleShortform, MAX_INGEST_BYTES, parseShortformBody } from "../src/server/ingest.ts";
import { buildHomeDayDetailModel, filterAndEnrichCalendarDays } from "../web/src/lib/home.ts";
import type { AwRawEvent } from "../src/sources/activitywatch/types.ts";

const TZ = "Europe/Bratislava";
const NOW = Date.parse("2026-10-20T12:00:00Z");
function shorts(timestamp = "2026-10-17T10:00:00Z", duration = 10): AwRawEvent {
  return { timestamp, duration, data: { url: "https://www.youtube.com/shorts/FakeShort01", title: "Synthetic short", audible: false } };
}
function view(time: string, id: string): NewEvent {
  return { source: "youtube", source_kind: "history_item", source_id: `${id}:${time}`, media_type: "video", title: "Synthetic view", started_at: time, external_ids: { youtube_video: id } };
}
function exportViews(times: string[]): string {
  return JSON.stringify(times.map((time, i) => ({ time, title: `Watched Synthetic ${i}`, titleUrl: `https://youtube.com/watch?v=FakeVideo0${i}`, products: ["YouTube"] })));
}

describe("short-form daily time", () => {
  test("muted sub-30-second Shorts merge, bypass video thresholds, retain no item identity", () => {
    const mapped = mapBucketEvents([shorts(), shorts("2026-10-17T11:00:00Z", 20), { ...shorts(), data: { ...shorts().data, incognito: true } }], { bucketId: "fake", device: "pc" });
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.source_id).toBe("aw:2026-10-17");
    expect(mapped[0]?.duration_seconds).toBe(30);
    expect(mapped[0]?.media_type).toBe("shortform");
    expect(JSON.stringify(mapped)).not.toContain("FakeShort01");
    expect(JSON.stringify(mapped)).not.toContain("Synthetic short");
    expect(mergePlaysByVideoDay(mapped, { minWatchMinutes: 5 })).toEqual(mapped);
  });

  test("local midnight and DST boundaries split time without duplicating overlaps", () => {
    const rows = intervalDayRecords([[Date.parse("2026-10-24T21:59:50Z"), Date.parse("2026-10-24T22:00:20Z")]], "aw", TZ);
    expect(rows.map((e) => [e.source_id, e.duration_seconds])).toEqual([["aw:2026-10-24", 10], ["aw:2026-10-25", 20]]);
    const dst = intervalDayRecords([[Date.parse("2026-10-25T00:59:50Z"), Date.parse("2026-10-25T01:00:20Z")]], "aw", TZ);
    expect(dst).toHaveLength(1);
    expect(dst[0]?.duration_seconds).toBe(30);
  });

  test("partial windows, multiple buckets, repeated sync and corrected durations are append-only", () => {
    const db = openDb(":memory:");
    const write = (raw: AwRawEvent[], bucket: string, from: string, to: string) => insertEvents(db, null, mergeStoredShortformDays(db, mapBucketEvents(raw, { bucketId: bucket, device: "pc" }), TZ, { bucket, from, to }));
    expect(write([shorts()], "a", "2026-10-17T09:00:00Z", "2026-10-17T11:00:00Z").inserted).toBe(1);
    expect(write([shorts()], "a", "2026-10-17T09:00:00Z", "2026-10-17T11:00:00Z").inserted).toBe(0);
    write([shorts("2026-10-17T10:00:05Z", 10)], "b", "2026-10-17T09:00:00Z", "2026-10-17T11:00:00Z");
    expect(getStats(db).total_minutes).toBe(15 / 60); // overlap measured once
    write([shorts("2026-10-17T12:00:00Z", 20)], "a", "2026-10-17T11:00:00Z", "2026-10-17T13:00:00Z");
    expect(getStats(db).total_minutes).toBe(35 / 60);
    write([shorts("2026-10-17T12:00:00Z", 5)], "a", "2026-10-17T11:00:00Z", "2026-10-17T13:00:00Z");
    expect(getStats(db).total_minutes).toBe(20 / 60);
    expect(write([shorts("2026-10-17T12:00:00Z", 20)], "a", "2026-10-17T11:00:00Z", "2026-10-17T13:00:00Z").inserted).toBe(1);
    expect(getStats(db).total_minutes).toBe(35 / 60);
    expect(write([shorts("2026-10-17T12:00:00Z", 20)], "a", "2026-10-17T11:00:00Z", "2026-10-17T13:00:00Z").inserted).toBe(0);
    write([], "a", "2026-10-17T11:00:00Z", "2026-10-17T13:00:00Z");
    expect(getStats(db).total_minutes).toBe(15 / 60);
    expect(db.query("SELECT * FROM events_latest WHERE source_kind = 'shortform_day'").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM events WHERE source_kind = 'shortform_day'").all().length).toBeGreaterThan(1);
    db.close();
  });

  test("Takeout dropped gaps become estimated day records, overlap imports are idempotent", () => {
    const db = openDb(":memory:");
    const input = exportViews(["2026-10-17T10:00:00Z", "2026-10-17T10:00:20Z", "2026-10-17T10:00:50Z"]);
    importYoutubeTakeout(db, input);
    const row = db.query<{ duration_seconds: number; raw: string }, []>("SELECT duration_seconds, raw FROM events_latest WHERE source_kind = 'shortform_day'").get()!;
    expect(row.duration_seconds).toBe(50);
    expect(JSON.parse(row.raw).estimated).toBe("gap");
    expect(importYoutubeTakeout(db, input).inserted).toBe(0);
    importYoutubeTakeout(db, exportViews(["2026-10-17T09:00:00Z", "2026-10-17T09:00:10Z"]));
    expect(db.query<{ duration_seconds: number }, []>("SELECT duration_seconds FROM events_latest WHERE source_kind = 'shortform_day'").get()?.duration_seconds).toBe(60);
    // Importing a smaller overlapping file must not discard other intervals.
    importYoutubeTakeout(db, input);
    expect(db.query<{ duration_seconds: number }, []>("SELECT duration_seconds FROM events_latest WHERE source_kind = 'shortform_day'").get()?.duration_seconds).toBe(60);
    db.close();
  });

  test("mocked GET-only sync and multi-chunk backfill keep days idempotent across boundaries", async () => {
    const db = openDb(":memory:");
    const config = { timezone: TZ, activitywatch: { url: "http://aw.synthetic", timeout_s: 5, device: "pc", include_music: false }, youtube: { min_watch_minutes: 5 }, covers: { external: false } } as Config;
    let observations = [shorts("2026-10-07T21:59:50Z", 30), shorts("2026-10-20T10:00:00Z", 20)];
    const fetch: FetchFn = async (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = new URL(String(input));
      if (url.pathname === "/api/0/buckets/") return Response.json({ synthetic: { id: "synthetic", type: "web.tab.current" } });
      expect(url.pathname).toBe("/api/0/buckets/synthetic/events");
      const from = Date.parse(url.searchParams.get("start")!), to = Date.parse(url.searchParams.get("end")!);
      return Response.json(observations.filter((e) => Date.parse(e.timestamp) < to && Date.parse(e.timestamp) + e.duration * 1000 > from));
    };
    const deps = { db, config, client: createActivityWatchClient(config.activitywatch, { fetch }), sink: new LocalDbSink(db), now: () => new Date(NOW), fetch };
    expect((await syncActivityWatch(deps)).inserted).toBe(1);
    expect((await syncActivityWatch(deps)).inserted).toBe(0);
    await backfillActivityWatch({ ...deps, since: "2026-10-01" });
    expect(getStats(db).total_minutes).toBe(50 / 60);
    expect((await backfillActivityWatch({ ...deps, since: "2026-10-01" })).inserted).toBe(0);
    expect(db.query<{ source_id: string; duration_seconds: number }, []>("SELECT source_id, duration_seconds FROM events_latest ORDER BY source_id").all()).toEqual([
      { source_id: "aw:2026-10-07", duration_seconds: 10 },
      { source_id: "aw:2026-10-08", duration_seconds: 20 },
      { source_id: "aw:2026-10-20", duration_seconds: 20 },
    ]);
    observations = [observations[0]!, shorts("2026-10-20T10:00:00Z", 5)];
    expect((await syncActivityWatch(deps)).inserted).toBe(1);
    expect(getStats(db).total_minutes).toBe(35 / 60);
    expect((await syncActivityWatch(deps)).inserted).toBe(0);
    expect(getLibrary(db).works).toEqual([]);
    expect(db.query("SELECT * FROM events WHERE source_kind != 'shortform_day'").all()).toEqual([]);
    db.close();
  });

  test("music is exempt from gap conversion and dropped gaps split at local midnight", () => {
    const views = [view("2026-10-17T21:59:50Z", "FakeVideo01"), view("2026-10-17T22:00:20Z", "FakeVideo02")];
    expect(applyTakeoutGapRule(views).shortform.map((e) => e.duration_seconds)).toEqual([10, 20]);
    expect(applyTakeoutGapRule([{ ...views[0]!, external_ids: { youtube_music: true } }, views[1]!]).shortform).toEqual([]);
  });

  test("a growing ActivityWatch Short crossing midnight keeps its observation cursor", async () => {
    const db = openDb(":memory:");
    const config = { timezone: TZ, activitywatch: { url: "http://aw.synthetic", timeout_s: 5, device: "pc", include_music: false }, youtube: { min_watch_minutes: 5 } } as Config;
    let seconds = 120;
    let now = new Date("2026-10-17T22:01:00Z");
    const fetch: FetchFn = async (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = new URL(String(input));
      if (url.pathname === "/api/0/buckets/") return Response.json({ synthetic: { id: "synthetic", type: "web.tab.current" } });
      expect(url.pathname).toBe("/api/0/buckets/synthetic/events");
      const event = shorts("2026-10-17T21:59:00Z", seconds);
      return Response.json(Date.parse(event.timestamp) >= Date.parse(url.searchParams.get("start")!) ? [event] : []);
    };
    const deps = { db, config, client: createActivityWatchClient(config.activitywatch, { fetch }), sink: new LocalDbSink(db), now: () => now, fetch };
    await syncActivityWatch(deps);
    expect(db.query<{ cursor: string }, []>("SELECT cursor FROM sync_state WHERE source='activitywatch:synthetic'").get()?.cursor).toBe("2026-10-17T21:59:00.000Z");
    now = new Date("2026-10-17T22:20:00Z");
    seconds = 1260;
    await syncActivityWatch(deps);
    expect(getStats(db).total_minutes).toBe(21);
    expect((await syncActivityWatch(deps)).inserted).toBe(0);
    expect(getCalendar(db, "2026-10", TZ).days.map((d) => [d.date, d.minutes])).toEqual([["2026-10-17", 1], ["2026-10-18", 20]]);
    db.close();
  });

  test("short-form cannot be created or assigned as an archived Library work", () => {
    const db = openDb(":memory:");
    expect(() => parseWorkEdit({ category: "shortform" })).toThrow();
    expect(() => saveArchiveEntry(db, {
      entry_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      work: { provider: "manual", category: "shortform", title: "Synthetic time", year: null, creators: [], seasons: [], runtime_minutes: null, pages: null },
      consumed: { minutes_override: 5 }, when: { precision: "day", date: "2026-10-17" },
    }, TZ)).toThrow("daily time");
    expect(db.query("SELECT * FROM events").all()).toEqual([]);
    db.close();
  });

  test("measured wins in every time read, phone stays separate, and no library/items/rankings", () => {
    const db = openDb(":memory:");
    const records = [shortformDay("2026-10-17", 600, "youtube", "takeout", TZ), shortformDay("2026-10-17", 120, "youtube", "aw", TZ), shortformDay("2026-10-17", 60, "phone", "phone:instagram", TZ)];
    insertEvents(db, null, records);
    const stats = getStats(db);
    expect(stats.total_minutes).toBe(3);
    expect(stats.total_items).toBe(0);
    expect(stats.by_media_type.shortform?.count).toBe(0);
    expect(stats.top_items).toEqual([]);
    expect(getLibrary(db).works).toEqual([]);
    expect(getTop(db, { kind: "channels" }).entries).toEqual([]);
    const calendar = getCalendar(db, "2026-10", TZ);
    expect(calendar.days[0]?.count).toBe(0);
    expect(calendar.days[0]?.minutes).toBe(3);
    expect(filterAndEnrichCalendarDays(calendar.days, ["shortform"])[0]?.count).toBe(0);
    expect(getHeatmapDays(db, 2026, TZ).days[0]).toEqual({ date: "2026-10-17", count: 0, minutes: 3 });
    expect(getHeatmapHours(db, 2026, TZ)).toEqual({ cells: [], unplaced_count: 0, unplaced_minutes: 3 });
    expect(getSeries(db, { bucket: "day", from: "2026-10-17", to: "2026-10-17" }).points[0]?.minutes_by_category.shortform).toBe(3);
    const month = getMonthReview(db, "2026-10");
    expect(month.total_minutes).toBe(3);
    expect(month.categories).toEqual([{ category: "shortform", total_minutes: 3, works: 0, units: 0 }]);
    expect(month.active_days).toBe(1);
    expect(month.top_works).toEqual([]);
    expect(month.hour_weekday.flat().reduce((a, b) => a + b, 0)).toBe(0);
    expect(getYearReviewV2(db, 2026).total_minutes).toBe(3);
    expect(getYearReviewV2(db, 2026).categories[0]?.units).toBe(0);
    const detail = buildHomeDayDetailModel({ day: calendar.days[0], date: "2026-10-17", todayStr: "2026-10-20" });
    expect(detail.shortformMinutes).toBe(3);
    expect(detail.works).toEqual([]);
    expect(detail.youtube).toBeNull();
    expect(detail.isEmpty).toBe(false);
    const legacyReview = computeYearReview(records.map((e, i) => ({ ...e, id: i, title: e.title ?? null })), TZ, 2026, "2026-10-20");
    expect(legacyReview.totals.items).toBe(0);
    expect(legacyReview.totals.titles).toBe(0);
    db.close();
  });
});

describe("phone daily short-form ingest", () => {
  function setup(token = "synthetic-token") {
    const db = openDb(":memory:");
    const config = { timezone: TZ, ingest: { token } } as Config;
    const app = new Hono();
    app.post("/api/ingest/shortform", (c) => handleShortform(c, { db, config, nowMs: () => NOW }));
    return { db, app };
  }
  const body = { days: [{ date: "2026-10-17", app: "instagram", seconds: 120 }] };
  const request = (app: Hono, data: unknown, token = "synthetic-token") => app.request("/api/ingest/shortform", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });

  test("auth, disabled, size limits, unchanged replay and changed daily totals", async () => {
    const { db, app } = setup();
    expect((await request(app, body, "wrong")).status).toBe(401);
    expect((await request(app, { ...body, padding: "x".repeat(MAX_INGEST_BYTES) })).status).toBe(413);
    expect(await (await request(app, body)).json()).toEqual({ accepted: 1, inserted: 1 });
    expect(await (await request(app, body)).json()).toEqual({ accepted: 1, inserted: 0 });
    expect(await (await request(app, { days: [{ ...body.days[0], seconds: 90 }] })).json()).toEqual({ accepted: 1, inserted: 1 });
    expect(getStats(db).total_minutes).toBe(1.5);
    expect(await (await request(app, body)).json()).toEqual({ accepted: 1, inserted: 1 });
    expect(await (await request(app, body)).json()).toEqual({ accepted: 1, inserted: 0 });
    expect(getStats(db).total_minutes).toBe(2);
    const rows = db.query<{ source_id: string; source: string; started_at: string }, []>("SELECT source_id, source, started_at FROM events_latest").all();
    expect(rows).toEqual([{ source_id: "phone:instagram:2026-10-17", source: "phone", started_at: "2026-10-16T22:00:00.000Z" }]);
    expect((await app.request("/api/ingest/shortform", { method: "POST", headers: { Authorization: "Bearer synthetic-token", "Content-Length": String(MAX_INGEST_BYTES + 1) }, body: "{}" })).status).toBe(413);
    const disabled = setup("");
    expect((await request(disabled.app, body)).status).toBe(503);
    disabled.db.close(); db.close();
  });

  test("rejects invalid dates, future days, apps, seconds, duplicates and invalid batches atomically", async () => {
    const { db, app } = setup();
    for (const patch of [{ date: "2026-02-30" }, { date: "2026-13-01" }, { date: "2026-10-21" }, { date: "17-10-2026" }, { seconds: -1 }, { seconds: 86401 }, { seconds: 1.2 }, { seconds: "20" }, { app: "" }, { app: "x".repeat(101) }, { app: "a:b" }]) {
      expect((await request(app, { days: [body.days[0], { ...body.days[0], ...patch }] })).status).toBe(400);
    }
    for (const data of [{}, { days: [] }, { days: Array(201).fill(body.days[0]) }, { days: [body.days[0], body.days[0]] }]) expect((await request(app, data)).status).toBe(400);
    expect((await app.request("/api/ingest/shortform", { method: "POST", headers: { Authorization: "Bearer synthetic-token" }, body: "{" })).status).toBe(400);
    expect(db.query("SELECT * FROM events").all()).toEqual([]);
    expect(parseShortformBody({ days: [{ date: "2026-10-20", app: "com.fake.app", seconds: 0 }] }, NOW)[0]?.duration_seconds).toBe(0);
    expect(parseShortformBody({ days: [{ date: "2026-10-20", app: "tiktok", seconds: 86400 }] }, NOW)[0]?.duration_seconds).toBe(86400);
    db.close();
  });
});
