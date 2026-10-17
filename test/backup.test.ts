import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import {
  BACKUP_FILE_RE,
  backupDateStamp,
  pruneBackups,
  runBackup,
} from "../src/io/backup.ts";

// --- synthetic seeding ----------------------------------------------------

/** Insert one synthetic event with an explicit hash (no real data). */
function insertEvent(db: Database, hash: string): void {
  db.run(
    `INSERT INTO events
       (record_hash, source, source_kind, source_id, media_type, title, started_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      hash,
      "manual",
      "manual",
      `src-${hash}`,
      "other",
      `Synthetic ${hash}`,
      "2026-10-17T08:15:00.000Z",
      "2026-10-17T08:16:00.000Z",
    ]
  );
}

function countEvents(db: Database): number {
  return (
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;").get()?.n ?? 0
  );
}

/** A fixed UTC date, midnight, `day` days into March 2026. */
function marchDay(day: number): Date {
  return new Date(Date.UTC(2026, 2, day, 0, 0, 0));
}

// --- runBackup ------------------------------------------------------------

describe("runBackup", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "it-backup-"));
  });

  afterEach(() => {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("date stamp is the UTC day of `now`", () => {
    expect(backupDateStamp(new Date("2026-03-04T23:59:59.000Z"))).toBe("2026-03-04");
    expect(backupDateStamp(new Date("2026-03-05T00:00:00.000Z"))).toBe("2026-03-05");
  });

  test("16 daily runs keep the newest 14 date sets (28 files)", () => {
    const db = openDb(":memory:");
    insertEvent(db, "evt-1");

    let lastPruned: string[] = [];
    for (let day = 1; day <= 16; day += 1) {
      const result = runBackup(db, { dir, keep: 14, now: marchDay(day) });
      lastPruned = result.pruned;
    }

    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(28);

    // Every kept date has a .db and a .json.
    for (let day = 3; day <= 16; day += 1) {
      const stamp = `2026-03-${String(day).padStart(2, "0")}`;
      expect(files).toContain(`inputtracker-${stamp}.db`);
      expect(files).toContain(`inputtracker-${stamp}.json`);
    }

    // The two oldest date sets are gone.
    expect(files).not.toContain("inputtracker-2026-03-01.db");
    expect(files).not.toContain("inputtracker-2026-03-01.json");
    expect(files).not.toContain("inputtracker-2026-03-02.db");
    expect(files).not.toContain("inputtracker-2026-03-02.json");

    // The final run pruned the second-oldest set (two files).
    expect(lastPruned).toEqual([
      join(dir, "inputtracker-2026-03-02.db"),
      join(dir, "inputtracker-2026-03-02.json"),
    ]);

    db.close();
  });

  test("unrelated and near-miss files are never touched", () => {
    const db = openDb(":memory:");
    insertEvent(db, "evt-1");

    const unrelated = [
      "notes.txt",
      "inputtracker-latest.db",
      "other-2026-01-01.json",
      "inputtracker-2026-03-01.bak",
      "inputtracker-20260301.db",
      // A `.tmp` suffix that is *not* one of the temp names this run writes is
      // unrelated and must survive, like any other near-miss file.
      "inputtracker-latest.db.tmp",
    ];
    for (const name of unrelated) {
      writeFileSync(join(dir, name), "keep me");
    }

    for (let day = 1; day <= 16; day += 1) {
      runBackup(db, { dir, keep: 14, now: marchDay(day) });
    }

    for (const name of unrelated) {
      expect(existsSync(join(dir, name))).toBe(true);
      expect(readFileSync(join(dir, name), "utf8")).toBe("keep me");
    }

    db.close();
  });

  test("snapshot opens with the same events row count and JSON matches", () => {
    const db = openDb(":memory:");
    insertEvent(db, "evt-1");
    insertEvent(db, "evt-2");
    insertEvent(db, "evt-3");

    const result = runBackup(db, { dir, keep: 14, now: marchDay(4) });

    const snapshot = new Database(result.dbPath, { readonly: true });
    expect(countEvents(snapshot)).toBe(3);
    snapshot.close();

    const parsed = JSON.parse(readFileSync(result.jsonPath, "utf8")) as {
      events: unknown[];
    };
    expect(parsed.events).toHaveLength(3);

    db.close();
  });

  test("same-day rerun overwrites the snapshot without error", () => {
    const db = openDb(":memory:");
    insertEvent(db, "evt-1");

    const now = marchDay(4);
    const first = runBackup(db, { dir, keep: 14, now });

    // Another row arrives, then the same day's backup runs again.
    insertEvent(db, "evt-2");
    const second = runBackup(db, { dir, keep: 14, now });

    expect(second.dbPath).toBe(first.dbPath);
    expect(readdirSync(dir).filter((name) => BACKUP_FILE_RE.test(name))).toHaveLength(2);

    const snapshot = new Database(second.dbPath, { readonly: true });
    expect(countEvents(snapshot)).toBe(2);
    snapshot.close();

    db.close();
  });

  test("a failing same-day rerun keeps the previous snapshot and export", () => {
    const db = openDb(":memory:");
    insertEvent(db, "evt-1");

    const now = marchDay(4);
    const first = runBackup(db, { dir, keep: 14, now });
    const dbBefore = readFileSync(first.dbPath);
    const jsonBefore = readFileSync(first.jsonPath, "utf8");

    // Simulate the DB work that follows failing, e.g. a `VACUUM INTO` error.
    insertEvent(db, "evt-2");
    const realRun = db.run.bind(db);
    (db as unknown as { run: unknown }).run = () => {
      throw new Error("synthetic VACUUM failure");
    };

    expect(() => runBackup(db, { dir, keep: 14, now })).toThrow("synthetic VACUUM failure");

    (db as unknown as { run: unknown }).run = realRun;

    // The old same-day files are byte-for-byte unchanged...
    expect(readFileSync(first.dbPath).equals(dbBefore)).toBe(true);
    expect(readFileSync(first.jsonPath, "utf8")).toBe(jsonBefore);
    // ...and no `.tmp` debris is left behind.
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    db.close();
  });

  test("keep: 0 still keeps the newest date set", () => {
    const db = openDb(":memory:");
    insertEvent(db, "evt-1");

    for (let day = 1; day <= 3; day += 1) {
      runBackup(db, { dir, keep: 0, now: marchDay(day) });
    }

    // Only the just-written set survives; older sets were pruned.
    expect(readdirSync(dir).sort()).toEqual([
      "inputtracker-2026-03-03.db",
      "inputtracker-2026-03-03.json",
    ]);

    db.close();
  });

  test("leftover temp files are cleaned up before writing", () => {
    const db = openDb(":memory:");
    insertEvent(db, "evt-1");

    const stamp = "2026-03-04";
    const dbTmp = join(dir, `inputtracker-${stamp}.db.tmp`);
    const jsonTmp = join(dir, `inputtracker-${stamp}.json.tmp`);
    writeFileSync(dbTmp, "half-written snapshot");
    writeFileSync(jsonTmp, "half-written export");

    const result = runBackup(db, { dir, keep: 14, now: marchDay(4) });

    expect(existsSync(dbTmp)).toBe(false);
    expect(existsSync(jsonTmp)).toBe(false);

    const snapshot = new Database(result.dbPath, { readonly: true });
    expect(countEvents(snapshot)).toBe(1);
    snapshot.close();

    db.close();
  });
});

// --- pruning pattern ------------------------------------------------------

describe("pruneBackups", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "it-backup-prune-"));
  });

  afterEach(() => {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pattern matches only dated .db/.json backups, never .tmp", () => {
    expect(BACKUP_FILE_RE.test("inputtracker-2026-03-01.db")).toBe(true);
    expect(BACKUP_FILE_RE.test("inputtracker-2026-03-01.json")).toBe(true);
    expect(BACKUP_FILE_RE.test("inputtracker-2026-03-01.db.tmp")).toBe(false);
    expect(BACKUP_FILE_RE.test("inputtracker-2026-03-01.json.tmp")).toBe(false);
    expect(BACKUP_FILE_RE.test("inputtracker-latest.db")).toBe(false);
    expect(BACKUP_FILE_RE.test("notes.txt")).toBe(false);
  });

  test("prunes only stale date sets, leaving .tmp and unrelated files", () => {
    const files = [
      "inputtracker-2026-02-01.db",
      "inputtracker-2026-03-01.db",
      "inputtracker-2026-03-01.json",
      "inputtracker-2026-03-01.db.tmp",
      "inputtracker-2026-03-01.json.tmp",
      "inputtracker-latest.db",
      "notes.txt",
    ];
    for (const name of files) {
      writeFileSync(join(dir, name), "synthetic");
    }

    const pruned = pruneBackups(dir, 1);

    expect(pruned).toEqual([join(dir, "inputtracker-2026-02-01.db")]);
    for (const name of files) {
      if (name === "inputtracker-2026-02-01.db") {
        expect(existsSync(join(dir, name))).toBe(false);
      } else {
        expect(existsSync(join(dir, name))).toBe(true);
      }
    }
  });
});

// --- CLI backup -----------------------------------------------------------

describe("CLI backup", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "it-backup-cli-"));
  });

  afterEach(() => {
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes a snapshot + export and prints one line, exit 0", async () => {
    const db = openDb(":memory:");
    insertEvent(db, "evt-1");

    const config = {
      storage: { db_path: ":memory:", backup_dir: dir, backup_keep: 14 },
    } as unknown as Config;

    let outText = "";
    let errText = "";
    const now = marchDay(4);

    const code = await runCli(["backup"], {
      loadConfig: () => config,
      openDb: () => db,
      now,
      out: (line) => {
        outText += `${line}\n`;
      },
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    const dbPath = join(dir, "inputtracker-2026-03-04.db");
    const jsonPath = join(dir, "inputtracker-2026-03-04.json");

    expect(code).toBe(0);
    expect(errText).toBe("");
    expect(outText).toBe(
      `backup written: ${dbPath}, ${jsonPath}; pruned 0 files\n`
    );
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
  });

  test("rejects unknown options with usage and exit 1", async () => {
    let errText = "";
    const code = await runCli(["backup", "--bogus"], {
      out: () => {},
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(1);
    expect(errText).toContain("Unknown option: --bogus");
    expect(errText).toContain("Usage: it");
  });

  test("usage lists the backup command", async () => {
    let outText = "";
    const code = await runCli(["--help"], {
      out: (line) => {
        outText += `${line}\n`;
      },
      err: () => {},
    });

    expect(code).toBe(0);
    expect(outText).toContain("backup");
  });
});
