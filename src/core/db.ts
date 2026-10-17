import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS ingest_runs (
          id INTEGER PRIMARY KEY,
          source TEXT NOT NULL,
          kind TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('running', 'ok', 'failed')),
          rows_seen INTEGER DEFAULT 0,
          rows_inserted INTEGER DEFAULT 0,
          error TEXT
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_hash TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          external_ids TEXT,
          media_type TEXT NOT NULL,
          title TEXT,
          parent_title TEXT,
          season INTEGER,
          episode INTEGER,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_seconds REAL,
          progress REAL,
          device TEXT,
          raw TEXT,
          ingested_at TEXT NOT NULL,
          ingest_run_id INTEGER REFERENCES ingest_runs(id)
        );
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_events_source_lookup
        ON events (source, source_kind, source_id);
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_events_started_at
        ON events (started_at);
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS events_no_update
        BEFORE UPDATE ON events
        BEGIN
          SELECT RAISE(ABORT, 'events is append-only');
        END;
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS events_no_delete
        BEFORE DELETE ON events
        BEGIN
          SELECT RAISE(ABORT, 'events is append-only');
        END;
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS sync_state (
          source TEXT PRIMARY KEY,
          cursor TEXT,
          updated_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE VIEW IF NOT EXISTS events_latest AS
        SELECT *
        FROM events
        WHERE id IN (
          SELECT MAX(id)
          FROM events
          GROUP BY source, source_kind, source_id
        );
      `);
    },
  },
];

export function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .query<{ version: number }, []>(
      "SELECT version FROM schema_migrations ORDER BY version ASC;"
    )
    .all();
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of sortedMigrations) {
    if (!appliedVersions.has(migration.version)) {
      const applyTx = db.transaction(() => {
        migration.up(db);
        db.run(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);",
          [migration.version, new Date().toISOString()]
        );
      });
      applyTx();
    }
  }
}

export function openDb(path: string): Database {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && dir !== "." && dir !== "") {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 5000;");
  migrate(db);

  return db;
}
