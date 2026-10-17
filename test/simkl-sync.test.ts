import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { LocalDbSink } from "../src/core/sink.ts";
import { SimklApiError, SimklAuthError } from "../src/sources/simkl/client.ts";
import type { SimklAllItems } from "../src/sources/simkl/map.ts";
import {
  isSimklAuthorised,
  isSimklConfigured,
  SIMKL_SOURCE,
  syncSimkl,
  type SimklActivities,
  type SyncSimklClient,
} from "../src/sources/simkl/sync.ts";
import type { SimklToken } from "../src/sources/simkl/token.ts";

const FIXTURE_ALL_ITEMS: SimklAllItems = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "simkl", "all-items.json"), "utf8")
);
const FIXTURE_ACTIVITIES: SimklActivities = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "simkl", "activities.json"), "utf8")
);

const SYNTHETIC_TOKEN = "simkl_at_synthetic_secret_token_12345";

function mockConfig(overrides: Partial<Config> = {}): Config {
  return {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://abs.test:13378", token: "abs-tok", timeout_s: 20 },
    simkl: { client_id: "simkl_client_id_synth", base_url: "https://api.simkl.com", poster_base_url: "https://simkl.in/posters", timeout_s: 20 },
    notify: { desktop: false, ntfy_url: "" },
    toJSON: () => ({}),
    toString: () => "",
    ...overrides,
  } as Config;
}

interface RecordedCall {
  path: string;
  query?: Record<string, string | number | boolean>;
}

class FakeRecordingSimklClient implements SyncSimklClient {
  readonly calls: RecordedCall[] = [];
  responses: Map<string, unknown> = new Map();
  errors: Map<string, Error> = new Map();

  async get<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean>
  ): Promise<T> {
    this.calls.push({ path, query });

    // Check error by exact path or path prefix
    if (this.errors.has(path)) {
      throw this.errors.get(path)!;
    }

    if (this.responses.has(path)) {
      return this.responses.get(path) as T;
    }

    // Default routes
    if (path === "/sync/activities") {
      return FIXTURE_ACTIVITIES as T;
    }
    if (path === "/sync/all-items/shows") {
      return (FIXTURE_ALL_ITEMS.shows ?? []) as T;
    }
    if (path === "/sync/all-items/movies") {
      return (FIXTURE_ALL_ITEMS.movies ?? []) as T;
    }
    if (path === "/sync/all-items/anime") {
      return (FIXTURE_ALL_ITEMS.anime ?? []) as T;
    }
    if (path === "/sync/all-items") {
      return FIXTURE_ALL_ITEMS as T;
    }

    return [] as T;
  }

  // Asserting only GET is used for data calls (no POST method exists on this client)
}

describe("Simkl sync (src/sources/simkl/sync.ts)", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test("isSimklConfigured and isSimklAuthorised helpers", () => {
    const unconfigured = mockConfig({ simkl: { client_id: "  ", base_url: "", poster_base_url: "", timeout_s: 20 } });
    expect(isSimklConfigured(unconfigured)).toBe(false);

    const configured = mockConfig({ simkl: { client_id: "valid_id", base_url: "", poster_base_url: "", timeout_s: 20 } });
    expect(isSimklConfigured(configured)).toBe(true);

    const fakeToken: SimklToken = {
      access_token: SYNTHETIC_TOKEN,
      refresh_token: "simkl_rt_synthetic",
      scope: "media:read",
      expires_at: "2026-10-25T00:00:00Z",
      obtained_at: "2026-10-18T00:00:00Z",
    };

    expect(isSimklAuthorised(configured, () => null)).toBe(false);
    expect(isSimklAuthorised(configured, () => fakeToken)).toBe(true);
  });

  test("first sync calls activities then shows, movies, anime in order and mode is full", async () => {
    const client = new FakeRecordingSimklClient();
    const sink = new LocalDbSink(db);
    const config = mockConfig();

    const result = await syncSimkl({ client, sink, db, config });

    expect(result.mode).toBe("full");
    expect(result.seen).toBe(4);
    expect(result.inserted).toBe(4);

    // Assert sequence of calls
    expect(client.calls.map((c) => c.path)).toEqual([
      "/sync/activities",
      "/sync/all-items/shows",
      "/sync/all-items/movies",
      "/sync/all-items/anime",
    ]);

    const expectedQuery = {
      extended: "full",
      episode_watched_at: "yes",
      include_all_episodes: "original",
    };
    for (let i = 1; i <= 3; i++) {
      expect(client.calls[i]!.query).toEqual(expectedQuery);
    }

    // Verify snapshot was saved in sync_state
    const state = db
      .query<{ cursor: string }, [string]>("SELECT cursor FROM sync_state WHERE source = ?;")
      .get(SIMKL_SOURCE);
    expect(state).toBeDefined();
    const saved = JSON.parse(state!.cursor);
    expect(saved.all).toBe(FIXTURE_ACTIVITIES.all);

    // Verify ingest_runs row
    const run = db
      .query<{ status: string; rows_seen: number; rows_inserted: number }, [number]>(
        "SELECT status, rows_seen, rows_inserted FROM ingest_runs WHERE id = ?;"
      )
      .get(result.runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe("ok");
    expect(run!.rows_seen).toBe(4);
    expect(run!.rows_inserted).toBe(4);
  });

  test("re-sync of the same data inserts 0 rows", async () => {
    const client = new FakeRecordingSimklClient();
    const sink = new LocalDbSink(db);
    const config = mockConfig();

    // First sync
    const first = await syncSimkl({ client, sink, db, config });
    expect(first.inserted).toBe(4);

    // Simulate changed activities so delta sync pulls all-items again with same items
    client.responses.set("/sync/activities", {
      ...FIXTURE_ACTIVITIES,
      all: "2026-05-09T10:00:00Z",
    });

    const second = await syncSimkl({ client, sink, db, config });
    expect(second.mode).toBe("delta");
    expect(second.seen).toBe(4);
    expect(second.inserted).toBe(0); // 0 inserted due to record_hash idempotency
  });

  test("unchanged 'all' does not call all-items and returns mode 'unchanged'", async () => {
    const client = new FakeRecordingSimklClient();
    const sink = new LocalDbSink(db);
    const config = mockConfig();

    // First sync saves FIXTURE_ACTIVITIES snapshot
    await syncSimkl({ client, sink, db, config });

    client.calls.length = 0; // reset recorded calls

    // Second sync: activities returned have identical `all`
    const second = await syncSimkl({ client, sink, db, config });

    expect(second.mode).toBe("unchanged");
    expect(second.seen).toBe(0);
    expect(second.inserted).toBe(0);

    // Only /sync/activities was called!
    expect(client.calls.map((c) => c.path)).toEqual(["/sync/activities"]);
  });

  test("changed 'all' calls delta all-items with date_from equal to saved snapshot exactly", async () => {
    const client = new FakeRecordingSimklClient();
    const sink = new LocalDbSink(db);
    const config = mockConfig();

    // First sync
    await syncSimkl({ client, sink, db, config });

    const newActivities = {
      ...FIXTURE_ACTIVITIES,
      all: "2026-05-10T12:00:00Z",
    };
    client.responses.set("/sync/activities", newActivities);
    client.calls.length = 0;

    const result = await syncSimkl({ client, sink, db, config });

    expect(result.mode).toBe("delta");
    expect(client.calls.map((c) => c.path)).toEqual([
      "/sync/activities",
      "/sync/all-items",
    ]);

    expect(client.calls[1]!.query).toEqual({
      date_from: FIXTURE_ACTIVITIES.all, // exactly the saved all string
      extended: "full",
      episode_watched_at: "yes",
      include_all_episodes: "original",
    });

    // Check new snapshot saved
    const state = db
      .query<{ cursor: string }, [string]>("SELECT cursor FROM sync_state WHERE source = ?;")
      .get(SIMKL_SOURCE);
    const saved = JSON.parse(state!.cursor);
    expect(saved.all).toBe("2026-05-10T12:00:00Z");
  });

  test("failed delta keeps old snapshot and next successful sync uses old date_from", async () => {
    const client = new FakeRecordingSimklClient();
    const sink = new LocalDbSink(db);
    const config = mockConfig();

    // First sync
    await syncSimkl({ client, sink, db, config });

    const newActivities1 = { ...FIXTURE_ACTIVITIES, all: "2026-05-11T12:00:00Z" };
    client.responses.set("/sync/activities", newActivities1);
    client.errors.set("/sync/all-items", new Error("Synthetic network timeout"));

    // Delta sync fails
    await expect(syncSimkl({ client, sink, db, config })).rejects.toThrow(
      "Synthetic network timeout"
    );

    // Snapshot in DB must still be the old one
    const stateAfterFail = db
      .query<{ cursor: string }, [string]>("SELECT cursor FROM sync_state WHERE source = ?;")
      .get(SIMKL_SOURCE);
    const savedAfterFail = JSON.parse(stateAfterFail!.cursor);
    expect(savedAfterFail.all).toBe(FIXTURE_ACTIVITIES.all);

    // Now clear error and run next sync with newActivities2
    client.errors.clear();
    client.calls.length = 0;
    const newActivities2 = { ...FIXTURE_ACTIVITIES, all: "2026-05-12T15:00:00Z" };
    client.responses.set("/sync/activities", newActivities2);

    const nextResult = await syncSimkl({ client, sink, db, config });
    expect(nextResult.mode).toBe("delta");

    // The date_from used must still be the original saved all string!
    expect(client.calls[1]!.query?.date_from).toBe(FIXTURE_ACTIVITIES.all);
  });

  test("max_items on first sync retries split by status and merges events", async () => {
    const client = new FakeRecordingSimklClient();
    const sink = new LocalDbSink(db);
    const config = mockConfig();

    // Trigger max_items on /sync/all-items/shows
    client.errors.set(
      "/sync/all-items/shows",
      new SimklApiError(400, "max_items", "Simkl max_items exceeded")
    );

    // Provide responses for the status calls
    client.responses.set("/sync/all-items/shows/watching", [
      FIXTURE_ALL_ITEMS.shows![0],
    ]);
    client.responses.set("/sync/all-items/shows/plantowatch", []);
    client.responses.set("/sync/all-items/shows/hold", []);
    client.responses.set("/sync/all-items/shows/completed", []);
    client.responses.set("/sync/all-items/shows/dropped", []);

    const result = await syncSimkl({ client, sink, db, config });

    expect(result.mode).toBe("full");
    expect(result.seen).toBe(4);

    // Check that status-specific endpoints were queried
    const paths = client.calls.map((c) => c.path);
    expect(paths).toContain("/sync/all-items/shows/watching");
    expect(paths).toContain("/sync/all-items/shows/completed");
  });

  test("max_items on delta sync splits into three types and merges results", async () => {
    const client = new FakeRecordingSimklClient();
    const sink = new LocalDbSink(db);
    const config = mockConfig();

    // First sync
    await syncSimkl({ client, sink, db, config });

    // Change activities
    client.responses.set("/sync/activities", {
      ...FIXTURE_ACTIVITIES,
      all: "2026-05-13T10:00:00Z",
    });

    // Make delta call throw max_items
    client.errors.set(
      "/sync/all-items",
      new SimklApiError(400, "max_items", "Too many items")
    );

    client.calls.length = 0;
    const result = await syncSimkl({ client, sink, db, config });

    expect(result.mode).toBe("delta");
    expect(result.seen).toBe(4);

    const paths = client.calls.map((c) => c.path);
    expect(paths).toContain("/sync/all-items");
    expect(paths).toContain("/sync/all-items/shows");
    expect(paths).toContain("/sync/all-items/movies");
    expect(paths).toContain("/sync/all-items/anime");
  });

  test("SimklAuthError message mentions 'it auth simkl' and redacts secrets", async () => {
    const client = new FakeRecordingSimklClient();
    const sink = new LocalDbSink(db);
    const config = mockConfig();

    client.errors.set(
      "/sync/activities",
      new SimklAuthError(`Access denied with token ${SYNTHETIC_TOKEN}`)
    );

    await expect(syncSimkl({ client, sink, db, config })).rejects.toThrow();

    // Check the ingest_runs failure record
    const run = db
      .query<{ status: string; error: string | null }, []>(
        "SELECT status, error FROM ingest_runs ORDER BY id DESC LIMIT 1;"
      )
      .get();

    expect(run).toBeDefined();
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("it auth simkl");
    expect(run!.error).not.toContain(SYNTHETIC_TOKEN);
  });
});

describe("CLI 'it sync simkl' (src/cli/index.ts)", () => {
  let db: Database;
  let outLines: string[];
  let errLines: string[];

  beforeEach(() => {
    db = openDb(":memory:");
    outLines = [];
    errLines = [];
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test("not configured: exits 0, prints hint to set simkl.client_id, no ingest run", async () => {
    const { runCli } = await import("../src/cli/index.ts");
    const config = mockConfig({ simkl: { client_id: "  ", base_url: "", poster_base_url: "", timeout_s: 20 } });

    const code = await runCli(["sync", "simkl"], {
      loadConfig: () => config,
      openDb: () => db,
      out: (l) => outLines.push(l),
      err: (l) => errLines.push(l),
    });

    expect(code).toBe(0);
    expect(outLines.join(" ")).toContain("simkl.client_id");
    expect(errLines).toHaveLength(0);

    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ingest_runs;")
      .get()?.n;
    expect(count).toBe(0);
  });

  test("configured but not authorised: exits 0, prints hint to run 'it auth simkl', no ingest run", async () => {
    const { runCli } = await import("../src/cli/index.ts");
    const config = mockConfig({ simkl: { client_id: "synth_id", base_url: "", poster_base_url: "", timeout_s: 20 } });

    const code = await runCli(["sync", "simkl"], {
      loadConfig: () => config,
      openDb: () => db,
      readSimklToken: () => null,
      out: (l) => outLines.push(l),
      err: (l) => errLines.push(l),
    });

    expect(code).toBe(0);
    expect(outLines.join(" ")).toContain("run: bun run it auth simkl");
    expect(errLines).toHaveLength(0);

    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ingest_runs;")
      .get()?.n;
    expect(count).toBe(0);
  });

  test("configured and authorised: runs sync and prints formatted success line", async () => {
    const { runCli } = await import("../src/cli/index.ts");
    const config = mockConfig({ simkl: { client_id: "synth_id", base_url: "", poster_base_url: "", timeout_s: 20 } });

    const code = await runCli(["sync", "simkl"], {
      loadConfig: () => config,
      openDb: () => db,
      readSimklToken: () => ({
        access_token: "tok",
        refresh_token: "rt",
        scope: "media:read",
        expires_at: "2026-10-25T00:00:00Z",
        obtained_at: "2026-10-18T00:00:00Z",
      }),
      syncSimkl: async () => ({
        runId: 99,
        seen: 12,
        inserted: 4,
        mode: "full",
      }),
      out: (l) => outLines.push(l),
      err: (l) => errLines.push(l),
    });

    expect(code).toBe(0);
    expect(outLines[0]).toBe("simkl: 12 seen, 4 new (full)");
    expect(errLines).toHaveLength(0);
  });

  test("sync failure: prints redacted message to stderr and exits 2", async () => {
    const { runCli } = await import("../src/cli/index.ts");
    const config = mockConfig({ simkl: { client_id: "synth_id", base_url: "", poster_base_url: "", timeout_s: 20 } });

    const code = await runCli(["sync", "simkl"], {
      loadConfig: () => config,
      openDb: () => db,
      readSimklToken: () => ({
        access_token: SYNTHETIC_TOKEN,
        refresh_token: "rt",
        scope: "media:read",
        expires_at: "2026-10-25T00:00:00Z",
        obtained_at: "2026-10-18T00:00:00Z",
      }),
      syncSimkl: async () => {
        throw new Error(`Failed with secret ${SYNTHETIC_TOKEN}`);
      },
      out: (l) => outLines.push(l),
      err: (l) => errLines.push(l),
    });

    expect(code).toBe(2);
    expect(errLines[0]).not.toContain(SYNTHETIC_TOKEN);
    expect(errLines[0]).toContain("***");
  });
});

