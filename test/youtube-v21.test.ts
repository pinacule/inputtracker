import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import type {
  LibraryResult,
  LibraryWorkDetail,
  MonthReview,
  SeriesResult,
  YearReviewV2,
  YoutubeOverview,
  YoutubeVideosResult,
} from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import {
  finishRun,
  insertEvents,
  startRun,
  type NewEvent,
} from "../src/core/events.ts";
import type { YoutubeVideoRow } from "../src/core/schema.ts";
import { LocalDbSink } from "../src/core/sink.ts";
import type {
  CalendarResult,
  HeatmapDaysResult,
  StatsResult,
} from "../src/server/aggregate.ts";
import { createApp } from "../src/server/app.ts";
import type { SearchResult } from "../src/server/search.ts";
import {
  setVideoTopicOverride,
} from "../src/server/youtube-routes.ts";
import {
  createActivityWatchClient,
  type FetchFn,
} from "../src/sources/activitywatch/client.ts";
import {
  mapBucketEvents,
  mergePlaysByVideoDay,
} from "../src/sources/activitywatch/map.ts";
import { syncActivityWatch } from "../src/sources/activitywatch/sync.ts";
import type { AwBucket, AwRawEvent } from "../src/sources/activitywatch/types.ts";
import {
  enrichYoutubeVideos,
  getYoutubeVideoEnrichmentMap,
  parseOembedPayload,
  parseWatchPageGenre,
} from "../src/sources/youtube/enrich.ts";

const TZ = "Europe/Bratislava";

const VID_A = "SynthVid00A";
const VID_B = "SynthVid00B";
const VID_C = "SynthVid00C";
const VID_D = "SynthVid00D";
const VID_E = "SynthVid00E";

function mockConfig(overrides: Partial<Config> = {}): Config {
  return {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: ":memory:",
      backup_dir: "/tmp/backups",
      backup_keep: 14,
    },
    audiobookshelf: {
      url: "http://abs.test:13378",
      token: "abs-tok",
      timeout_s: 20,
    },
    simkl: {
      client_id: "simkl_client_synth",
      base_url: "https://api.simkl.com",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: {
      thumb_base_url: "https://i.ytimg.com/vi",
      min_watch_minutes: 5,
      enrich_per_sync: 50,
    },
    activitywatch: {
      url: "http://127.0.0.1:5600",
      timeout_s: 20,
      device: "pc",
      include_music: false,
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
    ...overrides,
  } as Config;
}

function seedEvents(db: Database, events: NewEvent[], source = "youtube"): void {
  const runId = startRun(db, source);
  insertEvents(db, runId, events);
  finishRun(db, runId, {
    status: "ok",
    rowsSeen: events.length,
    rowsInserted: events.length,
  });
}

describe("Migration v7: append-only youtube_videos and youtube_channel_topics", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("rejects UPDATE and DELETE on youtube_videos and youtube_channel_topics", () => {
    db.run(
      `INSERT INTO youtube_videos (
        video_id, title, channel, status, http_status, fetched_at
      ) VALUES (?, ?, ?, 'ok', 200, '2026-10-18T10:00:00.000Z');`,
      [VID_A, "Synth Title", "Synth Channel"]
    );

    expect(() => {
      db.run("UPDATE youtube_videos SET title = 'Mutated' WHERE video_id = ?;", [
        VID_A,
      ]);
    }).toThrow(/youtube_videos is append-only/);

    expect(() => {
      db.run("DELETE FROM youtube_videos WHERE video_id = ?;", [VID_A]);
    }).toThrow(/youtube_videos is append-only/);

    db.run(
      `INSERT INTO youtube_channel_topics (
        record_hash, channel, normalized_channel, topic, created_at
      ) VALUES ('hash_1', 'Synth Channel', 'synth channel', 'Science', '2026-10-18T10:00:00.000Z');`
    );

    expect(() => {
      db.run(
        "UPDATE youtube_channel_topics SET topic = 'Math' WHERE record_hash = 'hash_1';"
      );
    }).toThrow(/youtube_channel_topics is append-only/);

    expect(() => {
      db.run("DELETE FROM youtube_channel_topics WHERE record_hash = 'hash_1';");
    }).toThrow(/youtube_channel_topics is append-only/);
  });
});

describe("ActivityWatch minimum watch time, per-day merge, idempotency, and crossing limit later", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("boundary check: 299s (4:59) is dropped, exactly 300s (5:00) is kept, and min_watch_minutes=0 disables", () => {
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T10:00:00.000Z",
        duration: 299,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_A}`,
          title: "Short 4m59s Video - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T11:00:00.000Z",
        duration: 300,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_B}`,
          title: "Boundary 5m00s Video - YouTube",
          audible: true,
        },
      },
    ];

    const withDefault5 = mapBucketEvents(rawEvents, {
      bucketId: "aw-watcher-web-chrome",
      device: "pc",
      tz: TZ,
      minWatchMinutes: 5,
    });
    expect(withDefault5).toHaveLength(1);
    expect(withDefault5[0]?.external_ids).toEqual({ youtube_video: VID_B });
    expect(withDefault5[0]?.duration_seconds).toBe(300);

    const withDisabled0 = mapBucketEvents(rawEvents, {
      bucketId: "aw-watcher-web-chrome",
      device: "pc",
      tz: TZ,
      minWatchMinutes: 0,
    });
    expect(withDisabled0).toHaveLength(2);
    expect(withDisabled0.map((e) => e.duration_seconds)).toEqual([299, 300]);
  });

  test("per-day merge: two plays of the same video on the same local day merge before checking threshold; different local days do not merge", () => {
    const rawEvents: AwRawEvent[] = [
      // VID_A on 2026-10-17 local: 180s at 10:00Z + 120s at 14:00Z = 300s (5:00 -> counts!)
      {
        timestamp: "2026-10-17T10:00:00.000Z",
        duration: 180,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_A}`,
          title: "Same Day Part 1 - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T14:00:00.000Z",
        duration: 120,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_A}`,
          title: "Same Day Merged Title - YouTube",
          audible: true,
        },
      },
      // VID_B across local midnight in Europe/Bratislava (UTC+2 on Oct 17):
      // 21:30Z = 2026-10-17 23:30 local (180s)
      // 22:30Z = 2026-10-18 00:30 local (180s) -> different local days, neither reaches 300s!
      {
        timestamp: "2026-10-17T21:30:00.000Z",
        duration: 180,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_B}`,
          title: "Split Across Midnight - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T22:30:00.000Z",
        duration: 180,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_B}`,
          title: "Split Across Midnight - YouTube",
          audible: true,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, {
      bucketId: "aw-watcher-web-chrome",
      device: "pc",
      tz: TZ,
      minWatchMinutes: 5,
    });

    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.source_id).toBe(`${VID_A}:2026-10-17T10:00:00.000Z`);
    expect(mapped[0]?.started_at).toBe("2026-10-17T10:00:00.000Z");
    expect(mapped[0]?.ended_at).toBe("2026-10-17T14:02:00.000Z");
    expect(mapped[0]?.duration_seconds).toBe(300);
    expect(mapped[0]?.title).toBe("Same Day Merged Title");
    expect(mapped[0]?.raw).toEqual({
      bucket: "aw-watcher-web-chrome",
      events: 2,
      audible_seconds: 300,
      total_seconds: 300,
    });
  });

  test("crossing the limit on a later sync stores the merged day without double counting, and repeat syncs are idempotent", async () => {
    const bucketId = "aw-watcher-web-chrome_test";
    const buckets: Record<string, AwBucket> = {
      [bucketId]: { id: bucketId, type: "web.tab.current" },
    };
    let bucketEvents: AwRawEvent[] = [];

    const mockFetch: FetchFn = async (input) => {
      const urlStr = typeof input === "string" ? input : String(input);
      const parsed = new URL(urlStr);

      if (parsed.pathname === "/api/0/buckets/") {
        return new Response(JSON.stringify(buckets), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (parsed.pathname.endsWith("/events")) {
        const startParam = parsed.searchParams.get("start");
        const endParam = parsed.searchParams.get("end");
        const filtered = bucketEvents.filter((ev) => {
          if (startParam && ev.timestamp < startParam) return false;
          if (endParam && ev.timestamp >= endParam) return false;
          return true;
        });
        return new Response(JSON.stringify(filtered), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (parsed.hostname === "www.youtube.com") {
        if (parsed.pathname === "/oembed") {
          return new Response(
            JSON.stringify({
              title: "Enriched Video Title",
              author_name: "Enriched Synth Channel",
              author_url: "https://www.youtube.com/channel/UCsynth123",
              thumbnail_url: `https://i.ytimg.com/vi/${VID_A}/hqdefault.jpg`,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (parsed.pathname === "/watch") {
          return new Response(
            '<html><head><meta itemprop="genre" content="Science &amp; Technology"></head></html>',
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
      }
      return new Response("Not found", { status: 404 });
    };

    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: mockFetch,
    });
    const sink = new LocalDbSink(db);

    // Sync 1 at 10:30Z: user watched VID_A for 180s (3 min < 5 min) at 10:00Z
    bucketEvents = [
      {
        timestamp: "2026-10-17T10:00:00.000Z",
        duration: 180,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_A}`,
          title: "Growing Video - YouTube",
          audible: true,
        },
      },
    ];

    const sync1 = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => new Date("2026-10-17T10:30:00.000Z"),
      sleep: async () => {},
    });
    expect(sync1.seen).toBe(0);
    expect(sync1.inserted).toBe(0);

    const countAfterSync1 = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get();
    expect(countAfterSync1?.n).toBe(0);

    // Sync 2 at 14:30Z (4 hours later, same local day): user watched another 180s at 14:00Z.
    // Total for VID_A on 2026-10-17 is now 180 + 180 = 360s (6 min >= 5 min)!
    bucketEvents = [
      ...bucketEvents,
      {
        timestamp: "2026-10-17T14:00:00.000Z",
        duration: 180,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_A}`,
          title: "Growing Video - YouTube",
          audible: true,
        },
      },
    ];

    const sync2 = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => new Date("2026-10-17T14:30:00.000Z"),
      sleep: async () => {},
    });
    expect(sync2.seen).toBe(1);
    expect(sync2.inserted).toBe(1);

    const latestAfterSync2 = db
      .query<{ source_id: string; duration_seconds: number }, []>(
        "SELECT source_id, duration_seconds FROM events_latest;"
      )
      .all();
    expect(latestAfterSync2).toEqual([
      {
        source_id: `${VID_A}:2026-10-17T10:00:00.000Z`,
        duration_seconds: 360,
      },
    ]);

    // Sync 3 at 14:40Z (repeat sync with no new events): inserts 0 rows (idempotent!)
    const sync3 = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => new Date("2026-10-17T14:40:00.000Z"),
      sleep: async () => {},
    });
    expect(sync3.seen).toBe(1);
    expect(sync3.inserted).toBe(0);

    // Sync 4 at 16:30Z: user watched another 120s at 16:00Z on the same day.
    // Total is now 360 + 120 = 480s. Updates the same source_id without double counting!
    bucketEvents = [
      ...bucketEvents,
      {
        timestamp: "2026-10-17T16:00:00.000Z",
        duration: 120,
        data: {
          url: `https://www.youtube.com/watch?v=${VID_A}`,
          title: "Growing Video - YouTube",
          audible: true,
        },
      },
    ];

    const sync4 = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => new Date("2026-10-17T16:30:00.000Z"),
      sleep: async () => {},
    });
    expect(sync4.seen).toBe(1);
    expect(sync4.inserted).toBe(1);

    const latestAfterSync4 = db
      .query<{ source_id: string; duration_seconds: number }, []>(
        "SELECT source_id, duration_seconds FROM events_latest;"
      )
      .all();
    expect(latestAfterSync4).toEqual([
      {
        source_id: `${VID_A}:2026-10-17T10:00:00.000Z`,
        duration_seconds: 480,
      },
    ]);

    // Also verify enrichment ran during sync and populated youtube_videos_latest
    const enriched = getYoutubeVideoEnrichmentMap(db).get(VID_A);
    expect(enriched).toBeDefined();
    expect(enriched?.channel).toBe("Enriched Synth Channel");
    expect(enriched?.genre).toBe("Science & Technology");
    expect(enriched?.status).toBe("ok");
  });
});

describe("Read filter hides old short rows everywhere", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();
    // Seed:
    // 1. Old stored short AW play: 120s (2 min < 5 min) on 2026-10-15 -> MUST BE HIDDEN EVERYWHERE
    // 2. Old stored short phone play: 240s (4 min < 5 min) on 2026-10-15 -> MUST BE HIDDEN EVERYWHERE
    // 3. Stored valid AW play: 600s (10 min >= 5 min) on 2026-10-16 -> KEPT
    // 4. Two stored plays of VID_D on 2026-10-17: 180s + 180s = 360s (6 min >= 5 min) -> KEPT
    seedEvents(db, [
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_A}:2026-10-15T10:00:00.000Z`,
        external_ids: { youtube_video: VID_A },
        media_type: "video",
        title: "Short Hidden Video One",
        parent_title: "Short Channel",
        started_at: "2026-10-15T10:00:00.000Z",
        ended_at: "2026-10-15T10:02:00.000Z",
        duration_seconds: 120,
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "phone-short-1",
        external_ids: { youtube_video: VID_B },
        media_type: "video",
        title: "Short Hidden Video Two",
        parent_title: "Short Channel",
        started_at: "2026-10-15T12:00:00.000Z",
        ended_at: "2026-10-15T12:04:00.000Z",
        duration_seconds: 240,
      },
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_C}:2026-10-16T10:00:00.000Z`,
        external_ids: { youtube_video: VID_C },
        media_type: "video",
        title: "Long Visible Video",
        parent_title: "Long Channel",
        started_at: "2026-10-16T10:00:00.000Z",
        ended_at: "2026-10-16T10:10:00.000Z",
        duration_seconds: 600,
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "phone-merge-1",
        external_ids: { youtube_video: VID_D },
        media_type: "video",
        title: "Merged Day Video",
        parent_title: "Long Channel",
        started_at: "2026-10-17T09:00:00.000Z",
        ended_at: "2026-10-17T09:03:00.000Z",
        duration_seconds: 180,
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "phone-merge-2",
        external_ids: { youtube_video: VID_D },
        media_type: "video",
        title: "Merged Day Video",
        parent_title: "Long Channel",
        started_at: "2026-10-17T15:00:00.000Z",
        ended_at: "2026-10-17T15:03:00.000Z",
        duration_seconds: 180,
      },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  test("hides short plays from library, calendar (day list), series, review totals, search, stats, and heat maps while keeping rows in events", async () => {
    const app = createApp({ db, config });

    // 0. Rows stay in events (append-only)
    const totalRows = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get();
    expect(totalRows?.n).toBe(5);

    // 1. Library: only "Long Channel" (10m + 6m = 16m); "Short Channel" is completely hidden
    const libRes = await app.request("/api/library");
    expect(libRes.status).toBe(200);
    const lib = (await libRes.json()) as LibraryResult;
    expect(lib.total_minutes).toBe(16);
    expect(lib.works.map((w) => w.title)).toEqual(["Long Channel"]);

    // 2. Calendar (day list): 2026-10-15 has 0 items (absent), 2026-10-16 has 10m, 2026-10-17 has 6m
    const calRes = await app.request("/api/calendar?month=2026-10");
    expect(calRes.status).toBe(200);
    const cal = (await calRes.json()) as CalendarResult;
    expect(cal.days.map((d) => [d.date, d.minutes])).toEqual([
      ["2026-10-16", 10],
      ["2026-10-17", 6],
    ]);

    // 3. Series: 2026-10-15 is empty, 16 has 10m, 17 has 6m
    const seriesRes = await app.request(
      "/api/series?bucket=day&from=2026-10-15&to=2026-10-17"
    );
    expect(seriesRes.status).toBe(200);
    const series = (await seriesRes.json()) as SeriesResult;
    expect(series.points).toEqual([
      { bucket: "2026-10-15", minutes_by_category: {} },
      { bucket: "2026-10-16", minutes_by_category: { youtube: 10 } },
      { bucket: "2026-10-17", minutes_by_category: { youtube: 6 } },
    ]);

    // 4. Month & Year Review totals: 16 minutes, 2 active days
    const mrRes = await app.request("/api/review/month?month=2026-10");
    expect(mrRes.status).toBe(200);
    const mr = (await mrRes.json()) as MonthReview;
    expect(mr.total_minutes).toBe(16);
    expect(mr.active_days).toBe(2);

    const yrRes = await app.request("/api/review/year?year=2026");
    expect(yrRes.status).toBe(200);
    const yr = (await yrRes.json()) as YearReviewV2;
    expect(yr.total_minutes).toBe(16);
    expect(yr.active_days).toBe(2);

    // 5. Search: searching for "Short" finds 0 hits; searching for "Long" finds Long Visible Video & Long Channel
    const searchShortRes = await app.request("/api/search?q=Short");
    const searchShort = (await searchShortRes.json()) as SearchResult;
    expect(searchShort.total).toBe(0);

    const searchLongRes = await app.request("/api/search?q=Long");
    const searchLong = (await searchLongRes.json()) as SearchResult;
    expect(searchLong.total).toBeGreaterThan(0);

    // 6. Heatmap & Stats
    const hmRes = await app.request("/api/heatmap/days?year=2026");
    const hm = (await hmRes.json()) as HeatmapDaysResult;
    expect(hm.days.map((d) => [d.date, d.minutes])).toEqual([
      ["2026-10-16", 10],
      ["2026-10-17", 6],
    ]);

    const statsRes = await app.request("/api/stats");
    const stats = (await statsRes.json()) as StatsResult;
    expect(stats.total_minutes).toBe(16);
    expect(stats.total_items).toBe(3);

    // 7. YouTube overview reports short_plays_hidden = 2
    const ytRes = await app.request("/api/youtube");
    expect(ytRes.status).toBe(200);
    const yt = (await ytRes.json()) as YoutubeOverview;
    expect(yt.total_minutes).toBe(16);
    expect(yt.videos).toBe(2);
    expect(yt.short_plays_hidden).toBe(2);
    expect(yt.min_watch_minutes).toBe(5);
  });
});

describe("Enrichment: oEmbed and watch page genre parsing, 404/429 retry-after, and cap", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("parseOembedPayload handles complete, partial, and malformed payloads", () => {
    expect(
      parseOembedPayload({
        title: "  Synthetic Essay  ",
        author_name: "  Synth Creator ",
        author_url: "https://www.youtube.com/channel/UC1234567890abcdef",
        thumbnail_url: "https://i.ytimg.com/vi/SynthVid00A/hqdefault.jpg",
      })
    ).toEqual({
      title: "Synthetic Essay",
      channel: "Synth Creator",
      channel_url: "https://www.youtube.com/channel/UC1234567890abcdef",
      channel_id: "UC1234567890abcdef",
      thumbnail_url: "https://i.ytimg.com/vi/SynthVid00A/hqdefault.jpg",
    });

    // @handle URL extraction & missing fields
    expect(
      parseOembedPayload({
        author_name: "Handle Creator",
        author_url: "https://www.youtube.com/@handle_creator",
        thumbnail_url: "ftp://invalid-scheme.example/img.jpg",
      })
    ).toEqual({
      title: null,
      channel: "Handle Creator",
      channel_url: "https://www.youtube.com/@handle_creator",
      channel_id: "@handle_creator",
      thumbnail_url: null,
    });

    expect(parseOembedPayload(null)).toEqual({
      title: null,
      channel: null,
      channel_url: null,
      channel_id: null,
      thumbnail_url: null,
    });
    expect(parseOembedPayload({})).toEqual({
      title: null,
      channel: null,
      channel_url: null,
      channel_id: null,
      thumbnail_url: null,
    });
  });

  test("parseWatchPageGenre parses itemprop='genre' in any attribute order, decodes HTML entities, and returns null when missing", () => {
    expect(
      parseWatchPageGenre(
        '<!doctype html><html><head><meta itemprop="genre" content="Science &amp; Technology"></head></html>'
      )
    ).toBe("Science & Technology");

    // Reversed attribute order and single quotes
    expect(
      parseWatchPageGenre(
        "<meta content='Film &amp; Animation' itemprop='genre' />"
      )
    ).toBe("Film & Animation");

    // Numeric entity
    expect(
      parseWatchPageGenre(
        '<meta name="x" itemprop="genre" content="People &#38; Blogs">'
      )
    ).toBe("People & Blogs");

    // HTML without the meta tag
    expect(
      parseWatchPageGenre(
        '<html><head><meta property="og:title" content="Some Video"></head><body>No genre tag</body></html>'
      )
    ).toBeNull();

    // Empty content attribute
    expect(
      parseWatchPageGenre('<meta itemprop="genre" content="   ">')
    ).toBeNull();
  });

  test("handles 200 without genre tag, 404, 429 with Retry-After, retry-after cooldown, and per-run cap", async () => {
    // Seed 4 videos with >= 5 min watch time
    seedEvents(db, [
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_A}:2026-10-17T10:00:00.000Z`,
        external_ids: { youtube_video: VID_A },
        media_type: "video",
        title: "Vid A",
        started_at: "2026-10-17T10:00:00.000Z",
        duration_seconds: 600,
      },
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_B}:2026-10-17T11:00:00.000Z`,
        external_ids: { youtube_video: VID_B },
        media_type: "video",
        title: "Vid B",
        started_at: "2026-10-17T11:00:00.000Z",
        duration_seconds: 600,
      },
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_C}:2026-10-17T12:00:00.000Z`,
        external_ids: { youtube_video: VID_C },
        media_type: "video",
        title: "Vid C",
        started_at: "2026-10-17T12:00:00.000Z",
        duration_seconds: 600,
      },
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_D}:2026-10-17T13:00:00.000Z`,
        external_ids: { youtube_video: VID_D },
        media_type: "video",
        title: "Vid D",
        started_at: "2026-10-17T13:00:00.000Z",
        duration_seconds: 600,
      },
    ]);

    let currentNowMs = Date.parse("2026-10-18T12:00:00.000Z");
    let vidBShouldSucceed = false;
    const fetchedUrls: string[] = [];
    const requestedMethods: string[] = [];

    const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : String(input);
      fetchedUrls.push(urlStr);
      requestedMethods.push(init?.method ?? "GET");

      const u = new URL(urlStr);
      const vid =
        u.pathname === "/oembed"
          ? new URL(u.searchParams.get("url")!).searchParams.get("v")
          : u.searchParams.get("v");

      // VID_D: 200 OK on oEmbed, 200 OK on watch page WITHOUT meta genre tag
      if (vid === VID_D) {
        if (u.pathname === "/oembed") {
          return new Response(
            JSON.stringify({
              title: "Vid D Enriched",
              author_name: "Channel D",
              author_url: "https://www.youtube.com/@chanD",
              thumbnail_url: `https://i.ytimg.com/vi/${VID_D}/hqdefault.jpg`,
            }),
            { status: 200 }
          );
        }
        return new Response("<html><head><title>Vid D</title></head></html>", {
          status: 200,
        });
      }

      // VID_C: 404 Not Found on oEmbed
      if (vid === VID_C) {
        return new Response("Not Found", { status: 404 });
      }

      // VID_B: 429 Too Many Requests with Retry-After: 120 (until vidBShouldSucceed = true)
      if (vid === VID_B && !vidBShouldSucceed) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "120" },
        });
      }

      // VID_A (and VID_B once retried): 200 OK with genre
      if (u.pathname === "/oembed") {
        return new Response(
          JSON.stringify({
            title: `Enriched ${vid}`,
            author_name: `Channel ${vid}`,
            author_url: `https://www.youtube.com/channel/UC_${vid}`,
          }),
          { status: 200 }
        );
      }
      return new Response(
        '<html><meta itemprop="genre" content="Education"></html>',
        { status: 200 }
      );
    }) as typeof fetch;

    // 1. Test enrichment cap: limit = 2 -> only newest 2 videos (VID_D and VID_C) are attempted
    const run1 = await enrichYoutubeVideos(db, {
      config: mockConfig({
        youtube: {
          thumb_base_url: "https://i.ytimg.com/vi",
          min_watch_minutes: 5,
          enrich_per_sync: 2,
        },
      }),
      fetch: fakeFetch,
      sleep: async () => {},
      nowMs: () => currentNowMs,
    });

    expect(run1).toEqual({
      attempted: 2,
      enriched: 1, // VID_D succeeded (even without meta tag!)
      notFound: 1, // VID_C returned 404
      failed: 0,
    });
    expect(requestedMethods.every((m) => m === "GET")).toBe(true);

    const mapAfterRun1 = getYoutubeVideoEnrichmentMap(db);
    expect(mapAfterRun1.get(VID_D)?.status).toBe("ok");
    expect(mapAfterRun1.get(VID_D)?.channel).toBe("Channel D");
    expect(mapAfterRun1.get(VID_D)?.genre).toBeNull();
    expect(mapAfterRun1.get(VID_D)?.retry_after).toBeNull();

    expect(mapAfterRun1.get(VID_C)?.status).toBe("not_found");
    expect(mapAfterRun1.get(VID_C)?.http_status).toBe(404);
    expect(mapAfterRun1.get(VID_C)?.retry_after).not.toBeNull();

    // 2. Next run with limit = 50 at the same timestamp:
    // VID_D is 'ok' (skipped), VID_C has retry_after in 7 days (skipped),
    // so only VID_B (429) and VID_A (200) are attempted!
    fetchedUrls.length = 0;
    const run2 = await enrichYoutubeVideos(db, {
      config: mockConfig(),
      fetch: fakeFetch,
      sleep: async () => {},
      nowMs: () => currentNowMs,
    });

    expect(run2).toEqual({
      attempted: 2,
      enriched: 1, // VID_A
      notFound: 0,
      failed: 1, // VID_B (429)
    });

    const mapAfterRun2 = getYoutubeVideoEnrichmentMap(db);
    const vidBFailed = mapAfterRun2.get(VID_B)!;
    expect(vidBFailed.status).toBe("failed");
    expect(vidBFailed.http_status).toBe(429);
    // Retry-After: 120 seconds -> 2026-10-18T12:02:00.000Z
    expect(vidBFailed.retry_after).toBe("2026-10-18T12:02:00.000Z");

    // 3. Run 3 at +60s (before Retry-After 120s expires): 0 videos attempted!
    currentNowMs += 60 * 1000;
    fetchedUrls.length = 0;
    const run3 = await enrichYoutubeVideos(db, {
      config: mockConfig(),
      fetch: fakeFetch,
      sleep: async () => {},
      nowMs: () => currentNowMs,
    });
    expect(run3.attempted).toBe(0);
    expect(fetchedUrls).toHaveLength(0);

    // 4. Run 4 at +121s (after Retry-After 120s expires): VID_B is retried and succeeds!
    currentNowMs += 61 * 1000;
    vidBShouldSucceed = true;
    const run4 = await enrichYoutubeVideos(db, {
      config: mockConfig(),
      fetch: fakeFetch,
      sleep: async () => {},
      nowMs: () => currentNowMs,
    });
    expect(run4).toEqual({
      attempted: 1,
      enriched: 1,
      notFound: 0,
      failed: 0,
    });

    const mapAfterRun4 = getYoutubeVideoEnrichmentMap(db);
    expect(mapAfterRun4.get(VID_B)?.status).toBe("ok");
    expect(mapAfterRun4.get(VID_B)?.channel).toBe(`Channel ${VID_B}`);
    expect(mapAfterRun4.get(VID_B)?.genre).toBe("Education");
    expect(mapAfterRun4.get(VID_B)?.retry_after).toBeNull();

    // And youtube_videos has both the failed row and the new ok row for VID_B (append-only!)
    const vidBHistory = db
      .query<YoutubeVideoRow, [string]>(
        "SELECT * FROM youtube_videos WHERE video_id = ? ORDER BY id ASC;"
      )
      .all(VID_B);
    expect(vidBHistory).toHaveLength(2);
    expect(vidBHistory[0]?.status).toBe("failed");
    expect(vidBHistory[1]?.status).toBe("ok");
  });

  test("CLI: it youtube enrich [--limit N] runs enrichment and validates --limit", async () => {
    seedEvents(db, [
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_A}:2026-10-17T10:00:00.000Z`,
        external_ids: { youtube_video: VID_A },
        media_type: "video",
        title: "CLI Video",
        started_at: "2026-10-17T10:00:00.000Z",
        duration_seconds: 600,
      },
    ]);

    const fakeFetch: typeof fetch = (async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : String(input));
      if (u.pathname === "/oembed") {
        return new Response(
          JSON.stringify({
            title: "CLI Enriched Video",
            author_name: "CLI Channel",
          }),
          { status: 200 }
        );
      }
      return new Response(
        '<html><meta itemprop="genre" content="Gaming"></html>',
        { status: 200 }
      );
    }) as typeof fetch;

    let outText = "";
    let errText = "";
    const code = await runCli(["youtube", "enrich", "--limit", "5"], {
      loadConfig: () => mockConfig(),
      openDb: () => db,
      fetch: fakeFetch,
      sleep: async () => {},
      out: (line) => {
        outText += `${line}\n`;
      },
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(0);
    expect(outText).toContain("youtube enrich: 1 attempted, 1 enriched");

    // Re-open db for invalid --limit test
    const db2 = openDb(":memory:");
    let errBad = "";
    const badCode = await runCli(["youtube", "enrich", "--limit", "0"], {
      loadConfig: () => mockConfig(),
      openDb: () => db2,
      out: () => {},
      err: (line) => {
        errBad += `${line}\n`;
      },
    });
    expect(badCode).toBe(1);
    expect(errBad).toContain("Invalid --limit");
    db2.close();
  });
});

describe("Topic precedence and YouTube endpoints (GET /api/youtube, GET /api/youtube/videos, POST /api/youtube/channel-topic)", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();

    // Seed enrichment data in youtube_videos:
    // VID_A: channel "Synth Tech", genre "Science & Technology"
    // VID_B: channel "Synth Tech", genre "Science & Technology"
    // VID_C: channel "Synth Cooking", genre "Howto & Style"
    // VID_D: channel "Uncategorized Channel", genre null
    // VID_E: short play (120s < 300s), should be hidden and counted in short_plays_hidden
    db.run(
      `INSERT INTO youtube_videos (video_id, title, channel, channel_id, genre, status, http_status, fetched_at)
       VALUES
         (?, 'Rust Async Deep Dive', 'Synth Tech', 'UCsynthtech', 'Science & Technology', 'ok', 200, '2026-10-18T10:00:00.000Z'),
         (?, 'Linux Kernel Internals', 'Synth Tech', 'UCsynthtech', 'Science & Technology', 'ok', 200, '2026-10-18T10:00:00.000Z'),
         (?, 'Sourdough Bread Guide', 'Synth Cooking', 'UCsynthcook', 'Howto & Style', 'ok', 200, '2026-10-18T10:00:00.000Z'),
         (?, 'Mystery Vlog', 'Uncategorized Channel', 'UCuncat', NULL, 'ok', 200, '2026-10-18T10:00:00.000Z');`,
      [VID_A, VID_B, VID_C, VID_D]
    );

    seedEvents(db, [
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_A}:2026-10-10T10:00:00.000Z`,
        external_ids: { youtube_video: VID_A },
        media_type: "video",
        title: "Rust Async Deep Dive",
        parent_title: null, // Enriched from youtube_videos_latest!
        started_at: "2026-10-10T10:00:00.000Z",
        duration_seconds: 1200, // 20m
      },
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_A}:2026-10-11T10:00:00.000Z`,
        external_ids: { youtube_video: VID_A },
        media_type: "video",
        title: "Rust Async Deep Dive",
        parent_title: null,
        started_at: "2026-10-11T10:00:00.000Z",
        duration_seconds: 600, // +10m -> total 30m, 2 plays
      },
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_B}:2026-10-12T10:00:00.000Z`,
        external_ids: { youtube_video: VID_B },
        media_type: "video",
        title: "Linux Kernel Internals",
        parent_title: null,
        started_at: "2026-10-12T10:00:00.000Z",
        duration_seconds: 900, // 15m
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "phone-cook-1",
        external_ids: { youtube_video: VID_C },
        media_type: "video",
        title: "Sourdough Bread Guide",
        parent_title: "Synth Cooking",
        started_at: "2026-10-13T10:00:00.000Z",
        duration_seconds: 600, // 10m
      },
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_D}:2026-10-14T10:00:00.000Z`,
        external_ids: { youtube_video: VID_D },
        media_type: "video",
        title: "Mystery Vlog",
        parent_title: null,
        started_at: "2026-10-14T10:00:00.000Z",
        duration_seconds: 300, // 5m (boundary!)
      },
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: `${VID_E}:2026-10-14T12:00:00.000Z`,
        external_ids: { youtube_video: VID_E },
        media_type: "video",
        title: "Too Short Clip",
        started_at: "2026-10-14T12:00:00.000Z",
        duration_seconds: 120, // 2m (< 5m -> hidden!)
      },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  test("topic precedence: video edit > channel topic > YouTube category > null", async () => {
    const app = createApp({ db, config });

    // Initially:
    // VID_A & VID_B have YouTube category "Science & Technology"
    // VID_C has YouTube category "Howto & Style"
    // VID_D has null
    let vidsRes = await app.request("/api/youtube/videos");
    expect(vidsRes.status).toBe(200);
    let vids = (await vidsRes.json()) as YoutubeVideosResult;
    expect(vids.total).toBe(4);

    const byId = (res: YoutubeVideosResult) =>
      new Map(res.videos.map((v) => [v.video_id, v]));

    expect(byId(vids).get(VID_A)?.topic).toBe("Science & Technology");
    expect(byId(vids).get(VID_B)?.topic).toBe("Science & Technology");
    expect(byId(vids).get(VID_C)?.topic).toBe("Howto & Style");
    expect(byId(vids).get(VID_D)?.topic).toBeNull();

    // Step 2: Set channel topic for "Synth Tech" -> "Programming"
    const setChanRes = await app.request("/api/youtube/channel-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "Synth Tech", topic: "Programming" }),
    });
    expect(setChanRes.status).toBe(200);
    expect(await setChanRes.json()).toEqual({
      channel: "Synth Tech",
      topic: "Programming",
      inserted: true,
    });

    // Repeat identical POST is idempotent (inserted: false)
    const repeatChanRes = await app.request("/api/youtube/channel-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "Synth Tech", topic: "Programming" }),
    });
    expect(await repeatChanRes.json()).toEqual({
      channel: "Synth Tech",
      topic: "Programming",
      inserted: false,
    });

    // Both VID_A and VID_B now have topic "Programming" (channel topic > YouTube category)
    vidsRes = await app.request("/api/youtube/videos");
    vids = (await vidsRes.json()) as YoutubeVideosResult;
    expect(byId(vids).get(VID_A)?.topic).toBe("Programming");
    expect(byId(vids).get(VID_B)?.topic).toBe("Programming");

    // Step 3: Set video edit override on VID_A -> "Rust"
    const vidAKey = byId(vids).get(VID_A)!.key;
    setVideoTopicOverride(db, vidAKey, "Rust");

    // VID_A now has "Rust" (video edit > channel topic), while VID_B still has "Programming"
    vidsRes = await app.request("/api/youtube/videos");
    vids = (await vidsRes.json()) as YoutubeVideosResult;
    expect(byId(vids).get(VID_A)?.topic).toBe("Rust");
    expect(byId(vids).get(VID_B)?.topic).toBe("Programming");

    // Step 4: Clear channel topic for "Synth Tech" with topic: null
    const clearChanRes = await app.request("/api/youtube/channel-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "Synth Tech", topic: null }),
    });
    expect(clearChanRes.status).toBe(200);
    expect(await clearChanRes.json()).toEqual({
      channel: "Synth Tech",
      topic: null,
      inserted: true,
    });

    // VID_A keeps "Rust" (video edit), while VID_B falls back to "Science & Technology" (YouTube category)
    vidsRes = await app.request("/api/youtube/videos");
    vids = (await vidsRes.json()) as YoutubeVideosResult;
    expect(byId(vids).get(VID_A)?.topic).toBe("Rust");
    expect(byId(vids).get(VID_B)?.topic).toBe("Science & Technology");

    // Step 5: Clear video edit on VID_A -> falls back to "Science & Technology"
    setVideoTopicOverride(db, vidAKey, null);
    vidsRes = await app.request("/api/youtube/videos");
    vids = (await vidsRes.json()) as YoutubeVideosResult;
    expect(byId(vids).get(VID_A)?.topic).toBe("Science & Technology");

    // Step 6: Also verify LibraryWork.channel and LibraryWork.topic are populated on /api/library
    const libRes = await app.request("/api/library?category=youtube");
    expect(libRes.status).toBe(200);
    const lib = (await libRes.json()) as LibraryResult;
    const synthTechWork = lib.works.find((w) => w.title === "Synth Tech")!;
    expect(synthTechWork).toBeDefined();
    expect(synthTechWork.channel).toBe("Synth Tech");
    expect(synthTechWork.topic).toBe("Science & Technology");
  });

  test("GET /api/youtube returns overview with topics, channels, sparkline days when from/to given, and short_plays_hidden", async () => {
    const app = createApp({ db, config });

    // All-time overview (no from/to -> days is [])
    const allRes = await app.request("/api/youtube");
    expect(allRes.status).toBe(200);
    const allOverview = (await allRes.json()) as YoutubeOverview;

    expect(allOverview.from).toBeNull();
    expect(allOverview.to).toBeNull();
    expect(allOverview.total_minutes).toBe(30 + 15 + 10 + 5); // 60m
    expect(allOverview.videos).toBe(4);
    expect(allOverview.short_plays_hidden).toBe(1); // VID_E (2m)
    expect(allOverview.min_watch_minutes).toBe(5);
    expect(allOverview.days).toEqual([]);

    expect(allOverview.topics).toEqual([
      {
        topic: "Science & Technology",
        channels: 1,
        videos: 2,
        total_minutes: 45,
      },
      {
        topic: "Howto & Style",
        channels: 1,
        videos: 1,
        total_minutes: 10,
      },
    ]);

    expect(allOverview.channels).toEqual([
      {
        channel: "Synth Tech",
        channel_id: "UCsynthtech",
        topic: "Science & Technology",
        videos: 2,
        total_minutes: 45,
        last_at: "2026-10-12T10:00:00.000Z",
      },
      {
        channel: "Synth Cooking",
        channel_id: "UCsynthcook",
        topic: "Howto & Style",
        videos: 1,
        total_minutes: 10,
        last_at: "2026-10-13T10:00:00.000Z",
      },
      {
        channel: "Uncategorized Channel",
        channel_id: "UCuncat",
        topic: null,
        videos: 1,
        total_minutes: 5,
        last_at: "2026-10-14T10:00:00.000Z",
      },
    ]);

    // Date-filtered overview: from=2026-10-11&to=2026-10-13
    const rangeRes = await app.request(
      "/api/youtube?from=2026-10-11&to=2026-10-13"
    );
    expect(rangeRes.status).toBe(200);
    const rangeOverview = (await rangeRes.json()) as YoutubeOverview;

    expect(rangeOverview.from).toBe("2026-10-11");
    expect(rangeOverview.to).toBe("2026-10-13");
    // In range: VID_A on Oct 11 (10m), VID_B on Oct 12 (15m), VID_C on Oct 13 (10m) = 35m
    expect(rangeOverview.total_minutes).toBe(35);
    expect(rangeOverview.videos).toBe(3);
    expect(rangeOverview.short_plays_hidden).toBe(0); // VID_E was on Oct 14
    expect(rangeOverview.days).toEqual([
      { bucket: "2026-10-11", minutes_by_category: { youtube: 10 } },
      { bucket: "2026-10-12", minutes_by_category: { youtube: 15 } },
      { bucket: "2026-10-13", minutes_by_category: { youtube: 10 } },
    ]);
  });

  test("GET /api/youtube/videos supports channel, topic, from, to, q filters, local thumbnail URLs, and limit/offset paging", async () => {
    const app = createApp({ db, config });

    // 1. Default list: newest first, local thumbnail URLs
    const allRes = await app.request("/api/youtube/videos");
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as YoutubeVideosResult;
    expect(all.total).toBe(4);
    expect(all.videos.map((v) => v.video_id)).toEqual([
      VID_D, // Oct 14
      VID_C, // Oct 13
      VID_B, // Oct 12
      VID_A, // Oct 11 (first_at Oct 10, last_at Oct 11, plays: 2, watched_minutes: 30)
    ]);

    const vidA = all.videos.find((v) => v.video_id === VID_A)!;
    expect(vidA).toEqual({
      key: `youtube:video:${VID_A}`,
      video_id: VID_A,
      title: "Rust Async Deep Dive",
      channel: "Synth Tech",
      topic: "Science & Technology",
      watched_minutes: 30,
      plays: 2,
      first_at: "2026-10-10T10:00:00.000Z",
      last_at: "2026-10-11T10:00:00.000Z",
      thumbnail_url: `/api/thumb/youtube/${VID_A}`,
    });

    // Video key also works with GET /api/library/work?key=
    const workDetailRes = await app.request(
      `/api/library/work?key=${encodeURIComponent(vidA.key)}`
    );
    expect(workDetailRes.status).toBe(200);
    const workDetail = (await workDetailRes.json()) as LibraryWorkDetail;
    expect(workDetail.title).toBe("Rust Async Deep Dive");
    expect(workDetail.channel).toBe("Synth Tech");
    expect(workDetail.topic).toBe("Science & Technology");
    expect(workDetail.total_minutes).toBe(30);
    expect(workDetail.units).toBe(2);

    // 2. Filter by channel
    const chanRes = await app.request(
      "/api/youtube/videos?channel=Synth+Tech"
    );
    const chanBody = (await chanRes.json()) as YoutubeVideosResult;
    expect(chanBody.total).toBe(2);
    expect(chanBody.videos.map((v) => v.video_id)).toEqual([VID_B, VID_A]);

    // 3. Filter by topic
    const topicRes = await app.request(
      `/api/youtube/videos?topic=${encodeURIComponent("Howto & Style")}`
    );
    const topicBody = (await topicRes.json()) as YoutubeVideosResult;
    expect(topicBody.total).toBe(1);
    expect(topicBody.videos[0]?.video_id).toBe(VID_C);

    // 4. Filter by q (multi-word search across title/channel/topic)
    const qRes = await app.request("/api/youtube/videos?q=rust+tech");
    const qBody = (await qRes.json()) as YoutubeVideosResult;
    expect(qBody.total).toBe(1);
    expect(qBody.videos[0]?.video_id).toBe(VID_A);

    // 5. Filter by from & to
    const dateRes = await app.request(
      "/api/youtube/videos?from=2026-10-12&to=2026-10-13"
    );
    const dateBody = (await dateRes.json()) as YoutubeVideosResult;
    expect(dateBody.total).toBe(2);
    expect(dateBody.videos.map((v) => v.video_id)).toEqual([VID_C, VID_B]);

    // 6. Paging with limit & offset
    const page1Res = await app.request("/api/youtube/videos?limit=2&offset=0");
    const page1 = (await page1Res.json()) as YoutubeVideosResult;
    expect(page1.total).toBe(4);
    expect(page1.videos.map((v) => v.video_id)).toEqual([VID_D, VID_C]);

    const page2Res = await app.request("/api/youtube/videos?limit=2&offset=2");
    const page2 = (await page2Res.json()) as YoutubeVideosResult;
    expect(page2.total).toBe(4);
    expect(page2.videos.map((v) => v.video_id)).toEqual([VID_B, VID_A]);

    // 7. Validation errors (400)
    expect((await app.request("/api/youtube?unknown=1")).status).toBe(400);
    expect((await app.request("/api/youtube?from=bad-date")).status).toBe(400);
    expect(
      (await app.request("/api/youtube?from=2026-10-15&to=2026-10-10")).status
    ).toBe(400);
    expect((await app.request("/api/youtube/videos?limit=0")).status).toBe(400);
    expect((await app.request("/api/youtube/videos?offset=-1")).status).toBe(400);
    expect(
      (
        await app.request("/api/youtube/channel-topic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: "   ", topic: "Math" }),
        })
      ).status
    ).toBe(400);
  });
});
