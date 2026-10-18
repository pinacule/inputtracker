/**
 * Native archive import: read back the JSON / CSV files produced by
 * (`export-json.ts`, `export-csv.ts`) and insert them into `events`, `goals`
 * and `annotations`.
 *
 * The importer is intentionally forgiving about the identity columns written by
 * the exporter: `id`, `record_hash`, `ingested_at` and `ingest_run_id` are
 * **ignored**. The record hash is recomputed from the normalized fields by
 * `insertEvents` / `normalize`, so an edited or stale hash in the file can never
 * create a duplicate.
 *
 * For goals and annotations, `id` and `record_hash` are also ignored and
 * recomputed. `goal_id`, `rev_id` and `created_at` are kept from the file as
 * they are data.
 *
 * `external_ids` and `raw` are stored in the export as JSON *strings*; here they
 * are parsed back into values so a re-insert stores the exact same JSON text.
 */

import type { Database } from "bun:sqlite";
import {
  finishRun,
  insertEvents,
  startRun,
  type MediaType,
  type NewEvent,
} from "../core/events.ts";
import { EVENT_COLUMNS, EXPORT_FORMAT } from "./export-json.ts";
import {
  goalRecordHash,
  GoalValidationError,
  normalizeGoalFields,
  UUID_RE,
} from "../server/goals.ts";
import {
  annotationRecordHash,
  AnnotationValidationError,
  parseAnnotationKey,
  parseNote,
  parseRating,
  parseRevId,
} from "../server/annotations.ts";
import { tenthsToLegacyRating } from "../server/ratings.ts";
import { toUtcIso } from "../core/time.ts";

/** `events` source used for the ingest run recorded by an import. */
export const NATIVE_IMPORT_SOURCE = "native-import";

/** Accepted export versions. */
const ACCEPTED_VERSIONS = new Set([1, 2]);

export interface ImportTableResult {
  /** Number of rows read from the file. */
  seen: number;
  /** Number of rows actually inserted (duplicates are ignored). */
  inserted: number;
}

export interface ImportNativeResult {
  /** Event counts. */
  events: ImportTableResult;
  /** Goal counts (zeros for v1/CSV). */
  goals: ImportTableResult;
  /** Annotation counts (zeros for v1/CSV). */
  annotations: ImportTableResult;
  /** Id of the `ingest_runs` row written for this import. */
  runId: number;

  // Legacy aliases for backwards compatibility:
  /** Number of event rows read from the file. */
  seen: number;
  /** Number of event rows actually inserted (duplicates are ignored). */
  inserted: number;
}

export interface ImportNativeOptions {
  /** Override the `ingest_runs.source`; defaults to `native-import`. */
  source?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- shared field coercion -------------------------------------------------

/**
 * Parse a JSON-valued column (`external_ids`, `raw`). `null`/`undefined`/empty
 * string → `null`. A string is JSON-parsed; a non-string is passed through.
 */
function parseJsonColumn(field: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    if (value === "") {
      return null;
    }
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`Field '${field}' is not valid JSON: ${JSON.stringify(value)}`);
    }
  }
  return value;
}

function toExternalIds(field: string, value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonColumn(field, value);
  if (parsed === null || parsed === undefined) {
    return null;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Field '${field}' must be a JSON object or null`);
  }
  return parsed as Record<string, unknown>;
}

/** Accepts a number (JSON) or a numeric string (CSV); empty string → null. */
function toNumberOrNull(field: string, value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error(`Field '${field}' must be a number`);
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  // `normalize` validates the actual type; this only satisfies `NewEvent`.
  return value as string;
}

/** Build a `NewEvent` from a raw record (parsed JSON or a CSV row). */
function toNewEvent(record: Record<string, unknown>): NewEvent {
  return {
    source: record.source as string,
    source_kind: record.source_kind as string,
    source_id: record.source_id as string,
    external_ids: toExternalIds("external_ids", record.external_ids),
    media_type: record.media_type as MediaType,
    title: stringOrNull(record.title),
    parent_title: stringOrNull(record.parent_title),
    season: toNumberOrNull("season", record.season),
    episode: toNumberOrNull("episode", record.episode),
    started_at: record.started_at as string,
    ended_at: stringOrNull(record.ended_at),
    duration_seconds: toNumberOrNull("duration_seconds", record.duration_seconds),
    progress: toNumberOrNull("progress", record.progress),
    device: stringOrNull(record.device),
    raw: parseJsonColumn("raw", record.raw),
  };
}

// --- goal/annotation import row types -------------------------------------

interface ValidatedGoalRow {
  record_hash: string;
  goal_id: string;
  rev_id: string;
  year: number;
  metric: string;
  source: string | null;
  media_type: string | null;
  target: number;
  archived: number;
  created_at: string;
}

interface ValidatedAnnotationRow {
  record_hash: string;
  source: string;
  title: string;
  rev_id: string;
  rating: number | null;
  rating_tenths: number | null;
  note: string | null;
  created_at: string;
}

/** `created_at` of an imported row, normalized to UTC ISO 8601 with ms. */
function importCreatedAt(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${what}: created_at is required`);
  }
  try {
    return toUtcIso(value);
  } catch {
    throw new Error(`${what}: invalid created_at ${JSON.stringify(value)}`);
  }
}

/**
 * Validate a goal row from a JSON export file with the same rules as
 * `addGoalRevision` (`normalizeGoalFields`), except that the `goal_id` does not
 * have to exist yet: the import creates it. Both ids must be present.
 */
function validateGoalRow(record: Record<string, unknown>, index: number): ValidatedGoalRow {
  const what = `Goal at index ${index}`;
  const goalId = record.goal_id;
  if (typeof goalId !== "string" || !UUID_RE.test(goalId)) {
    throw new GoalValidationError(`${what}: invalid goal_id ${JSON.stringify(goalId)}`);
  }
  const revId = record.rev_id;
  if (typeof revId !== "string" || !UUID_RE.test(revId)) {
    throw new GoalValidationError(`${what}: invalid rev_id ${JSON.stringify(revId)}`);
  }
  let fields: ReturnType<typeof normalizeGoalFields>;
  try {
    fields = normalizeGoalFields(record);
  } catch (e) {
    throw new GoalValidationError(`${what}: ${errorText(e)}`);
  }
  const created_at = importCreatedAt(record.created_at, what);
  const record_hash = goalRecordHash({ goal_id: goalId, rev_id: revId, ...fields });
  return { record_hash, goal_id: goalId, rev_id: revId, ...fields, created_at };
}

/**
 * Validate an annotation row from a JSON export file. Reuses the same
 * validators from `annotations.ts`.
 */
function validateAnnotationRow(
  record: Record<string, unknown>,
  index: number
): ValidatedAnnotationRow {
  let key: { source: string; title: string };
  try {
    key = parseAnnotationKey(record.source, record.title);
  } catch (e) {
    throw new AnnotationValidationError(
      `Annotation at index ${index}: ${(e as Error).message}`
    );
  }

  let rating: number | null;
  try {
    const parsedLegacy =
      record.rating !== undefined && record.rating !== null
        ? parseRating(record.rating)
        : null;
    const parsedTenths =
      record.rating_tenths !== undefined && record.rating_tenths !== null
        ? typeof record.rating_tenths === "number" &&
          Number.isInteger(record.rating_tenths)
          ? parseRating(record.rating_tenths / 10)
          : parseRating(record.rating_tenths)
        : null;
    rating = parsedLegacy ?? parsedTenths;
  } catch (e) {
    throw new AnnotationValidationError(
      `Annotation at index ${index}: ${(e as Error).message}`
    );
  }
  const ratingTenths = rating === null ? null : Math.round(rating * 10);
  const legacyRating = tenthsToLegacyRating(ratingTenths);

  let note: string | null;
  try {
    note = parseNote(record.note);
  } catch (e) {
    throw new AnnotationValidationError(
      `Annotation at index ${index}: ${(e as Error).message}`
    );
  }

  // A missing rev_id would get a fresh random one and break idempotent re-import.
  if (record.rev_id === undefined || record.rev_id === null || record.rev_id === "") {
    throw new AnnotationValidationError(`Annotation at index ${index}: rev_id is required`);
  }
  let revId: string;
  try {
    revId = parseRevId(record.rev_id);
  } catch (e) {
    throw new AnnotationValidationError(
      `Annotation at index ${index}: ${(e as Error).message}`
    );
  }

  const createdAt = importCreatedAt(record.created_at, `Annotation at index ${index}`);

  const hash = annotationRecordHash({
    source: key.source,
    title: key.title,
    rev_id: revId,
    rating,
    note,
  });

  return {
    record_hash: hash,
    source: key.source,
    title: key.title,
    rev_id: revId,
    rating: legacyRating,
    rating_tenths: ratingTenths,
    note,
    created_at: createdAt,
  };
}

// --- JSON ------------------------------------------------------------------

/** Parsed native JSON result containing events, goals and annotations. */
export interface ParsedNativeJson {
  events: NewEvent[];
  goals: ValidatedGoalRow[];
  annotations: ValidatedAnnotationRow[];
}

/** Parse a `inputtracker-export` JSON document (v1 or v2). */
export function parseNativeJson(text: string): ParsedNativeJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    throw new Error(`Invalid JSON export: ${errorText(caught)}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid export: expected a JSON object envelope");
  }

  const envelope = parsed as Record<string, unknown>;

  if (envelope.format !== EXPORT_FORMAT) {
    throw new Error(
      `Invalid export: expected format "${EXPORT_FORMAT}", got ${JSON.stringify(envelope.format)}`
    );
  }

  const version = envelope.version;
  if (typeof version !== "number" || !ACCEPTED_VERSIONS.has(version)) {
    throw new Error(
      `Unsupported export version: expected 1 or 2, got ${JSON.stringify(version)}`
    );
  }

  if (!Array.isArray(envelope.events)) {
    throw new Error("Invalid export: field 'events' must be an array");
  }

  const events = envelope.events.map((entry: unknown, index: number) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid export: event at index ${index} is not an object`);
    }
    return toNewEvent(entry as Record<string, unknown>);
  });

  let goals: ValidatedGoalRow[] = [];
  let annotations: ValidatedAnnotationRow[] = [];

  if (version === 2) {
    // v2 requires both keys to be present (but empty arrays are fine)
    if (!("goals" in envelope)) {
      throw new Error("Invalid v2 export: field 'goals' is required");
    }
    if (!("annotations" in envelope)) {
      throw new Error("Invalid v2 export: field 'annotations' is required");
    }
    if (!Array.isArray(envelope.goals)) {
      throw new Error("Invalid export: field 'goals' must be an array");
    }
    if (!Array.isArray(envelope.annotations)) {
      throw new Error("Invalid export: field 'annotations' must be an array");
    }

    goals = envelope.goals.map((entry: unknown, index: number) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Invalid export: goal at index ${index} is not an object`);
      }
      return validateGoalRow(entry as Record<string, unknown>, index);
    });

    annotations = envelope.annotations.map((entry: unknown, index: number) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Invalid export: annotation at index ${index} is not an object`);
      }
      return validateAnnotationRow(entry as Record<string, unknown>, index);
    });
  }

  return { events, goals, annotations };
}

// --- CSV (RFC 4180) --------------------------------------------------------

/**
 * Split RFC 4180 CSV text into rows of fields. Handles quoted fields, doubled
 * inner quotes, embedded commas/CR/LF and both `\n` and `\r\n` row endings. A
 * trailing newline does not produce a trailing empty row.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i] as string;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Row ending is CRLF or LF; a bare CR is dropped so CRLF collapses to one break.
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Parse a native CSV export into `NewEvent`s. */
export function parseNativeCsv(text: string): NewEvent[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (header === undefined) {
    throw new Error("Invalid CSV export: missing header row");
  }

  const missing = EVENT_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `Invalid CSV export: header is missing column(s): ${missing.join(", ")}`
    );
  }

  const indexOf = new Map<string, number>();
  header.forEach((name, index) => {
    if (!indexOf.has(name)) {
      indexOf.set(name, index);
    }
  });

  const events: NewEvent[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const fields = rows[r] as string[];
    if (fields.length !== header.length) {
      throw new Error(
        `Invalid CSV export: row ${r} has ${fields.length} field(s), expected ${header.length}`
      );
    }

    const record: Record<string, unknown> = {};
    for (const column of EVENT_COLUMNS) {
      const value = fields[indexOf.get(column) as number] as string;
      // Empty field → null, matching the exporter's NULL handling.
      record[column] = value === "" ? null : value;
    }
    events.push(toNewEvent(record));
  }

  return events;
}

// --- format detection ------------------------------------------------------

/**
 * Guess the export format from a filename, or fall back to sniffing content.
 * Returns `null` when neither the extension nor the content is recognisable.
 */
export function detectFormat(filenameOrText: string): "json" | "csv" | null {
  const trimmed = filenameOrText.trimStart();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".csv")) {
    return "csv";
  }
  if (trimmed.startsWith("{")) {
    return "json";
  }
  if (trimmed.includes(",") && trimmed.split("\n", 1)[0]?.includes("record_hash")) {
    return "csv";
  }
  return null;
}

// --- import ----------------------------------------------------------------

/**
 * Import a native export into `events` (and `goals`/`annotations` for v2 JSON).
 * The import is atomic: if any row is invalid the whole thing throws, nothing
 * is inserted, and the ingest run is finished with `status = 'failed'`.
 */
export function importNative(
  db: Database,
  text: string,
  format: "json" | "csv",
  opts: ImportNativeOptions = {}
): ImportNativeResult {
  let events: NewEvent[];
  let goalRows: ValidatedGoalRow[] = [];
  let annotationRows: ValidatedAnnotationRow[] = [];

  if (format === "json") {
    const result = parseNativeJson(text);
    events = result.events;
    goalRows = result.goals;
    annotationRows = result.annotations;
  } else {
    events = parseNativeCsv(text);
  }

  const runId = startRun(db, opts.source ?? NATIVE_IMPORT_SOURCE);
  try {
    // Use a single transaction for atomicity across all three tables.
    const txResult = db.transaction(() => {
      const evtResult = insertEvents(db, runId, events);

      let goalsInserted = 0;
      if (goalRows.length > 0) {
        const goalStmt = db.prepare(
          `INSERT OR IGNORE INTO goals (
            record_hash, goal_id, rev_id, year, metric, source,
            media_type, target, archived, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
        );
        for (const g of goalRows) {
          const res = goalStmt.run(
            g.record_hash, g.goal_id, g.rev_id, g.year, g.metric, g.source,
            g.media_type, g.target, g.archived, g.created_at
          );
          goalsInserted += res.changes;
        }
      }

      let annotationsInserted = 0;
      if (annotationRows.length > 0) {
        const annStmt = db.prepare(
          `INSERT OR IGNORE INTO annotations (
            record_hash, source, title, rev_id, rating, rating_tenths, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
        );
        for (const a of annotationRows) {
          const res = annStmt.run(
            a.record_hash, a.source, a.title, a.rev_id, a.rating, a.rating_tenths, a.note,
            a.created_at
          );
          annotationsInserted += res.changes;
        }
      }

      return {
        events: evtResult,
        goalsInserted,
        annotationsInserted,
      };
    })();

    const totalSeen = txResult.events.seen + goalRows.length + annotationRows.length;
    const totalInserted = txResult.events.inserted + txResult.goalsInserted + txResult.annotationsInserted;
    finishRun(db, runId, {
      status: "ok",
      rowsSeen: totalSeen,
      rowsInserted: totalInserted,
    });

    return {
      events: { seen: txResult.events.seen, inserted: txResult.events.inserted },
      goals: { seen: goalRows.length, inserted: txResult.goalsInserted },
      annotations: { seen: annotationRows.length, inserted: txResult.annotationsInserted },
      runId,
      // Legacy aliases
      seen: txResult.events.seen,
      inserted: txResult.events.inserted,
    };
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
