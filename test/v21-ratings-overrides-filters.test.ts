import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/core/config.ts";
import type {
  ArchiveEntrySummary,
  ArchiveRequest,
  ArchiveResult,
  HiddenWorksResult,
  LibraryResult,
  LibraryWorkDetail,
  MonthReview,
  SeriesResult,
  WorkEdit,
  YearReviewV2,
} from "../src/core/contract.ts";
import { migrate, migrations, openDb } from "../src/core/db.ts";
import {
  finishRun,
  insertEvents,
  startRun,
  type NewEvent,
} from "../src/core/events.ts";
import type {
  CalendarResult,
  HeatmapDaysResult,
  HeatmapHoursResult,
  ProgressLists,
  StatsResult,
} from "../src/server/aggregate.ts";
import { parseRating } from "../src/server/annotations.ts";
import { createApp } from "../src/server/app.ts";
import { getCover } from "../src/server/covers.ts";
import type { InsightsResult } from "../src/server/insights.ts";
import { writeWorkCache } from "../src/server/metadata/cache.ts";
import { getWorkOverrides } from "../src/server/overrides.ts";
import { ratingToTenths, tenthsToRating } from "../src/server/ratings.ts";
import type { SearchResult, TitleHistory } from "../src/server/search.ts";
import type { YearReview } from "../src/server/year-review.ts";

const TZ = "Europe/Bratislava";
const ENTRY_1 = "11111111-1111-4111-8111-111111111111";
const ENTRY_2 = "22222222-2222-4222-8222-222222222222";
const ENTRY_3 = "33333333-3333-4333-8333-333333333333";

function mockConfig(dbPath = ":memory:"): Config {
  return {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: dbPath,
      backup_dir: dbPath === ":memory:" ? "/tmp/backups" : join(dirname(dbPath), "backups"),
      backup_keep: 14,
    },
    audiobookshelf: {
      url: "http://abs.invalid:13378",
      token: "SYNTHETIC_ABS_SECRET",
      timeout_s: 20,
    },
    simkl: {
      client_id: "",
      base_url: "https://api.simkl.invalid",
      poster_base_url: "https://simkl.invalid/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://yt.invalid/vi" },
    covers: {
      external: false,
      openlibrary_url: "https://openlibrary.invalid",
      openlibrary_covers_url: "https://covers.openlibrary.invalid",
    },
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
}

function seedEvents(db: Database, events: NewEvent[], source = "test"): void {
  const runId = startRun(db, source);
  insertEvents(db, runId, events);
  finishRun(db, runId, {
    status: "ok",
    rowsSeen: events.length,
    rowsInserted: events.length,
  });
}

function tableCount(db: Database, table: string): number {
  return (
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table};`).get()?.n ?? 0
  );
}

describe("v2.1 Section 7: Ratings 0–10 with one decimal (Migration v5)", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();
  });

  test("rating validation edge cases: accepts 0, 10, 7.5 and rejects 7.25, -0.1, 10.1, NaN, '8'", async () => {
    expect(ratingToTenths(0)).toBe(0);
    expect(ratingToTenths(10)).toBe(100);
    expect(ratingToTenths(7.5)).toBe(75);
    expect(ratingToTenths(null)).toBeNull();
    expect(ratingToTenths(undefined)).toBeNull();

    expect(parseRating(0)).toBe(0);
    expect(parseRating(10)).toBe(10);
    expect(parseRating(7.5)).toBe(7.5);

    const invalidRatings: unknown[] = [7.25, -0.1, 10.1, Number.NaN, "8", Infinity, -Infinity];
    for (const bad of invalidRatings) {
      expect(() => ratingToTenths(bad)).toThrow();
      expect(() => parseRating(bad)).toThrow();
    }

    // Also test via HTTP endpoints (POST /api/archive, POST /api/library/work/edit, POST /api/annotations)
    const app = createApp({ db, config });
    seedEvents(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "movie:100:2026-10-10T18:00:00.000Z",
        external_ids: { imdb: "tt0000100" },
        media_type: "movie",
        title: "Synthetic Rated Film",
        started_at: "2026-10-10T18:00:00.000Z",
        duration_seconds: 5400,
      },
    ]);

    const lib = (await (await app.request("/api/library")).json()) as LibraryResult;
    const workKey = lib.works[0]!.key;

    for (const valid of [0, 7.5, 10]) {
      const res = await app.request(
        `/api/library/work/edit?key=${encodeURIComponent(workKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: valid }),
        }
      );
      expect(res.status).toBe(200);
      const detail = (await res.json()) as LibraryWorkDetail;
      expect(detail.rating).toBe(valid);
    }

    for (const bad of [7.25, -0.1, 10.1, "8"]) {
      const editRes = await app.request(
        `/api/library/work/edit?key=${encodeURIComponent(workKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: bad }),
        }
      );
      expect(editRes.status).toBe(400);
      const editErr = (await editRes.json()) as { error?: string };
      expect(typeof editErr.error).toBe("string");

      const archRes = await app.request("/api/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry_id: ENTRY_1,
          work: {
            provider: "manual",
            category: "film",
            title: "Bad Rating Film",
            year: 2020,
            creators: [],
            seasons: [],
            runtime_minutes: 100,
            pages: null,
          },
          consumed: { times: 1 },
          when: { precision: "day", date: "2026-10-10" },
          rating: bad,
        }),
      });
      expect(archRes.status).toBe(400);
    }
  });

  test("old integer rating in v4 annotations table still reads as the same value after migrating to v5/v6", async () => {
    const v4Db = new Database(":memory:");
    v4Db.run("PRAGMA foreign_keys = ON;");
    v4Db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    for (const m of migrations.filter((x) => x.version <= 4)) {
      m.up(v4Db);
      v4Db.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);",
        [m.version, "2026-10-01T00:00:00.000Z"]
      );
    }

    seedEvents(v4Db, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "sess-legacy-1",
        external_ids: { abs_item: "li_legacy_1" },
        media_type: "audiobook",
        title: "Legacy Rated Audiobook",
        started_at: "2026-10-12T10:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);

    // Insert old integer rating (before rating_tenths column existed)
    v4Db.run(
      `INSERT INTO annotations (record_hash, source, title, rev_id, rating, note, created_at)
       VALUES ('legacy_hash_1', 'audiobookshelf', 'Legacy Rated Audiobook', '11111111-1111-4111-8111-111111111111', 8, 'Old note', '2026-10-12T11:00:00.000Z');`
    );

    // Upgrade to latest (v5 + v6)
    migrate(v4Db);

    expect(tenthsToRating(null, 8)).toBe(8);

    const app = createApp({ db: v4Db, config });
    const lib = (await (await app.request("/api/library")).json()) as LibraryResult;
    expect(lib.works).toHaveLength(1);
    expect(lib.works[0]?.rating).toBe(8);

    const detail = (await (
      await app.request(
        `/api/library/work?key=${encodeURIComponent(lib.works[0]!.key)}`
      )
    ).json()) as LibraryWorkDetail;
    expect(detail.rating).toBe(8);
    expect(detail.note).toBe("Old note");

    const annRes = await app.request(
      "/api/annotations?source=audiobookshelf&title=Legacy%20Rated%20Audiobook"
    );
    expect((await annRes.json()) as { rating: number }).toMatchObject({
      rating: 8,
      note: "Old note",
    });

    v4Db.close();
  });

  test("one rating per library work: archive form, work page (/api/annotations), and WorkEdit.rating all set the same value", async () => {
    const app = createApp({ db, config });

    // 1. Create via archive form with rating 7.5
    const createRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: ENTRY_1,
        work: {
          provider: "cinemeta",
          provider_id: "tt1234567",
          category: "film",
          title: "Unified Rating Film",
          original_title: null,
          year: 2024,
          cover_url: null,
          creators: ["Director X"],
          genres: [],
          description: null,
          seasons: [],
          runtime_minutes: 120,
          pages: null,
          external_ids: { imdb: "tt1234567" },
        },
        consumed: { times: 1 },
        when: { precision: "day", date: "2026-10-05" },
        rating: 7.5,
        note: "Initial note",
      } satisfies ArchiveRequest),
    });
    expect(createRes.status).toBe(200);

    // Also add a Simkl watch of the same film
    seedEvents(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "movie:777:2026-10-06T20:00:00.000Z",
        external_ids: { imdb: "tt1234567" },
        media_type: "movie",
        title: "Unified Rating Film",
        started_at: "2026-10-06T20:00:00.000Z",
        duration_seconds: 7200,
      },
    ]);

    const lib1 = (await (await app.request("/api/library")).json()) as LibraryResult;
    expect(lib1.works).toHaveLength(1);
    const key = lib1.works[0]!.key;
    expect(lib1.works[0]?.rating).toBe(7.5);

    // 2. Update via WorkEdit.rating to 0
    const editRes = await app.request(
      `/api/library/work/edit?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 0 } satisfies WorkEdit),
      }
    );
    expect(editRes.status).toBe(200);
    expect(((await editRes.json()) as LibraryWorkDetail).rating).toBe(0);

    // Seen in month review, year-review, title-history, and /api/annotations
    const mr = (await (
      await app.request("/api/review/month?month=2026-10")
    ).json()) as MonthReview;
    expect(mr.top_works[0]?.rating).toBe(0);

    const yr = (await (
      await app.request("/api/year-review?year=2026&date=2026-10-18")
    ).json()) as YearReview;
    expect(yr.top_titles[0]?.rating).toBe(0);

    const th = (await (
      await app.request(
        `/api/title-history?key=${encodeURIComponent("simkl\u0000Unified Rating Film")}`
      )
    ).json()) as TitleHistory;
    expect(th.rating).toBe(0);

    // 3. Update via /api/annotations (work page) to 9.3
    const annRes = await app.request("/api/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "simkl",
        title: "Unified Rating Film",
        rating: 9.3,
        note: "Updated note",
      }),
    });
    expect(annRes.status).toBe(201);

    const lib2 = (await (await app.request("/api/library")).json()) as LibraryResult;
    expect(lib2.works[0]?.rating).toBe(9.3);
  });
});

describe("v2.1 Section 8: Edit any work, overrides everywhere, hide/unhide, planned/dropped, stable keys, append-only", () => {
  let db: Database;
  let config: Config;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-v21-edit-"));
    const dbPath = join(tempDir, "inputtracker.db");
    db = openDb(dbPath);
    config = mockConfig(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("editing a work updates library, day list, series category minutes, stats, search, and reviews; clearing with null restores original values", async () => {
    const app = createApp({ db, config });

    // Seed a Simkl show (initially categorized as 'series', 2 episodes = 60m on 2026-10-10)
    // and an Audiobookshelf audiobook (30m on 2026-10-10)
    seedEvents(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "ep:500:1:1:2026-10-10T18:00:00.000Z",
        external_ids: { simkl: 500, imdb: "tt5000500" },
        media_type: "episode",
        title: "Original Show Name",
        season: 1,
        episode: 1,
        started_at: "2026-10-10T18:00:00.000Z",
        duration_seconds: 1800, // 30m
      },
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "ep:500:1:2:2026-10-10T18:30:00.000Z",
        external_ids: { simkl: 500, imdb: "tt5000500" },
        media_type: "episode",
        title: "Original Show Name",
        season: 1,
        episode: 2,
        started_at: "2026-10-10T18:30:00.000Z",
        duration_seconds: 1800, // 30m
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-s1",
        external_ids: { abs_item: "li_book_1" },
        media_type: "audiobook",
        title: "Steady Audiobook",
        parent_title: "Author Steady",
        started_at: "2026-10-10T09:00:00.000Z",
        duration_seconds: 1800, // 30m
      },
    ]);

    // Cache metadata work details for anilist:999888 so linking meta populates seasons too
    writeWorkCache(
      config,
      "anilist",
      "999888",
      {
        provider: "anilist",
        provider_id: "999888",
        category: "anime",
        title: "Overridden Anime Title",
        original_title: "Overridden Original",
        year: 2025,
        cover_url: "/api/meta-cover/anilist/999888",
        creators: ["Studio Override"],
        genres: ["Sci-Fi"],
        description: null,
        seasons: [
          {
            number: 1,
            title: "Season 1",
            year: 2025,
            episodes: 12,
            episode_minutes: 24,
            total_minutes: 288,
            provider_id: "999888",
          },
        ],
        runtime_minutes: null,
        pages: null,
        external_ids: { anilist: "999888" },
      },
      null,
      Date.now()
    );

    const libBefore = (await (await app.request("/api/library")).json()) as LibraryResult;
    const showWorkBefore = libBefore.works.find(
      (w) => w.title === "Original Show Name"
    )!;
    expect(showWorkBefore.category).toBe("series");
    expect(showWorkBefore.edited).toBe(false);
    const showKey = showWorkBefore.key;

    // Edit the work: rename, move category from 'series' -> 'anime', set status, rating, note, meta, topic
    const editPayload: WorkEdit = {
      title: "Overridden Anime Title",
      category: "anime",
      status: "finished",
      rating: 8.7,
      note: "Custom override note",
      meta: { provider: "anilist", provider_id: "999888" },
      topic: "Cyberpunk",
    };

    const editRes = await app.request(
      `/api/library/work/edit?key=${encodeURIComponent(showKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editPayload),
      }
    );
    expect(editRes.status).toBe(200);
    const editedDetail = (await editRes.json()) as LibraryWorkDetail;
    expect(editedDetail.key).toBe(showKey);
    expect(editedDetail.title).toBe("Overridden Anime Title");
    expect(editedDetail.category).toBe("anime");
    expect(editedDetail.status).toBe("finished");
    expect(editedDetail.rating).toBe(8.7);
    expect(editedDetail.note).toBe("Custom override note");
    expect(editedDetail.cover_url).toBe("/api/meta-cover/anilist/999888");
    expect(editedDetail.edited).toBe(true);
    expect(editedDetail.topic).toBe("Cyberpunk");
    expect(editedDetail.seasons).toEqual([
      {
        number: 1,
        title: "Season 1",
        year: 2025,
        episodes: 12,
        episode_minutes: 24,
        total_minutes: 288,
        provider_id: "999888",
        watched_episodes: 2,
      },
    ]);

    // Check getWorkOverrides(db) exports the LatestOverride including topic
    const overridesMap = getWorkOverrides(db);
    expect(overridesMap.get(showKey)).toMatchObject({
      work_key: showKey,
      title: "Overridden Anime Title",
      category: "anime",
      status: "finished",
      rating: 8.7,
      rating_tenths: 87,
      note: "Custom override note",
      hidden: false,
      meta: { provider: "anilist", provider_id: "999888" },
      topic: "Cyberpunk",
      edited: true,
    });

    // 1. Library: category moved from 'series' to 'anime'
    const libAfter = (await (await app.request("/api/library")).json()) as LibraryResult;
    expect(libAfter.categories).toEqual([
      { category: "anime", total_minutes: 60, works: 1, units: 2 },
      { category: "book", total_minutes: 30, works: 1, units: 1 },
    ]);
    const showInLib = libAfter.works.find((w) => w.key === showKey)!;
    expect(showInLib.title).toBe("Overridden Anime Title");
    expect(showInLib.category).toBe("anime");
    expect(showInLib.edited).toBe(true);

    // 2. Calendar / Day list: title, category, and cover_url reflect the override
    const cal = (await (
      await app.request("/api/calendar?month=2026-10")
    ).json()) as CalendarResult;
    const dayItems = cal.days[0]!.items;
    const epItems = dayItems.filter((i) => i.source === "simkl");
    expect(epItems).toHaveLength(2);
    expect(epItems[0]?.title).toBe("Overridden Anime Title");
    expect(epItems[0]?.category).toBe("anime");
    expect(epItems[0]?.cover_url).toBe("/api/meta-cover/anilist/999888");

    // 3. Series: minutes_by_category moved from 'series' to 'anime'
    const series = (await (
      await app.request("/api/series?bucket=day&from=2026-10-10&to=2026-10-10")
    ).json()) as SeriesResult;
    expect(series.points).toEqual([
      {
        bucket: "2026-10-10",
        minutes_by_category: { anime: 60, book: 30 },
      },
    ]);

    // 4. Month & Year Reviews: totals and top_works reflect the override
    const mr = (await (
      await app.request("/api/review/month?month=2026-10")
    ).json()) as MonthReview;
    expect(mr.categories).toEqual([
      { category: "anime", total_minutes: 60, works: 1, units: 2 },
      { category: "book", total_minutes: 30, works: 1, units: 1 },
    ]);
    expect(mr.top_works[0]?.title).toBe("Overridden Anime Title");
    expect(mr.top_works[0]?.category).toBe("anime");
    expect(mr.finished_works.map((w) => w.title)).toContain(
      "Overridden Anime Title"
    );

    const yr = (await (
      await app.request("/api/review/year?year=2026")
    ).json()) as YearReviewV2;
    expect(yr.categories).toEqual([
      { category: "anime", total_minutes: 60, works: 1, units: 2 },
      { category: "book", total_minutes: 30, works: 1, units: 1 },
    ]);

    // 5. Stats & Search: top_items and search hits use overridden title & category
    const stats = (await (await app.request("/api/stats")).json()) as StatsResult;
    expect(stats.top_items[0]).toMatchObject({
      title: "Overridden Anime Title",
      category: "anime",
      minutes: 60,
    });

    const searchRes = (await (
      await app.request("/api/search?q=Overridden")
    ).json()) as SearchResult;
    expect(searchRes.total).toBe(1);
    expect(searchRes.hits[0]?.title).toBe("Overridden Anime Title");
    expect(searchRes.hits[0]?.cover_url).toBe("/api/meta-cover/anilist/999888");

    // 6. Clearing overrides with null restores source values and sets edited: false
    const clearRes = await app.request(
      `/api/library/work/edit?key=${encodeURIComponent(showKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: null,
          category: null,
          status: null,
          rating: null,
          note: null,
          meta: null,
          topic: null,
        } satisfies WorkEdit),
      }
    );
    expect(clearRes.status).toBe(200);
    const clearedDetail = (await clearRes.json()) as LibraryWorkDetail;
    expect(clearedDetail.title).toBe("Original Show Name");
    expect(clearedDetail.category).toBe("series");
    expect(clearedDetail.status).toBe("in_progress");
    expect(clearedDetail.rating).toBeNull();
    expect(clearedDetail.note).toBeNull();
    expect(clearedDetail.cover_url).toBeNull();
    expect(clearedDetail.topic).toBeNull();
    expect(clearedDetail.edited).toBe(false);

    const seriesAfterClear = (await (
      await app.request("/api/series?bucket=day&from=2026-10-10&to=2026-10-10")
    ).json()) as SeriesResult;
    expect(seriesAfterClear.points).toEqual([
      {
        bucket: "2026-10-10",
        minutes_by_category: { series: 60, book: 30 },
      },
    ]);
  });

  test("hide and unhide removes and restores the work from every view and total, while GET /api/library/hidden lists hidden works", async () => {
    const app = createApp({ db, config });

    seedEvents(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "movie:10:2026-10-10T18:00:00.000Z",
        external_ids: { imdb: "tt0000010" },
        media_type: "movie",
        title: "Visible Film",
        started_at: "2026-10-10T18:00:00.000Z",
        duration_seconds: 7200, // 120m
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-hide-1",
        external_ids: { abs_item: "li_hide_1" },
        media_type: "audiobook",
        title: "Secret Audiobook",
        started_at: "2026-10-10T10:00:00.000Z",
        duration_seconds: 3600, // 60m
      },
    ]);

    const libInitial = (await (await app.request("/api/library")).json()) as LibraryResult;
    expect(libInitial.total_minutes).toBe(180);
    const hideKey = libInitial.works.find((w) => w.title === "Secret Audiobook")!.key;

    // Hide "Secret Audiobook"
    const hideRes = await app.request(
      `/api/library/work/edit?key=${encodeURIComponent(hideKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true } satisfies WorkEdit),
      }
    );
    expect(hideRes.status).toBe(200);

    // Listed in GET /api/library/hidden
    const hiddenList = (await (
      await app.request("/api/library/hidden")
    ).json()) as HiddenWorksResult;
    expect(hiddenList.works).toHaveLength(1);
    expect(hiddenList.works[0]?.key).toBe(hideKey);
    expect(hiddenList.works[0]?.title).toBe("Secret Audiobook");

    // Removed from library, calendar, heatmap, stats, series, reviews, search
    const libHidden = (await (await app.request("/api/library")).json()) as LibraryResult;
    expect(libHidden.total_minutes).toBe(120);
    expect(libHidden.works.map((w) => w.title)).toEqual(["Visible Film"]);
    expect(libHidden.categories).toEqual([
      { category: "film", total_minutes: 120, works: 1, units: 1 },
    ]);

    const calHidden = (await (
      await app.request("/api/calendar?month=2026-10")
    ).json()) as CalendarResult;
    expect(calHidden.days[0]?.minutes).toBe(120);
    expect(calHidden.days[0]?.items.map((i) => i.title)).toEqual(["Visible Film"]);

    const hmHidden = (await (
      await app.request("/api/heatmap/days?year=2026")
    ).json()) as HeatmapDaysResult;
    expect(hmHidden.days[0]?.minutes).toBe(120);

    const statsHidden = (await (await app.request("/api/stats")).json()) as StatsResult;
    expect(statsHidden.total_minutes).toBe(120);
    expect(statsHidden.total_items).toBe(1);

    const mrHidden = (await (
      await app.request("/api/review/month?month=2026-10")
    ).json()) as MonthReview;
    expect(mrHidden.total_minutes).toBe(120);

    const yrHidden = (await (
      await app.request("/api/review/year?year=2026")
    ).json()) as YearReviewV2;
    expect(yrHidden.total_minutes).toBe(120);

    const searchHidden = (await (
      await app.request("/api/search?q=Secret")
    ).json()) as SearchResult;
    expect(searchHidden.total).toBe(0);

    // Unhide "Secret Audiobook"
    const unhideRes = await app.request(
      `/api/library/work/edit?key=${encodeURIComponent(hideKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: false } satisfies WorkEdit),
      }
    );
    expect(unhideRes.status).toBe(200);

    const hiddenAfterUnhide = (await (
      await app.request("/api/library/hidden")
    ).json()) as HiddenWorksResult;
    expect(hiddenAfterUnhide.works).toHaveLength(0);

    // Totals restored everywhere
    const libRestored = (await (await app.request("/api/library")).json()) as LibraryResult;
    expect(libRestored.total_minutes).toBe(180);
    expect(libRestored.works).toHaveLength(2);

    const statsRestored = (await (await app.request("/api/stats")).json()) as StatsResult;
    expect(statsRestored.total_minutes).toBe(180);
  });

  test("planned archive entry is in the library with 0 minutes and nowhere else; dropped entry keeps any time given", async () => {
    const app = createApp({ db, config });

    // 1. Planned anime entry (even with seasons/runtime metadata, counts 0 minutes)
    const plannedReq: ArchiveRequest = {
      entry_id: ENTRY_1,
      work: {
        provider: "anilist",
        provider_id: "555111",
        category: "anime",
        title: "Planned Future Anime",
        original_title: null,
        year: 2026,
        cover_url: "/api/meta-cover/anilist/555111",
        creators: ["Studio Plan"],
        genres: [],
        description: null,
        seasons: [
          {
            number: 1,
            title: "S1",
            year: 2026,
            episodes: 12,
            episode_minutes: 24,
            total_minutes: 288,
            provider_id: "555111",
          },
        ],
        runtime_minutes: null,
        pages: null,
        external_ids: { anilist: "555111" },
      },
      consumed: {},
      when: { precision: "day", date: "2026-10-12" },
      status: "planned",
    };

    const plannedRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plannedReq),
    });
    expect(plannedRes.status).toBe(200);
    const plannedBody = (await plannedRes.json()) as ArchiveResult;
    expect(plannedBody.total_minutes).toBe(0);
    expect(plannedBody.estimated).toBe(false);

    // 2. Dropped series entry with 3 watched episodes (3 * 50 = 150 minutes kept)
    const droppedReq: ArchiveRequest = {
      entry_id: ENTRY_2,
      work: {
        provider: "tvmaze",
        provider_id: "888222",
        category: "series",
        title: "Dropped Drama Show",
        original_title: null,
        year: 2024,
        cover_url: null,
        creators: [],
        genres: [],
        description: null,
        seasons: [
          {
            number: 1,
            title: "S1",
            year: 2024,
            episodes: 10,
            episode_minutes: 50,
            total_minutes: 500,
            provider_id: null,
          },
        ],
        runtime_minutes: null,
        pages: null,
        external_ids: { tvmaze: "888222" },
      },
      consumed: { seasons: [{ number: 1, episodes: 3 }] },
      when: { precision: "day", date: "2026-10-12" },
      status: "dropped",
    };

    const droppedRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(droppedReq),
    });
    expect(droppedRes.status).toBe(200);
    const droppedBody = (await droppedRes.json()) as ArchiveResult;
    expect(droppedBody.total_minutes).toBe(150);

    // Library has BOTH works: planned (0 min) and dropped (150 min)
    const lib = (await (await app.request("/api/library")).json()) as LibraryResult;
    expect(lib.total_minutes).toBe(150);
    const plannedWork = lib.works.find((w) => w.title === "Planned Future Anime")!;
    expect(plannedWork).toBeDefined();
    expect(plannedWork.status).toBe("planned");
    expect(plannedWork.total_minutes).toBe(0);

    const droppedWork = lib.works.find((w) => w.title === "Dropped Drama Show")!;
    expect(droppedWork).toBeDefined();
    expect(droppedWork.status).toBe("dropped");
    expect(droppedWork.total_minutes).toBe(150);

    // Planned entry is NOWHERE else (calendar, heatmap, series, stats, reviews, search)
    const cal = (await (
      await app.request("/api/calendar?month=2026-10")
    ).json()) as CalendarResult;
    expect(cal.days).toHaveLength(1);
    expect(cal.days[0]?.minutes).toBe(150);
    expect(cal.days[0]?.items.map((i) => i.title)).toEqual(["Dropped Drama Show"]);

    const series = (await (
      await app.request("/api/series?bucket=day&from=2026-10-12&to=2026-10-12")
    ).json()) as SeriesResult;
    expect(series.points[0]?.minutes_by_category).toEqual({ series: 150 });

    const mr = (await (
      await app.request("/api/review/month?month=2026-10")
    ).json()) as MonthReview;
    expect(mr.total_minutes).toBe(150);
    expect(mr.top_works.map((w) => w.title)).toEqual(["Dropped Drama Show"]);

    const yr = (await (
      await app.request("/api/review/year?year=2026")
    ).json()) as YearReviewV2;
    expect(yr.total_minutes).toBe(150);
    expect(yr.top_works.map((w) => w.title)).toEqual(["Dropped Drama Show"]);

    const stats = (await (await app.request("/api/stats")).json()) as StatsResult;
    expect(stats.total_minutes).toBe(150);
    expect(stats.total_items).toBe(1);

    const searchPlanned = (await (
      await app.request("/api/search?q=Planned")
    ).json()) as SearchResult;
    expect(searchPlanned.total).toBe(0);
  });

  test("stable work keys: key survives new syncs, re-ordering of events, and WorkEdit overrides", async () => {
    const evA: NewEvent = {
      source: "simkl",
      source_kind: "watch",
      source_id: "ep:1:1:1:2026-05-01T10:00:00.000Z",
      external_ids: { mal: 37521, simkl: 1 },
      media_type: "episode",
      title: "Synthetic Vinland",
      season: 1,
      episode: 1,
      started_at: "2026-05-01T10:00:00.000Z",
      duration_seconds: 1440,
    };
    const evB: NewEvent = {
      source: "audiobookshelf",
      source_kind: "listening_session",
      source_id: "abs-b1",
      external_ids: { abs_item: "li_stable_99" },
      media_type: "audiobook",
      title: "Synthetic Dune",
      started_at: "2026-06-01T10:00:00.000Z",
      duration_seconds: 3600,
    };
    const evC: NewEvent = {
      source: "manual",
      source_kind: "history_item",
      source_id: "man-c1",
      media_type: "book",
      title: "Manual Plain Book",
      started_at: "2026-07-01T10:00:00.000Z",
      duration_seconds: 1800,
    };

    const app1 = createApp({ db, config });
    seedEvents(db, [evA, evB, evC]);

    const lib1 = (await (await app1.request("/api/library")).json()) as LibraryResult;
    const keys1 = new Map(lib1.works.map((w) => [w.title, w.key]));

    // Now sync more events (earlier and later, plus new works that sort before/after)
    seedEvents(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "ep:2:1:1:2020-01-01T10:00:00.000Z",
        external_ids: { mal: 10001, simkl: 2 },
        media_type: "episode",
        title: "AAA First Alphabetical Anime",
        season: 1,
        episode: 1,
        started_at: "2020-01-01T10:00:00.000Z",
        duration_seconds: 1440,
      },
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "ep:1:1:2:2026-05-02T10:00:00.000Z",
        external_ids: { mal: 37521, simkl: 1 },
        media_type: "episode",
        title: "Synthetic Vinland",
        season: 1,
        episode: 2,
        started_at: "2026-05-02T10:00:00.000Z",
        duration_seconds: 1440,
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-b2",
        external_ids: { abs_item: "li_stable_99" },
        media_type: "audiobook",
        title: "Synthetic Dune",
        started_at: "2026-06-02T10:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);

    const lib2 = (await (await app1.request("/api/library")).json()) as LibraryResult;
    const keys2 = new Map(lib2.works.map((w) => [w.title, w.key]));

    expect(keys2.get("Synthetic Vinland")).toBe(keys1.get("Synthetic Vinland"));
    expect(keys2.get("Synthetic Dune")).toBe(keys1.get("Synthetic Dune"));
    expect(keys2.get("Manual Plain Book")).toBe(keys1.get("Manual Plain Book"));

    // Also insert in reverse order into a second fresh DB and verify identical keys
    const dbReverse = openDb(":memory:");
    seedEvents(dbReverse, [evC, evB, evA]);
    const appRev = createApp({ db: dbReverse, config: mockConfig() });
    const libRev = (await (await appRev.request("/api/library")).json()) as LibraryResult;
    const keysRev = new Map(libRev.works.map((w) => [w.title, w.key]));

    expect(keysRev.get("Synthetic Vinland")).toBe(keys1.get("Synthetic Vinland"));
    expect(keysRev.get("Synthetic Dune")).toBe(keys1.get("Synthetic Dune"));
    expect(keysRev.get("Manual Plain Book")).toBe(keys1.get("Manual Plain Book"));
    dbReverse.close();
  });

  test("append-only: edits never UPDATE or DELETE rows; row counts in events, annotations, and work_overrides only grow", async () => {
    const app = createApp({ db, config });

    seedEvents(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "movie:888:2026-10-10T18:00:00.000Z",
        external_ids: { imdb: "tt0888888" },
        media_type: "movie",
        title: "Append Only Film",
        started_at: "2026-10-10T18:00:00.000Z",
        duration_seconds: 6000,
      },
    ]);

    const lib = (await (await app.request("/api/library")).json()) as LibraryResult;
    const key = lib.works[0]!.key;

    let prevEvents = tableCount(db, "events");
    let prevAnnotations = tableCount(db, "annotations");
    let prevOverrides = tableCount(db, "work_overrides");

    const edits: WorkEdit[] = [
      { title: "Append Only Film v2", rating: 7.5 },
      { category: "anime", rating: 8.5, note: "First note" },
      { hidden: true },
      { hidden: false, title: null, category: null, rating: null, note: null },
    ];

    for (const edit of edits) {
      const res = await app.request(
        `/api/library/work/edit?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(edit),
        }
      );
      expect(res.status).toBe(200);

      const curEvents = tableCount(db, "events");
      const curAnnotations = tableCount(db, "annotations");
      const curOverrides = tableCount(db, "work_overrides");

      expect(curEvents).toBeGreaterThanOrEqual(prevEvents);
      expect(curAnnotations).toBeGreaterThanOrEqual(prevAnnotations);
      expect(curOverrides).toBeGreaterThan(prevOverrides);

      prevEvents = curEvents;
      prevAnnotations = curAnnotations;
      prevOverrides = curOverrides;
    }

    // Verify SQLite triggers abort UPDATE and DELETE on work_overrides
    expect(() =>
      db.run("UPDATE work_overrides SET title = 'hack';")
    ).toThrow("work_overrides is append-only");
    expect(() =>
      db.run("DELETE FROM work_overrides;")
    ).toThrow("work_overrides is append-only");
  });
});

describe("v2.1 Section 9: Multi-category and exclude filters on every endpoint", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();

    // Seed 4 categories on 2026-10-15 (plus an earlier year 2025-10-15 for on_this_day):
    // - anime: 50m
    // - film: 120m
    // - audiobook: 60m
    // - youtube: 30m
    seedEvents(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "ep:1:1:1:2026-10-15T12:00:00.000Z",
        external_ids: { mal: 111 },
        media_type: "episode",
        title: "Filter Anime",
        season: 1,
        episode: 1,
        started_at: "2026-10-15T12:00:00.000Z",
        duration_seconds: 3000, // 50m
      },
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "movie:2:2026-10-15T14:00:00.000Z",
        external_ids: { imdb: "tt0000002" },
        media_type: "movie",
        title: "Filter Film",
        started_at: "2026-10-15T14:00:00.000Z",
        duration_seconds: 7200, // 120m
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-f1",
        external_ids: { abs_item: "li_f1" },
        media_type: "audiobook",
        title: "Filter Audiobook",
        started_at: "2026-10-15T16:00:00.000Z",
        duration_seconds: 3600, // 60m
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-f1",
        external_ids: { youtube_video: "VidFilter01" },
        media_type: "video",
        title: "Filter Video",
        parent_title: "Filter Channel",
        started_at: "2026-10-15T18:00:00.000Z",
        duration_seconds: 1800, // 30m
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-f0-2025",
        external_ids: { youtube_video: "VidFilter00" },
        media_type: "video",
        title: "Filter Old Video",
        parent_title: "Filter Channel",
        started_at: "2025-10-15T18:00:00.000Z",
        duration_seconds: 1800, // 30m
      },
    ]);
  });

  test("category=anime,film and exclude=youtube filter works and totals across library, series, calendar, heatmaps, search, stats, reviews, insights, and archive", async () => {
    const app = createApp({ db, config });

    // Also add 2 archive entries (book: 90m, film: 100m) for /api/archive
    await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: ENTRY_1,
        work: {
          provider: "manual",
          category: "book",
          title: "Filter Archive Book",
          year: 2026,
          creators: [],
          seasons: [],
          runtime_minutes: null,
          pages: 60, // 90m
        },
        consumed: { progress: 1 },
        when: { precision: "day", date: "2026-10-15" },
      } satisfies ArchiveRequest),
    });

    // 1. Library: categories always lists all 5 categories, while works and total_minutes follow the filter
    const libMulti = (await (
      await app.request("/api/library?category=anime,film")
    ).json()) as LibraryResult;
    expect(libMulti.categories.map((c) => c.category)).toEqual([
      "anime",
      "film",
      "book",
      "youtube",
    ]);
    expect(libMulti.works.map((w) => w.category).sort()).toEqual(["anime", "film"]);
    expect(libMulti.total_minutes).toBe(50 + 120);

    const libExclude = (await (
      await app.request("/api/library?exclude=youtube,book")
    ).json()) as LibraryResult;
    expect(libExclude.categories).toHaveLength(4);
    // Audiobooks count as books, so excluding books excludes them too.
    expect(libExclude.works.map((w) => w.category).sort()).toEqual([
      "anime",
      "film",
    ]);
    expect(libExclude.total_minutes).toBe(50 + 120);

    // 2. Series
    const seriesMulti = (await (
      await app.request(
        "/api/series?bucket=day&from=2026-10-15&to=2026-10-15&category=anime,audiobook&exclude=audiobook"
      )
    ).json()) as SeriesResult;
    expect(seriesMulti.points[0]?.minutes_by_category).toEqual({ anime: 50 });

    // 3. Calendar
    const calExclude = (await (
      await app.request("/api/calendar?month=2026-10&exclude=youtube,book")
    ).json()) as CalendarResult;
    expect(calExclude.days[0]?.minutes).toBe(50 + 120);
    expect(calExclude.days[0]?.count).toBe(2);

    // 4. Heatmap Days & Hours
    const hmDays = (await (
      await app.request("/api/heatmap/days?year=2026&category=anime,film")
    ).json()) as HeatmapDaysResult;
    expect(hmDays.days[0]?.minutes).toBe(170);
    expect(hmDays.days[0]?.count).toBe(2);

    const hmHours = (await (
      await app.request("/api/heatmap/hours?year=2026&category=anime,film")
    ).json()) as HeatmapHoursResult;
    const hmHoursTotal = hmHours.cells.reduce((s, c) => s + c.minutes, 0);
    expect(hmHoursTotal).toBe(170);

    // 5. Search
    const searchFiltered = (await (
      await app.request("/api/search?q=Filter&category=anime,film")
    ).json()) as SearchResult;
    expect(searchFiltered.hits.map((h) => h.title).sort()).toEqual([
      "Filter Anime",
      "Filter Film",
    ]);

    const searchExcluded = (await (
      await app.request("/api/search?q=Filter&exclude=youtube")
    ).json()) as SearchResult;
    expect(
      searchExcluded.hits.every((h) => h.source !== "youtube")
    ).toBe(true);

    // 6. Stats
    const statsFiltered = (await (
      await app.request("/api/stats?category=anime,film")
    ).json()) as StatsResult;
    expect(statsFiltered.total_minutes).toBe(170);
    expect(statsFiltered.total_items).toBe(2);

    // 7. Month Review & Year Review V2 & Year Review V1
    const mrFiltered = (await (
      await app.request("/api/review/month?month=2026-10&exclude=youtube,book")
    ).json()) as MonthReview;
    expect(mrFiltered.total_minutes).toBe(50 + 120);
    expect(mrFiltered.categories.map((c) => c.category)).toEqual([
      "anime",
      "film",
    ]);

    const yrV2Filtered = (await (
      await app.request("/api/review/year?year=2026&category=anime,film")
    ).json()) as YearReviewV2;
    expect(yrV2Filtered.total_minutes).toBe(170);

    const yrV1Filtered = (await (
      await app.request(
        "/api/year-review?year=2026&date=2026-10-18&category=anime,film"
      )
    ).json()) as YearReview;
    expect(yrV1Filtered.totals.minutes).toBe(170);

    // 8. Insights
    const insightsExcluded = (await (
      await app.request("/api/insights?date=2026-10-15&exclude=youtube")
    ).json()) as InsightsResult;
    expect(insightsExcluded.on_this_day.years).toHaveLength(0);

    // 9. Archive list
    const archList = (await (
      await app.request("/api/archive?category=book,film&exclude=film")
    ).json()) as ArchiveEntrySummary[];
    expect(archList).toHaveLength(1);
    expect(archList[0]?.title).toBe("Filter Archive Book");
  });

  test("unknown category names in category or exclude return 400 on every endpoint", async () => {
    const app = createApp({ db, config });
    const endpoints = [
      "/api/library?category=anime,notacategory",
      "/api/library?exclude=notacategory",
      "/api/series?bucket=day&from=2026-10-01&to=2026-10-05&category=bad",
      "/api/series?bucket=day&from=2026-10-01&to=2026-10-05&exclude=bad",
      "/api/calendar?month=2026-10&category=bad",
      "/api/calendar?month=2026-10&exclude=bad",
      "/api/heatmap/days?year=2026&category=bad",
      "/api/heatmap/hours?year=2026&exclude=bad",
      "/api/search?q=Filter&category=bad",
      "/api/search?q=Filter&exclude=bad",
      "/api/stats?category=bad",
      "/api/stats?exclude=bad",
      "/api/review/month?month=2026-10&category=bad",
      "/api/review/year?year=2026&exclude=bad",
      "/api/year-review?year=2026&category=bad",
      "/api/insights?exclude=bad",
      "/api/archive?category=bad",
      "/api/archive?exclude=bad",
    ];

    for (const url of endpoints) {
      const res = await app.request(url);
      expect(res.status, url).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error, url).toBe("string");
    }
  });
});

describe("Part 4: Audiobookshelf cover 404 miss is not re-requested", () => {
  let db: Database;
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-abs-miss-"));
    const dbPath = join(tempDir, "inputtracker.db");
    db = openDb(dbPath);
    config = mockConfig(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("an ABS item returning 404 is remembered and not re-requested on subsequent /api/cover/:itemId or getCover calls", async () => {
    const absCalls: string[] = [];
    let currentTime = 1_700_000_000_000;

    // Seed a media_progress row whose book was deleted from ABS (title is just itemId)
    seedEvents(db, [
      {
        source: "audiobookshelf",
        source_kind: "media_progress",
        source_id: "li_deleted_item_1",
        media_type: "audiobook",
        title: "li_deleted_item_1",
        started_at: "2026-10-10T10:00:00.000Z",
        progress: 0.25,
      },
    ]);

    const app = createApp({
      db,
      config,
      nowMs: () => currentTime,
      createAbsClient: () => ({
        getAllSessions: async () => [],
        get: async (path: string) => {
          absCalls.push(`GET ${path}`);
          return { libraries: [] } as any;
        },
        getBinary: async (path: string) => {
          absCalls.push(`GET_BINARY ${path}`);
          throw new Error("HTTP 404: Not Found");
        },
      }),
    });

    // 1st request: asks ABS once, gets 404
    const res1 = await app.request("/api/cover/li_deleted_item_1");
    expect(res1.status).toBe(404);
    expect(absCalls).toEqual(["GET_BINARY /api/items/li_deleted_item_1/cover"]);

    // 2nd and 3rd requests (1 hour and 2 days later): ABS is NOT asked again!
    currentTime += 3600 * 1000;
    const res2 = await app.request("/api/cover/li_deleted_item_1");
    expect(res2.status).toBe(404);
    expect(absCalls).toEqual(["GET_BINARY /api/items/li_deleted_item_1/cover"]);

    // Even when getCover is called without a db handle, the 404 miss prevents re-requesting ABS
    const resNoDb = await getCover("li_deleted_item_1", {
      config,
      now: () => currentTime,
      createAbsClient: () =>
        ({
          getBinary: async (path: string) => {
            absCalls.push(`GET_BINARY ${path}`);
            throw new Error("HTTP 404: Not Found");
          },
        }) as any,
    });
    expect(resNoDb).toBeNull();
    expect(absCalls).toEqual(["GET_BINARY /api/items/li_deleted_item_1/cover"]);
  });
});
