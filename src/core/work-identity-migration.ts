import type { Migration } from "./db.ts";

// Kept separate from other workers' schema additions; manager must coordinate
// this version when merging parallel branches.
export const workIdentityMigration: Migration = {
  version: 14,
  name: "work_identity_aliases",
  up(db) {
    db.run(`CREATE TABLE work_key_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      old_key TEXT NOT NULL UNIQUE,
      new_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (old_key <> new_key)
    );`);
    db.run(`CREATE TRIGGER work_key_aliases_no_cycle BEFORE INSERT ON work_key_aliases
      BEGIN
        SELECT RAISE(ABORT, 'work key alias cycle') WHERE NEW.old_key IN (
          WITH RECURSIVE chain(key) AS (
            SELECT NEW.new_key
            UNION SELECT a.new_key FROM work_key_aliases a JOIN chain c ON a.old_key = c.key
          ) SELECT key FROM chain
        );
      END;`);
    for (const action of ["UPDATE", "DELETE"]) {
      db.run(`CREATE TRIGGER work_key_aliases_no_${action.toLowerCase()}
        BEFORE ${action} ON work_key_aliases BEGIN
        SELECT RAISE(ABORT, 'work_key_aliases is append-only'); END;`);
    }
    db.run("ALTER TABLE annotations ADD COLUMN work_key TEXT;");
    db.run("CREATE INDEX idx_annotations_work_key ON annotations(work_key);");
    db.run("DROP VIEW annotations_latest;");
    db.run(`CREATE VIEW annotations_latest AS SELECT * FROM annotations WHERE id IN (
      SELECT MAX(id) FROM annotations
      GROUP BY CASE WHEN work_key IS NULL THEN 'title' ELSE 'work' END,
        CASE WHEN work_key IS NULL THEN source ELSE work_key END,
        CASE WHEN work_key IS NULL THEN title ELSE '' END
    );`);
  },
};
