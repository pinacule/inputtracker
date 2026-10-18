/**
 * Full-archive JSON export.
 *
 * Reads every row of `events`, `goals` and `annotations` — the append-only
 * archives, *not* the `*_latest` views — ordered by `id`, and serializes the
 * canonical `inputtracker-export` envelope documented in DATA_FORMAT.md:
 *
 *   {
 *     "format": "inputtracker-export",
 *     "version": 2,
 *     "events": [ ...all columns... ],
 *     "goals": [ ...all columns... ],
 *     "annotations": [ ...all columns... ]
 *   }
 *
 * Timestamps are written exactly as stored (UTC ISO 8601) and the
 * `external_ids` / `raw` JSON columns stay as the stored JSON strings.
 */

import type { Database } from "bun:sqlite";
import type { AnnotationRow, EventRow, GoalRow } from "../core/schema.ts";

export const EXPORT_FORMAT = "inputtracker-export";
export const EXPORT_VERSION = 2;

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
  goals: GoalRow[];
  annotations: AnnotationRow[];
}

/** Read every event row, oldest first (`ORDER BY id`). */
export function selectAllEvents(db: Database): EventRow[] {
  return db.query<EventRow, []>("SELECT * FROM events ORDER BY id ASC;").all();
}

/** Read every goal row, oldest first (`ORDER BY id`). */
export function selectAllGoals(db: Database): GoalRow[] {
  return db.query<GoalRow, []>("SELECT * FROM goals ORDER BY id ASC;").all();
}

/** Read every annotation row, oldest first (`ORDER BY id`). */
export function selectAllAnnotations(db: Database): AnnotationRow[] {
  return db.query<AnnotationRow, []>("SELECT * FROM annotations ORDER BY id ASC;").all();
}

/** Number of rows in the full `events` archive. */
export function countEvents(db: Database): number {
  const row = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
    .get();
  return row?.n ?? 0;
}

/** Serialize the whole archive as JSON: events, goals and annotations. */
export function exportJson(db: Database): string {
  const envelope: ExportEnvelope = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    events: selectAllEvents(db),
    goals: selectAllGoals(db),
    annotations: selectAllAnnotations(db),
  };
  return JSON.stringify(envelope, null, 2);
}
