import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import type {
  ArchiveRequest,
  LibraryResult,
  LibraryWorkDetail,
  MonthReview,
  SeriesResult,
  SettingsView,
  YearReviewV2,
} from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import {
  finishRun,
  insertEvents,
  startRun,
  type NewEvent,
} from "../src/core/events.ts";
import { runBackup } from "../src/io/backup.ts";
import { createApp } from "../src/server/app.ts";

const TZ = "Europe/Bratislava";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: {
      url: "https://user:pass@abs.example.internal:13378/api/v1?secret=1",
      token: "SUPER_SECRET_ABS_TOKEN_999",
      timeout_s: 20,
    },
    simkl: {
      client_id: "simkl_client_123",
      base_url: "https://api.simkl.com/v2",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    activitywatch: {
      url: "http://127.0.0.1:5600/api",
      timeout_s: 20,
      device: "pc",
      include_music: false,
    },
    ingest: {
      token: "INGEST_SECRET_TOKEN_AT_LEAST_32_CHARS_LONG_XYZ",
    },
    covers: {
      external: false,
      openlibrary_url: "https://openlibrary.org",
      openlibrary_covers_url: "https://covers.openlibrary.org",
    },
    notify: {
      desktop: false,
      ntfy_url: "https://ntfy.sh/my-secret-topic",
      ntfy_token: "NTFY_SECRET_TOKEN_777",
      app_url: "",
      weekly_summary: false,
    },
    toJSON: () => ({}),
    toString: () => "{}",
    ...overrides,
  };
  return cfg;
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

describe("Library endpoints (GET /api/library, GET /api/library/work)", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();
  });

  test("joins works across sources by external id and normalized title, groups YouTube by channel, and deduplicates same-day watches", async () => {
    const app = createApp({ db, config });

    // 1. Archive entry for Season 1 of an anime (with mal id "37521")
    const archiveAnime: ArchiveRequest = {
      entry_id: "aaaaaaaa-1111-4111-8111-111111111111",
      work: {
        provider: "anilist",
        provider_id: "101348",
        category: "anime",
        title: "Synthetic Saga",
        original_title: "Sintetiku Saga",
        year: 2019,
        cover_url: "/api/meta-cover/anilist/101348",
        creators: ["Studio Synth"],
        genres: ["Action"],
        description: null,
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
            episodes: 2,
            episode_minutes: 24,
            total_minutes: 48,
            provider_id: "136010",
          },
        ],
        runtime_minutes: null,
        pages: null,
        external_ids: { anilist: "101348", mal: "37521" },
      },
      consumed: { seasons: [{ number: 1 }] },
      when: { precision: "year", date: "2020" },
    };
    await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(archiveAnime),
    });

    // 2. Simkl episode watches for Season 2 of the SAME anime (different title spelling, joined via mal: 37521!)
    // Plus a movie watched on both Simkl and Manual on the same day (deduped to 1 watch)
    // Plus 2 YouTube videos from the same channel
    seedEvents(db, [
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "ep:901:2:1:2026-10-10T18:00:00.000Z",
        external_ids: { simkl: 901, mal: 37521 },
        media_type: "episode",
        title: "Synthetic Saga TV",
        season: 2,
        episode: 1,
        started_at: "2026-10-10T18:00:00.000Z",
        duration_seconds: 1440, // 24m
      },
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "ep:901:2:2:2026-10-11T18:00:00.000Z",
        external_ids: { simkl: 901, mal: 37521 },
        media_type: "episode",
        title: "Synthetic Saga TV",
        season: 2,
        episode: 2,
        started_at: "2026-10-11T18:00:00.000Z",
        duration_seconds: 1440, // 24m
      },
      // Movie on Simkl + Manual on the same local day -> deduped to 120m (not 240m)
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "movie:555:2026-10-12T19:00:00.000Z",
        external_ids: { simkl: 555, imdb: "tt9999999" },
        media_type: "movie",
        title: "Synthetic Duplicate Film",
        started_at: "2026-10-12T19:00:00.000Z",
        duration_seconds: 7200, // 120m
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-dup-1",
        media_type: "movie",
        title: "Synthetic Duplicate Film",
        started_at: "2026-10-12T19:05:00.000Z",
        duration_seconds: 7200, // 120m
      },
      // YouTube videos from the same channel -> 1 channel work with 2 units
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-play-1",
        external_ids: { youtube_video: "Vid00000001" },
        media_type: "video",
        title: "First Essay Video",
        parent_title: "Synthetic Essays Channel",
        started_at: "2026-10-13T10:00:00.000Z",
        duration_seconds: 900, // 15m
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-play-2",
        external_ids: { youtube_video: "Vid00000002" },
        media_type: "video",
        title: "Second Essay Video",
        parent_title: "Synthetic Essays Channel",
        started_at: "2026-10-14T10:00:00.000Z",
        duration_seconds: 1500, // 25m
      },
    ]);

    const res = await app.request("/api/library?sort=time");
    expect(res.status).toBe(200);
    const lib = (await res.json()) as LibraryResult;

    // Anime: 576 + 24 + 24 = 624 min (1 work, 3 units, sources: ["manual", "simkl"], status: "finished" since both S1 & S2 are now fully watched!)
    // Film: 120 min (deduped from 240 min!)
    // YouTube: 40 min (1 channel work, 2 video units)
    expect(lib.categories).toEqual([
      { category: "anime", total_minutes: 624, works: 1, units: 3 },
      { category: "film", total_minutes: 120, works: 1, units: 1 },
      { category: "youtube", total_minutes: 40, works: 1, units: 2 },
    ]);
    expect(lib.total_minutes).toBe(624 + 120 + 40);
    expect(lib.works.map((w) => [w.title, w.total_minutes, w.units, w.status, w.sources])).toEqual([
      ["Synthetic Saga", 624, 3, "finished", ["manual", "simkl"]],
      ["Synthetic Duplicate Film", 120, 1, "finished", ["manual", "simkl"]],
      ["Synthetic Essays Channel", 40, 2, "unknown", ["youtube"]],
    ]);

    // Check YouTube channel work detail lists the individual videos in history
    const ytWork = lib.works.find((w) => w.category === "youtube")!;
    const ytDetailRes = await app.request(
      `/api/library/work?key=${encodeURIComponent(ytWork.key)}`
    );
    expect(ytDetailRes.status).toBe(200);
    const ytDetail = (await ytDetailRes.json()) as LibraryWorkDetail;
    expect(ytDetail.title).toBe("Synthetic Essays Channel");
    expect(ytDetail.history.map((h) => [h.label, h.minutes])).toEqual([
      ["Second Essay Video", 25],
      ["First Essay Video", 15],
    ]);

    // Filter by category and search query
    const filteredRes = await app.request("/api/library?category=film&q=duplicate");
    const filtered = (await filteredRes.json()) as LibraryResult;
    // `categories` always lists every category that has data (for the tabs)
    expect(filtered.categories).toHaveLength(3);
    expect(filtered.works).toHaveLength(1);
    expect(filtered.works[0]?.title).toBe("Synthetic Duplicate Film");
    expect(filtered.total_minutes).toBe(120);
  });
});

describe("Reviews and Series (GET /api/series, GET /api/review/month, GET /api/review/year)", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();
  });

  test("year review equals the sum of its 12 months plus year-precision archive time, and excludes unknown precision", async () => {
    const app = createApp({ db, config });

    // 1. Exact-day events in March and October 2025
    seedEvents(db, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-2025-1",
        media_type: "audiobook",
        title: "Synthetic Audio 2025",
        started_at: "2025-03-10T09:00:00.000Z", // 10:00 CET on Mon 2025-03-10
        duration_seconds: 3600, // 60m
        progress: 0.4,
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-2025-2",
        media_type: "audiobook",
        title: "Synthetic Audio 2025",
        started_at: "2025-03-11T09:00:00.000Z", // 10:00 CET on Tue 2025-03-11 (2-day streak)
        duration_seconds: 5400, // 90m
        progress: 1.0,
      },
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "movie:2025:1",
        media_type: "movie",
        title: "Synthetic Autumn Film",
        started_at: "2025-10-05T18:00:00.000Z",
        duration_seconds: 7200, // 120m
      },
    ]);

    // 2. Month-precision archive entry in 2025-03 (300m)
    await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: "bbbbbbbb-1111-4111-8111-111111111111",
        work: {
          provider: "manual",
          category: "book",
          title: "Synthetic March Book",
          year: 2025,
          creators: ["Author M"],
          seasons: [],
          runtime_minutes: null,
          pages: 200, // 200 * 1.5 = 300m
        },
        consumed: { progress: 1 },
        when: { precision: "month", date: "2025-03" },
      } satisfies ArchiveRequest),
    });

    // 3. Year-precision archive entry in 2025 (500m)
    await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: "cccccccc-1111-4111-8111-111111111111",
        work: {
          provider: "manual",
          category: "series",
          title: "Synthetic 2025 Series",
          year: 2025,
          creators: [],
          seasons: [
            {
              number: 1,
              title: "S1",
              year: 2025,
              episodes: 10,
              episode_minutes: 50,
              total_minutes: 500,
              provider_id: null,
            },
          ],
          runtime_minutes: null,
          pages: null,
        },
        consumed: { seasons: [{ number: 1 }] },
        when: { precision: "year", date: "2025" },
      } satisfies ArchiveRequest),
    });

    // 4. Unknown-precision archive entry (999m) -> excluded from month/year reviews, included in library
    await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_id: "dddddddd-1111-4111-8111-111111111111",
        work: {
          provider: "manual",
          category: "book",
          title: "Synthetic Timeless Book",
          year: null,
          creators: [],
          seasons: [],
          runtime_minutes: null,
          pages: null,
        },
        consumed: { progress: 1, minutes_override: 999 },
        when: { precision: "unknown" },
      } satisfies ArchiveRequest),
    });

    // Check Month Review for 2025-03: 60 + 90 (day) + 300 (month) = 450m, undated = 300m
    const mrMarchRes = await app.request("/api/review/month?month=2025-03");
    expect(mrMarchRes.status).toBe(200);
    const mrMarch = (await mrMarchRes.json()) as MonthReview;
    expect(mrMarch.total_minutes).toBe(450);
    expect(mrMarch.undated_minutes).toBe(300);
    expect(mrMarch.active_days).toBe(2);
    expect(mrMarch.longest_streak_days).toBe(2);
    expect(mrMarch.days).toHaveLength(31);
    expect(mrMarch.hour_weekday).toHaveLength(24);
    expect(mrMarch.hour_weekday[10]?.[0]).toBe(60); // 10:00 Mon
    expect(mrMarch.hour_weekday[10]?.[1]).toBe(90); // 10:00 Tue
    expect(mrMarch.started_works.map((w) => w.title)).toContain(
      "Synthetic Audio 2025"
    );
    expect(mrMarch.finished_works.map((w) => w.title)).toContain(
      "Synthetic Audio 2025"
    );

    // Fetch all 12 MonthReviews for 2025 and the YearReviewV2 for 2025
    const monthReviews: MonthReview[] = [];
    for (let m = 1; m <= 12; m++) {
      const mStr = `2025-${String(m).padStart(2, "0")}`;
      const r = await app.request(`/api/review/month?month=${mStr}`);
      expect(r.status).toBe(200);
      monthReviews.push((await r.json()) as MonthReview);
    }

    const yrRes = await app.request("/api/review/year?year=2025");
    expect(yrRes.status).toBe(200);
    const yr = (await yrRes.json()) as YearReviewV2;

    const sumOfMonths = monthReviews.reduce((s, mr) => s + mr.total_minutes, 0);
    expect(sumOfMonths).toBe(450 + 120); // March (450) + October (120) = 570
    expect(yr.undated_minutes).toBe(500); // Year-precision archive entry
    expect(yr.total_minutes).toBe(sumOfMonths + yr.undated_minutes); // 570 + 500 = 1070
    expect(yr.months.map((m) => m.total_minutes)).toEqual(
      monthReviews.map((mr) => mr.total_minutes)
    );
    expect(yr.active_days).toBe(3);
    expect(yr.longest_streak_days).toBe(2);

    // Check GET /api/series
    const seriesDayRes = await app.request(
      "/api/series?bucket=day&from=2025-03-10&to=2025-03-12"
    );
    expect(seriesDayRes.status).toBe(200);
    const seriesDay = (await seriesDayRes.json()) as SeriesResult;
    // Day series includes only day-precision events (not the 300m month-precision book)
    expect(seriesDay.points).toEqual([
      { bucket: "2025-03-10", minutes_by_category: { audiobook: 60 } },
      { bucket: "2025-03-11", minutes_by_category: { audiobook: 90 } },
      { bucket: "2025-03-12", minutes_by_category: {} },
    ]);

    const seriesMonthRes = await app.request(
      "/api/series?bucket=month&from=2025-03-01&to=2025-04-30"
    );
    expect(seriesMonthRes.status).toBe(200);
    const seriesMonth = (await seriesMonthRes.json()) as SeriesResult;
    // Month series includes both day and month precision events
    expect(seriesMonth.points).toEqual([
      {
        bucket: "2025-03",
        minutes_by_category: { audiobook: 150, book: 300 },
      },
      { bucket: "2025-04", minutes_by_category: {} },
    ]);
  });
});

describe("Settings endpoint (GET /api/settings)", () => {
  let tempDir: string;
  let dbPath: string;
  let backupDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-settings-test-"));
    dbPath = join(tempDir, "inputtracker.db");
    backupDir = join(tempDir, "backups");
    db = openDb(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns hosts only, never leaks secrets, reports database size, backup time, and provider status", async () => {
    const config = mockConfig({
      storage: { db_path: dbPath, backup_dir: backupDir, backup_keep: 14 },
    });

    // Seed an event and a failed sync run containing secrets in the error text
    seedEvents(db, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-s1",
        media_type: "audiobook",
        title: "Synthetic Audiobook",
        started_at: "2026-10-17T10:00:00.000Z",
        duration_seconds: 1800,
      },
    ]);

    const failedRunId = startRun(db, "simkl");
    finishRun(db, failedRunId, {
      status: "failed",
      error:
        "Failed with token simkl_at_secretToken123 and SUPER_SECRET_ABS_TOKEN_999 and INGEST_SECRET_TOKEN_AT_LEAST_32_CHARS_LONG_XYZ",
    });

    // Run a backup so last_backup_at is populated
    runBackup(db, { dir: backupDir, keep: 7, now: new Date("2026-10-18T03:30:00.000Z") });

    const app = createApp({
      db,
      config,
      readSimklToken: () => ({
        access_token: "simkl_at_secretToken123",
        refresh_token: "simkl_rt_secretRefresh456",
        scope: "public",
        expires_at: "2030-01-01T00:00:00.000Z",
        obtained_at: "2026-10-01T00:00:00.000Z",
      }),
    });

    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const rawText = await res.clone().text();
    const settings = (await res.json()) as SettingsView;

    // Never leaks any secret anywhere in the response
    expect(rawText).not.toContain("SUPER_SECRET_ABS_TOKEN_999");
    expect(rawText).not.toContain("INGEST_SECRET_TOKEN_AT_LEAST_32_CHARS_LONG_XYZ");
    expect(rawText).not.toContain("NTFY_SECRET_TOKEN_777");
    expect(rawText).not.toContain("simkl_at_secretToken123");
    expect(rawText).not.toContain("user:pass");
    expect(rawText).not.toContain("/api/v1");

    expect(settings.timezone).toBe(TZ);
    expect(typeof settings.version).toBe("string");
    expect(settings.covers_external).toBe(false);
    expect(settings.ingest_token_set).toBe(true);

    // Sources have host only (no path, no user:pass)
    const absSource = settings.sources.find((s) => s.source === "audiobookshelf")!;
    expect(absSource.enabled).toBe(true);
    expect(absSource.host).toBe("abs.example.internal:13378");
    expect(absSource.can_sync_now).toBe(true);

    const simklSource = settings.sources.find((s) => s.source === "simkl")!;
    expect(simklSource.enabled).toBe(true);
    expect(simklSource.host).toBe("api.simkl.com");
    expect(simklSource.can_sync_now).toBe(true);
    expect(simklSource.last_status).toBe("failed");
    expect(simklSource.last_error).toContain("***");

    // Metadata providers: keyless ones enabled, tmdb disabled when no tmdb_api_key
    expect(settings.metadata_providers).toEqual([
      { provider: "anilist", enabled: true },
      { provider: "tvmaze", enabled: true },
      { provider: "itunes", enabled: true },
      { provider: "openlibrary", enabled: true },
      { provider: "tmdb", enabled: false },
    ]);

    // Database stats
    expect(settings.database.events).toBe(1);
    expect(typeof settings.database.size_bytes).toBe("number");
    expect(settings.database.size_bytes).toBeGreaterThan(0);
    expect(settings.database.last_backup_at).not.toBeNull();
  });
});
