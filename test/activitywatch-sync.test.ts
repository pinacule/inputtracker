import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import type { Config } from "../src/core/config.ts";
import { LocalDbSink } from "../src/core/sink.ts";
import { runCli } from "../src/cli/index.ts";
import {
  createActivityWatchClient,
  type FetchFn,
} from "../src/sources/activitywatch/client.ts";
import {
  ACTIVITYWATCH_SOURCE,
  SyncFailedError,
  syncActivityWatch,
} from "../src/sources/activitywatch/sync.ts";
import type { AwBucket, AwRawEvent } from "../src/sources/activitywatch/types.ts";

const FAKE_VID_1 = "AAAAAAAAAA1";
const FAKE_VID_2 = "BBBBBBBBBB2";

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

describe("ActivityWatch sync (src/sources/activitywatch/sync.ts)", () => {
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
        const events = state.eventsPerBucket?.[bucketId] ?? [];
        return new Response(JSON.stringify(events), {
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

  test("GET-only: asserts every mocked request uses GET", async () => {
    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    await syncActivityWatch({ client, sink, db, config });

    expect(requestedMethods.length).toBeGreaterThan(0);
    expect(requestedMethods.every((m) => m === "GET")).toBe(true);
  });

  test("first run window: start is now - 7 days and end is now", async () => {
    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    const fixedNow = new Date("2026-10-17T18:00:00.000Z");
    await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => fixedNow,
    });

    const eventsCall = requestedUrls.find((u) => u.includes("/events?"));
    expect(eventsCall).toBeDefined();

    const parsed = new URL(eventsCall!);
    const expectedStart = new Date(
      fixedNow.getTime() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();
    const expectedEnd = fixedNow.toISOString();

    expect(parsed.searchParams.get("start")).toBe(expectedStart);
    expect(parsed.searchParams.get("end")).toBe(expectedEnd);
    expect(parsed.searchParams.get("limit")).toBe("-1");
  });

  test("cursor kept at an open play (ended within 10 min of window end)", async () => {
    const fixedNow = new Date("2026-10-17T18:30:00.000Z");
    const bucketId = "aw-watcher-web-chrome_test";

    // Play started at 18:20:00, ended at 18:25:00 (5 min before window end 18:30:00 <= 10 min)
    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-10-17T18:20:00.000Z",
          duration: 300,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Synthetic Open Video - YouTube",
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

    const result = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => fixedNow,
    });

    expect(result.seen).toBe(1);
    expect(result.inserted).toBe(1);

    const cursorRow = db
      .query<{ cursor: string }, [string]>(
        "SELECT cursor FROM sync_state WHERE source = ?;"
      )
      .get(`activitywatch:${bucketId}`);

    // Cursor should be kept at started_at of open play: 18:20:00.000Z
    expect(cursorRow?.cursor).toBe("2026-10-17T18:20:00.000Z");
  });

  test("cursor set to end when play ended > 10 min before window end", async () => {
    const fixedNow = new Date("2026-10-17T18:30:00.000Z");
    const bucketId = "aw-watcher-web-chrome_test";

    // Play started at 18:00:00, ended at 18:15:00 (15 min before 18:30:00 > 10 min)
    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-10-17T18:00:00.000Z",
          duration: 900,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Synthetic Finished Video - YouTube",
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

    await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => fixedNow,
    });

    const cursorRow = db
      .query<{ cursor: string }, [string]>(
        "SELECT cursor FROM sync_state WHERE source = ?;"
      )
      .get(`activitywatch:${bucketId}`);

    // Cursor should be window end: 18:30:00.000Z
    expect(cursorRow?.cursor).toBe(fixedNow.toISOString());
  });

  test("re-run over the same data inserts 0 rows (idempotent)", async () => {
    const fixedNow = new Date("2026-10-17T18:30:00.000Z");
    const bucketId = "aw-watcher-web-chrome_test";

    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-10-17T18:00:00.000Z",
          duration: 300,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Synthetic Idempotent Video - YouTube",
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

    const first = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => fixedNow,
    });
    expect(first.seen).toBe(1);
    expect(first.inserted).toBe(1);

    const second = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => fixedNow,
    });
    expect(second.seen).toBe(1);
    expect(second.inserted).toBe(0);
  });

  test("a growing open play inserts one new row and events_latest shows the larger duration", async () => {
    const bucketId = "aw-watcher-web-chrome_test";
    const run1Now = new Date("2026-10-17T18:30:00.000Z");

    // Run 1: user watched 300 seconds from 18:20 to 18:25
    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-10-17T18:20:00.000Z",
          duration: 300,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Synthetic Growing Video - YouTube",
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

    const run1 = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => run1Now,
    });
    expect(run1.inserted).toBe(1);

    const sourceId = `${FAKE_VID_1}:2026-10-17T18:20:00.000Z`;

    const rowAfterRun1 = db
      .query<{ duration_seconds: number }, [string]>(
        "SELECT duration_seconds FROM events_latest WHERE source_id = ?;"
      )
      .get(sourceId);
    expect(rowAfterRun1?.duration_seconds).toBe(300);

    // Run 2: 10 minutes later (18:40), user watched an additional 540 seconds (gap = 1 min <= 10 min)
    const run2Now = new Date("2026-10-17T18:40:00.000Z");
    state.eventsPerBucket = {
      [bucketId]: [
        {
          timestamp: "2026-10-17T18:20:00.000Z",
          duration: 300,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Synthetic Growing Video - YouTube",
            audible: true,
          },
        },
        {
          timestamp: "2026-10-17T18:26:00.000Z",
          duration: 540,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Synthetic Growing Video - YouTube",
            audible: true,
          },
        },
      ],
    };

    const run2 = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => run2Now,
    });

    // Growing play re-emitted with more seconds → inserts 1 new row
    expect(run2.seen).toBe(1);
    expect(run2.inserted).toBe(1);

    // In events table: exactly 2 rows for this source_id
    const countRow = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM events WHERE source_id = ?;"
      )
      .get(sourceId);
    expect(countRow?.count).toBe(2);

    // In events_latest view: shows the newer row with larger duration (300 + 540 = 840)
    const rowAfterRun2 = db
      .query<{ duration_seconds: number }, [string]>(
        "SELECT duration_seconds FROM events_latest WHERE source_id = ?;"
      )
      .get(sourceId);
    expect(rowAfterRun2?.duration_seconds).toBe(840);
  });

  test("two buckets: syncs both buckets and tracks cursors separately", async () => {
    const fixedNow = new Date("2026-10-17T18:30:00.000Z");
    state.buckets = {
      "aw-watcher-web-chrome_pc": {
        id: "aw-watcher-web-chrome_pc",
        type: "web.tab.current",
      },
      "aw-watcher-web-firefox_pc": {
        id: "aw-watcher-web-firefox_pc",
        type: "web.tab.current",
      },
      "aw-watcher-window_pc": {
        id: "aw-watcher-window_pc",
        type: "currentwindow", // Non-matching bucket type
      },
    };

    state.eventsPerBucket = {
      "aw-watcher-web-chrome_pc": [
        {
          timestamp: "2026-10-17T18:00:00.000Z",
          duration: 100,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
            title: "Chrome Video - YouTube",
            audible: true,
          },
        },
      ],
      "aw-watcher-web-firefox_pc": [
        {
          timestamp: "2026-10-17T18:00:00.000Z",
          duration: 120,
          data: {
            url: `https://www.youtube.com/watch?v=${FAKE_VID_2}`,
            title: "Firefox Video - YouTube",
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

    const result = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      now: () => fixedNow,
    });

    expect(result.buckets).toBe(2);
    expect(result.seen).toBe(2);
    expect(result.inserted).toBe(2);

    const chromeCursor = db
      .query<{ cursor: string }, [string]>(
        "SELECT cursor FROM sync_state WHERE source = ?;"
      )
      .get("activitywatch:aw-watcher-web-chrome_pc");
    expect(chromeCursor).toBeDefined();

    const firefoxCursor = db
      .query<{ cursor: string }, [string]>(
        "SELECT cursor FROM sync_state WHERE source = ?;"
      )
      .get("activitywatch:aw-watcher-web-firefox_pc");
    expect(firefoxCursor).toBeDefined();

    // Verify window watcher bucket was never queried
    expect(requestedUrls.some((u) => u.includes("aw-watcher-window"))).toBe(
      false
    );
  });

  test("unreachable → failed run recorded in ingest_runs, throws SyncFailedError without URL query strings", async () => {
    state.fail = "network";

    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    let thrown: unknown;
    try {
      await syncActivityWatch({ client, sink, db, config });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SyncFailedError);
    const syncErr = thrown as SyncFailedError;
    expect(syncErr.source).toBe(ACTIVITYWATCH_SOURCE);
    expect(syncErr.message).toBe("activitywatch unreachable");
    expect(syncErr.message).not.toContain("?");

    const failedRun = db
      .query<{ status: string; error: string }, [number]>(
        "SELECT status, error FROM ingest_runs WHERE id = ?;"
      )
      .get(syncErr.runId);

    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.error).toBe("activitywatch unreachable");
    expect(failedRun?.error).not.toContain("?");
  });

  test("HTTP 500 error → failed run with activitywatch HTTP 500", async () => {
    state.fail = "500";

    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    let thrown: unknown;
    try {
      await syncActivityWatch({ client, sink, db, config });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SyncFailedError);
    const syncErr = thrown as SyncFailedError;
    expect(syncErr.message).toBe("activitywatch HTTP 500");

    const failedRun = db
      .query<{ status: string; error: string }, [number]>(
        "SELECT status, error FROM ingest_runs WHERE id = ?;"
      )
      .get(syncErr.runId);

    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.error).toBe("activitywatch HTTP 500");
  });

  test("no web.tab.current bucket → ok run with seen 0 and prints hint", async () => {
    state.buckets = {
      "aw-watcher-window_pc": {
        id: "aw-watcher-window_pc",
        type: "currentwindow",
      },
    };

    let hintPrinted = "";
    const fetchFn = createMockFetch();
    const config = mockConfig();
    const client = createActivityWatchClient(config.activitywatch, {
      fetch: fetchFn,
    });
    const sink = new LocalDbSink(db);

    const result = await syncActivityWatch({
      client,
      sink,
      db,
      config,
      out: (msg) => {
        hintPrinted += msg;
      },
    });

    expect(result.seen).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.buckets).toBe(0);
    expect(hintPrinted).toContain("aw-watcher-web");

    const run = db
      .query<{ status: string; rows_seen: number }, [number]>(
        "SELECT status, rows_seen FROM ingest_runs WHERE id = ?;"
      )
      .get(result.runId);
    expect(run?.status).toBe("ok");
    expect(run?.rows_seen).toBe(0);
  });

  test("CLI: it sync activitywatch success outputs counts and exits 0", async () => {
    let outText = "";
    const code = await runCli(["sync", "activitywatch"], {
      loadConfig: () => mockConfig(),
      openDb: () => db,
      syncActivityWatch: async () => ({
        runId: 1,
        seen: 5,
        inserted: 2,
        buckets: 1,
      }),
      out: (msg) => {
        outText += `${msg}\n`;
      },
      err: () => {},
    });

    expect(code).toBe(0);
    expect(outText).toContain("activitywatch: 5 seen, 2 new (1 bucket)");
  });

  test("CLI: it sync activitywatch failure outputs error and exits 2", async () => {
    let errText = "";
    const code = await runCli(["sync", "activitywatch"], {
      loadConfig: () => mockConfig(),
      openDb: () => db,
      syncActivityWatch: async () => {
        throw new SyncFailedError("activitywatch unreachable", {
          source: "activitywatch",
          runId: 2,
        });
      },
      out: () => {},
      err: (msg) => {
        errText += `${msg}\n`;
      },
    });

    expect(code).toBe(2);
    expect(errText).toContain("activitywatch unreachable");
  });
});
