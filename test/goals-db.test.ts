import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations, openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun } from "../src/core/events.ts";
import { addGoalRevision } from "../src/server/goals.ts";
import type { GoalRow } from "../src/core/schema.ts";

describe("goals db & schema (migration v2)", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  test("migration v2 on a temp DB created at v1 with events → events unchanged, schema_migrations has 2", () => {
    const v1Db = new Database(":memory:");
    v1Db.run("PRAGMA foreign_keys = ON;");

    // Initialize only migration 1
    v1Db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    migrations[0]!.up(v1Db);
    v1Db.run(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?);",
      [new Date().toISOString()]
    );

    // Seed events at v1
    const runId = startRun(v1Db, "test_v1");
    insertEvents(v1Db, runId, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs_seed_1",
        media_type: "audiobook",
        title: "Synthetic Book One",
        started_at: "2026-05-01T10:00:00.000Z",
        duration_seconds: 3600,
      },
      {
        source: "simkl",
        source_kind: "watch",
        source_id: "simkl_seed_1",
        media_type: "movie",
        title: "Synthetic Movie One",
        started_at: "2026-05-02T10:00:00.000Z",
        duration_seconds: 7200,
      },
    ]);
    finishRun(v1Db, runId, { status: "ok", rowsSeen: 2, rowsInserted: 2 });

    const beforeEvents = v1Db
      .query<{ id: number; title: string; record_hash: string }, []>(
        "SELECT id, title, record_hash FROM events ORDER BY id ASC;"
      )
      .all();
    expect(beforeEvents).toHaveLength(2);

    // Apply migration v2 via migrate()
    migrate(v1Db);

    // Check schema_migrations has version 1 and 2
    const migrationRows = v1Db
      .query<{ version: number }, []>(
        "SELECT version FROM schema_migrations ORDER BY version ASC;"
      )
      .all();
    expect(migrationRows).toHaveLength(2);
    expect(migrationRows.map((r) => r.version)).toEqual([1, 2]);

    // Check events table is unchanged
    const afterEvents = v1Db
      .query<{ id: number; title: string; record_hash: string }, []>(
        "SELECT id, title, record_hash FROM events ORDER BY id ASC;"
      )
      .all();
    expect(afterEvents).toEqual(beforeEvents);

    // Check goals table and goals_latest view exist
    const tables = v1Db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='goals';"
      )
      .all();
    expect(tables).toHaveLength(1);

    const views = v1Db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='view' AND name='goals_latest';"
      )
      .all();
    expect(views).toHaveLength(1);

    v1Db.close();
  });

  test("UPDATE and DELETE on goals abort with 'goals is append-only'", () => {
    const res = addGoalRevision(db, {
      year: 2026,
      metric: "items",
      target: 30,
    });
    expect(res.inserted).toBe(true);

    const row = db
      .query<GoalRow, [string]>("SELECT * FROM goals WHERE goal_id = ?;")
      .get(res.goal_id);
    expect(row).not.toBeNull();
    const rowId = row!.id;

    // UPDATE should throw
    expect(() => {
      db.run("UPDATE goals SET target = 99 WHERE id = ?;", [rowId]);
    }).toThrow("goals is append-only");

    // DELETE should throw
    expect(() => {
      db.run("DELETE FROM goals WHERE id = ?;", [rowId]);
    }).toThrow("goals is append-only");

    // Row remains intact
    const intact = db
      .query<GoalRow, [number]>("SELECT * FROM goals WHERE id = ?;")
      .get(rowId);
    expect(intact?.target).toBe(30);
  });

  test("goals_latest returns the newest revision", () => {
    const res1 = addGoalRevision(db, {
      year: 2026,
      metric: "items",
      target: 20,
    });
    const goalId = res1.goal_id;
    const rev2 = "b0000000-0000-0000-0000-000000000002";

    addGoalRevision(db, {
      goal_id: goalId,
      rev_id: rev2,
      year: 2026,
      metric: "items",
      target: 50,
    });

    const latest = db
      .query<GoalRow, [string]>("SELECT * FROM goals_latest WHERE goal_id = ?;")
      .get(goalId);

    expect(latest).not.toBeNull();
    expect(latest?.rev_id).toBe(rev2);
    expect(latest?.target).toBe(50);
  });

  test("same rev_id twice → 1 row (idempotent insert)", () => {
    const res1 = addGoalRevision(db, {
      year: 2026,
      metric: "hours",
      target: 100,
    });
    expect(res1.inserted).toBe(true);
    const goalId = res1.goal_id;
    const revId = res1.rev_id;

    const res2 = addGoalRevision(db, {
      goal_id: goalId,
      rev_id: revId,
      year: 2026,
      metric: "hours",
      target: 100,
    });
    expect(res2.inserted).toBe(false);

    const rows = db
      .query<GoalRow, [string]>("SELECT * FROM goals WHERE goal_id = ?;")
      .all(goalId);
    expect(rows).toHaveLength(1);
  });

  test("A → B → A with new rev_ids → latest is A", () => {
    // Revision 1: target 10
    const res1 = addGoalRevision(db, {
      year: 2026,
      metric: "items",
      target: 10,
    });
    const goalId = res1.goal_id;

    const rev2 = "b0000000-0000-0000-0000-000000000005";
    const rev3 = "b0000000-0000-0000-0000-000000000006";

    // Revision 2: target 20
    addGoalRevision(db, {
      goal_id: goalId,
      rev_id: rev2,
      year: 2026,
      metric: "items",
      target: 20,
    });

    // Revision 3: back to target 10
    addGoalRevision(db, {
      goal_id: goalId,
      rev_id: rev3,
      year: 2026,
      metric: "items",
      target: 10,
    });

    const allRows = db
      .query<GoalRow, [string]>("SELECT * FROM goals WHERE goal_id = ? ORDER BY id ASC;")
      .all(goalId);
    expect(allRows).toHaveLength(3);

    const latest = db
      .query<GoalRow, [string]>("SELECT * FROM goals_latest WHERE goal_id = ?;")
      .get(goalId);
    expect(latest).not.toBeNull();
    expect(latest?.rev_id).toBe(rev3);
    expect(latest?.target).toBe(10);
  });
});
