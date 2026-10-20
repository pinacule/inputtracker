import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "../../core/config.ts";

export function pushStatePath(config: Config): string {
  return join(dirname(config.storage.db_path), "activitywatch-push-state.json");
}

/** Only cursor/notification metadata. Never opens the PC's cold archive. */
export function loadPushState(db: Database, path: string): void {
  if (!existsSync(path)) return;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Invalid ActivityWatch push state file"); }
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { state?: unknown }).state)) throw new Error("Invalid ActivityWatch push state file");
  for (const row of (value as { state: unknown[] }).state) {
    if (!row || typeof row !== "object") throw new Error("Invalid ActivityWatch push state file");
    const { source, cursor, updated_at } = row as { source?: unknown; cursor?: unknown; updated_at?: unknown };
    if (typeof source !== "string" || (!source.startsWith("activitywatch:") && source !== "notify:activitywatch") || typeof cursor !== "string" || typeof updated_at !== "string" || !Number.isFinite(Date.parse(updated_at)) ||
      (source !== "notify:activitywatch" && (!Number.isFinite(Date.parse(cursor)) || new Date(cursor).toISOString() !== cursor))) throw new Error("Invalid ActivityWatch push state file");
    db.run("INSERT INTO sync_state(source, cursor, updated_at) VALUES (?, ?, ?);", [source, cursor, updated_at]);
  }
}

export function savePushState(db: Database, path: string): void {
  const state = db.query<{ source: string; cursor: string; updated_at: string }, []>(
    "SELECT source, cursor, updated_at FROM sync_state ORDER BY source;"
  ).all();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, state }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

/** Exclusive process lock, released even on failure; dead owners can be retried. */
export function lockPushState(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  try {
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw new Error("Cannot lock ActivityWatch push state");
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("ActivityWatch push state is locked");
    try { process.kill(pid, 0); } catch (caught) {
      if ((caught as { code?: string }).code === "ESRCH") {
        unlinkSync(lock);
        return lockPushState(path);
      }
    }
    throw new Error("ActivityWatch push is already running");
  }
  return () => unlinkSync(lock);
}
