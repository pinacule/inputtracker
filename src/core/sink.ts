/**
 * Sink abstraction: where mapped `NewEvent`s go.
 *
 * `LocalDbSink` writes to SQLite through `insertEvents`; `HttpSink` pushes
 * the same mapped records to `POST /api/ingest/events` for cloud deployments.
 */

import type { Database } from "bun:sqlite";
import { insertEvents, type NewEvent } from "./events.ts";
import { MAX_EVENT_BATCH, MAX_EVENT_BODY_BYTES } from "./ingest-events.ts";
import type { PushConfig } from "./config.ts";

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

/** No redirects: never forward the bearer token to another host. */
export class HttpSink implements Sink {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: PushConfig, fetchFn: typeof fetch = fetch) {
    try {
      const url = new URL(config.server_url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      this.url = `${url.href.replace(/\/$/, "")}/api/ingest/events`;
    } catch { throw new Error("Invalid push server URL"); }
    if (config.token.length < 32 || /[\s\x00-\x1f\x7f]/.test(config.token)) throw new Error("Push token is not configured");
    this.token = config.token;
    this.fetchFn = fetchFn;
  }

  async write(events: NewEvent[], _run: SinkRunInfo): Promise<SinkWriteResult> {
    // Build every batch before sending: oversized single events cannot strand a cursor.
    const batches: NewEvent[][] = [];
    let batch: NewEvent[] = [];
    for (const event of events) {
      const candidate = [...batch, event];
      if (candidate.length > MAX_EVENT_BATCH || Buffer.byteLength(JSON.stringify({ events: candidate })) > MAX_EVENT_BODY_BYTES) {
        if (!batch.length) throw new Error("Push event too large");
        batches.push(batch);
        batch = [];
      }
      batch.push(event);
      if (Buffer.byteLength(JSON.stringify({ events: batch })) > MAX_EVENT_BODY_BYTES) throw new Error("Push event too large");
    }
    batches.push(batch); // Empty batches still confirm server reachability before cursor advance.
    let inserted = 0;
    for (const events of batches) {
      try {
        const response = await this.fetchFn(this.url, { method: "POST", redirect: "error",
          signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ events }) });
        if (response.status !== 200) throw new Error();
        const body: unknown = await response.json();
        if (!body || typeof body !== "object") throw new Error();
        const ack = body as { accepted?: unknown; inserted?: unknown };
        if (ack.accepted !== events.length || typeof ack.inserted !== "number" || !Number.isInteger(ack.inserted) || ack.inserted < 0 || ack.inserted > events.length) throw new Error();
        inserted += ack.inserted;
      } catch { throw new Error("ActivityWatch push failed: server unreachable or batch not acknowledged"); }
    }
    return { seen: events.length, inserted };
  }
}
