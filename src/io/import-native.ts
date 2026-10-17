/**
 * Native archive import: read back the JSON / CSV files produced by T09
 * (`export-json.ts`, `export-csv.ts`) and insert them into `events`.
 *
 * The importer is intentionally forgiving about the identity columns written by
 * the exporter: `id`, `record_hash`, `ingested_at` and `ingest_run_id` are
 * **ignored**. The record hash is recomputed from the normalized fields by
 * `insertEvents` / `normalize`, so an edited or stale hash in the file can never
 * create a duplicate.
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
import { EVENT_COLUMNS, EXPORT_FORMAT, EXPORT_VERSION } from "./export-json.ts";

/** `events` source used for the ingest run recorded by an import. */
export const NATIVE_IMPORT_SOURCE = "native-import";

export interface ImportNativeResult {
  /** Number of rows read from the file. */
  seen: number;
  /** Number of rows actually inserted (duplicates are ignored). */
  inserted: number;
  /** Id of the `ingest_runs` row written for this import. */
  runId: number;
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

// --- JSON ------------------------------------------------------------------

/** Parse a `inputtracker-export` JSON document into `NewEvent`s. */
export function parseNativeJson(text: string): NewEvent[] {
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
  if (envelope.version !== EXPORT_VERSION) {
    throw new Error(
      `Unsupported export version: expected ${EXPORT_VERSION}, got ${JSON.stringify(envelope.version)}`
    );
  }
  if (!Array.isArray(envelope.events)) {
    throw new Error("Invalid export: field 'events' must be an array");
  }

  return envelope.events.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid export: event at index ${index} is not an object`);
    }
    return toNewEvent(entry as Record<string, unknown>);
  });
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
 * Import a native export into `events`. The import is atomic: if any row is
 * invalid the whole thing throws, nothing is inserted, and the ingest run is
 * finished with `status = 'failed'`.
 */
export function importNative(
  db: Database,
  text: string,
  format: "json" | "csv",
  opts: ImportNativeOptions = {}
): ImportNativeResult {
  const events = format === "json" ? parseNativeJson(text) : parseNativeCsv(text);

  const runId = startRun(db, opts.source ?? NATIVE_IMPORT_SOURCE);
  try {
    const { seen, inserted } = insertEvents(db, runId, events);
    finishRun(db, runId, { status: "ok", rowsSeen: seen, rowsInserted: inserted });
    return { seen, inserted, runId };
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
