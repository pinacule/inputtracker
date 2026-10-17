/**
 * Full-archive JSON export.
 *
 * Reads every row of `events` — the append-only archive, *not* the
 * `events_latest` view — ordered by `id`, and serializes the canonical
 * `inputtracker-export` envelope documented in PLAN.md:
 *
 *   { "format": "inputtracker-export", "version": 1, "events": [ ...all columns... ] }
 *
 * Timestamps are written exactly as stored (UTC ISO 8601) and the
 * `external_ids` / `raw` JSON columns stay as the stored JSON strings.
 */

import type { Database } from "bun:sqlite";
import type { EventRow } from "../core/schema.ts";

export const EXPORT_FORMAT = "inputtracker-export";
export const EXPORT_VERSION = 1;

/**
 * Every column of `EventRow`, in schema order. Used as the CSV header and to
 * guarantee both exports carry exactly the same columns.
 */
export const EVENT_COLUMNS = [
  "id",
  "record_hash",
  "source",
  "source_kind",
  "source_id",
  "external_ids",
  "media_type",
  "title",
  "parent_title",
  "season",
  "episode",
  "started_at",
  "ended_at",
  "duration_seconds",
  "progress",
  "device",
  "raw",
  "ingested_at",
  "ingest_run_id",
] as const;

export type EventColumn = (typeof EVENT_COLUMNS)[number];

export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  events: EventRow[];
}

/** Read every event row, oldest first (`ORDER BY id`). */
export function selectAllEvents(db: Database): EventRow[] {
  return db.query<EventRow, []>("SELECT * FROM events ORDER BY id ASC;").all();
}

/** Number of rows in the full `events` archive. */
export function countEvents(db: Database): number {
  const row = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
    .get();
  return row?.n ?? 0;
}

/** Serialize the whole `events` archive as JSON. */
export function exportJson(db: Database): string {
  const envelope: ExportEnvelope = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    events: selectAllEvents(db),
  };
  return JSON.stringify(envelope, null, 2);
}
