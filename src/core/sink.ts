/**
 * Sink abstraction: where mapped `NewEvent`s go.
 *
 * v1 has a single sink, `LocalDbSink`, which writes to the local SQLite
 * database through `insertEvents` (`INSERT OR IGNORE` on `record_hash`).
 * Later a remote sink (HTTP `POST /api/ingest`) can implement the same
 * interface without changing any source module.
 */

import type { Database } from "bun:sqlite";
import { insertEvents, type NewEvent } from "./events.ts";

export interface SinkRunInfo {
  source: string;
  /**
   * Ingest run id when known. `LocalDbSink` stamps inserted rows with it so
   * every event can be traced back to the run that produced it.
   */
  runId?: number | null;
}

export interface SinkWriteResult {
  seen: number;
  inserted: number;
}

export interface Sink {
  write(
    events: NewEvent[],
    run: SinkRunInfo
  ): SinkWriteResult | Promise<SinkWriteResult>;
}

/**
 * Sink that writes events into the local database. Insertion is idempotent
 * (dedup on `record_hash`) and transactional, so a failure writes nothing.
 */
export class LocalDbSink implements Sink {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  write(events: NewEvent[], run: SinkRunInfo): SinkWriteResult {
    return insertEvents(this.db, run.runId ?? null, events);
  }
}
