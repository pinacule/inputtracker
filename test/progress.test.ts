import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import {
  finishRun,
  insertEvents,
  startRun,
  type NewEvent,
} from "../src/core/events.ts";
import { createApp } from "../src/server/app.ts";
import {
  getInProgress,
  getProgressLists,
  type ProgressLists,
} from "../src/server/aggregate.ts";

const TZ = "Europe/Bratislava";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://localhost:13378", token: "secret", timeout_s: 20 },
    notify: { desktop: false, ntfy_url: "" },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

describe("getProgressLists", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  function seedRun(eventsToInsert: NewEvent[]): void {
    const runId = startRun(db, "test-seed");
    insertEvents(db, runId, eventsToInsert);
    finishRun(db, runId, {
      status: "ok",
      rowsSeen: eventsToInsert.length,
      rowsInserted: eventsToInsert.length,
    });
  }

  function progressEvent(
    sourceId: string,
    overrides: Partial<NewEvent> = {}
  ): NewEvent {
    return {
      source: "audiobookshelf",
      source_kind: "media_progress",
      source_id: sourceId,
      media_type: "audiobook",
      title: `Book ${sourceId}`,
      parent_title: "Synthetic Author",
      started_at: "2026-10-17T08:00:00.000Z",
      progress: 0.5,
      ...overrides,
    };
  }

  test("an item synced three times yields one entry with its latest values", () => {
    seedRun([progressEvent("item-three", { progress: 0.2, started_at: "2026-10-17T08:00:00.000Z" })]);
    seedRun([progressEvent("item-three", { progress: 0.5, started_at: "2026-10-17T09:00:00.000Z" })]);
    seedRun([progressEvent("item-three", { progress: 0.8, started_at: "2026-10-17T10:00:00.000Z" })]);

    const result = getProgressLists(db);
    expect(result.in_progress).toHaveLength(1);
    expect(result.finished).toHaveLength(0);

    const item = result.in_progress[0]!;
    expect(item.progress).toBe(0.8);
    expect(item.last_update).toBe("2026-10-17T10:00:00.000Z");
    expect(item.title).toBe("Book item-three");
    expect(item.parent_title).toBe("Synthetic Author");
    expect(item.is_finished).toBe(false);
    expect(item.finished_at).toBeNull();
  });

  test("finished items (progress 1, ended_at, or raw isFinished) land in finished only", () => {
    seedRun([
      progressEvent("finished-progress", {
        progress: 1.0,
        started_at: "2026-10-17T08:00:00.000Z",
      }),
      progressEvent("finished-ended", {
        progress: 0.6,
        started_at: "2026-10-17T09:00:00.000Z",
        ended_at: "2026-10-17T09:30:00.000Z",
      }),
      progressEvent("finished-raw", {
        progress: 0.5,
        started_at: "2026-10-17T10:00:00.000Z",
        raw: { isFinished: true, progress: 0.5 },
      }),
      progressEvent("still-going", {
        progress: 0.4,
        started_at: "2026-10-17T11:00:00.000Z",
      }),
    ]);

    const result = getProgressLists(db);
    expect(result.finished).toHaveLength(3);
    // Newest first by last update.
    expect(result.finished[0]!.title).toBe("Book finished-raw");
    expect(result.finished[0]!.is_finished).toBe(true);
    expect(result.finished[0]!.finished_at).toBeNull();

    const bySourceId = new Map(result.finished.map((i) => [i.title, i]));
    expect(bySourceId.get("Book finished-progress")?.is_finished).toBe(true);
    expect(bySourceId.get("Book finished-ended")?.finished_at).toBe(
      "2026-10-17T09:30:00.000Z"
    );

    // The non-finished item is only in in_progress.
    expect(result.in_progress).toHaveLength(1);
    expect(result.in_progress[0]!.title).toBe("Book still-going");
  });

  test("progress 0 and null items are excluded from both lists", () => {
    seedRun([
      progressEvent("zero", { progress: 0, started_at: "2026-10-17T08:00:00.000Z" }),
      {
        source: "audiobookshelf",
        source_kind: "media_progress",
        source_id: "null-progress",
        media_type: "audiobook",
        title: "No progress value",
        started_at: "2026-10-17T09:00:00.000Z",
        progress: null,
      },
    ]);

    const result = getProgressLists(db);
    expect(result.in_progress).toHaveLength(0);
    expect(result.finished).toHaveLength(0);
  });

  test("non-media_progress events are ignored", () => {
    seedRun([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "session-1",
        media_type: "audiobook",
        title: "A listening session",
        started_at: "2026-10-17T08:00:00.000Z",
        progress: 0.5,
      },
      {
        source: "audiobookshelf",
        source_kind: "daily_stat",
        source_id: "2026-10-17",
        media_type: "other",
        started_at: "2026-10-17T09:00:00.000Z",
        progress: 0.5,
      },
    ]);

    const result = getProgressLists(db);
    expect(result.in_progress).toHaveLength(0);
    expect(result.finished).toHaveLength(0);
  });

  test("source filter isolates items", () => {
    seedRun([
      progressEvent("abs-item", {
        source: "audiobookshelf",
        started_at: "2026-10-17T08:00:00.000Z",
      }),
      progressEvent("manual-item", {
        source: "manual",
        started_at: "2026-10-17T09:00:00.000Z",
      }),
    ]);

    const all = getProgressLists(db);
    expect(all.in_progress).toHaveLength(2);
    // Sorted by last update descending.
    expect(all.in_progress[0]!.source).toBe("manual");

    const abs = getProgressLists(db, "audiobookshelf");
    expect(abs.in_progress).toHaveLength(1);
    expect(abs.in_progress[0]!.source).toBe("audiobookshelf");

    const other = getProgressLists(db, "nonexistent");
    expect(other.in_progress).toHaveLength(0);
    expect(other.finished).toHaveLength(0);
  });

  test("items carry cover_url: abs_item when present, else the ABS item id in source_id", () => {
    seedRun([
      progressEvent("with-cover", {
        external_ids: { abs_item: "absItem_9" },
        started_at: "2026-10-17T08:00:00.000Z",
      }),
      progressEvent("no-cover", { started_at: "2026-10-17T09:00:00.000Z" }),
      progressEvent("manual-1", {
        source: "manual",
        started_at: "2026-10-17T10:00:00.000Z",
      }),
    ]);

    const result = getProgressLists(db);
    const byTitle = new Map(result.in_progress.map((i) => [i.title, i]));
    expect(byTitle.get("Book with-cover")?.cover_url).toBe(
      "/api/cover/absItem_9"
    );
    // ABS progress rows use the library item id as source_id.
    expect(byTitle.get("Book no-cover")?.cover_url).toBe("/api/cover/no-cover");
    // Only Audiobookshelf has covers.
    expect(byTitle.get("Book manual-1")?.cover_url).toBeNull();
  });

  test("a progress row titled with its own item id takes the newest session title", () => {
    const session = (sourceId: string, title: string, startedAt: string): NewEvent => ({
      source: "audiobookshelf",
      source_kind: "listening_session",
      source_id: sourceId,
      external_ids: { abs_item: "item-x" },
      media_type: "audiobook",
      title,
      started_at: startedAt,
      duration_seconds: 600,
    });
    seedRun([
      session("s1", "Old Session Title", "2026-10-01T08:00:00.000Z"),
      session("s2", "Session Title", "2026-10-02T08:00:00.000Z"),
      progressEvent("item-x", { title: "item-x" }),
      progressEvent("item-y", { title: "item-y", started_at: "2026-10-17T07:00:00.000Z" }),
      progressEvent("item-z", { title: null, started_at: "2026-10-17T06:00:00.000Z" }),
    ]);

    const titles = getProgressLists(db).in_progress.map((i) => i.title);
    // item-y / item-z have no session: they keep what they had.
    expect(titles).toEqual(["Session Title", "item-y", null]);
    expect(getInProgress(db).map((i) => i.title)).toEqual(["Session Title", "item-y", null]);
  });

  test("existing getInProgress still returns only unfinished in-progress rows", () => {
    seedRun([
      progressEvent("going", { progress: 0.3, started_at: "2026-10-17T08:00:00.000Z" }),
      progressEvent("done", { progress: 1, started_at: "2026-10-17T09:00:00.000Z" }),
    ]);

    const inProgress = getInProgress(db);
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]!.title).toBe("Book going");
  });
});

describe("GET /api/progress", () => {
  let db: Database;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    config = mockConfig();
  });

  test("returns 200 JSON with in_progress and finished lists", async () => {
    const app = createApp({ db, config });

    const runId = startRun(db, "test-seed");
    insertEvents(db, runId, [
      {
        source: "audiobookshelf",
        source_kind: "media_progress",
        source_id: "api-going",
        media_type: "audiobook",
        title: "API Going",
        started_at: "2026-10-17T08:00:00.000Z",
        progress: 0.25,
      },
      {
        source: "audiobookshelf",
        source_kind: "media_progress",
        source_id: "api-done",
        media_type: "audiobook",
        title: "API Done",
        started_at: "2026-10-17T09:00:00.000Z",
        progress: 1,
      },
    ]);
    finishRun(db, runId, { status: "ok", rowsSeen: 2, rowsInserted: 2 });

    const res = await app.request("/api/progress");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as ProgressLists;
    expect(body.in_progress).toHaveLength(1);
    expect(body.in_progress[0]!.title).toBe("API Going");
    expect(body.finished).toHaveLength(1);
    expect(body.finished[0]!.title).toBe("API Done");

    // The source filter is accepted.
    const filtered = await app.request("/api/progress?source=manual");
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as ProgressLists;
    expect(filteredBody.in_progress).toHaveLength(0);
    expect(filteredBody.finished).toHaveLength(0);
  });

  test("rejects an unknown query parameter with 400", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/progress?unexpected=1");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown query parameter");
  });
});
