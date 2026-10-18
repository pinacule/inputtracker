import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Config } from "../src/core/config.ts";
import type {
  ArchiveEntrySummary,
  ArchiveRequest,
  ArchiveResult,
  LibraryResult,
  LibraryWorkDetail,
  MonthReview,
  WorkDetails,
  YearReviewV2,
} from "../src/core/contract.ts";
import { migrate, migrations, openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun } from "../src/core/events.ts";
import type { EventRow } from "../src/core/schema.ts";
import {
  CONSUMPTION_KINDS,
  coverUrlFor,
  type CalendarResult,
  type HeatmapDaysResult,
  type HeatmapHoursResult,
  type StatsResult,
} from "../src/server/aggregate.ts";
import { createApp } from "../src/server/app.ts";
import type { InsightsResult } from "../src/server/insights.ts";

const TZ = "Europe/Bratislava";
const ENTRY_ID_1 = "11111111-2222-4333-8444-555555555555";
const ENTRY_ID_2 = "22222222-3333-4444-8555-666666666666";
const ENTRY_ID_3 = "33333333-4444-4555-8666-777777777777";

function mockConfig(): Config {
  const cfg: Config = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://abs.invalid:13378", token: "secret", timeout_s: 20 },
    simkl: {
      client_id: "",
      base_url: "https://api.simkl.test",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: {
      desktop: false,
      ntfy_url: "",
      ntfy_token: "",
      app_url: "",
      weekly_summary: false,
    },
    toJSON: () => ({}),
    toString: () => "{}",
  };
  return cfg;
}

function syntheticAnimeWork(): WorkDetails {
  return {
    provider: "anilist",
    provider_id: "101348",
    category: "anime",
    title: "Synthetic Saga",
    original_title: "Synthetic Saga Original",
    year: 2019,
    cover_url: "/api/meta-cover/anilist/101348",
    creators: ["Synthetic Studio"],
    genres: ["Action", "Adventure"],
    description: "A synthetic two-season anime epic.",
    seasons: [
      {
        number: 1,
        title: "Season 1",
        year: 2019,
        episodes: 24,
        episode_minutes: 24,
        total_minutes: 576,
        provider_id: "101348",
      },
      {
        number: 2,
        title: "Season 2",
        year: 2023,
        episodes: 24,
        episode_minutes: 24,
        total_minutes: 576,
        provider_id: "136010",
      },
    ],
    runtime_minutes: null,
    pages: null,
    external_ids: {
      anilist: "101348",
      mal: "37521",
    },
  };
}

describe("Migration v4 (events_latest hides tombstones)", () => {
  test("upgrades an existing v3 database, hides raw.deleted rows in events_latest, and preserves all rows in events", () => {
    const v3Db = new Database(":memory:");
    v3Db.run("PRAGMA foreign_keys = ON;");
    v3Db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    // Apply only v1, v2, v3
    for (const m of migrations.filter((x) => x.version <= 3)) {
      m.up(v3Db);
      v3Db.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);",
        [m.version, "2026-10-01T00:00:00.000Z"]
      );
    }

    const runId = startRun(v3Db, "manual", "archive");
    insertEvents(v3Db, runId, [
      {
        source: "manual",
        source_kind: "archive",
        source_id: "archive:e1:s1",
        media_type: "episode",
        title: "Synthetic Saga",
        season: 1,
        started_at: "2021-05-01T10:00:00.000Z",
        duration_seconds: 34560,
        raw: { category: "anime", entry_id: "e1" },
      },
      {
        source: "manual",
        source_kind: "archive",
        source_id: "archive:e1:s2",
        media_type: "episode",
        title: "Synthetic Saga",
        season: 2,
        started_at: "2021-05-01T10:00:00.000Z",
        duration_seconds: 34560,
        raw: { category: "anime", entry_id: "e1" },
      },
    ]);
    // Insert a tombstone for s2 before upgrading to v4
    insertEvents(v3Db, runId, [
      {
        source: "manual",
        source_kind: "archive",
        source_id: "archive:e1:s2",
        media_type: "episode",
        title: "Synthetic Saga",
        season: 2,
        started_at: "2021-05-01T10:00:00.000Z",
        ended_at: "2021-05-01T10:00:00.000Z",
        duration_seconds: 0,
        raw: { category: "anime", entry_id: "e1", deleted: true },
      },
    ]);
    finishRun(v3Db, runId, { status: "ok", rowsSeen: 3, rowsInserted: 3 });

    // Under v3, events_latest still returns the tombstone row (2 rows total)
    const v3Latest = v3Db
      .query<EventRow, []>("SELECT * FROM events_latest ORDER BY id ASC;")
      .all();
    expect(v3Latest).toHaveLength(2);

    // Upgrade to v4 via migrate()
    migrate(v3Db);

    const versions = v3Db
      .query<{ version: number }, []>(
        "SELECT version FROM schema_migrations ORDER BY version ASC;"
      )
      .all()
      .map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4]);

    // After v4 upgrade, events_latest hides the tombstoned s2 row
    const v4Latest = v3Db
      .query<EventRow, []>("SELECT * FROM events_latest ORDER BY id ASC;")
      .all();
    expect(v4Latest).toHaveLength(1);
    expect(v4Latest[0]?.source_id).toBe("archive:e1:s1");

    // All 3 rows remain in `events`
    const allEvents = v3Db
      .query<EventRow, []>("SELECT * FROM events ORDER BY id ASC;")
      .all();
    expect(allEvents).toHaveLength(3);

    v3Db.close();
  });
});

describe("CONSUMPTION_KINDS and coverUrlFor for archive events", () => {
  test("CONSUMPTION_KINDS includes archive", () => {
    expect(CONSUMPTION_KINDS.has("archive")).toBe(true);
  });

  test("coverUrlFor returns /api/meta-cover/<provider>/<id> and validates both parts", () => {
    expect(
      coverUrlFor({
        source: "manual",
        source_kind: "archive",
        external_ids: { meta_provider: "anilist", meta_id: "101348" },
      })
    ).toBe("/api/meta-cover/anilist/101348");

    expect(
      coverUrlFor({
        source: "manual",
        source_kind: "archive",
        external_ids: JSON.stringify({
          meta_provider: "openlibrary",
          meta_id: "OL45804W",
        }),
      })
    ).toBe("/api/meta-cover/openlibrary/OL45804W");

    // Invalid provider or id rejected
    for (const bad of [
      { meta_provider: "unknown", meta_id: "101348" },
      { meta_provider: "../etc", meta_id: "101348" },
      { meta_provider: "anilist", meta_id: "../passwd" },
      { meta_provider: "anilist", meta_id: "id with spaces" },
      { meta_provider: "anilist", meta_id: "" },
      { meta_provider: "anilist", meta_id: "a".repeat(65) },
      { meta_provider: "anilist" },
      {},
    ]) {
      expect(
        coverUrlFor({
          source: "manual",
          source_kind: "archive",
          external_ids: bad,
        })
      ).toBeNull();
    }
  });
});

describe("Archive entry lifecycle (Vinland Saga-like 2 seasons × 24 ep × 24 min = 1152 min)", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();
  });

  test("full lifecycle: create, library & month review, excluded from calendar, idempotent re-send, edit to 1 season tombstones season 2, delete hides everywhere while events keeps history", async () => {
    const app = createApp({ db, config });

    const req2Seasons: ArchiveRequest = {
      entry_id: ENTRY_ID_1,
      work: syntheticAnimeWork(),
      consumed: {
        seasons: [{ number: 1 }, { number: 2 }],
      },
      when: {
        precision: "month",
        date: "2021-05",
      },
      rating: 9,
      note: "Synthetic masterpiece",
    };

    // 1. Create entry with 2 seasons (2 × 24 × 24 = 1152 min)
    const createRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req2Seasons),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as ArchiveResult;
    expect(created).toEqual({
      entry_id: ENTRY_ID_1,
      inserted: 2,
      units: 2,
      total_minutes: 1152,
      estimated: true,
    });

    // 2. Re-sending the identical request is a no-op (inserted: 0)
    const resendRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req2Seasons),
    });
    expect(resendRes.status).toBe(200);
    const resent = (await resendRes.json()) as ArchiveResult;
    expect(resent.inserted).toBe(0);
    expect(resent.total_minutes).toBe(1152);
    expect(resent.units).toBe(2);

    const countAfterResend = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get()!.n;
    expect(countAfterResend).toBe(2);

    const annCountAfterResend = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM annotations;")
      .get()!.n;
    expect(annCountAfterResend).toBe(1);

    // 3. Shows up in Library Anime totals
    const libRes = await app.request("/api/library?category=anime");
    expect(libRes.status).toBe(200);
    const lib = (await libRes.json()) as LibraryResult;
    expect(lib.total_minutes).toBe(1152);
    expect(lib.categories).toEqual([
      {
        category: "anime",
        total_minutes: 1152,
        works: 1,
        units: 2,
      },
    ]);
    expect(lib.works).toHaveLength(1);
    expect(lib.works[0]).toMatchObject({
      category: "anime",
      title: "Synthetic Saga",
      cover_url: "/api/meta-cover/anilist/101348",
      total_minutes: 1152,
      units: 2,
      status: "finished",
      rating: 9,
      sources: ["manual"],
    });

    // Work detail shows both seasons with 24 watched episodes and note
    const workKey = lib.works[0]!.key;
    const detailRes = await app.request(
      `/api/library/work?key=${encodeURIComponent(workKey)}`
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as LibraryWorkDetail;
    expect(detail.note).toBe("Synthetic masterpiece");
    expect(detail.seasons.map((s) => [s.number, s.episodes, s.watched_episodes])).toEqual([
      [1, 24, 24],
      [2, 24, 24],
    ]);
    expect(detail.history).toHaveLength(2);
    expect(detail.history[0]?.precision).toBe("month");
    expect(detail.history[0]?.entry_id).toBe(ENTRY_ID_1);

    // 4. Shows up in Month Review for 2021-05 (including undated_minutes)
    const mrRes = await app.request("/api/review/month?month=2021-05");
    expect(mrRes.status).toBe(200);
    const mr = (await mrRes.json()) as MonthReview;
    expect(mr.month).toBe("2021-05");
    expect(mr.total_minutes).toBe(1152);
    expect(mr.undated_minutes).toBe(1152);
    expect(mr.active_days).toBe(0);
    expect(mr.longest_streak_days).toBe(0);
    expect(mr.categories).toEqual([
      {
        category: "anime",
        total_minutes: 1152,
        works: 1,
        units: 2,
      },
    ]);
    expect(mr.top_works).toHaveLength(1);
    expect(mr.top_works[0]?.title).toBe("Synthetic Saga");
    expect(mr.top_works[0]?.total_minutes).toBe(1152);

    // 5. Does NOT appear on Calendar, Heatmap Days, Heatmap Hours, or Streaks when precision is `month`
    const calRes = await app.request("/api/calendar?month=2021-05");
    const cal = (await calRes.json()) as CalendarResult;
    expect(cal.days).toHaveLength(0);

    const hmDaysRes = await app.request("/api/heatmap/days?year=2021");
    const hmDays = (await hmDaysRes.json()) as HeatmapDaysResult;
    expect(hmDays.days).toHaveLength(0);

    const hmHoursRes = await app.request("/api/heatmap/hours?year=2021");
    const hmHours = (await hmHoursRes.json()) as HeatmapHoursResult;
    expect(hmHours.cells).toHaveLength(0);

    const insightsRes = await app.request("/api/insights?date=2022-05-01");
    const insights = (await insightsRes.json()) as InsightsResult;
    expect(insights.streaks.overall.longest).toBe(0);
    expect(insights.on_this_day.years).toHaveLength(0);

    // 6. Editing to 1 season tombstones season 2
    const req1Season: ArchiveRequest = {
      ...req2Seasons,
      consumed: {
        seasons: [{ number: 1 }],
      },
    };
    const editRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req1Season),
    });
    expect(editRes.status).toBe(200);
    const edited = (await editRes.json()) as ArchiveResult;
    expect(edited.units).toBe(1);
    expect(edited.total_minutes).toBe(576);
    expect(edited.inserted).toBeGreaterThanOrEqual(1);

    // Verify season 2 has a tombstone in `events` and is absent from `events_latest`
    const s2Rows = db
      .query<EventRow, [string]>(
        "SELECT * FROM events WHERE source_id = ? ORDER BY id ASC;"
      )
      .all(`archive:${ENTRY_ID_1}:s2`);
    expect(s2Rows).toHaveLength(2);
    const s2LatestInEvents = s2Rows[s2Rows.length - 1]!;
    expect(s2LatestInEvents.duration_seconds).toBe(0);
    expect(JSON.parse(s2LatestInEvents.raw!).deleted).toBe(true);

    const latestRowsAfterEdit = db
      .query<EventRow, []>("SELECT * FROM events_latest;")
      .all();
    expect(latestRowsAfterEdit).toHaveLength(1);
    expect(latestRowsAfterEdit[0]?.source_id).toBe(`archive:${ENTRY_ID_1}:s1`);

    // Library and Month Review now show 576 min and status in_progress (1 of 2 seasons watched)
    const libAfterEdit = (await (
      await app.request("/api/library?category=anime")
    ).json()) as LibraryResult;
    expect(libAfterEdit.total_minutes).toBe(576);
    expect(libAfterEdit.works[0]?.total_minutes).toBe(576);
    expect(libAfterEdit.works[0]?.units).toBe(1);
    expect(libAfterEdit.works[0]?.status).toBe("in_progress");

    const mrAfterEdit = (await (
      await app.request("/api/review/month?month=2021-05")
    ).json()) as MonthReview;
    expect(mrAfterEdit.total_minutes).toBe(576);
    expect(mrAfterEdit.undated_minutes).toBe(576);

    // GET /api/archive shows the updated 1-season summary
    const listRes = await app.request("/api/archive");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as ArchiveEntrySummary[];
    expect(list).toHaveLength(1);
    expect(list[0]?.entry_id).toBe(ENTRY_ID_1);
    expect(list[0]?.total_minutes).toBe(576);
    expect(list[0]?.consumed).toEqual({ seasons: [{ number: 1 }] });

    // 7. Deleting hides the entry everywhere while `events` keeps every row
    const rowsBeforeDelete = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get()!.n;

    const delRes = await app.request(`/api/archive/${ENTRY_ID_1}/delete`, {
      method: "POST",
    });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { deleted: number };
    expect(delBody.deleted).toBe(1); // s1 tombstoned (s2 was already tombstoned)

    // Repeat delete is idempotent
    const delAgainRes = await app.request(`/api/archive/${ENTRY_ID_1}/delete`, {
      method: "POST",
    });
    expect(delAgainRes.status).toBe(200);
    expect(((await delAgainRes.json()) as { deleted: number }).deleted).toBe(0);

    // Every historical row is preserved in `events` (+1 tombstone row for s1)
    const rowsAfterDelete = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get()!.n;
    expect(rowsAfterDelete).toBe(rowsBeforeDelete + 1);

    // Hidden everywhere in reads
    expect(
      ((await (await app.request("/api/archive")).json()) as ArchiveEntrySummary[])
    ).toHaveLength(0);
    const libAfterDel = (await (
      await app.request("/api/library")
    ).json()) as LibraryResult;
    expect(libAfterDel.works).toHaveLength(0);
    expect(libAfterDel.categories).toHaveLength(0);
    expect(libAfterDel.total_minutes).toBe(0);

    const mrAfterDel = (await (
      await app.request("/api/review/month?month=2021-05")
    ).json()) as MonthReview;
    expect(mrAfterDel.total_minutes).toBe(0);

    const statsAfterDel = (await (
      await app.request("/api/stats")
    ).json()) as StatsResult;
    expect(statsAfterDel.total_items).toBe(0);
    expect(statsAfterDel.total_minutes).toBe(0);
  });
});

describe("Archive units, duration rules, ranges and date precisions", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();
  });

  test("film viewings (times = 2), book pages estimate (pages * 1.5 * progress), audiobook override, and minutes_override priority", async () => {
    const app = createApp({ db, config });

    // Film watched twice: 120 * 2 = 240 min, 2 units (v1, v2), day precision -> appears on calendar!
    const filmReq: ArchiveRequest = {
      entry_id: ENTRY_ID_1,
      work: {
        provider: "itunes",
        provider_id: "998877",
        category: "film",
        title: "Synthetic Odyssey",
        original_title: null,
        year: 2020,
        cover_url: "/api/meta-cover/itunes/998877",
        creators: ["Synthetic Director"],
        genres: ["Sci-Fi"],
        description: null,
        seasons: [],
        runtime_minutes: 120,
        pages: null,
        external_ids: { itunes: "998877" },
      },
      consumed: { times: 2 },
      when: { precision: "day", date: "2026-10-10", end_date: "2026-10-12" },
    };

    const filmRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(filmReq),
    });
    expect(filmRes.status).toBe(200);
    const filmBody = (await filmRes.json()) as ArchiveResult;
    expect(filmBody).toEqual({
      entry_id: ENTRY_ID_1,
      inserted: 2,
      units: 2,
      total_minutes: 240,
      estimated: true,
    });

    // Day precision units spread across 2026-10-10 and 2026-10-12 appear on Calendar with category "film"
    const calRes = await app.request("/api/calendar?month=2026-10");
    const cal = (await calRes.json()) as CalendarResult;
    expect(cal.days.map((d) => [d.date, d.minutes, d.items[0]?.category])).toEqual([
      ["2026-10-10", 120, "film"],
      ["2026-10-12", 120, "film"],
    ]);

    // Book: 400 pages * 1.5 min * 0.5 progress = 300 min (estimated: true)
    const bookReq: ArchiveRequest = {
      entry_id: ENTRY_ID_2,
      work: {
        provider: "openlibrary",
        provider_id: "OL12345W",
        category: "book",
        title: "Synthetic Chronicles",
        original_title: null,
        year: 1995,
        cover_url: "/api/meta-cover/openlibrary/OL12345W",
        creators: ["Synthetic Writer"],
        genres: [],
        description: null,
        seasons: [],
        runtime_minutes: null,
        pages: 400,
        external_ids: { openlibrary: "OL12345W" },
      },
      consumed: { progress: 0.5 },
      when: { precision: "year", date: "2024" },
    };

    const bookRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookReq),
    });
    expect(bookRes.status).toBe(200);
    expect((await bookRes.json()) as ArchiveResult).toEqual({
      entry_id: ENTRY_ID_2,
      inserted: 1,
      units: 1,
      total_minutes: 300,
      estimated: true,
    });

    // minutes_override always wins and sets estimated: false
    const overrideRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...bookReq,
        consumed: { progress: 1, minutes_override: 450 },
      }),
    });
    expect(overrideRes.status).toBe(200);
    expect((await overrideRes.json()) as ArchiveResult).toEqual({
      entry_id: ENTRY_ID_2,
      inserted: 1,
      units: 1,
      total_minutes: 450,
      estimated: false,
    });

    // Manual audiobook with unknown precision
    const audioReq: ArchiveRequest = {
      entry_id: ENTRY_ID_3,
      work: {
        provider: "manual",
        category: "audiobook",
        title: "Synthetic Spoken Book",
        year: null,
        creators: ["Synthetic Narrator"],
        seasons: [],
        runtime_minutes: null,
        pages: null,
      },
      consumed: { progress: 1, minutes_override: 600 },
      when: { precision: "unknown" },
    };

    const audioRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(audioReq),
    });
    expect(audioRes.status).toBe(200);
    expect((await audioRes.json()) as ArchiveResult).toEqual({
      entry_id: ENTRY_ID_3,
      inserted: 1,
      units: 1,
      total_minutes: 600,
      estimated: false,
    });

    // Re-sending unknown precision entry is idempotent (inserted: 0)
    const audioResend = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(audioReq),
    });
    expect(((await audioResend.json()) as ArchiveResult).inserted).toBe(0);

    // Year review for 2024 includes the year-precision book in undated_minutes, not the unknown audiobook
    const yrRes = await app.request("/api/review/year?year=2024");
    expect(yrRes.status).toBe(200);
    const yr = (await yrRes.json()) as YearReviewV2;
    expect(yr.total_minutes).toBe(450);
    expect(yr.undated_minutes).toBe(450);

    // Library includes all 3 works (film 240 + book 450 + audiobook 600 = 1290)
    const libRes = await app.request("/api/library");
    const lib = (await libRes.json()) as LibraryResult;
    expect(lib.total_minutes).toBe(1290);
    expect(lib.works).toHaveLength(3);
  });

  test("validation rejects bad archive payloads and unknown query params", async () => {
    const app = createApp({ db, config });

    const badUuid = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: "not-a-uuid",
        work: syntheticAnimeWork(),
        consumed: { seasons: [{ number: 1 }] },
        when: { precision: "year", date: "2021" },
      }),
    });
    expect(badUuid.status).toBe(400);

    const badRange = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: ENTRY_ID_1,
        work: syntheticAnimeWork(),
        consumed: { seasons: [{ number: 1 }] },
        when: { precision: "month", date: "2021-06", end_date: "2021-03" },
      }),
    });
    expect(badRange.status).toBe(400);

    const missingDelete = await app.request(
      `/api/archive/${ENTRY_ID_1}/delete`,
      { method: "POST" }
    );
    expect(missingDelete.status).toBe(404);

    const badCategoryFilter = await app.request("/api/archive?category=invalid");
    expect(badCategoryFilter.status).toBe(400);
  });
});
