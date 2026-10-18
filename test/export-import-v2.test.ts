/**
 * Export v2 + import round-trip tests: events, goals and annotations.
 *
 * All data is synthetic. No network access. Tests use in-memory SQLite databases
 * opened by `openDb(":memory:")` which runs all migrations including v2 (goals)
 * and v3 (annotations).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/core/db.ts";
import { insertEvents, type NewEvent } from "../src/core/events.ts";
import type {
  AnnotationRow,
  EventRow,
  GoalRow,
} from "../src/core/schema.ts";
import {
  EXPORT_FORMAT,
  exportJson,
  type ExportEnvelope,
} from "../src/io/export-json.ts";
import { importNative, parseNativeJson } from "../src/io/import-native.ts";
import { runBackup } from "../src/io/backup.ts";
import { goalRecordHash, normalizeGoalFields } from "../src/server/goals.ts";
import { saveAnnotation } from "../src/server/annotations.ts";
import { runVerifyCopy } from "../src/cli/verify-copy.ts";
import type { Config } from "../src/core/config.ts";
import { runCli } from "../src/cli/index.ts";

// --- synthetic data helpers ------------------------------------------------

function sampleEvents(): NewEvent[] {
  return [
    {
      source: "audiobookshelf",
      source_kind: "listening_session",
      source_id: "sess-1",
      external_ids: { asin: "B000FAKE" },
      media_type: "audiobook",
      title: "Synthetic Book",
      parent_title: "Synthetic Author",
      started_at: "2026-10-17T08:15:00.000Z",
      ended_at: "2026-10-17T08:35:00.000Z",
      duration_seconds: 1200,
      progress: 0.75,
      device: "Synthetic Phone",
    },
    {
      source: "manual",
      source_kind: "manual",
      source_id: "manual-1",
      media_type: "movie",
      title: "Synthetic Movie",
      started_at: "2026-10-17T10:00:00.000Z",
    },
  ];
}

const GOAL_1_ID = "aaaaaaaa-1111-4000-8000-000000000001";
const GOAL_1_REV1 = "bbbbbbbb-1111-4000-8000-000000000001";
const GOAL_1_REV2 = "bbbbbbbb-2222-4000-8000-000000000002";
const GOAL_2_ID = "aaaaaaaa-2222-4000-8000-000000000002";
const GOAL_2_REV1 = "cccccccc-1111-4000-8000-000000000001";

/**
 * Insert one goal revision with fixed ids. `addGoalRevision` only accepts a
 * `goal_id` that already exists, but the verify-copy tests need two databases
 * seeded with identical ids, so revisions are written directly (with the real
 * validation and hash).
 */
function insertGoal(
  db: Database,
  goalId: string,
  revId: string,
  fields: Parameters<typeof normalizeGoalFields>[0],
  createdAt: string
): void {
  const norm = normalizeGoalFields(fields);
  const hash = goalRecordHash({ goal_id: goalId, rev_id: revId, ...norm });
  db.run(
    `INSERT INTO goals (record_hash, goal_id, rev_id, year, metric, source, media_type, target, archived, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [hash, goalId, revId, norm.year, norm.metric, norm.source, norm.media_type, norm.target, norm.archived, createdAt]
  );
}

function seedGoals(db: Database): void {
  // Goal 1: initial rev, then an archived rev
  insertGoal(db, GOAL_1_ID, GOAL_1_REV1, { year: 2026, metric: "items", target: 30 }, "2026-01-01T00:00:00.000Z");
  insertGoal(
    db,
    GOAL_1_ID,
    GOAL_1_REV2,
    { year: 2026, metric: "items", target: 30, archived: 1 },
    "2026-06-01T00:00:00.000Z"
  );
  // Goal 2: single rev
  insertGoal(
    db,
    GOAL_2_ID,
    GOAL_2_REV1,
    { year: 2026, metric: "hours", source: "audiobookshelf", media_type: "audiobook", target: 200 },
    "2026-02-01T00:00:00.000Z"
  );
}

function seedAnnotations(db: Database): void {
  // Normal annotation
  saveAnnotation(
    db,
    { source: "audiobookshelf", title: "Synthetic Book", rating: 8, note: "Great read", rev_id: "dddddddd-1111-4000-8000-000000000001" },
    "2026-10-17T09:00:00.000Z"
  );
  // Annotation with unicode note
  saveAnnotation(
    db,
    { source: "manual", title: "Synthetic Movie", rating: 7, note: "Výborný film 🎬", rev_id: "dddddddd-2222-4000-8000-000000000002" },
    "2026-10-17T10:30:00.000Z"
  );
  // Cleared annotation (nulls)
  saveAnnotation(
    db,
    { source: "audiobookshelf", title: "Synthetic Book", rating: null, note: null, rev_id: "dddddddd-3333-4000-8000-000000000003" },
    "2026-10-17T11:00:00.000Z"
  );
}

/** Seed a DB with events, goals and annotations. */
function seedAll(db: Database): Database {
  insertEvents(db, null, sampleEvents());
  seedGoals(db);
  seedAnnotations(db);
  return db;
}

function count(db: Database, table: string): number {
  return (
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table};`).get()?.n ?? 0
  );
}

/** All goal rows except id (auto-assigned). */
type ComparableGoalRow = Omit<GoalRow, "id">;
function comparableGoals(db: Database): ComparableGoalRow[] {
  return db
    .query<GoalRow, []>("SELECT * FROM goals ORDER BY record_hash ASC;")
    .all()
    .map(({ id, ...rest }) => rest);
}

/** All annotation rows except id. */
type ComparableAnnotationRow = Omit<AnnotationRow, "id">;
function comparableAnnotations(db: Database): ComparableAnnotationRow[] {
  return db
    .query<AnnotationRow, []>("SELECT * FROM annotations ORDER BY record_hash ASC;")
    .all()
    .map(({ id, ...rest }) => rest);
}

/** All event rows except identity/ingest bookkeeping columns. */
type ComparableEventRow = Omit<EventRow, "id" | "ingested_at" | "ingest_run_id">;
function comparableEvents(db: Database): ComparableEventRow[] {
  return db
    .query<EventRow, []>("SELECT * FROM events ORDER BY record_hash ASC;")
    .all()
    .map(({ id, ingested_at, ingest_run_id, ...rest }) => rest);
}

// --- round-trip tests ------------------------------------------------------

describe("export v2 / import round-trip", () => {
  test("exportJson produces v2 envelope with events, goals and annotations", () => {
    const db = seedAll(openDb(":memory:"));
    const envelope = JSON.parse(exportJson(db)) as ExportEnvelope;

    expect(envelope.format).toBe(EXPORT_FORMAT);
    expect(envelope.version).toBe(2);
    expect(envelope.events).toHaveLength(2);
    expect(envelope.goals).toHaveLength(3);
    expect(envelope.annotations).toHaveLength(3);

    // goals ordered by id
    expect(envelope.goals[0]!.goal_id).toBe(GOAL_1_ID);
    expect(envelope.goals[0]!.rev_id).toBe(GOAL_1_REV1);
    expect(envelope.goals[1]!.goal_id).toBe(GOAL_1_ID);
    expect(envelope.goals[1]!.archived).toBe(1);
    expect(envelope.goals[2]!.goal_id).toBe(GOAL_2_ID);

    db.close();
  });

  test("round-trip: identical rows in all three tables after import", () => {
    const source = seedAll(openDb(":memory:"));
    const text = exportJson(source);

    const target = openDb(":memory:");
    const result = importNative(target, text, "json");

    expect(result.events).toEqual({ seen: 2, inserted: 2 });
    expect(result.goals).toEqual({ seen: 3, inserted: 3 });
    expect(result.annotations).toEqual({ seen: 3, inserted: 3 });

    // Events match (exclude id, ingested_at, ingest_run_id)
    expect(comparableEvents(target)).toEqual(comparableEvents(source));

    // Goals match (exclude id)
    expect(comparableGoals(target)).toEqual(comparableGoals(source));

    // Annotations match (exclude id)
    expect(comparableAnnotations(target)).toEqual(comparableAnnotations(source));

    // goals_latest resolves the same way
    const sourceLatestGoals = source
      .query<GoalRow, []>("SELECT * FROM goals_latest ORDER BY goal_id;")
      .all()
      .map(({ id, ...rest }) => rest);
    const targetLatestGoals = target
      .query<GoalRow, []>("SELECT * FROM goals_latest ORDER BY goal_id;")
      .all()
      .map(({ id, ...rest }) => rest);
    expect(targetLatestGoals).toEqual(sourceLatestGoals);

    // annotations_latest resolves the same way
    const sourceLatestAnn = source
      .query<AnnotationRow, []>("SELECT * FROM annotations_latest ORDER BY source, title;")
      .all()
      .map(({ id, ...rest }) => rest);
    const targetLatestAnn = target
      .query<AnnotationRow, []>("SELECT * FROM annotations_latest ORDER BY source, title;")
      .all()
      .map(({ id, ...rest }) => rest);
    expect(targetLatestAnn).toEqual(sourceLatestAnn);

    source.close();
    target.close();
  });

  test("re-import of the same file inserts 0 in every table", () => {
    const db = seedAll(openDb(":memory:"));
    const text = exportJson(db);

    const result = importNative(db, text, "json");

    expect(result.events.inserted).toBe(0);
    expect(result.goals.inserted).toBe(0);
    expect(result.annotations.inserted).toBe(0);
    expect(result.events.seen).toBe(2);
    expect(result.goals.seen).toBe(3);
    expect(result.annotations.seen).toBe(3);

    // Counts unchanged
    expect(count(db, "events")).toBe(2);
    expect(count(db, "goals")).toBe(3);
    expect(count(db, "annotations")).toBe(3);

    db.close();
  });

  test("v1 file (events only) still imports with zero goals/annotations", () => {
    const db = openDb(":memory:");
    insertEvents(db, null, sampleEvents());
    const v1 = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      events: JSON.parse(exportJson(db)).events,
    });

    const target = openDb(":memory:");
    const result = importNative(target, v1, "json");

    expect(result.events).toEqual({ seen: 2, inserted: 2 });
    expect(result.goals).toEqual({ seen: 0, inserted: 0 });
    expect(result.annotations).toEqual({ seen: 0, inserted: 0 });
    expect(count(target, "events")).toBe(2);

    db.close();
    target.close();
  });

  test("v2 file missing goals key is an error", () => {
    const bad = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 2,
      events: [],
      annotations: [],
    });
    expect(() => parseNativeJson(bad)).toThrow(/goals.*required/i);
  });

  test("v2 file missing annotations key is an error", () => {
    const bad = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 2,
      events: [],
      goals: [],
    });
    expect(() => parseNativeJson(bad)).toThrow(/annotations.*required/i);
  });

  test("v2 file with empty arrays is fine", () => {
    const ok = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 2,
      events: [],
      goals: [],
      annotations: [],
    });
    const result = parseNativeJson(ok);
    expect(result.events).toHaveLength(0);
    expect(result.goals).toHaveLength(0);
    expect(result.annotations).toHaveLength(0);
  });
});

// --- invalid data tests ---------------------------------------------------

describe("invalid goals/annotations in import", () => {
  test("an invalid goal (target: 0) inserts nothing in any table", () => {
    const source = seedAll(openDb(":memory:"));
    const envelope = JSON.parse(exportJson(source)) as Record<string, unknown>;
    // Tamper with the first goal: target 0 is invalid
    const goals = envelope.goals as Record<string, unknown>[];
    goals[0]!.target = 0;

    const target = openDb(":memory:");
    expect(() => importNative(target, JSON.stringify(envelope), "json")).toThrow(/target/i);
    expect(count(target, "events")).toBe(0);
    expect(count(target, "goals")).toBe(0);
    expect(count(target, "annotations")).toBe(0);

    source.close();
    target.close();
  });

  test("an invalid annotation (rating: 11) inserts nothing in any table", () => {
    const source = seedAll(openDb(":memory:"));
    const envelope = JSON.parse(exportJson(source)) as Record<string, unknown>;
    // Tamper with the first annotation
    const annotations = envelope.annotations as Record<string, unknown>[];
    annotations[0]!.rating = 11;

    const target = openDb(":memory:");
    expect(() => importNative(target, JSON.stringify(envelope), "json")).toThrow(/rating/i);
    expect(count(target, "events")).toBe(0);
    expect(count(target, "goals")).toBe(0);
    expect(count(target, "annotations")).toBe(0);

    source.close();
    target.close();
  });

  test("an annotation without rev_id is rejected (a random one would break re-import)", () => {
    const source = seedAll(openDb(":memory:"));
    const envelope = JSON.parse(exportJson(source)) as Record<string, unknown>;
    delete (envelope.annotations as Record<string, unknown>[])[0]!.rev_id;

    const target = openDb(":memory:");
    expect(() => importNative(target, JSON.stringify(envelope), "json")).toThrow(/rev_id/i);
    expect(count(target, "annotations")).toBe(0);

    source.close();
    target.close();
  });

  test("created_at must be a timestamp and is stored as UTC ISO", () => {
    const source = seedAll(openDb(":memory:"));
    const bad = JSON.parse(exportJson(source)) as Record<string, unknown>;
    (bad.goals as Record<string, unknown>[])[0]!.created_at = "not a date";
    const target = openDb(":memory:");
    expect(() => importNative(target, JSON.stringify(bad), "json")).toThrow(/created_at/i);
    expect(count(target, "goals")).toBe(0);

    const offset = JSON.parse(exportJson(source)) as Record<string, unknown>;
    (offset.annotations as Record<string, unknown>[])[0]!.created_at = "2026-10-17T11:00:00+02:00";
    importNative(target, JSON.stringify(offset), "json");
    const row = target
      .query<{ created_at: string }, []>("SELECT created_at FROM annotations ORDER BY id LIMIT 1;")
      .get();
    expect(row?.created_at).toBe("2026-10-17T09:00:00.000Z");

    source.close();
    target.close();
  });

  test("a tampered record_hash in the file doesn't create a duplicate", () => {
    const source = seedAll(openDb(":memory:"));
    const envelope = JSON.parse(exportJson(source)) as Record<string, unknown>;

    // Tamper all hashes
    const goals = envelope.goals as Record<string, unknown>[];
    for (const g of goals) {
      g.record_hash = "tampered-goal-hash";
    }
    const annotations = envelope.annotations as Record<string, unknown>[];
    for (const a of annotations) {
      a.record_hash = "tampered-ann-hash";
    }

    // Import into a fresh DB with the original data
    const target = seedAll(openDb(":memory:"));
    const result = importNative(target, JSON.stringify(envelope), "json");

    // Everything should be 0 inserted because the recomputed hashes match
    expect(result.events.inserted).toBe(0);
    expect(result.goals.inserted).toBe(0);
    expect(result.annotations.inserted).toBe(0);

    // No extra rows
    expect(count(target, "events")).toBe(2);
    expect(count(target, "goals")).toBe(3);
    expect(count(target, "annotations")).toBe(3);

    source.close();
    target.close();
  });

  test("an invalid goal after valid events rolls back everything", () => {
    const db = openDb(":memory:");
    const envelope = {
      format: EXPORT_FORMAT,
      version: 2,
      events: [
        {
          source: "manual",
          source_kind: "manual",
          source_id: "m-1",
          media_type: "book",
          started_at: "2026-10-17T00:00:00.000Z",
        },
      ],
      goals: [
        {
          goal_id: GOAL_1_ID,
          rev_id: GOAL_1_REV1,
          year: 2026,
          metric: "items",
          target: 0, // invalid!
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      annotations: [],
    };

    expect(() => importNative(db, JSON.stringify(envelope), "json")).toThrow(/target/i);
    expect(count(db, "events")).toBe(0);
    expect(count(db, "goals")).toBe(0);

    db.close();
  });
});

// --- backup includes goals & annotations -----------------------------------

describe("backup includes goals and annotations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "it-backup-v2-"));
  });

  afterEach(() => {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("JSON written by backup.ts contains goals and annotations", () => {
    const db = seedAll(openDb(":memory:"));
    const result = runBackup(db, {
      dir,
      keep: 14,
      now: new Date("2026-10-17T12:00:00Z"),
    });

    const json = JSON.parse(readFileSync(result.jsonPath, "utf8")) as ExportEnvelope;
    expect(json.version).toBe(2);
    expect(json.events).toHaveLength(2);
    expect(json.goals).toHaveLength(3);
    expect(json.annotations).toHaveLength(3);

    db.close();
  });
});

// --- verify-copy with goals & annotations ----------------------------------

describe("verify-copy with goals & annotations", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "it-verify-v2-"));
  });

  afterEach(() => {
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeDb(path: string, seedFn: (db: Database) => void): void {
    const db = openDb(path);
    seedFn(db);
    db.close();
  }

  function configFor(dbPath: string): Config {
    return { storage: { db_path: dbPath } } as unknown as Config;
  }

  test("a copy missing an annotation row is reported", () => {
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");

    makeDb(refPath, (db) => {
      insertEvents(db, null, sampleEvents());
      seedGoals(db);
      seedAnnotations(db);
    });

    // Copy has the same events and goals but only 2 of 3 annotations
    makeDb(copyPath, (db) => {
      insertEvents(db, null, sampleEvents());
      seedGoals(db);
      saveAnnotation(
        db,
        { source: "audiobookshelf", title: "Synthetic Book", rating: 8, note: "Great read", rev_id: "dddddddd-1111-4000-8000-000000000001" },
        "2026-10-17T09:00:00.000Z"
      );
      saveAnnotation(
        db,
        { source: "manual", title: "Synthetic Movie", rating: 7, note: "Výborný film 🎬", rev_id: "dddddddd-2222-4000-8000-000000000002" },
        "2026-10-17T10:30:00.000Z"
      );
      // Missing the third annotation (cleared one)
    });

    const lines: string[] = [];
    const errs: string[] = [];
    const code = runVerifyCopy([copyPath], {
      loadConfig: () => configFor(refPath),
      out: (line) => lines.push(line),
      err: (line) => errs.push(line),
      usage: () => "usage",
    });

    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("annotations missing in copy: 1");
    expect(text).not.toContain("copy OK");
  });

  test("identical copies with goals & annotations exit 0", () => {
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");

    makeDb(refPath, (db) => {
      insertEvents(db, null, sampleEvents());
      seedGoals(db);
      seedAnnotations(db);
    });

    makeDb(copyPath, (db) => {
      insertEvents(db, null, sampleEvents());
      seedGoals(db);
      seedAnnotations(db);
    });

    const lines: string[] = [];
    const errs: string[] = [];
    const code = runVerifyCopy([copyPath], {
      loadConfig: () => configFor(refPath),
      out: (line) => lines.push(line),
      err: (line) => errs.push(line),
      usage: () => "usage",
    });

    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("reference goals: 3");
    expect(text).toContain("copy goals: 3");
    expect(text).toContain("goals missing in copy: 0");
    expect(text).toContain("reference annotations: 3");
    expect(text).toContain("copy annotations: 3");
    expect(text).toContain("annotations missing in copy: 0");
    expect(text).toContain("copy OK: every event present");
  });
});

// --- CSV import stays events-only ------------------------------------------

describe("CSV import stays events-only", () => {
  test("CSV import reports zero goals/annotations", () => {
    const source = openDb(":memory:");
    insertEvents(source, null, sampleEvents());

    // Use the importNative CSV path (exportCsv only exports events)
    const { exportCsv } = require("../src/io/export-csv.ts") as { exportCsv: (db: Database) => string };
    const csvText = exportCsv(source);

    const target = openDb(":memory:");
    const result = importNative(target, csvText, "csv");

    expect(result.events.inserted).toBe(2);
    expect(result.goals).toEqual({ seen: 0, inserted: 0 });
    expect(result.annotations).toEqual({ seen: 0, inserted: 0 });

    source.close();
    target.close();
  });
});
