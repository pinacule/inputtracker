/**
 * Nightly backup: a dated SQLite snapshot (`VACUUM INTO`) plus the full JSON
 * export, written into the configured backup directory.
 *
 * Naming is fixed: `inputtracker-YYYY-MM-DD.db` and `…json`, where the date is
 * the UTC day of `now` (injectable so tests never depend on the wall clock).
 * Pruning only ever touches files that match exactly that pattern, keeping the
 * newest `keep` dates; anything else in the directory is left alone.
 *
 * `events` is append-only, so a backup only ever reads: `VACUUM INTO` copies the
 * database and `exportJson` reads every row of the archive.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJson } from "./export-json.ts";

/** Matches exactly the files this command writes; nothing else is touched. */
export const BACKUP_FILE_RE = /^inputtracker-(\d{4}-\d{2}-\d{2})\.(db|json)$/;

export interface BackupOptions {
  /** Directory the snapshot and export are written to (created if missing). */
  dir: string;
  /** Number of newest date sets to keep; older date sets are pruned. */
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
 * pattern (`notes.txt`, `inputtracker-latest.db`, …) are never touched.
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
  const keepCount = Number.isFinite(keep) ? Math.max(0, Math.trunc(keep)) : 0;
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

/**
 * Write a snapshot and a JSON export for today's UTC date, then prune old date
 * sets. Re-running on the same day overwrites that day's files.
 */
export function runBackup(db: Database, options: BackupOptions): BackupResult {
  const { dir, keep } = options;
  const date = backupDateStamp(options.now ?? new Date());

  mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, `inputtracker-${date}.db`);
  const jsonPath = join(dir, `inputtracker-${date}.json`);

  // `VACUUM INTO` refuses to overwrite an existing file. This is our own backup
  // file, so remove it first to make same-day reruns work.
  if (existsSync(dbPath)) {
    rmSync(dbPath);
  }
  db.run("VACUUM INTO ?", [dbPath]);
  writeFileSync(jsonPath, exportJson(db), "utf8");

  const pruned = pruneBackups(dir, keep);

  return { dbPath, jsonPath, pruned };
}
