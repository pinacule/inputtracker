/**
 * RFC 4180 CSV parser and helpers for Achriom and native CSV files.
 *
 * Handles UTF-8 BOM, quoted fields containing commas, doubled double-quotes
 * (`""`), embedded LF / CRLF newlines inside quotes, and `; `-separated list
 * fields used by Achriom exports.
 */

import { escapeCsvField } from "./export-csv.ts";

export { escapeCsvField };

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

/**
 * Parse RFC 4180 CSV text into rows of string fields.
 * - Strips a leading UTF-8 BOM (`\uFEFF`) if present.
 * - Handles both `\n` and `\r\n` row endings.
 * - Preserves embedded newlines (`\n`), commas, and escaped quotes (`""` → `"`)
 *   inside double-quoted fields.
 * - Throws `CsvParseError` on unclosed quotes or malformed quoting.
 */
export function parseCsvRows(rawText: string): string[][] {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStartedQuoted = false;
  let afterClosingQuote = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        afterClosingQuote = true;
        i += 1;
        continue;
      }
      if (ch === "\r" && text[i + 1] === "\n") {
        field += "\n";
        i += 2;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (afterClosingQuote) {
      if (ch === ",") {
        row.push(field);
        field = "";
        fieldStartedQuoted = false;
        afterClosingQuote = false;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        fieldStartedQuoted = false;
        afterClosingQuote = false;
        i += 1;
        continue;
      }
      if (ch === "\r") {
        i += 1;
        continue;
      }
      throw new CsvParseError(
        `Unexpected character '${ch}' after closing quote at offset ${i}`
      );
    }

    if (ch === '"') {
      if (field === "") {
        inQuotes = true;
        fieldStartedQuoted = true;
        i += 1;
        continue;
      }
      throw new CsvParseError(`Unexpected quote inside unquoted field at offset ${i}`);
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      fieldStartedQuoted = false;
      i += 1;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStartedQuoted = false;
      i += 1;
      continue;
    }

    if (ch === "\r") {
      if (text[i + 1] === "\n") {
        i += 1;
        continue;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStartedQuoted = false;
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new CsvParseError("Unclosed quoted field at end of CSV");
  }

  if (field !== "" || fieldStartedQuoted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export interface ParsedCsvTable {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/**
 * Parse RFC 4180 CSV text into a header array and an array of row objects
 * keyed by header name.
 */
export function parseCsvObjects(text: string): ParsedCsvTable {
  const allRows = parseCsvRows(text);
  if (allRows.length === 0) {
    return { headers: [], rows: [] };
  }

  const rawHeader = allRows[0]!;
  if (rawHeader.length === 1 && rawHeader[0]!.trim() === "" && allRows.length === 1) {
    return { headers: [], rows: [] };
  }

  const headers = rawHeader.map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];

  for (let r = 1; r < allRows.length; r++) {
    const fields = allRows[r]!;
    // Ignore a trailing completely empty line
    if (fields.length === 1 && fields[0] === "" && headers.length > 1) {
      continue;
    }
    if (fields.length !== headers.length) {
      throw new CsvParseError(
        `CSV row ${r} has ${fields.length} field(s), expected ${headers.length}`
      );
    }
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]!] = fields[c]!;
    }
    rows.push(obj);
  }

  return { headers, rows };
}

/**
 * Split a `; `-separated list inside a CSV field (e.g. `"Action; Adventure; Drama"`),
 * trimming items and dropping empty ones.
 */
export function splitCsvList(value: string | null | undefined): string[] {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  const out: string[] = [];
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (trimmed !== "" && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}
