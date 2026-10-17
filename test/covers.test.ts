import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun } from "../src/core/events.ts";
import { createApp } from "../src/server/app.ts";
import type { AbsBinaryResponse } from "../src/sources/audiobookshelf/client.ts";
import type { SyncClient } from "../src/sources/audiobookshelf/sync.ts";

const TOKEN = "SYNTHETIC-COVER-TOKEN-4242";

interface CallLog {
  method: string;
  path: string;
}

interface FakeOptions {
  calls: CallLog[];
  response?: AbsBinaryResponse;
  error?: Error;
}

/** Fake ABS client: records every call; never touches the network. */
function fakeClient(
  opts: FakeOptions
): SyncClient & { getBinary: (path: string) => Promise<AbsBinaryResponse> } {
  return {
    getAllSessions: async <T>(): Promise<T[]> => {
      opts.calls.push({ method: "getAllSessions", path: "" });
      throw new Error("unexpected getAllSessions call");
    },
    get: async <T>(): Promise<T> => {
      opts.calls.push({ method: "get", path: "" });
      throw new Error("unexpected get call");
    },
    getBinary: async (path: string): Promise<AbsBinaryResponse> => {
      opts.calls.push({ method: "getBinary", path });
      if (opts.error) {
        throw opts.error;
      }
      return (
        opts.response ?? {
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "image/png",
        }
      );
    },
  };
}

function mockConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
  const cfg = {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: dbPath,
      backup_dir: join(dirname(dbPath), "backups"),
      backup_keep: 14,
    },
    audiobookshelf: {
      url: "http://abs.invalid:13378",
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

describe("GET /api/cover/:itemId", () => {
  let db: Database;
  let tempDir: string;
  let dbPath: string;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-cover-"));
    dbPath = join(tempDir, "inputtracker.db");
    config = mockConfig(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fetches once, returns bytes + content type, then serves from cache", async () => {
    const calls: CallLog[] = [];
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const app = createApp({
      db,
      config,
      createAbsClient: () =>
        fakeClient({ calls, response: { bytes, contentType: "image/png" } }),
    });

    const res1 = await app.request("/api/cover/abc123");
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toBe("image/png");
    expect(res1.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(new Uint8Array(await res1.arrayBuffer())).toEqual(bytes);

    // Second request is a cache hit: no additional ABS call.
    const res2 = await app.request("/api/cover/abc123");
    expect(res2.status).toBe(200);
    expect(res2.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res2.arrayBuffer())).toEqual(bytes);

    // Only `getBinary` was ever used, and only for the allow-listed cover path.
    expect(calls).toEqual([
      { method: "getBinary", path: "/api/items/abc123/cover" },
    ]);
  });

  test("caches under dirname(db_path)/covers", async () => {
    const calls: CallLog[] = [];
    const app = createApp({
      db,
      config,
      createAbsClient: () =>
        fakeClient({
          calls,
          response: { bytes: new Uint8Array([9, 9]), contentType: "image/jpeg" },
        }),
    });

    const res = await app.request("/api/cover/xyz_9-AB");
    expect(res.status).toBe(200);

    const imgPath = join(tempDir, "covers", "xyz_9-AB.img");
    const typePath = join(tempDir, "covers", "xyz_9-AB.type");
    expect(existsSync(imgPath)).toBe(true);
    expect(existsSync(typePath)).toBe(true);
    expect(readFileSync(typePath, "utf8")).toBe("image/jpeg");
    expect(new Uint8Array(readFileSync(imgPath))).toEqual(
      new Uint8Array([9, 9])
    );
  });

  test("a throwing client yields 404 and caches nothing", async () => {
    const calls: CallLog[] = [];
    const app = createApp({
      db,
      config,
      createAbsClient: () =>
        fakeClient({ calls, error: new Error("connection refused") }),
    });

    const res = await app.request("/api/cover/missing1");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");

    expect(calls).toEqual([
      { method: "getBinary", path: "/api/items/missing1/cover" },
    ]);
    expect(existsSync(join(tempDir, "covers", "missing1.img"))).toBe(false);
    expect(existsSync(join(tempDir, "covers", "missing1.type"))).toBe(false);
  });

  test("rejects ids with dots, slashes or spaces without calling the client", async () => {
    const calls: CallLog[] = [];
    const app = createApp({
      db,
      config,
      createAbsClient: () => fakeClient({ calls }),
    });

    const badPaths = [
      "/api/cover/" + encodeURIComponent("../etc/passwd"),
      "/api/cover/../etc/passwd",
      "/api/cover/" + encodeURIComponent("has space"),
      "/api/cover/bad.id",
    ];

    for (const path of badPaths) {
      const res = await app.request(path);
      expect([400, 404]).toContain(res.status);
    }

    expect(calls).toHaveLength(0);
  });

  test("a non-image content type yields 404 and is not cached", async () => {
    const calls: CallLog[] = [];
    const app = createApp({
      db,
      config,
      createAbsClient: () =>
        fakeClient({
          calls,
          response: {
            bytes: new Uint8Array([1]),
            contentType: "application/json",
          },
        }),
    });

    const res = await app.request("/api/cover/notimg1");
    expect(res.status).toBe(404);
    expect(existsSync(join(tempDir, "covers", "notimg1.img"))).toBe(false);
    expect(existsSync(join(tempDir, "covers", "notimg1.type"))).toBe(false);
  });

  test("never leaks the ABS token (or URL) in headers or body", async () => {
    const calls: CallLog[] = [];
    const app = createApp({
      db,
      config,
      createAbsClient: () =>
        fakeClient({
          calls,
          // Content-type parameters are stripped by the proxy.
          response: {
            bytes: new Uint8Array([1, 2, 3, 4]),
            contentType: `image/png; note=${TOKEN}`,
          },
        }),
    });

    const res = await app.request("/api/cover/tokencheck");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    for (const [name, value] of res.headers) {
      expect(name).not.toContain(TOKEN);
      expect(value).not.toContain(TOKEN);
      expect(value).not.toContain("abs.invalid");
    }

    const bodyText = await res.clone().text();
    expect(bodyText).not.toContain(TOKEN);
    expect(bodyText).not.toContain("abs.invalid");

    // Unavailable covers (404 JSON) stay clean too.
    const calls2: CallLog[] = [];
    const app2 = createApp({
      db,
      config,
      createAbsClient: () =>
        fakeClient({ calls: calls2, error: new Error("offline") }),
    });
    const res404 = await app2.request("/api/cover/tokencheck2");
    expect(res404.status).toBe(404);
    const text404 = await res404.text();
    expect(text404).not.toContain(TOKEN);
    expect(text404).not.toContain("abs.invalid");
    for (const [name, value] of res404.headers) {
      expect(value).not.toContain(TOKEN);
      expect(name).not.toContain(TOKEN);
    }
  });
});

describe("cover_url on calendar and in-progress items", () => {
  let db: Database;
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-cover-url-"));
    config = mockConfig(join(tempDir, "inputtracker.db"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("points calendar items at /api/cover/<abs_item> when present", async () => {
    const runId = startRun(db, "test-seed");
    insertEvents(db, runId, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "sess-1",
        external_ids: { abs_item: "absItem_1" },
        media_type: "audiobook",
        title: "Book One",
        started_at: "2026-10-17T08:00:00.000Z",
        duration_seconds: 600,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Movie No Cover",
        started_at: "2026-10-17T09:00:00.000Z",
        duration_seconds: 600,
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "sess-2",
        external_ids: { abs_item: "bad id!" },
        media_type: "audiobook",
        title: "Book Bad Id",
        started_at: "2026-10-17T09:30:00.000Z",
        duration_seconds: 600,
      },
    ]);
    finishRun(db, runId, { status: "ok", rowsSeen: 3, rowsInserted: 3 });

    const app = createApp({
      db,
      config,
      createAbsClient: () => fakeClient({ calls: [] }),
    });

    const res = await app.request("/api/calendar?month=2026-10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: { items: { title: string | null; cover_url: string | null }[] }[];
    };
    const items = body.days[0]?.items ?? [];
    const byTitle = new Map(items.map((it) => [it.title, it]));

    expect(byTitle.get("Book One")?.cover_url).toBe("/api/cover/absItem_1");
    expect(byTitle.get("Movie No Cover")?.cover_url).toBeNull();
    expect(byTitle.get("Book Bad Id")?.cover_url).toBeNull();
  });

  test("points in-progress items at /api/cover/<abs_item> when present", async () => {
    const runId = startRun(db, "test-seed");
    insertEvents(db, runId, [
      {
        source: "audiobookshelf",
        source_kind: "media_progress",
        source_id: "prog-1",
        external_ids: { abs_item: "absProg_2" },
        media_type: "audiobook",
        title: "In Progress",
        started_at: "2026-10-17T10:00:00.000Z",
        progress: 0.4,
      },
      {
        source: "audiobookshelf",
        source_kind: "media_progress",
        source_id: "prog-2",
        media_type: "audiobook",
        title: "No Ids",
        started_at: "2026-10-17T11:00:00.000Z",
        progress: 0.5,
      },
    ]);
    finishRun(db, runId, { status: "ok", rowsSeen: 2, rowsInserted: 2 });

    const app = createApp({
      db,
      config,
      createAbsClient: () => fakeClient({ calls: [] }),
    });

    const res = await app.request("/api/in-progress");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string | null;
      cover_url: string | null;
    }[];
    const byTitle = new Map(body.map((it) => [it.title, it]));
    expect(byTitle.get("In Progress")?.cover_url).toBe("/api/cover/absProg_2");
    expect(byTitle.get("No Ids")?.cover_url).toBeNull();
  });
});
