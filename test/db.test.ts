import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../src/core/db.ts";
import type { EventRow } from "../src/core/schema.ts";

describe("db core", () => {
  describe("in-memory db (:memory:)", () => {
    let db: ReturnType<typeof openDb>;

    beforeEach(() => {
      db = openDb(":memory:");
    });

    test("all tables, the view, indexes, and both triggers exist after openDb", () => {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
        )
        .all()
        .map((r) => r.name);

      expect(tables).toContain("schema_migrations");
      expect(tables).toContain("ingest_runs");
      expect(tables).toContain("events");
      expect(tables).toContain("sync_state");

      const views = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name;"
        )
        .all()
        .map((r) => r.name);

      expect(views).toContain("events_latest");

      const triggers = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name;"
        )
        .all()
        .map((r) => r.name);

      expect(triggers).toContain("events_no_update");
      expect(triggers).toContain("events_no_delete");

      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;"
        )
        .all()
        .map((r) => r.name);

      expect(indexes).toContain("idx_events_source_lookup");
      expect(indexes).toContain("idx_events_started_at");
    });

    test("UPDATE on events throws; DELETE on events throws; row still intact afterwards", () => {
      const runRes = db.run(
        `INSERT INTO ingest_runs (source, kind, started_at, status)
         VALUES ('mock_source', 'sync', '2026-10-17T08:00:00.000Z', 'running');`
      );
      const runId = Number(runRes.lastInsertRowid);

      const eventRes = db.run(
        `INSERT INTO events (
           record_hash, source, source_kind, source_id, media_type,
           title, parent_title, started_at, ingested_at, ingest_run_id
         ) VALUES (
           'hash_test_1', 'mock_source', 'listening_session', 'sess_001', 'audiobook',
           'Synthetic Book Title', 'Synthetic Author', '2026-10-17T08:15:00.000Z',
           '2026-10-17T08:16:00.000Z', ?
         );`,
        [runId]
      );
      const eventId = Number(eventRes.lastInsertRowid);

      // Attempt UPDATE
      expect(() => {
        db.run("UPDATE events SET title = 'Changed Synthetic Title' WHERE id = ?;", [
          eventId,
        ]);
      }).toThrow("events is append-only");

      // Attempt DELETE
      expect(() => {
        db.run("DELETE FROM events WHERE id = ?;", [eventId]);
      }).toThrow("events is append-only");

      // Verify row is still intact
      const row = db
        .query<EventRow, [number]>("SELECT * FROM events WHERE id = ?;")
        .get(eventId);

      expect(row).not.toBeNull();
      expect(row?.title).toBe("Synthetic Book Title");
      expect(row?.record_hash).toBe("hash_test_1");
      expect(row?.source_id).toBe("sess_001");
    });

    test("migrate run twice → no error, schema_migrations has one row per migration", () => {
      expect(() => migrate(db)).not.toThrow();
      expect(() => migrate(db)).not.toThrow();

      const migrationRows = db
        .query<{ version: number; applied_at: string }, []>(
          "SELECT version, applied_at FROM schema_migrations ORDER BY version ASC;"
        )
        .all();

      expect(migrationRows).toHaveLength(2);
      expect(migrationRows[0]?.version).toBe(1);
      expect(migrationRows[1]?.version).toBe(2);
      expect(typeof migrationRows[0]?.applied_at).toBe("string");
      expect(migrationRows[0]?.applied_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
      expect(typeof migrationRows[1]?.applied_at).toBe("string");
      expect(migrationRows[1]?.applied_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
    });

    test("events_latest returns exactly one row (the max id) per key when the same key is inserted 3 times with different record_hash; and separate rows for different keys", () => {
      // Key A: inserted 3 times
      db.run(
        `INSERT INTO events (
           record_hash, source, source_kind, source_id, media_type,
           title, started_at, progress, duration_seconds, ingested_at
         ) VALUES
           ('hash_a_1', 'source_a', 'session', 'item_1', 'audiobook', 'Track 1', '2026-10-17T08:00:00.000Z', 0.2, 120, '2026-10-17T08:05:00.000Z'),
           ('hash_a_2', 'source_a', 'session', 'item_1', 'audiobook', 'Track 1', '2026-10-17T08:00:00.000Z', 0.6, 360, '2026-10-17T08:10:00.000Z'),
           ('hash_a_3', 'source_a', 'session', 'item_1', 'audiobook', 'Track 1', '2026-10-17T08:00:00.000Z', 1.0, 600, '2026-10-17T08:15:00.000Z');`
      );

      // Key B: inserted 2 times
      db.run(
        `INSERT INTO events (
           record_hash, source, source_kind, source_id, media_type,
           title, started_at, progress, duration_seconds, ingested_at
         ) VALUES
           ('hash_b_1', 'source_a', 'session', 'item_2', 'audiobook', 'Track 2', '2026-10-17T09:00:00.000Z', 0.5, 300, '2026-10-17T09:05:00.000Z'),
           ('hash_b_2', 'source_a', 'session', 'item_2', 'audiobook', 'Track 2', '2026-10-17T09:00:00.000Z', 0.8, 480, '2026-10-17T09:10:00.000Z');`
      );

      // Key C: inserted 1 time (different source)
      db.run(
        `INSERT INTO events (
           record_hash, source, source_kind, source_id, media_type,
           title, started_at, progress, duration_seconds, ingested_at
         ) VALUES
           ('hash_c_1', 'source_b', 'watch', 'video_99', 'video', 'Synthetic Video', '2026-10-17T10:00:00.000Z', 1.0, 900, '2026-10-17T10:15:00.000Z');`
      );

      const latestRows = db
        .query<EventRow, []>(
          "SELECT * FROM events_latest ORDER BY source ASC, source_id ASC;"
        )
        .all();

      expect(latestRows).toHaveLength(3);

      const item1 = latestRows.find(
        (r) => r.source === "source_a" && r.source_id === "item_1"
      );
      expect(item1).toBeDefined();
      expect(item1?.record_hash).toBe("hash_a_3");
      expect(item1?.progress).toBe(1.0);
      expect(item1?.duration_seconds).toBe(600);
      expect(item1?.id).toBe(3);

      const item2 = latestRows.find(
        (r) => r.source === "source_a" && r.source_id === "item_2"
      );
      expect(item2).toBeDefined();
      expect(item2?.record_hash).toBe("hash_b_2");
      expect(item2?.progress).toBe(0.8);
      expect(item2?.id).toBe(5);

      const itemVideo = latestRows.find(
        (r) => r.source === "source_b" && r.source_id === "video_99"
      );
      expect(itemVideo).toBeDefined();
      expect(itemVideo?.record_hash).toBe("hash_c_1");
      expect(itemVideo?.id).toBe(6);

      // Verify that same source and source_id but differing source_kind are partitioned separately
      db.run(
        `INSERT INTO events (
           record_hash, source, source_kind, source_id, media_type,
           title, started_at, progress, duration_seconds, ingested_at
         ) VALUES
           ('hash_diff_kind_1', 'source_a', 'media_progress', 'item_1', 'audiobook', 'Track 1 Progress', '2026-10-17T08:30:00.000Z', 1.0, 600, '2026-10-17T08:30:00.000Z');`
      );

      const latestWithDiffKind = db
        .query<EventRow, []>(
          "SELECT * FROM events_latest WHERE source = 'source_a' AND source_id = 'item_1' ORDER BY source_kind ASC;"
        )
        .all();

      expect(latestWithDiffKind).toHaveLength(2);
      expect(latestWithDiffKind[0]?.source_kind).toBe("media_progress");
      expect(latestWithDiffKind[0]?.record_hash).toBe("hash_diff_kind_1");
      expect(latestWithDiffKind[1]?.source_kind).toBe("session");
      expect(latestWithDiffKind[1]?.record_hash).toBe("hash_a_3");
    });

    test("duplicate record_hash with INSERT OR IGNORE inserts nothing", () => {
      db.run(
        `INSERT INTO events (
           record_hash, source, source_kind, source_id, media_type,
           title, started_at, ingested_at
         ) VALUES (
           'hash_unique_100', 'mock_source', 'session', 'sess_100', 'audiobook',
           'Original Title', '2026-10-17T08:00:00.000Z', '2026-10-17T08:01:00.000Z'
         );`
      );

      const countBefore = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events;")
        .get();
      expect(countBefore?.count).toBe(1);

      // Attempt duplicate insert with INSERT OR IGNORE
      const res = db.run(
        `INSERT OR IGNORE INTO events (
           record_hash, source, source_kind, source_id, media_type,
           title, started_at, ingested_at
         ) VALUES (
           'hash_unique_100', 'mock_source', 'session', 'sess_100', 'audiobook',
           'Duplicate Title Attempt', '2026-10-17T08:00:00.000Z', '2026-10-17T08:02:00.000Z'
         );`
      );

      expect(res.changes).toBe(0);

      const countAfter = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events;")
        .get();
      expect(countAfter?.count).toBe(1);

      const stored = db
        .query<EventRow, []>("SELECT * FROM events WHERE record_hash = 'hash_unique_100';")
        .get();
      expect(stored?.title).toBe("Original Title");
    });

    test("foreign_keys pragma is 1; bad ingest_run_id is rejected", () => {
      const fk = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys;").get();
      expect(fk?.foreign_keys).toBe(1);

      // Insert event referencing a non-existent ingest_run_id (e.g. 999999)
      expect(() => {
        db.run(
          `INSERT INTO events (
             record_hash, source, source_kind, source_id, media_type,
             started_at, ingested_at, ingest_run_id
           ) VALUES (
             'hash_fk_fail', 'mock_source', 'session', 'sess_fk', 'audiobook',
             '2026-10-17T08:00:00.000Z', '2026-10-17T08:01:00.000Z', 999999
           );`
        );
      }).toThrow(/FOREIGN KEY/i);

      // Create valid ingest_run
      const runRes = db.run(
        `INSERT INTO ingest_runs (source, started_at, status)
         VALUES ('mock_source', '2026-10-17T08:00:00.000Z', 'running');`
      );
      const validRunId = Number(runRes.lastInsertRowid);

      // Insert referencing valid runId should succeed
      expect(() => {
        db.run(
          `INSERT INTO events (
             record_hash, source, source_kind, source_id, media_type,
             started_at, ingested_at, ingest_run_id
           ) VALUES (
             'hash_fk_success', 'mock_source', 'session', 'sess_fk', 'audiobook',
             '2026-10-17T08:00:00.000Z', '2026-10-17T08:01:00.000Z', ?
           );`,
          [validRunId]
        );
      }).not.toThrow();
    });

    test("sync_state row can be updated", () => {
      db.run(
        `INSERT INTO sync_state (source, cursor, updated_at)
         VALUES ('audiobookshelf', 'cursor_token_1', '2026-10-17T08:00:00.000Z');`
      );

      const initial = db
        .query<{ source: string; cursor: string; updated_at: string }, []>(
          "SELECT * FROM sync_state WHERE source = 'audiobookshelf';"
        )
        .get();
      expect(initial?.cursor).toBe("cursor_token_1");
      expect(initial?.updated_at).toBe("2026-10-17T08:00:00.000Z");

      db.run(
        `UPDATE sync_state
         SET cursor = 'cursor_token_2', updated_at = '2026-10-17T09:00:00.000Z'
         WHERE source = 'audiobookshelf';`
      );

      const updated = db
        .query<{ source: string; cursor: string; updated_at: string }, []>(
          "SELECT * FROM sync_state WHERE source = 'audiobookshelf';"
        )
        .get();
      expect(updated?.cursor).toBe("cursor_token_2");
      expect(updated?.updated_at).toBe("2026-10-17T09:00:00.000Z");
    });
  });

  describe("file db in os.tmpdir", () => {
    let tempDir: string;
    let dbPath: string;
    let fileDb: ReturnType<typeof openDb>;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "it-db-test-"));
      // Test nested path so openDb creates parent dirs
      dbPath = join(tempDir, "nested", "subfolder", "inputtracker.db");
      fileDb = openDb(dbPath);
    });

    afterEach(() => {
      try {
        fileDb?.close();
      } catch {
        // ignore
      }
      try {
        if (tempDir && existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    });

    test("creates parent dir and enables WAL mode for file DB", () => {
      expect(existsSync(dbPath)).toBe(true);

      const journalMode = fileDb
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode;")
        .get();
      expect(journalMode?.journal_mode.toLowerCase()).toBe("wal");

      const fk = fileDb
        .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys;")
        .get();
      expect(fk?.foreign_keys).toBe(1);

      const tables = fileDb
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
        )
        .all()
        .map((r) => r.name);
      expect(tables).toContain("events");
      expect(tables).toContain("schema_migrations");
    });

    test("re-opening existing file DB preserves data and migrations are idempotent", () => {
      fileDb.run(
        `INSERT INTO sync_state (source, cursor, updated_at)
         VALUES ('simkl', 'cursor_token_simkl', '2026-10-17T08:00:00.000Z');`
      );

      fileDb.close();

      // Re-open existing DB at same path
      const reopenedDb = openDb(dbPath);
      try {
        const row = reopenedDb
          .query<{ source: string; cursor: string }, []>(
            "SELECT source, cursor FROM sync_state WHERE source = 'simkl';"
          )
          .get();
        expect(row?.cursor).toBe("cursor_token_simkl");

        const migrationRows = reopenedDb
          .query<{ version: number }, []>(
            "SELECT version FROM schema_migrations;"
          )
          .all();
        expect(migrationRows).toHaveLength(2);
      } finally {
        reopenedDb.close();
      }
    });

    test("ingest_runs rejects invalid status via CHECK constraint", () => {
      expect(() => {
        fileDb.run(
          `INSERT INTO ingest_runs (source, started_at, status)
           VALUES ('mock_source', '2026-10-17T08:00:00.000Z', 'invalid_status');`
        );
      }).toThrow(/CHECK/i);
    });

    test("regular duplicate INSERT into events throws UNIQUE constraint error", () => {
      fileDb.run(
        `INSERT INTO events (
           record_hash, source, source_kind, source_id, media_type,
           started_at, ingested_at
         ) VALUES (
           'unique_hash_xyz', 'source_a', 'session', 'item_1', 'audiobook',
           '2026-10-17T08:00:00.000Z', '2026-10-17T08:01:00.000Z'
         );`
      );

      expect(() => {
        fileDb.run(
          `INSERT INTO events (
             record_hash, source, source_kind, source_id, media_type,
             started_at, ingested_at
           ) VALUES (
             'unique_hash_xyz', 'source_a', 'session', 'item_1', 'audiobook',
             '2026-10-17T08:00:00.000Z', '2026-10-17T08:02:00.000Z'
           );`
        );
      }).toThrow(/UNIQUE/i);
    });
  });
});
