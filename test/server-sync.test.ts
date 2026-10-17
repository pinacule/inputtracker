import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { createApp } from "../src/server/app.ts";
import {
  SyncFailedError,
  type AbsSyncResult,
  type SyncClient,
} from "../src/sources/audiobookshelf/sync.ts";

const TOKEN = "SYNTHETIC-ABS-TOKEN-99";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg = {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: {
      url: "http://abs.test:13378",
      token: TOKEN,
      timeout_s: 20,
    },
    notify: { desktop: false, ntfy_url: "" },
    toJSON: () => ({}),
    toString: () => "",
    ...overrides,
  } as Config;
  return cfg;
}

/** Fake ABS client that never touches the network. */
function fakeClient(): SyncClient {
  return {
    getAllSessions: async <T>(): Promise<T[]> => [],
    get: async <T>(): Promise<T> => ({}) as T,
  };
}

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("network access is disabled in tests");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function insertRun(
  db: Database,
  run: {
    id: number;
    source: string;
    kind?: string | null;
    started_at: string;
    finished_at?: string | null;
    status: "running" | "ok" | "failed";
    rows_seen?: number;
    rows_inserted?: number;
    error?: string | null;
  }
): void {
  db.run(
    `INSERT INTO ingest_runs
       (id, source, kind, started_at, finished_at, status, rows_seen, rows_inserted, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      run.id,
      run.source,
      run.kind ?? null,
      run.started_at,
      run.finished_at ?? null,
      run.status,
      run.rows_seen ?? 0,
      run.rows_inserted ?? 0,
      run.error ?? null,
    ]
  );
}

describe("POST /api/sync/audiobookshelf", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  test("runs the injected sync and returns runId/seen/inserted", async () => {
    const config = mockConfig();

    const app = createApp({
      db,
      config,
      createAbsClient: () => fakeClient(),
      syncAudiobookshelf: async (deps): Promise<AbsSyncResult> => {
        expect(deps.db).toBe(db);
        return { runId: 42, seen: 5, inserted: 3 };
      },
    });

    const res = await app.request("/api/sync/audiobookshelf", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 42, seen: 5, inserted: 3 });
    expect(fetchCalls).toBe(0);
  });

  test("maps SyncFailedError to 502 with a redacted message", async () => {
    const config = mockConfig();

    const app = createApp({
      db,
      config,
      createAbsClient: () => fakeClient(),
      syncAudiobookshelf: async (): Promise<AbsSyncResult> => {
        throw new SyncFailedError(`connection refused for token ${TOKEN}`, {
          source: "audiobookshelf",
          runId: 7,
        });
      },
    });

    const res = await app.request("/api/sync/audiobookshelf", { method: "POST" });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain(TOKEN);
    expect(body.error).toContain("***");
    expect(fetchCalls).toBe(0);
  });

  test("returns 400 when Audiobookshelf is not configured", async () => {
    const config = mockConfig({
      audiobookshelf: {
        url: "http://abs.test:13378",
        token: "",
        timeout_s: 20,
      },
    });
    let syncRan = false;

    const app = createApp({
      db,
      config,
      createAbsClient: () => fakeClient(),
      syncAudiobookshelf: async (): Promise<AbsSyncResult> => {
        syncRan = true;
        return { runId: 1, seen: 0, inserted: 0 };
      },
    });

    const res = await app.request("/api/sync/audiobookshelf", { method: "POST" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not configured/i);
    expect(syncRan).toBe(false);
    expect(fetchCalls).toBe(0);
  });

  test("rejects a concurrent call with 409 while one is running", async () => {
    const config = mockConfig();
    const deferred: { resolve: ((result: AbsSyncResult) => void) | null } = {
      resolve: null,
    };
    const pending = new Promise<AbsSyncResult>((resolve) => {
      deferred.resolve = resolve;
    });
    let startCount = 0;

    const app = createApp({
      db,
      config,
      createAbsClient: () => fakeClient(),
      syncAudiobookshelf: (): Promise<AbsSyncResult> => {
        startCount += 1;
        return pending;
      },
    });

    const first = app.request("/api/sync/audiobookshelf", { method: "POST" });
    // Let the first handler reach its `await` and set the in-flight flag.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startCount).toBe(1);

    const second = await app.request("/api/sync/audiobookshelf", { method: "POST" });
    expect(second.status).toBe(409);
    expect(startCount).toBe(1);

    if (deferred.resolve) {
      deferred.resolve({ runId: 1, seen: 0, inserted: 0 });
    } else {
      throw new Error("sync resolver was never captured");
    }
    const firstRes = await first;
    expect(firstRes.status).toBe(200);

    // Once the first run finished, a new call is accepted again.
    const third = await app.request("/api/sync/audiobookshelf", { method: "POST" });
    expect(third.status).toBe(200);
    expect(startCount).toBe(2);
    expect(fetchCalls).toBe(0);
  });

  test("rejects unknown query parameters with 400", async () => {
    const app = createApp({
      db,
      config: mockConfig(),
      createAbsClient: () => fakeClient(),
      syncAudiobookshelf: async () => ({ runId: 1, seen: 0, inserted: 0 }),
    });

    const res = await app.request("/api/sync/audiobookshelf?extra=1", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sync/status", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  test("returns the latest run per source, read-only", async () => {
    const config = mockConfig();

    insertRun(db, {
      id: 1,
      source: "audiobookshelf",
      kind: "sync",
      started_at: "2026-10-16T10:00:00.000Z",
      finished_at: "2026-10-16T10:01:00.000Z",
      status: "ok",
      rows_seen: 10,
      rows_inserted: 4,
    });
    insertRun(db, {
      id: 2,
      source: "audiobookshelf",
      kind: "sync",
      started_at: "2026-10-17T10:00:00.000Z",
      finished_at: "2026-10-17T10:01:00.000Z",
      status: "failed",
      rows_seen: 0,
      rows_inserted: 0,
      error: "synthetic failure",
    });
    insertRun(db, {
      id: 3,
      source: "manual",
      started_at: "2026-10-17T11:00:00.000Z",
      finished_at: "2026-10-17T11:00:01.000Z",
      status: "ok",
      rows_seen: 1,
      rows_inserted: 1,
    });

    const app = createApp({ db, config });
    const res = await app.request("/api/sync/status");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{
        source: string;
        started_at: string;
        finished_at: string | null;
        rows_seen: number;
        rows_inserted: number;
        error: string | null;
      }>;
    };

    expect(body.runs).toHaveLength(2);
    expect(body.runs.map((run) => run.source)).toEqual(["audiobookshelf", "manual"]);

    const absRun = body.runs[0]!;
    expect(absRun.started_at).toBe("2026-10-17T10:00:00.000Z");
    expect(absRun.rows_seen).toBe(0);
    expect(absRun.rows_inserted).toBe(0);
    expect(absRun.error).toBe("synthetic failure");

    const manualRun = body.runs[1]!;
    expect(manualRun.started_at).toBe("2026-10-17T11:00:00.000Z");
    expect(manualRun.rows_inserted).toBe(1);
    expect(manualRun.error).toBeNull();

    // Read-only: no rows added or changed.
    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ingest_runs;")
      .get()?.n;
    expect(count).toBe(3);
    expect(fetchCalls).toBe(0);
  });

  test("returns an empty list when there are no runs", async () => {
    const app = createApp({ db, config: mockConfig() });
    const res = await app.request("/api/sync/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [] });
  });

  test("rejects unknown query parameters with 400", async () => {
    const app = createApp({ db, config: mockConfig() });
    const res = await app.request("/api/sync/status?extra=1");
    expect(res.status).toBe(400);
  });
});
