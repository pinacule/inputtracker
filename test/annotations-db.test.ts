import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrations, openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun } from "../src/core/events.ts";
import {
  annotationRecordHash,
  getAnnotation,
  getAnnotationsFor,
  saveAnnotation,
  AnnotationValidationError,
  type Annotation,
} from "../src/server/annotations.ts";
import type { AnnotationRow } from "../src/core/schema.ts";

const REV_A = "11111111-1111-4111-8111-111111111111";
const REV_B = "22222222-2222-4222-8222-222222222222";
const REV_C = "33333333-3333-4333-8333-333333333333";

describe("annotations db & schema (migration v3)", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  test("migration v3 on a temp DB created at v1 with events → events unchanged, schema_migrations has 1, 2, 3", () => {
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

    // Apply missing migrations (v2 goals, v3 annotations) via migrate()
    migrate(v1Db);

    const migrationRows = v1Db
      .query<{ version: number }, []>(
        "SELECT version FROM schema_migrations ORDER BY version ASC;"
      )
      .all();
    expect(migrationRows.map((r) => r.version)).toEqual(
      [...migrations].map((m) => m.version).sort((a, b) => a - b)
    );

    // Events table is unchanged
    const afterEvents = v1Db
      .query<{ id: number; title: string; record_hash: string }, []>(
        "SELECT id, title, record_hash FROM events ORDER BY id ASC;"
      )
      .all();
    expect(afterEvents).toEqual(beforeEvents);

    // annotations table, index, triggers and view exist
    const tables = v1Db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='annotations';"
      )
      .all();
    expect(tables).toHaveLength(1);

    const indexes = v1Db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_annotations_source_title';"
      )
      .all();
    expect(indexes).toHaveLength(1);

    const triggers = v1Db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'annotations_no_%' ORDER BY name;"
      )
      .all()
      .map((r) => r.name);
    expect(triggers).toEqual([
      "annotations_no_delete",
      "annotations_no_update",
    ]);

    const views = v1Db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='view' AND name='annotations_latest';"
      )
      .all();
    expect(views).toHaveLength(1);

    v1Db.close();
  });

  test("UPDATE and DELETE on annotations abort", () => {
    saveAnnotation(
      db,
      { source: "manual", title: "Synthetic Film", rating: 8, rev_id: REV_A },
      "2026-10-17T10:00:00.000Z"
    );

    expect(() =>
      db.run("UPDATE annotations SET rating = 1 WHERE title = 'Synthetic Film';")
    ).toThrow("annotations is append-only");
    expect(() =>
      db.run("DELETE FROM annotations WHERE title = 'Synthetic Film';")
    ).toThrow("annotations is append-only");
  });

  test("latest revision wins", () => {
    saveAnnotation(
      db,
      { source: "manual", title: "Synthetic Film", rating: 5, rev_id: REV_A },
      "2026-10-17T10:00:00.000Z"
    );
    saveAnnotation(
      db,
      {
        source: "manual",
        title: "Synthetic Film",
        rating: 9,
        note: "Even better on rewatch",
        rev_id: REV_B,
      },
      "2026-10-17T11:00:00.000Z"
    );

    const latest = getAnnotation(db, "manual", "Synthetic Film") as Annotation;
    expect(latest.rating).toBe(9);
    expect(latest.note).toBe("Even better on rewatch");
    expect(latest.rev_id).toBe(REV_B);
  });

  test("same rev_id twice inserts one row (retried save)", () => {
    const first = saveAnnotation(db, {
      source: "manual",
      title: "Synthetic Film",
      rating: 7,
      rev_id: REV_A,
    });
    expect(first.inserted).toBe(true);

    const second = saveAnnotation(db, {
      source: "manual",
      title: "Synthetic Film",
      rating: 7,
      rev_id: REV_A,
    });
    expect(second.inserted).toBe(false);
    expect(second.rev_id).toBe(REV_A);

    const rows = db
      .query<AnnotationRow, []>("SELECT * FROM annotations;")
      .all();
    expect(rows).toHaveLength(1);
    expect(second.annotation.id).toBe(first.annotation.id);
  });

  test("A → B → A with new rev_ids: three rows, latest is A", () => {
    saveAnnotation(
      db,
      { source: "manual", title: "Synthetic Film", rating: 4, rev_id: REV_A },
      "2026-10-17T10:00:00.000Z"
    );
    saveAnnotation(
      db,
      { source: "manual", title: "Synthetic Film", rating: 9, rev_id: REV_B },
      "2026-10-17T11:00:00.000Z"
    );
    saveAnnotation(
      db,
      { source: "manual", title: "Synthetic Film", rating: 4, rev_id: REV_C },
      "2026-10-17T12:00:00.000Z"
    );

    const rows = db
      .query<AnnotationRow, []>("SELECT * FROM annotations ORDER BY id ASC;")
      .all();
    expect(rows).toHaveLength(3);

    const latest = getAnnotation(db, "manual", "Synthetic Film") as Annotation;
    expect(latest.rating).toBe(4);
    expect(latest.rev_id).toBe(REV_C);
  });

  test("clearing the rating and note writes a new row with NULLs", () => {
    saveAnnotation(db, {
      source: "manual",
      title: "Synthetic Film",
      rating: 8,
      note: "Great",
      rev_id: REV_A,
    });
    const cleared = saveAnnotation(db, {
      source: "manual",
      title: "Synthetic Film",
      rating: null,
      note: null,
      rev_id: REV_B,
    });
    expect(cleared.inserted).toBe(true);
    expect(cleared.annotation.rating).toBeNull();
    expect(cleared.annotation.note).toBeNull();

    const latest = getAnnotation(db, "manual", "Synthetic Film") as Annotation;
    expect(latest.rating).toBeNull();
    expect(latest.note).toBeNull();
  });

  test("Unicode, emoji and newlines round-trip; trailing whitespace is trimmed", () => {
    const note = "Šťastný deň! 🎬\nSecond line with emoji 🍿   \n   ";
    saveAnnotation(
      db,
      { source: "manual", title: "Synthetic Film 🎥", rating: 10, note, rev_id: REV_A },
      "2026-10-17T10:00:00.000Z"
    );

    const latest = getAnnotation(db, "manual", "Synthetic Film 🎥") as Annotation;
    expect(latest.note).toBe("Šťastný deň! 🎬\nSecond line with emoji 🍿");
    expect(latest.title).toBe("Synthetic Film 🎥");
  });

  test("getAnnotation for an unannotated title returns nulls", () => {
    expect(getAnnotation(db, "manual", "Nothing Here")).toEqual({
      rating: null,
      note: null,
    });
  });

  test("getAnnotationsFor batch lookup returns one map entry per annotated key", () => {
    saveAnnotation(db, {
      source: "manual",
      title: "Film One",
      rating: 8,
      rev_id: REV_A,
    });
    saveAnnotation(db, {
      source: "manual",
      title: "Film Two",
      rating: 3,
      rev_id: REV_B,
    });

    const map = getAnnotationsFor(db, [
      { source: "manual", title: "Film One" },
      { source: "manual", title: "Film Two" },
      { source: "manual", title: "Film Missing" },
    ]);
    expect(map.size).toBe(2);
    const keys = [...map.keys()].sort();
    expect(keys).toEqual([
      "manual\u0000Film One",
      "manual\u0000Film Two",
    ]);
    expect(map.get("manual\u0000Film One")!.rating).toBe(8);
    expect(map.get("manual\u0000Film Two")!.rating).toBe(3);
  });

  test("record_hash covers source, title, rev_id, rating, note (not created_at)", () => {
    const norm = {
      source: "manual",
      title: "Synthetic Film",
      rev_id: REV_A,
      rating: 7,
      note: "Nice",
    };
    const h1 = annotationRecordHash(norm);
    const h2 = annotationRecordHash({ ...norm });
    expect(h1).toBe(h2);
    // created_at is not an input to the hash at all
    expect(annotationRecordHash({ ...norm, rating: 8 })).not.toBe(h1);
    expect(annotationRecordHash({ ...norm, rev_id: REV_B })).not.toBe(h1);
  });

  test("length and value limits are enforced", () => {
    expect(() =>
      saveAnnotation(db, { source: "x".repeat(65), title: "T", rev_id: REV_A })
    ).toThrow(AnnotationValidationError);
    expect(() =>
      saveAnnotation(db, { source: "manual", title: "x".repeat(501), rev_id: REV_A })
    ).toThrow(AnnotationValidationError);
    expect(() =>
      saveAnnotation(db, {
        source: "manual",
        title: "T",
        note: "x".repeat(5001),
        rev_id: REV_A,
      })
    ).toThrow(AnnotationValidationError);
    // Exactly at the limits is fine
    const ok = saveAnnotation(db, {
      source: "x".repeat(64),
      title: "y".repeat(500),
      note: "z".repeat(5000),
      rating: 10,
      rev_id: REV_A,
    });
    expect(ok.inserted).toBe(true);

    for (const bad of [-0.1, 10.1, 11, 7.25, Number.NaN, "7" as unknown]) {
      expect(() =>
        saveAnnotation(db, {
          source: "manual",
          title: "T2",
          rating: bad as number,
          rev_id: REV_B,
        })
      ).toThrow(AnnotationValidationError);
    }
    expect(() =>
      saveAnnotation(db, { source: "manual", title: "T3", rev_id: "not-a-uuid" })
    ).toThrow(AnnotationValidationError);
    expect(() =>
      saveAnnotation(db, { source: "", title: "T4", rev_id: REV_A })
    ).toThrow(AnnotationValidationError);
    expect(() =>
      saveAnnotation(db, { source: "manual", title: "   ", rev_id: REV_A })
    ).toThrow(AnnotationValidationError);
  });

  test("CHECK constraints reject out-of-range values at the SQL level too", () => {
    // Bypass the validator with a raw insert to prove the CHECK exists.
    expect(() =>
      db.run(
        `INSERT INTO annotations (record_hash, source, title, rev_id, rating, note, created_at)
         VALUES ('h1', 'manual', 'Raw Film', '${REV_A}', 11, NULL, '2026-10-17T10:00:00.000Z');`
      )
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO annotations (record_hash, source, title, rev_id, rating, note, created_at)
         VALUES ('h2', 'manual', 'Raw Film 2', '${REV_B}', NULL, '${"n".repeat(5001)}', '2026-10-17T10:00:00.000Z');`
      )
    ).toThrow();
  });
});
