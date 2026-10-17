/**
 * Audiobookshelf sync: fetch → map → sink.
 *
 * Flow: `startRun` → fetch sessions + `/api/me` + `/api/me/listening-stats`
 * → `mapAll` → `sink.write` (idempotent `INSERT OR IGNORE`) → `finishRun(ok)`
 * → advance the cursor in `sync_state`.
 *
 * The cursor (max session `updatedAt`) is an optimisation only: this module
 * always refetches every session, so dropping or losing the cursor can never
 * cause data loss or duplicates. It is written **only** after a fully
 * successful run.
 *
 * On any error the run is recorded as `failed` with a redacted message, no
 * events are written, the cursor is left untouched, and a `SyncFailedError`
 * (so the CLI can exit 2) is thrown.
 */

import type { Database } from "bun:sqlite";
import { redact, redactString, type Config } from "../../core/config.ts";
import { finishRun, startRun } from "../../core/events.ts";
import type { Sink } from "../../core/sink.ts";
import type { AbsClient } from "./client.ts";
import {
  mapAll,
  type AbsListeningStats,
  type AbsMeResponse,
  type AbsSession,
} from "./map.ts";

export const ABS_SOURCE = "audiobookshelf";
export const ABS_SYNC_KIND = "sync";

/** The subset of the ABS client the sync needs (easy to fake in tests). */
export type SyncClient = Pick<AbsClient, "getAllSessions" | "get">;

export interface SyncAbsDeps {
  client: SyncClient;
  sink: Sink;
  db: Database;
  /** Used only to redact the failure text stored on `ingest_runs`. */
  config?: Config;
  /** Injectable clock for the `sync_state.updated_at` stamp. */
  now?: () => Date;
}

export interface AbsSyncResult {
  runId: number;
  seen: number;
  inserted: number;
}

/**
 * Typed failure result thrown by `syncAudiobookshelf`. Its `message` is already
 * redacted, so it is safe to print or store.
 */
export class SyncFailedError extends Error {
  readonly source: string;
  readonly runId: number;

  constructor(message: string, opts: { source: string; runId: number }) {
    super(message);
    this.name = "SyncFailedError";
    this.source = opts.source;
    this.runId = opts.runId;
  }
}

function redactErrorText(err: unknown, config?: Config): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.trim() !== "" ? raw : String(err);
  return config ? redactString(message, config) : redact(message);
}

/**
 * Largest finite session `updatedAt` as a string, or `null` when there is none.
 */
function maxUpdatedAt(sessions: AbsSession[]): string | null {
  let max = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    const updatedAt = session?.updatedAt;
    if (
      typeof updatedAt === "number" &&
      Number.isFinite(updatedAt) &&
      updatedAt > max
    ) {
      max = updatedAt;
    }
  }
  return Number.isFinite(max) ? String(max) : null;
}

function advanceCursor(
  db: Database,
  sessions: AbsSession[],
  now?: () => Date
): void {
  const cursor = maxUpdatedAt(sessions);
  const updatedAt = (now ? now() : new Date()).toISOString();
  db.run(
    `INSERT INTO sync_state (source, cursor, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE
       SET cursor = excluded.cursor, updated_at = excluded.updated_at;`,
    [ABS_SOURCE, cursor, updatedAt]
  );
}

/**
 * Run one Audiobookshelf sync. Returns the run id and the row counts.
 * Throws `SyncFailedError` (after recording a failed run) on any failure.
 */
export async function syncAudiobookshelf(
  deps: SyncAbsDeps
): Promise<AbsSyncResult> {
  const { client, sink, db, config, now } = deps;
  const runId = startRun(db, ABS_SOURCE, ABS_SYNC_KIND);

  let seen = 0;
  let inserted = 0;

  try {
    const sessions = await client.getAllSessions<AbsSession>();
    const me = await client.get<AbsMeResponse>("/api/me");
    const stats = await client.get<AbsListeningStats>("/api/me/listening-stats");

    const events = mapAll({ sessions, me, stats });
    const result = await sink.write(events, { source: ABS_SOURCE, runId });
    seen = result.seen;
    inserted = result.inserted;

    finishRun(db, runId, {
      status: "ok",
      rowsSeen: seen,
      rowsInserted: inserted,
    });

    // Success only: the cursor may be lost/deleted without harm.
    advanceCursor(db, sessions, now);
  } catch (err) {
    const message = redactErrorText(err, config);
    try {
      finishRun(db, runId, {
        status: "failed",
        rowsSeen: 0,
        rowsInserted: 0,
        error: message,
      });
    } catch {
      // Never let recording the failure mask the original error.
    }
    throw new SyncFailedError(message, { source: ABS_SOURCE, runId });
  }

  return { runId, seen, inserted };
}
