/**
 * Full-archive CSV export (RFC 4180).
 *
 * One header row with every `EventRow` column (schema order, taken from
 * `EVENT_COLUMNS`), then one row per `events` row ordered by `id`. Fields
 * containing a comma, double quote, CR or LF are wrapped in double quotes and
 * inner quotes are doubled. `NULL` becomes an empty field. The `external_ids`
 * and `raw` JSON columns are written as their stored JSON strings. Rows are
 * terminated with `\n`.
 */

import type { Database } from "bun:sqlite";
import { EVENT_COLUMNS, selectAllEvents } from "./export-json.ts";

const NEEDS_QUOTING_RE = /[",\r\n]/;

/** RFC 4180 field escaping; `null`/`undefined` → empty field. */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (NEEDS_QUOTING_RE.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialize the whole `events` archive as RFC 4180 CSV. */
export function exportCsv(db: Database): string {
  const lines: string[] = [EVENT_COLUMNS.join(",")];

  for (const event of selectAllEvents(db)) {
    const fields = EVENT_COLUMNS.map((column) => escapeCsvField(event[column]));
    lines.push(fields.join(","));
  }

  return `${lines.join("\n")}\n`;
}
