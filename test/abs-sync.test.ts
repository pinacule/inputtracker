import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type AudiobookshelfConfig, type Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import type { EventRow, IngestRunRow, SyncStateRow } from "../src/core/schema.ts";
import { LocalDbSink } from "../src/core/sink.ts";
import { runCli } from "../src/cli/index.ts";
import {
  createAbsClient,
  type FetchFn,
} from "../src/sources/audiobookshelf/client.ts";
import type {
  AbsListeningStats,
  AbsMeResponse,
  AbsSession,
  AbsSessionsEnvelope,
} from "../src/sources/audiobookshelf/map.ts";
import {
  ABS_SOURCE,
  SyncFailedError,
  syncAudiobookshelf,
} from "../src/sources/audiobookshelf/sync.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "abs");
const ABS_URL = "http://abs.test:13378";
const FAKE_TOKEN = "FAKE-ABS-TOKEN-42";

function loadFixture<T>(filename: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, filename), "utf8")) as T;
}

const fixtureSessions = loadFixture<AbsSessionsEnvelope>("sessions-page0.json").sessions;
const fixtureMe = loadFixture<AbsMeResponse>("me.json");
const fixtureStats = loadFixture<AbsListeningStats>("listening-stats.json");

const absConfig: AudiobookshelfConfig = {
  url: ABS_URL,
  token: FAKE_TOKEN,
  timeout_s: 1,
};

interface ServerData {
  sessions?: AbsSession[];
  me?: AbsMeResponse;
  stats?: AbsListeningStats;
  fail?: boolean;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fake ABS host: serves paginated sessions plus `/api/me` and listening stats. */
function createMockFetch(getData: () => ServerData): FetchFn {
  return async (input) => {
    const data = getData();
    if (data.fail) {
      throw new Error(`connect ECONNREFUSED for token ${FAKE_TOKEN}`);
    }

    const url = new URL(typeof input === "string" ? input : String(input));

    if (url.pathname === "/api/me/listening-sessions") {
      const sessions = data.sessions ?? [];
      return jsonResponse({
        total: sessions.length,
        numPages: 1,
        page: 0,
        itemsPerPage: 100,
        sessions,
      });
    }
    if (url.pathname === "/api/me/listening-stats") {
      return jsonResponse(data.stats ?? {});
    }
    if (url.pathname === "/api/me") {
      return jsonResponse(data.me ?? {});
    }

    throw new Error(`Unexpected request path: ${url.pathname}`);
  };
}

function buildGrowingSession(version: {
  timeListening: number;
  currentTime: number;
  updatedAt: number;
}): AbsSession {
  return {
    id: "session-grow-1",
    userId: "user-fake-1",
    libraryId: "lib-fake-1",
    libraryItemId: "item-grow-1",
    bookId: "book-grow-1",
    episodeId: null,
    mediaType: "book",
    mediaMetadata: { title: "Growing Synthetic Book" },
    chapters: [],
    displayTitle: "Growing Synthetic Book",
    displayAuthor: "Fake Author",
    coverPath: null,
    duration: 1000,
    playMethod: 0,
    mediaPlayer: "html5",
    deviceInfo: { deviceName: "Fake Device", ipAddress: "203.0.113.9" },
    serverVersion: "2.7.0",
    date: "2026-10-17",
    dayOfWeek: "Saturday",
    timeListening: version.timeListening,
    startTime: 0,
    currentTime: version.currentTime,
    startedAt: 1_760_000_000_000,
    updatedAt: version.updatedAt,
  };
}

function countEvents(db: Database): number {
  return (
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events;").get()
      ?.count ?? 0
  );
}

function getCursor(db: Database): string | null {
  return (
    db
      .query<SyncStateRow, [string]>("SELECT * FROM sync_state WHERE source = ?;")
      .get(ABS_SOURCE)?.cursor ?? null
  );
}

function countSyncState(db: Database): number {
  return (
    db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sync_state;")
      .get()?.count ?? 0
  );
}

function latestRun(db: Database): IngestRunRow | null {
  return (
    db
      .query<IngestRunRow, []>("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1;")
      .get() ?? null
  );
}

describe("Audiobookshelf sync", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-abs-sync-"));
    const configPath = join(tempDir, "config.toml");
    writeFileSync(
      configPath,
      [
        'timezone = "Europe/Bratislava"',
        "",
        "[storage]",
        'db_path = ":memory:"',
        "",
        "[audiobookshelf]",
        `url = "${ABS_URL}"`,
        `token = "${FAKE_TOKEN}"`,
        "timeout_s = 1",
        "",
      ].join("\n")
    );
    config = loadConfig({ path: configPath });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeClient(getData: () => ServerData) {
    return createAbsClient(absConfig, { fetch: createMockFetch(getData), retries: 0 });
  }

  test("two runs: second inserts 0 new rows", async () => {
    const db = openDb(":memory:");
    const data: ServerData = {
      sessions: fixtureSessions,
      me: fixtureMe,
      stats: fixtureStats,
    };
    const client = makeClient(() => data);
    const sink = new LocalDbSink(db);

    const first = await syncAudiobookshelf({ client, sink, db, config });
    expect(first.inserted).toBeGreaterThan(0);
    expect(first.seen).toBe(first.inserted);
    expect(countEvents(db)).toBe(first.inserted);

    const firstRun = latestRun(db);
    expect(firstRun?.status).toBe("ok");
    expect(firstRun?.rows_seen).toBe(first.seen);
    expect(firstRun?.rows_inserted).toBe(first.inserted);

    const second = await syncAudiobookshelf({ client, sink, db, config });
    expect(second.seen).toBe(first.seen);
    expect(second.inserted).toBe(0);
    expect(countEvents(db)).toBe(first.inserted);
    expect(latestRun(db)?.status).toBe("ok");
  });

  test("one growing session synced three times → 3 rows in events, 1 in events_latest", async () => {
    const db = openDb(":memory:");
    const versions = [
      { timeListening: 100, currentTime: 100, updatedAt: 1_760_000_000_000 },
      { timeListening: 250, currentTime: 250, updatedAt: 1_760_000_100_000 },
      { timeListening: 400, currentTime: 400, updatedAt: 1_760_000_200_000 },
    ];

    let call = 0;
    const client = makeClient(() => ({
      sessions: [buildGrowingSession(versions[call])],
      me: {},
      stats: {},
    }));
    const sink = new LocalDbSink(db);

    for (call = 0; call < versions.length; call++) {
      const result = await syncAudiobookshelf({ client, sink, db, config });
      expect(result.inserted).toBe(1);
    }

    expect(countEvents(db)).toBe(3);

    const latest = db
      .query<EventRow, []>("SELECT * FROM events_latest;")
      .all();
    expect(latest).toHaveLength(1);
    expect(latest[0]?.source_kind).toBe("listening_session");
    expect(latest[0]?.source_id).toBe("session-grow-1");
    expect(latest[0]?.duration_seconds).toBe(400);

    // The cursor reflects the newest version's updatedAt.
    expect(getCursor(db)).toBe("1760000200000");
  });

  test("unreachable host → failed run, no events changed, cursor unchanged, next run succeeds", async () => {
    const db = openDb(":memory:");
    const data: ServerData = {
      sessions: fixtureSessions,
      me: {},
      stats: {},
    };
    let fail = false;
    const client = createAbsClient(absConfig, {
      fetch: createMockFetch(() => ({ ...data, fail })),
      retries: 0,
    });
    const sink = new LocalDbSink(db);

    const ok = await syncAudiobookshelf({ client, sink, db, config });
    expect(ok.inserted).toBe(fixtureSessions.length);
    const eventsBefore = countEvents(db);
    const cursorBefore = getCursor(db);
    expect(cursorBefore).not.toBeNull();

    fail = true;
    let caught: unknown;
    try {
      await syncAudiobookshelf({ client, sink, db, config });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SyncFailedError);
    const message = (caught as Error).message;
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(FAKE_TOKEN);

    const failedRun = latestRun(db);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.rows_seen).toBe(0);
    expect(failedRun?.rows_inserted).toBe(0);
    expect(failedRun?.error).not.toBeNull();
    expect(failedRun?.error).not.toContain(FAKE_TOKEN);
    expect(failedRun?.error).toContain("***");

    // Nothing else changed.
    expect(countEvents(db)).toBe(eventsBefore);
    expect(getCursor(db)).toBe(cursorBefore);
    expect(countSyncState(db)).toBe(1);

    // Next run succeeds and inserts nothing new.
    fail = false;
    const retry = await syncAudiobookshelf({ client, sink, db, config });
    expect(retry.inserted).toBe(0);
    expect(latestRun(db)?.status).toBe("ok");
  });

  test("cursor deleted → re-run still inserts 0 new rows (idempotent)", async () => {
    const db = openDb(":memory:");
    const data: ServerData = {
      sessions: fixtureSessions,
      me: {},
      stats: {},
    };
    const client = makeClient(() => data);
    const sink = new LocalDbSink(db);

    const first = await syncAudiobookshelf({ client, sink, db, config });
    expect(first.inserted).toBeGreaterThan(0);

    db.run("DELETE FROM sync_state WHERE source = ?;", [ABS_SOURCE]);
    expect(countSyncState(db)).toBe(0);
    expect(getCursor(db)).toBeNull();

    const second = await syncAudiobookshelf({ client, sink, db, config });
    expect(second.inserted).toBe(0);
    expect(countEvents(db)).toBe(first.inserted);
    expect(countSyncState(db)).toBe(1);
    expect(getCursor(db)).not.toBeNull();
  });
});

describe("CLI", () => {
  test("unknown source → usage and exit 1", async () => {
    let outText = "";
    let errText = "";
    const code = await runCli(["sync", "simkl"], {
      out: (line) => {
        outText += `${line}\n`;
      },
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(1);
    expect(errText).toContain("Unknown source: simkl");
    expect(errText).toContain("Usage: it");
    expect(outText).toBe("");
  });

  test("unknown command → usage and exit 1", async () => {
    let errText = "";
    const code = await runCli(["bogus"], {
      out: () => {},
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(1);
    expect(errText).toContain("Unknown command: bogus");
    expect(errText).toContain("Usage: it");
  });

  test("successful sync → prints counts and exit 0", async () => {
    let outText = "";
    let errText = "";
    const code = await runCli(["sync", "audiobookshelf"], {
      loadConfig: () => ({
        storage: { db_path: ":memory:" },
      }) as unknown as Config,
      syncAudiobookshelf: async () => ({ runId: 1, seen: 3, inserted: 2 }),
      out: (line) => {
        outText += `${line}\n`;
      },
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(0);
    expect(outText).toContain("seen 3");
    expect(outText).toContain("inserted 2");
    expect(errText).toBe("");
  });

  test("sync failure → exit 2 and no token in output", async () => {
    let errText = "";
    const code = await runCli(["sync", "audiobookshelf"], {
      loadConfig: () => ({
        storage: { db_path: ":memory:" },
        audiobookshelf: { token: FAKE_TOKEN },
      }) as unknown as Config,
      syncAudiobookshelf: async () => {
        throw new Error(`sync failed with token ${FAKE_TOKEN}`);
      },
      out: () => {},
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(2);
    expect(errText.length).toBeGreaterThan(0);
    expect(errText).not.toContain(FAKE_TOKEN);
    expect(errText).toContain("***");
  });
});
