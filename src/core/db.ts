import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { workIdentityMigration } from "./work-identity-migration.ts";

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
  {
    version: 2,
    name: "goals",
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_hash TEXT NOT NULL UNIQUE,
          goal_id TEXT NOT NULL,
          rev_id TEXT NOT NULL,
          year INTEGER NOT NULL,
          metric TEXT NOT NULL CHECK (metric IN ('items','hours','titles','active_days')),
          source TEXT,
          media_type TEXT,
          target REAL NOT NULL CHECK (target > 0),
          archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
          created_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_goals_goal_id
        ON goals (goal_id);
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS goals_no_update
        BEFORE UPDATE ON goals
        BEGIN
          SELECT RAISE(ABORT, 'goals is append-only');
        END;
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS goals_no_delete
        BEFORE DELETE ON goals
        BEGIN
          SELECT RAISE(ABORT, 'goals is append-only');
        END;
      `);

      db.run(`
        CREATE VIEW IF NOT EXISTS goals_latest AS
        SELECT *
        FROM goals
        WHERE id IN (
          SELECT MAX(id)
          FROM goals
          GROUP BY goal_id
        );
      `);
    },
  },
  {
    version: 3,
    name: "annotations",
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS annotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_hash TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          rev_id TEXT NOT NULL,
          rating INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 10)),
          note TEXT CHECK (note IS NULL OR length(note) <= 5000),
          created_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_annotations_source_title
        ON annotations (source, title);
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS annotations_no_update
        BEFORE UPDATE ON annotations
        BEGIN
          SELECT RAISE(ABORT, 'annotations is append-only');
        END;
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS annotations_no_delete
        BEFORE DELETE ON annotations
        BEGIN
          SELECT RAISE(ABORT, 'annotations is append-only');
        END;
      `);

      db.run(`
        CREATE VIEW IF NOT EXISTS annotations_latest AS
        SELECT *
        FROM annotations
        WHERE id IN (
          SELECT MAX(id)
          FROM annotations
          GROUP BY source, title
        );
      `);
    },
  },
  {
    version: 4,
    name: "archive_tombstones",
    up: (db: Database) => {
      db.run("DROP VIEW IF EXISTS events_latest;");
      db.run(`
        CREATE VIEW events_latest AS
        SELECT *
        FROM events
        WHERE id IN (
          SELECT MAX(id)
          FROM events
          GROUP BY source, source_kind, source_id
        )
        AND COALESCE(json_extract(raw, '$.deleted'), 0) = 0;
      `);
    },
  },
  {
    version: 5,
    name: "rating_tenths",
    up: (db: Database) => {
      db.run(`
        ALTER TABLE annotations
        ADD COLUMN rating_tenths INTEGER CHECK (rating_tenths IS NULL OR (rating_tenths BETWEEN 0 AND 100));
      `);
      db.run("DROP VIEW IF EXISTS annotations_latest;");
      db.run(`
        CREATE VIEW annotations_latest AS
        SELECT *
        FROM annotations
        WHERE id IN (
          SELECT MAX(id)
          FROM annotations
          GROUP BY source, title
        );
      `);
    },
  },
  {
    version: 6,
    name: "work_overrides",
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS work_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_hash TEXT NOT NULL UNIQUE,
          work_key TEXT NOT NULL,
          rev_id TEXT NOT NULL,
          title TEXT,
          category TEXT,
          status TEXT,
          rating_tenths INTEGER CHECK (rating_tenths IS NULL OR (rating_tenths BETWEEN 0 AND 100)),
          note TEXT CHECK (note IS NULL OR length(note) <= 5000),
          hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
          meta_provider TEXT,
          meta_id TEXT,
          meta_json TEXT,
          topic TEXT,
          created_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_work_overrides_work_key
        ON work_overrides (work_key);
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS work_overrides_no_update
        BEFORE UPDATE ON work_overrides
        BEGIN
          SELECT RAISE(ABORT, 'work_overrides is append-only');
        END;
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS work_overrides_no_delete
        BEFORE DELETE ON work_overrides
        BEGIN
          SELECT RAISE(ABORT, 'work_overrides is append-only');
        END;
      `);

      db.run(`
        CREATE VIEW IF NOT EXISTS work_overrides_latest AS
        SELECT *
        FROM work_overrides
        WHERE id IN (
          SELECT MAX(id)
          FROM work_overrides
          GROUP BY work_key
        );
      `);
    },
  },
  {
    version: 7,
    name: "youtube_enrichment_and_topics",
    up: (db: Database) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS youtube_videos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id TEXT NOT NULL,
          title TEXT,
          channel TEXT,
          channel_url TEXT,
          channel_id TEXT,
          thumbnail_url TEXT,
          genre TEXT,
          status TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'failed')),
          http_status INTEGER,
          retry_after TEXT,
          fetched_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_youtube_videos_video_id
        ON youtube_videos (video_id);
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS youtube_videos_no_update
        BEFORE UPDATE ON youtube_videos
        BEGIN
          SELECT RAISE(ABORT, 'youtube_videos is append-only');
        END;
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS youtube_videos_no_delete
        BEFORE DELETE ON youtube_videos
        BEGIN
          SELECT RAISE(ABORT, 'youtube_videos is append-only');
        END;
      `);

      db.run(`
        CREATE VIEW IF NOT EXISTS youtube_videos_latest AS
        SELECT *
        FROM youtube_videos
        WHERE id IN (
          SELECT MAX(id)
          FROM youtube_videos
          GROUP BY video_id
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS youtube_channel_topics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_hash TEXT NOT NULL UNIQUE,
          channel TEXT NOT NULL,
          normalized_channel TEXT NOT NULL,
          topic TEXT,
          created_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_youtube_channel_topics_norm
        ON youtube_channel_topics (normalized_channel);
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS youtube_channel_topics_no_update
        BEFORE UPDATE ON youtube_channel_topics
        BEGIN
          SELECT RAISE(ABORT, 'youtube_channel_topics is append-only');
        END;
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS youtube_channel_topics_no_delete
        BEFORE DELETE ON youtube_channel_topics
        BEGIN
          SELECT RAISE(ABORT, 'youtube_channel_topics is append-only');
        END;
      `);

      db.run(`
        CREATE VIEW IF NOT EXISTS youtube_channel_topics_latest AS
        SELECT *
        FROM youtube_channel_topics
        WHERE id IN (
          SELECT MAX(id)
          FROM youtube_channel_topics
          GROUP BY normalized_channel
        );
      `);
    },
  },
  {
    version: 8,
    name: "youtube_takeout_v8",
    up: (db: Database) => {
      db.run(`
        ALTER TABLE youtube_videos
        ADD COLUMN length_seconds INTEGER;
      `);

      db.run("DROP VIEW IF EXISTS youtube_videos_latest;");
      db.run(`
        CREATE VIEW youtube_videos_latest AS
        SELECT *
        FROM youtube_videos
        WHERE id IN (
          SELECT MAX(id)
          FROM youtube_videos
          GROUP BY video_id
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS youtube_favorites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_hash TEXT NOT NULL UNIQUE,
          video_id TEXT NOT NULL,
          added_at TEXT,
          created_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_youtube_favorites_video_id
        ON youtube_favorites (video_id);
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS youtube_favorites_no_update
        BEFORE UPDATE ON youtube_favorites
        BEGIN
          SELECT RAISE(ABORT, 'youtube_favorites is append-only');
        END;
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS youtube_favorites_no_delete
        BEFORE DELETE ON youtube_favorites
        BEGIN
          SELECT RAISE(ABORT, 'youtube_favorites is append-only');
        END;
      `);

      db.run(`
        CREATE VIEW IF NOT EXISTS youtube_favorites_latest AS
        SELECT *
        FROM youtube_favorites
        WHERE id IN (
          SELECT MAX(id)
          FROM youtube_favorites
          GROUP BY video_id
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS youtube_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_hash TEXT NOT NULL UNIQUE,
          channel_id TEXT NOT NULL,
          channel_url TEXT,
          channel_title TEXT,
          created_at TEXT NOT NULL
        );
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_youtube_subscriptions_channel_id
        ON youtube_subscriptions (channel_id);
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS youtube_subscriptions_no_update
        BEFORE UPDATE ON youtube_subscriptions
        BEGIN
          SELECT RAISE(ABORT, 'youtube_subscriptions is append-only');
        END;
      `);

      db.run(`
        CREATE TRIGGER IF NOT EXISTS youtube_subscriptions_no_delete
        BEFORE DELETE ON youtube_subscriptions
        BEGIN
          SELECT RAISE(ABORT, 'youtube_subscriptions is append-only');
        END;
      `);

      db.run(`
        CREATE VIEW IF NOT EXISTS youtube_subscriptions_latest AS
        SELECT *
        FROM youtube_subscriptions
        WHERE id IN (
          SELECT MAX(id)
          FROM youtube_subscriptions
          GROUP BY channel_id
        );
      `);
    },
  },
  workIdentityMigration,
  {
    version: 15,
    name: "work_override_times",
    up: (db: Database) => {
      // How many times the work was watched/read/played; display only, never time.
      db.run(`
        ALTER TABLE work_overrides
        ADD COLUMN times INTEGER CHECK (times IS NULL OR (times BETWEEN 0 AND 999));
      `);
      db.run("DROP VIEW IF EXISTS work_overrides_latest;");
      db.run(`
        CREATE VIEW work_overrides_latest AS
        SELECT *
        FROM work_overrides
        WHERE id IN (
          SELECT MAX(id)
          FROM work_overrides
          GROUP BY work_key
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
