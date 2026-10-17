/**
 * Nightly backup: a dated SQLite snapshot (`VACUUM INTO`) plus the full JSON
 * export, written into the configured backup directory.
 *
 * Naming is fixed: `inputtracker-YYYY-MM-DD.db` and `…json`, where the date is
 * the UTC day of `now` (injectable so tests never depend on the wall clock).
 * Pruning only ever touches files that match exactly that pattern, keeping the
 * newest `keep` dates (at least one); anything else in the directory is left
 * alone.
 *
 * Both artifacts are first written next to the final name with a `.tmp` suffix
 * and only renamed into place once fully written. A failed run therefore never
 * clobbers the same day's existing backup, and any leftover `.tmp` is removed
 * before a retry and again if the run fails.
 *
 * `events` is append-only, so a backup only ever reads: `VACUUM INTO` copies the
 * database and `exportJson` reads every row of the archive.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJson } from "./export-json.ts";

/** Matches exactly the files this command writes; nothing else is touched. */
export const BACKUP_FILE_RE = /^inputtracker-(\d{4}-\d{2}-\d{2})\.(db|json)$/;

export interface BackupOptions {
  /** Directory the snapshot and export are written to (created if missing). */
  dir: string;
  /** Number of newest date sets to keep (clamped to at least 1). */
  keep: number;
  /** Timestamp the date stamp is taken from; defaults to the current time. */
  now?: Date;
}

export interface BackupResult {
  dbPath: string;
  jsonPath: string;
  /** Absolute paths of the files removed by pruning, sorted. */
  pruned: string[];
}

/** `YYYY-MM-DD` in UTC. */
export function backupDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Delete every file in `dir` that matches {@link BACKUP_FILE_RE} and belongs to
 * a date older than the newest `keep` dates. Files that do not match the
 * pattern (`notes.txt`, `inputtracker-latest.db`, a `.tmp` left behind by an
 * interrupted run, …) are never touched.
 *
 * `keep` is clamped to at least 1 so the set that was just written is never
 * pruned away by a `0`, negative or nonsensical value.
 */
export function pruneBackups(dir: string, keep: number): string[] {
  const byDate = new Map<string, string[]>();

  for (const name of readdirSync(dir)) {
    const match = BACKUP_FILE_RE.exec(name);
    if (match === null) {
      continue;
    }
    const date = match[1] as string;
    const files = byDate.get(date);
    if (files === undefined) {
      byDate.set(date, [join(dir, name)]);
    } else {
      files.push(join(dir, name));
    }
  }

  // ISO dates sort lexicographically, so a plain ascending sort is oldest first.
  const dates = [...byDate.keys()].sort();
  const keepCount = Number.isFinite(keep) ? Math.max(1, Math.trunc(keep)) : 1;
  const removeCount = Math.max(0, dates.length - keepCount);
  const stale = dates.slice(0, removeCount);

  const pruned: string[] = [];
  for (const date of stale) {
    for (const file of byDate.get(date) as string[]) {
      rmSync(file);
      pruned.push(file);
    }
  }

  pruned.sort();
  return pruned;
}

/** Remove a path if present; used to clear partially written temp files. */
function removeIfExists(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Write a snapshot and a JSON export for today's UTC date, then prune old date
 * sets. Re-running on the same day replaces that day's files.
 *
 * The snapshot and export are written to `.tmp` siblings and renamed over the
 * final names only after both are complete, so a failed rerun (for example a
 * failing `VACUUM INTO`) leaves the previous same-day files untouched.
 */
export function runBackup(db: Database, options: BackupOptions): BackupResult {
  const { dir, keep } = options;
  const date = backupDateStamp(options.now ?? new Date());

  mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, `inputtracker-${date}.db`);
  const jsonPath = join(dir, `inputtracker-${date}.json`);
  const dbTmpPath = `${dbPath}.tmp`;
  const jsonTmpPath = `${jsonPath}.tmp`;

  // Clear leftovers from an earlier failed run before we start.
  removeIfExists(dbTmpPath);
  removeIfExists(jsonTmpPath);

  try {
    // `VACUUM INTO` refuses to overwrite an existing file; the temp path was
    // just cleared, so this always writes a fresh snapshot.
    db.run("VACUUM INTO ?", [dbTmpPath]);
    writeFileSync(jsonTmpPath, exportJson(db), "utf8");

    // Both temp files are complete: swap them into place. Renaming over the
    // final names keeps the existing files intact if anything above throws.
    renameSync(dbTmpPath, dbPath);
    renameSync(jsonTmpPath, jsonPath);
  } catch (caught) {
    removeIfExists(dbTmpPath);
    removeIfExists(jsonTmpPath);
    throw caught;
  }

  const pruned = pruneBackups(dir, keep);

  return { dbPath, jsonPath, pruned };
}
