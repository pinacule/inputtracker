/**
 * Manual entry: let the user record a consumed item by hand (a movie watched,
 * a book read, …) as an append-only `events` row.
 *
 * The user always types a **local** wall-clock time (e.g. `2026-10-17 21:30`
 * in the configured timezone). `localToUtcIso` turns that into the UTC ISO
 * string that is stored in `events`; an input that already carries `Z` or an
 * explicit numeric offset is respected as-is.
 *
 * Everything here is synthetic-test friendly: `newId` is injectable so tests
 * can pin `source_id` instead of relying on `crypto.randomUUID()`.
 */

import type { Database } from "bun:sqlite";
import {
  finishRun,
  insertEvents,
  startRun,
  VALID_MEDIA_TYPES,
  type MediaType,
  type NewEvent,
} from "../core/events.ts";
import { localToUtcIso, toUtcIso } from "../core/time.ts";

export { localToUtcIso } from "../core/time.ts";

/** `events.source` for rows written by manual entry. */
export const MANUAL_SOURCE = "manual";
/** `events.source_kind` for rows written by manual entry. */
export const MANUAL_SOURCE_KIND = "history_item";

/** Accepted shape of an optional `client_id` (case-insensitive UUID). */
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ManualInput {
  media_type: MediaType;
  title: string;
  parent_title?: string | null;
  season?: number | null;
  episode?: number | null;
  /** Local wall-clock time in the configured timezone (or explicit offset/Z). */
  started_at: string;
  /** Local wall-clock time in the configured timezone (or explicit offset/Z). */
  ended_at?: string | null;
  duration_seconds?: number | null;
  progress?: number | null;
  device?: string | null;
  external_ids?: Record<string, unknown> | null;
  /**
   * Optional idempotency key from a client (e.g. the offline queue on a
   * phone). When present it becomes the row's `source_id` as
   * `client:<uuid in lowercase>`, so re-sending the exact same body — a retry
   * after a lost response — is a no-op instead of a second row.
   */
  client_id?: string | null;
}

export interface ManualOptions {
  /** Override the generated `source_id` (defaults to `crypto.randomUUID()`). */
  newId?: () => string;
}

export interface ManualResult {
  /** `source_id` of the row that was (or would have been) written. */
  id: string;
  /** 1 on insert, 0 when the exact same row already existed. */
  inserted: number;
  /** Id of the `ingest_runs` row written for this entry. */
  runId: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- validation ------------------------------------------------------------

function optionalString(
  field: string,
  value: unknown,
  problems: string[]
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    problems.push(`${field} must be a string`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalInteger(
  field: string,
  value: unknown,
  problems: string[]
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    problems.push(`${field} must be a finite number`);
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    problems.push(`${field} must be an integer >= 0`);
    return null;
  }
  return value;
}

function optionalNumber(
  field: string,
  value: unknown,
  problems: string[]
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    problems.push(`${field} must be a finite number`);
    return null;
  }
  return value;
}

/**
 * Validate a {@link ManualInput} and build the `NewEvent` that `addManual` will
 * insert.
 *
 * Required: a valid `media_type`, a non-empty trimmed `title` and `started_at`.
 * Optional numerics must be finite; `duration_seconds >= 0`; `progress` within
 * `0..1`; `season`/`episode` integers `>= 0`; `ended_at` (when given) must not
 * be before `started_at`. All problems are collected and reported in a single
 * `Error` (joined by `"; "`).
 *
 * `started_at`/`ended_at` are interpreted as local wall-clock times in `tz`
 * unless they already carry an explicit offset or `Z`. An optional `client_id`
 * (a UUID) replaces the generated `source_id` with `client:<uuid in lowercase>`
 * so the same body can be sent again safely; an invalid one is a problem like
 * any other.
 */
export function validateManual(
  input: ManualInput,
  tz: string,
  opts: ManualOptions = {}
): NewEvent {
  const problems: string[] = [];

  const mediaTypeRaw = input?.media_type as unknown;
  let mediaType: MediaType | null = null;
  if (typeof mediaTypeRaw !== "string" || mediaTypeRaw.trim() === "") {
    problems.push("media_type is required");
  } else if (!VALID_MEDIA_TYPES.has(mediaTypeRaw)) {
    problems.push(`Invalid media_type: '${mediaTypeRaw}'`);
  } else {
    mediaType = mediaTypeRaw as MediaType;
  }

  const titleRaw = input?.title as unknown;
  let title: string | null = null;
  if (typeof titleRaw !== "string" || titleRaw.trim() === "") {
    problems.push("title is required (non-empty)");
  } else {
    title = titleRaw.trim();
  }

  let startedAt: string | null = null;
  if (input?.started_at === undefined || input.started_at === null) {
    problems.push("started_at is required");
  } else if (typeof input.started_at !== "string" || input.started_at.trim() === "") {
    problems.push("started_at is required");
  } else {
    try {
      startedAt = localToUtcIso(input.started_at, tz);
    } catch (caught) {
      problems.push(`Invalid started_at: ${errorText(caught)}`);
    }
  }

  let endedAt: string | null = null;
  if (input?.ended_at !== undefined && input.ended_at !== null) {
    if (typeof input.ended_at !== "string" || input.ended_at.trim() === "") {
      problems.push("ended_at must be a non-empty string");
    } else {
      try {
        endedAt = localToUtcIso(input.ended_at, tz);
      } catch (caught) {
        problems.push(`Invalid ended_at: ${errorText(caught)}`);
      }
    }
  }
  if (
    startedAt !== null &&
    endedAt !== null &&
    Date.parse(endedAt) < Date.parse(startedAt)
  ) {
    problems.push("ended_at must not be before started_at");
  }

  const parentTitle = optionalString("parent_title", input?.parent_title, problems);
  const device = optionalString("device", input?.device, problems);
  const season = optionalInteger("season", input?.season, problems);
  const episode = optionalInteger("episode", input?.episode, problems);

  const durationSeconds = optionalNumber(
    "duration_seconds",
    input?.duration_seconds,
    problems
  );
  if (durationSeconds !== null && durationSeconds < 0) {
    problems.push("duration_seconds must be >= 0");
  }

  let progress: number | null = null;
  if (input?.progress !== undefined && input.progress !== null) {
    const raw = input.progress;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      problems.push("progress must be a finite number");
    } else if (raw < 0 || raw > 1) {
      problems.push(`progress must be between 0 and 1, got ${raw}`);
    } else {
      progress = raw;
    }
  }

  let externalIds: Record<string, unknown> | null = null;
  if (input?.external_ids !== undefined && input.external_ids !== null) {
    const raw = input.external_ids;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      problems.push("external_ids must be an object or null");
    } else {
      externalIds = raw;
    }
  }

  // Optional client idempotency key: `source_id` becomes `client:<uuid>` so a
  // resent body hits the same `record_hash` and the insert is ignored.
  let clientSourceId: string | null = null;
  if (input?.client_id !== undefined && input.client_id !== null) {
    if (typeof input.client_id !== "string" || !CLIENT_ID_RE.test(input.client_id)) {
      problems.push("client_id must be a UUID");
    } else {
      clientSourceId = `client:${input.client_id.toLowerCase()}`;
    }
  }

  if (problems.length > 0 || mediaType === null || title === null || startedAt === null) {
    throw new Error(problems.join("; "));
  }

  const newId = opts.newId ?? (() => crypto.randomUUID());

  return {
    source: MANUAL_SOURCE,
    source_kind: MANUAL_SOURCE_KIND,
    source_id: clientSourceId ?? newId(),
    external_ids: externalIds,
    media_type: mediaType,
    title,
    parent_title: parentTitle,
    season,
    episode,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    progress,
    device,
    raw: null,
  };
}

// --- insert ----------------------------------------------------------------

/**
 * Validate and insert one manual entry, wrapped in a `manual` ingest run.
 *
 * Validation errors are thrown before any run is started, so bad input leaves
 * no trace. Any failure while inserting finishes the run with `failed`.
 */
export function addManual(
  db: Database,
  input: ManualInput,
  tz: string,
  opts: ManualOptions = {}
): ManualResult {
  const event = validateManual(input, tz, opts);

  const runId = startRun(db, MANUAL_SOURCE);
  try {
    const { inserted } = insertEvents(db, runId, [event]);
    finishRun(db, runId, { status: "ok", rowsSeen: 1, rowsInserted: inserted });
    return { id: event.source_id, inserted, runId };
  } catch (caught) {
    finishRun(db, runId, {
      status: "failed",
      rowsSeen: 0,
      rowsInserted: 0,
      error: errorText(caught),
    });
    throw caught;
  }
}
