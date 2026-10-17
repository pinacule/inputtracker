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
import { toUtcIso } from "../core/time.ts";

/** `events.source` for rows written by manual entry. */
export const MANUAL_SOURCE = "manual";
/** `events.source_kind` for rows written by manual entry. */
export const MANUAL_SOURCE_KIND = "history_item";

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

// --- local wall-clock → UTC ------------------------------------------------

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const EXPLICIT_OFFSET_RE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;
const HOUR_MS = 3_600_000;

/** `Intl.DateTimeFormat`s are expensive; cache one per timezone. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached !== undefined) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new Error(`Invalid timezone: "${tz}"`);
  }
  formatterCache.set(tz, formatter);
  return formatter;
}

/** Wall-clock parts of the UTC instant `utcMs` in timezone `tz`. */
function wallClockAt(tz: string, utcMs: number): WallClock {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const valueOf = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? Number.NaN : Number.parseInt(part.value, 10);
  };
  return {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day"),
    // Some ICU versions report the midnight hour as "24"; normalize to 0.
    hour: valueOf("hour") % 24,
    minute: valueOf("minute"),
    second: valueOf("second"),
  };
}

/** Offset (local − UTC, in ms) of timezone `tz` at the UTC instant `utcMs`. */
function zoneOffsetMs(tz: string, utcMs: number): number {
  const w = wallClockAt(tz, utcMs);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Offsets that could apply to the wall-clock time whose "pretend UTC" value is
 * `naive`. Transitions are at most a few hours from the requested time, so
 * sampling around it collects every candidate without walking the tz database.
 */
function candidateOffsets(tz: string, naive: number): number[] {
  const offsets = new Set<number>();
  for (const hours of [-12, -6, -1, 0, 1, 6, 12]) {
    offsets.add(zoneOffsetMs(tz, naive + hours * HOUR_MS));
  }
  return [...offsets];
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * Convert a local wall-clock string in the IANA timezone `tz` to a UTC ISO 8601
 * string (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 *
 * Accepted forms: `2026-10-17 21:30`, `2026-10-17T21:30`, an optional `:SS`, or
 * a bare date (`2026-10-17` ⇒ 00:00 local). An input that already ends in `Z` or
 * a numeric offset is passed straight to {@link toUtcIso} and respected as-is.
 *
 * DST edge cases:
 * - **Spring-forward gap** (a local time that does not exist): the time is
 *   shifted *forward* by the gap to the next valid instant, matching Temporal's
 *   default `compatible` disambiguation (`02:30` on a 02:00→03:00 day becomes
 *   `03:30` local).
 * - **Fall-back ambiguity** (a local time that happens twice): the *first*
 *   (earlier) occurrence is used.
 *
 * Throws a clear `Error` on invalid input or an unknown timezone.
 */
export function localToUtcIso(local: string, tz: string): string {
  if (typeof local !== "string") {
    throw new Error("Invalid local time: expected a string");
  }
  const trimmed = local.trim();
  if (trimmed === "") {
    throw new Error('Invalid local time: ""');
  }

  // Already unambiguous: an explicit `Z` or numeric offset wins.
  if (EXPLICIT_OFFSET_RE.test(trimmed)) {
    return toUtcIso(trimmed);
  }

  const match = NAIVE_RE.exec(trimmed);
  if (match === null) {
    throw new Error(`Invalid local time: "${trimmed}"`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(`Invalid local time: "${trimmed}"`);
  }

  // Reject impossible calendar dates such as 2026-02-30.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new Error(`Invalid local time: "${trimmed}"`);
  }

  const wanted: WallClock = { year, month, day, hour, minute, second };
  // Treat the wall-clock fields as if they were UTC; subtracting the zone offset
  // yields the real instant.
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);

  const validInstants: number[] = [];
  for (const offset of candidateOffsets(tz, naive)) {
    const instant = naive - offset;
    if (sameWallClock(wallClockAt(tz, instant), wanted)) {
      validInstants.push(instant);
    }
  }

  if (validInstants.length > 0) {
    // Ambiguous (fall-back): `min` is the first, earlier occurrence.
    return new Date(Math.min(...validInstants)).toISOString();
  }

  // No exact match: the requested wall-clock time falls in a spring-forward gap.
  // Pick the candidate shifted forward by the smallest positive amount.
  let bestInstant: number | null = null;
  let bestShift = Number.POSITIVE_INFINITY;
  for (const offset of candidateOffsets(tz, naive)) {
    const instant = naive - offset;
    const w = wallClockAt(tz, instant);
    const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const shift = wall - naive;
    if (shift > 0 && shift < bestShift) {
      bestShift = shift;
      bestInstant = instant;
    }
  }

  if (bestInstant === null) {
    throw new Error(`Could not resolve local time "${trimmed}" in timezone "${tz}"`);
  }
  return new Date(bestInstant).toISOString();
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
 * unless they already carry an explicit offset or `Z`.
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

  if (problems.length > 0 || mediaType === null || title === null || startedAt === null) {
    throw new Error(problems.join("; "));
  }

  const newId = opts.newId ?? (() => crypto.randomUUID());

  return {
    source: MANUAL_SOURCE,
    source_kind: MANUAL_SOURCE_KIND,
    source_id: newId(),
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
