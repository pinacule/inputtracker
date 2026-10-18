import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { startRun } from "../src/core/events.ts";
import type { Config } from "../src/core/config.ts";
import { LocalDbSink } from "../src/core/sink.ts";
import { localToUtcIso } from "../src/core/time.ts";
import { runCli } from "../src/cli/index.ts";
import {
  createActivityWatchClient,
  type FetchFn,
} from "../src/sources/activitywatch/client.ts";
import {
  ACTIVITYWATCH_SOURCE,
  backfillActivityWatch,
  syncActivityWatch,
} from "../src/sources/activitywatch/sync.ts";
import type { AwBucket, AwRawEvent } from "../src/sources/activitywatch/types.ts";

const FAKE_VID_1 = "AAAAAAAAAA1";
const FAKE_VID_2 = "BBBBBBBBBB2";
const FAKE_VID_3 = "CCCCCCCCCC3";

function mockConfig(overrides: Partial<Config> = {}): Config {
  return {
    timezone: "Europe/Bratislava",
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
      client_id: "simkl_client_id_synth",
      base_url: "https://api.simkl.com",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
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
    toString: () => "",
    ...overrides,
  } as Config;
}

interface MockServerState {
  buckets?: Record<string, AwBucket>;
  eventsPerBucket?: Record<string, AwRawEvent[]>;
  fail?: "network" | "500" | null;
}

describe("ActivityWatch backfill (test/activitywatch-backfill.test.ts)", () => {
  let db: Database;
  let requestedMethods: string[] = [];
  let requestedUrls: string[] = [];
  let state: MockServerState;

  function createMockFetch(): FetchFn {
    return async (input, init) => {
      const method = init?.method ?? "GET";
      requestedMethods.push(method);

      const urlStr = typeof input === "string" ? input : String(input);
      requestedUrls.push(urlStr);

      if (state.fail === "network") {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5600");
      }
      if (state.fail === "500") {
        return new Response("Internal Server Error", { status: 500 });
      }

      const parsed = new URL(urlStr);
      if (parsed.pathname === "/api/0/buckets/") {
        return new Response(JSON.stringify(state.buckets ?? {}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const match = parsed.pathname.match(/^\/api\/0\/buckets\/([^/]+)\/events$/);
      if (match) {
        const bucketId = decodeURIComponent(match[1]);
        const allEvents = state.eventsPerBucket?.[bucketId] ?? [];
        const startParam = parsed.searchParams.get("start");
        const endParam = parsed.searchParams.get("end");

        const filtered = allEvents.filter((ev) => {
          if (startParam && ev.timestamp < startParam) return false;
          if (endParam && ev.timestamp >= endParam) return false;
          return true;
        });

        return new Response(JSON.stringify(filtered), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    };
  }

  beforeEach(() => {
    db = openDb(":memory:");
    requestedMethods = [];
    requestedUrls = [];
    state = {
      buckets: {
        "aw-watcher-web-chrome_test": {
          id: "aw-watcher-web-chrome_test",
          type: "web.tab.current",
          client: "aw-watcher-web",
          hostname: "test-pc",
        },
      },
      eventsPerBucket: {},
      fail: null,
    };
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test("window from --since to oldest stored play", async () => {
    const bucketId = "aw-watcher-web-chrome_test";
    const sink = new LocalDbSink(db);

    // Seed an already stored play in DB starting at 2026-10-10T12:00:00.000Z
    const seedRunId = startRun(db, ACTIVITYWATCH_SOURCE, "sync");
    await sink.write(
      [
        {
          source: "youtube",
          source_kind: "aw_play",
          source_id: `${FAKE_VID_1}:2026-10-10T12:00:00.000Z`,
          media_type: "video",
          title: "Initial Play",
          parent_title: null,
          started_at: "2026-10-10T12:00:00.000Z",
          ended_at: "2026-10-10T12:20:00.000Z",
          duration_seconds: 1200,
          progress: null,
          device: "pc",
          external_ids: { youtube_video: FAKE_VID_1 },
          raw: { bucket: bucketId },
        },
      ],
      { source: ACTIVITYWATCH_SOURCE, runId: seedRunId }
    );

    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });

    const fixedNow = new Date("2026-10-17T18:00:00.000Z");
    await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-05",
      config,
      now: () => fixedNow,
    });

    // In Europe/Bratislava (UTC+2 on 2026-10-05), 2026-10-05 00:00 is 2026-10-04T22:00:00.000Z
    const expectedStart = "2026-10-04T22:00:00.000Z";
    const expectedEnd = "2026-10-10T12:00:00.000Z";

    const eventsCall = requestedUrls.find((u) => u.includes("/events?"));
    expect(eventsCall).toBeDefined();

    const parsed = new URL(eventsCall!);
    expect(parsed.searchParams.get("start")).toBe(expectedStart);
    expect(parsed.searchParams.get("end")).toBe(expectedEnd);
  });

  test("nothing stored → up to now", async () => {
    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    const fixedNow = new Date("2026-10-17T18:00:00.000Z");
    await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-15",
      config,
      now: () => fixedNow,
    });

    const expectedStart = "2026-10-14T22:00:00.000Z";
    const expectedEnd = fixedNow.toISOString();

    const eventsCall = requestedUrls.find((u) => u.includes("/events?"));
    expect(eventsCall).toBeDefined();

    const parsed = new URL(eventsCall!);
    expect(parsed.searchParams.get("start")).toBe(expectedStart);
    expect(parsed.searchParams.get("end")).toBe(expectedEnd);
  });

  test("chunking (e.g. 20 days → 3 chunks, oldest first) with a play spanning a chunk boundary emitted once and whole", async () => {
    const bucketId = "aw-watcher-web-chrome_test";
    const sink = new LocalDbSink(db);

    // Window: from 2026-09-01T00:00:00.000Z to 2026-09-21T00:00:00.000Z (20 days)
    // Seed an already stored play starting at 2026-09-21T00:00:00.000Z so window is exactly 20 days
    const seedRunId = startRun(db, ACTIVITYWATCH_SOURCE, "sync");
    await sink.write(
      [
        {
          source: "youtube",
          source_kind: "aw_play",
          source_id: `${FAKE_VID_1}:2026-09-21T00:00:00.000Z`,
          media_type: "video",
          title: "Anchor Play",
          parent_title: null,
          started_at: "2026-09-21T00:00:00.000Z",
          ended_at: "2026-09-21T00:20:00.000Z",
          duration_seconds: 1200,
          progress: null,
          device: "pc",
          external_ids: { youtube_video: FAKE_VID_1 },
          raw: { bucket: bucketId },
        },
      ],
      { source: ACTIVITYWATCH_SOURCE, runId: seedRunId }
    );

    // Chunk 1 starts at 2026-09-01T00:00:00.000Z and ends at 2026-09-08T00:00:00.000Z (7 days).
    // Put a play spanning the boundary:
    // Event 1: starts at 2026-09-07T23:55:00.000Z, dur 300s (ends 2026-09-08T00:00:00.000Z)
    // Event 2: starts at 2026-09-08T00:00:00.000Z, dur 600s (ends 2026-09-08T00:10:00.000Z)
    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-09-07T23:55:00.000Z",
          duration: 300,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_2}`,
            title: "Spanning Video - YouTube",
            audible: true,
          },
        },
        {
          timestamp: "2026-09-08T00:00:00.000Z",
          duration: 600,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_2}`,
            title: "Spanning Video - YouTube",
            audible: true,
          },
        },
      ],
    };

    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });

    const printed: string[] = [];
    const result = await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-09-01T00:00:00.000Z",
      config,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
      out: (line) => printed.push(line),
    });

    // 20 days window → 3 chunks
    const eventCalls = requestedUrls.filter((u) => u.includes("/events?"));
    expect(eventCalls.length).toBe(3);

    // Oldest first: verify chunk start times increase monotonically
    const chunkStarts = eventCalls.map((u) => new URL(u).searchParams.get("start")!);
    expect(new Date(chunkStarts[0]).getTime()).toBeLessThan(
      new Date(chunkStarts[1]).getTime()
    );
    expect(new Date(chunkStarts[1]).getTime()).toBeLessThan(
      new Date(chunkStarts[2]).getTime()
    );

    // Chunk 1 starts at 2026-09-01T00:00:00.000Z
    expect(chunkStarts[0]).toBe("2026-09-01T00:00:00.000Z");
    // Next chunk starts at started_at of the earliest play still going at chunk end: 2026-09-07T23:55:00.000Z
    expect(chunkStarts[1]).toBe("2026-09-07T23:55:00.000Z");

    // The boundary-spanning play was emitted once and whole in the DB
    const rows = db
      .query<{ started_at: string; ended_at: string; duration_seconds: number }, [string]>(
        `SELECT started_at, ended_at, duration_seconds
         FROM events_latest
         WHERE external_ids LIKE ?;`
      )
      .all(`%${FAKE_VID_2}%`);

    expect(rows.length).toBe(1);
    expect(rows[0].started_at).toBe("2026-09-07T23:55:00.000Z");
    expect(rows[0].ended_at).toBe("2026-09-08T00:10:00.000Z");
    expect(rows[0].duration_seconds).toBe(900);

    expect(result.seen).toBe(1);
    expect(result.inserted).toBe(1);
    expect(printed.some((p) => p.includes("3 chunks, 1 seen, 1 new"))).toBe(true);
  });

  test("overlap with a stored play skipped", async () => {
    const bucketId = "aw-watcher-web-chrome_test";
    const sink = new LocalDbSink(db);

    // Stored play in DB: 12:00 to 12:30
    const seedRunId = startRun(db, ACTIVITYWATCH_SOURCE, "sync");
    await sink.write(
      [
        {
          source: "youtube",
          source_kind: "aw_play",
          source_id: `${FAKE_VID_1}:2026-10-10T12:00:00.000Z`,
          media_type: "video",
          title: "Stored Play",
          parent_title: null,
          started_at: "2026-10-10T12:00:00.000Z",
          ended_at: "2026-10-10T12:30:00.000Z",
          duration_seconds: 1800,
          progress: null,
          device: "pc",
          external_ids: { youtube_video: FAKE_VID_1 },
          raw: { bucket: bucketId },
        },
      ],
      { source: ACTIVITYWATCH_SOURCE, runId: seedRunId }
    );

    // ActivityWatch has:
    // 1. Earlier non-overlapping play: 10:00 to 10:20 (VID_2)
    // 2. Overlapping play: 11:55 to 12:05 (VID_3) - overlaps [12:00, 12:30]
    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-10-10T10:00:00.000Z",
          duration: 1200,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_2}`,
            title: "Earlier Video - YouTube",
            audible: true,
          },
        },
        {
          timestamp: "2026-10-10T11:55:00.000Z",
          duration: 600,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_3}`,
            title: "Overlapping Cut Video - YouTube",
            audible: true,
          },
        },
      ],
    };

    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });

    const result = await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-10T09:00:00.000Z",
      config,
      now: () => new Date("2026-10-17T18:00:00.000Z"),
    });

    // VID_2 is inserted, VID_3 is skipped due to overlap
    expect(result.inserted).toBe(1);

    const vid2 = db
      .query<{ id: number }, [string]>(
        `SELECT id FROM events_latest WHERE external_ids LIKE ?;`
      )
      .get(`%${FAKE_VID_2}%`);
    expect(vid2).not.toBeNull();

    const vid3 = db
      .query<{ id: number }, [string]>(
        `SELECT id FROM events_latest WHERE external_ids LIKE ?;`
      )
      .get(`%${FAKE_VID_3}%`);
    expect(vid3).toBeNull();
  });

  test("re-run inserts 0", async () => {
    const bucketId = "aw-watcher-web-chrome_test";
    const sink = new LocalDbSink(db);

    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-10-05T10:00:00.000Z",
          duration: 600,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Synth Video 1 - YouTube",
            audible: true,
          },
        },
      ],
    };

    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });

    const fixedNow = new Date("2026-10-17T18:00:00.000Z");

    const res1 = await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-01",
      config,
      now: () => fixedNow,
    });
    expect(res1.inserted).toBe(1);

    // Second run with the exact same since argument
    const res2 = await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-01",
      config,
      now: () => fixedNow,
    });
    expect(res2.inserted).toBe(0);
  });

  test("sync_state unchanged after backfill and the normal sync still uses its cursor", async () => {
    const bucketId = "aw-watcher-web-chrome_test";
    const initialCursor = "2026-10-15T12:00:00.000Z";
    db.run(
      `INSERT INTO sync_state (source, cursor, updated_at) VALUES (?, ?, ?);`,
      [`activitywatch:${bucketId}`, initialCursor, "2026-10-15T12:00:00.000Z"]
    );

    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    const fixedNow = new Date("2026-10-17T18:00:00.000Z");

    // Run backfill
    await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-01",
      config,
      now: () => fixedNow,
    });

    // Check sync_state is untouched
    const cursorRow = db
      .query<{ cursor: string }, [string]>(
        `SELECT cursor FROM sync_state WHERE source = ?;`
      )
      .get(`activitywatch:${bucketId}`);
    expect(cursorRow?.cursor).toBe(initialCursor);

    // Normal sync still uses cursor
    requestedUrls = [];
    await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => fixedNow,
    });

    const syncEventsCall = requestedUrls.find((u) => u.includes("/events?"));
    expect(syncEventsCall).toBeDefined();
    const parsed = new URL(syncEventsCall!);

    // Start should be cursor - 10 min = 2026-10-15T11:50:00.000Z
    expect(parsed.searchParams.get("start")).toBe("2026-10-15T11:50:00.000Z");
    expect(parsed.searchParams.get("end")).toBe(fixedNow.toISOString());
  });

  test("local date → UTC including a DST date (e.g. 2026-03-29 and 2026-10-25)", async () => {
    const tz = "Europe/Bratislava";

    // 2026-03-29: Spring forward DST transition date
    // At local midnight, Bratislava is still standard time (UTC+1). Midnight is 2026-03-28T23:00:00.000Z.
    const springUtc = localToUtcIso("2026-03-29", tz);
    expect(springUtc).toBe("2026-03-28T23:00:00.000Z");

    // 2026-10-25: Fall back DST transition date
    // At local midnight, Bratislava is still summer time (UTC+2). Midnight is 2026-10-24T22:00:00.000Z.
    const fallUtc = localToUtcIso("2026-10-25", tz);
    expect(fallUtc).toBe("2026-10-24T22:00:00.000Z");

    // Also assert that backfillActivityWatch queries starting from these exact UTC instants
    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    // Spring DST run
    requestedUrls = [];
    await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-03-29",
      config,
      now: () => new Date("2026-04-01T12:00:00.000Z"),
    });
    const springCall = requestedUrls.find((u) => u.includes("/events?"));
    expect(new URL(springCall!).searchParams.get("start")).toBe("2026-03-28T23:00:00.000Z");

    // Fall DST run
    requestedUrls = [];
    await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-25",
      config,
      now: () => new Date("2026-11-01T12:00:00.000Z"),
    });
    const fallCall = requestedUrls.find((u) => u.includes("/events?"));
    expect(new URL(fallCall!).searchParams.get("start")).toBe("2026-10-24T22:00:00.000Z");
  });

  test("invalid/future --since → exit 1", async () => {
    let errOutput = "";
    const fixedNow = new Date("2026-10-18T12:00:00.000Z");

    // 1. Invalid date string
    const codeInvalid = await runCli(["sync", "activitywatch", "--since", "not-a-date"], {
      loadConfig: () => mockConfig(),
      openDb: () => db,
      now: fixedNow,
      err: (msg) => {
        errOutput += `${msg}\n`;
      },
    });
    expect(codeInvalid).toBe(1);
    expect(errOutput).toContain("Invalid --since date");

    // 2. Impossible calendar date
    errOutput = "";
    const codeBadCal = await runCli(["sync", "activitywatch", "--since", "2026-02-30"], {
      loadConfig: () => mockConfig(),
      openDb: () => db,
      now: fixedNow,
      err: (msg) => {
        errOutput += `${msg}\n`;
      },
    });
    expect(codeBadCal).toBe(1);
    expect(errOutput).toContain("Invalid --since date");

    // 3. Date in the future
    errOutput = "";
    const codeFuture = await runCli(["sync", "activitywatch", "--since", "2026-10-20"], {
      loadConfig: () => mockConfig(),
      openDb: () => db,
      now: fixedNow,
      err: (msg) => {
        errOutput += `${msg}\n`;
      },
    });
    expect(codeFuture).toBe(1);
    expect(errOutput).toContain("future");

    // 4. Missing value for --since
    errOutput = "";
    const codeMissing = await runCli(["sync", "activitywatch", "--since"], {
      loadConfig: () => mockConfig(),
      openDb: () => db,
      now: fixedNow,
      err: (msg) => {
        errOutput += `${msg}\n`;
      },
    });
    expect(codeMissing).toBe(1);
    expect(errOutput).toContain("Missing value for --since");
  });

  test("GET-only: asserts client only makes GET requests during backfill", async () => {
    const bucketId = "aw-watcher-web-chrome_test";
    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-10-16T10:00:00.000Z",
          duration: 600,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Synth Video - YouTube",
            audible: true,
          },
        },
      ],
    };

    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-15",
      config,
      now: () => new Date("2026-10-17T18:00:00.000Z"),
    });

    expect(requestedMethods.length).toBeGreaterThan(0);
    expect(requestedMethods.every((m) => m === "GET")).toBe(true);
  });

  test("creates ingest_runs row with kind 'backfill' and status 'ok'", async () => {
    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    await backfillActivityWatch({
      client,
      sink,
      db,
      since: "2026-10-15",
      config,
      now: () => new Date("2026-10-17T18:00:00.000Z"),
    });

    const runRow = db
      .query<{ source: string; kind: string; status: string }, []>(
        `SELECT source, kind, status FROM ingest_runs ORDER BY id DESC LIMIT 1;`
      )
      .get();

    expect(runRow?.source).toBe("activitywatch");
    expect(runRow?.kind).toBe("backfill");
    expect(runRow?.status).toBe("ok");
  });
});
