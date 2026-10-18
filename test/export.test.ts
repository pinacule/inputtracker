import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import type { EventRow } from "../src/core/schema.ts";
import {
  EVENT_COLUMNS,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportJson,
} from "../src/io/export-json.ts";
import { escapeCsvField, exportCsv } from "../src/io/export-csv.ts";

// --- synthetic seeding helpers -------------------------------------------

interface SeedEvent {
  record_hash: string;
  source?: string;
  source_kind?: string;
  source_id?: string;
  external_ids?: string | null;
  media_type?: string;
  title?: string | null;
  parent_title?: string | null;
  season?: number | null;
  episode?: number | null;
  started_at?: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  progress?: number | null;
  device?: string | null;
  raw?: string | null;
  ingested_at?: string;
  ingest_run_id?: number | null;
}

/** Insert one synthetic event directly, filling every column with defaults. */
function insertEvent(db: Database, event: SeedEvent): number {
  const row: Record<string, string | number | null> = {
    record_hash: event.record_hash,
    source: event.source ?? "manual",
    source_kind: event.source_kind ?? "manual",
    source_id: event.source_id ?? "src-1",
    external_ids: event.external_ids ?? null,
    media_type: event.media_type ?? "other",
    title: event.title ?? null,
    parent_title: event.parent_title ?? null,
    season: event.season ?? null,
    episode: event.episode ?? null,
    started_at: event.started_at ?? "2026-10-17T08:15:00.000Z",
    ended_at: event.ended_at ?? null,
    duration_seconds: event.duration_seconds ?? null,
    progress: event.progress ?? null,
    device: event.device ?? null,
    raw: event.raw ?? null,
    ingested_at: event.ingested_at ?? "2026-10-17T08:16:00.000Z",
    ingest_run_id: event.ingest_run_id ?? null,
  };

  const columns = EVENT_COLUMNS.filter((column) => column !== "id");
  const placeholders = columns.map(() => "?").join(", ");
  const res = db.run(
    `INSERT INTO events (${columns.join(", ")}) VALUES (${placeholders});`,
    columns.map((column) => row[column] ?? null)
  );
  return Number(res.lastInsertRowid);
}

/** Three rows of one growing session (same source/kind/id) + one unrelated row. */
function seedGrowingSession(db: Database): void {
  insertEvent(db, {
    record_hash: "grow-1",
    source: "audiobookshelf",
    source_kind: "listening_session",
    source_id: "sess-1",
    media_type: "audiobook",
    title: "Synthetic Book",
    started_at: "2026-10-17T08:15:00.000Z",
    duration_seconds: 60,
    progress: 0.1,
    ingested_at: "2026-10-17T08:16:00.000Z",
  });
  insertEvent(db, {
    record_hash: "grow-2",
    source: "audiobookshelf",
    source_kind: "listening_session",
    source_id: "sess-1",
    media_type: "audiobook",
    title: "Synthetic Book",
    started_at: "2026-10-17T08:15:00.000Z",
    duration_seconds: 360,
    progress: 0.6,
    ingested_at: "2026-10-17T08:30:00.000Z",
  });
  insertEvent(db, {
    record_hash: "grow-3",
    source: "audiobookshelf",
    source_kind: "listening_session",
    source_id: "sess-1",
    media_type: "audiobook",
    title: "Synthetic Book",
    started_at: "2026-10-17T08:15:00.000Z",
    duration_seconds: 600,
    progress: 1,
    ingested_at: "2026-10-17T08:45:00.000Z",
  });
  insertEvent(db, {
    record_hash: "watch-1",
    source: "youtube",
    source_kind: "watch",
    source_id: "vid-9",
    media_type: "video",
    title: "Synthetic Video",
    started_at: "2026-10-17T09:00:00.000Z",
    duration_seconds: 900,
    ingested_at: "2026-10-17T09:05:00.000Z",
  });
}

function count(db: Database, from: string): number {
  return (
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${from};`).get()?.n ?? 0
  );
}

// --- minimal RFC 4180 parser (test-local, independent of the exporter) ----

function parseCsv(text: string): string[][] {
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

// --- JSON export ----------------------------------------------------------

describe("exportJson", () => {
  test("wraps every events row in the versioned envelope, oldest first", () => {
    const db = openDb(":memory:");
    seedGrowingSession(db);

    const parsed = JSON.parse(exportJson(db)) as {
      format: string;
      version: number;
      events: EventRow[];
    };

    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.version).toBe(EXPORT_VERSION);
    expect(EXPORT_FORMAT).toBe("inputtracker-export");
    expect(EXPORT_VERSION).toBe(2);

    // ALL rows of the archive, not the collapsed `events_latest` view.
    expect(parsed.events).toHaveLength(4);
    expect(count(db, "events")).toBe(4);
    expect(count(db, "events_latest")).toBe(2);

    // Ordered by id ascending.
    expect(parsed.events.map((e) => e.id)).toEqual([1, 2, 3, 4]);

    // Every column present on every row.
    const sortedColumns = [...EVENT_COLUMNS].sort();
    for (const event of parsed.events) {
      expect(Object.keys(event).sort()).toEqual(sortedColumns);
    }

    db.close();
  });

  test("preserves UTC timestamps exactly and keeps JSON columns as strings", () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      record_hash: "json-cols",
      source: "audiobookshelf",
      source_kind: "listening_session",
      source_id: "sess-json",
      external_ids: '{"imdb":"tt0000001","simkl":42}',
      media_type: "audiobook",
      title: "Synthetic Book",
      started_at: "2026-10-17T08:15:00.000Z",
      ended_at: "2026-10-17T08:35:00.000Z",
      duration_seconds: 1200.5,
      progress: 0.75,
      device: "Synthetic Phone",
      raw: '{"nested":{"kept":"as-string"}}',
      ingested_at: "2026-10-17T08:36:00.000Z",
    });

    const parsed = JSON.parse(exportJson(db)) as { events: EventRow[] };
    const event = parsed.events[0];

    expect(event?.started_at).toBe("2026-10-17T08:15:00.000Z");
    expect(event?.ended_at).toBe("2026-10-17T08:35:00.000Z");
    expect(event?.ingested_at).toBe("2026-10-17T08:36:00.000Z");
    // Stored JSON stays a JSON *string*, not a parsed object.
    expect(typeof event?.external_ids).toBe("string");
    expect(event?.external_ids).toBe('{"imdb":"tt0000001","simkl":42}');
    expect(typeof event?.raw).toBe("string");
    expect(event?.raw).toBe('{"nested":{"kept":"as-string"}}');

    db.close();
  });

  test("null columns stay null in JSON", () => {
    const db = openDb(":memory:");
    insertEvent(db, { record_hash: "null-cols" });

    const parsed = JSON.parse(exportJson(db)) as { events: EventRow[] };
    const event = parsed.events[0];

    expect(event?.external_ids).toBeNull();
    expect(event?.title).toBeNull();
    expect(event?.parent_title).toBeNull();
    expect(event?.season).toBeNull();
    expect(event?.episode).toBeNull();
    expect(event?.ended_at).toBeNull();
    expect(event?.duration_seconds).toBeNull();
    expect(event?.progress).toBeNull();
    expect(event?.device).toBeNull();
    expect(event?.raw).toBeNull();
    expect(event?.ingest_run_id).toBeNull();

    db.close();
  });
});

// --- CSV export -----------------------------------------------------------

describe("exportCsv", () => {
  test("header has every column and there is one row per event", () => {
    const db = openDb(":memory:");
    seedGrowingSession(db);

    const rows = parseCsv(exportCsv(db));

    expect(rows[0]).toEqual([...EVENT_COLUMNS]);
    expect(rows).toHaveLength(1 + 4);

    db.close();
  });

  test("escapes commas, quotes and newlines and round-trips (RFC 4180)", () => {
    const db = openDb(":memory:");
    const messyTitle = 'Comma, "quoted" and\nnewline';
    const messyRaw = '{"note":"a,b\\n\\"c\\""}';
    insertEvent(db, {
      record_hash: "messy",
      title: messyTitle,
      parent_title: "Author, with comma",
      raw: messyRaw,
      started_at: "2026-10-17T08:15:00.000Z",
    });

    const csv = exportCsv(db);
    // Raw text shows quoting + doubled inner quotes.
    expect(csv).toContain('"Comma, ""quoted"" and\nnewline"');
    expect(csv).toContain('"Author, with comma"');

    const rows = parseCsv(csv);
    const record = rows[1] as string[];
    const get = (column: string): string =>
      record[EVENT_COLUMNS.indexOf(column as (typeof EVENT_COLUMNS)[number])] as string;

    expect(get("title")).toBe(messyTitle);
    expect(get("parent_title")).toBe("Author, with comma");
    expect(get("raw")).toBe(messyRaw);
    expect(get("started_at")).toBe("2026-10-17T08:15:00.000Z");

    db.close();
  });

  test("nulls become empty fields and UTC timestamps are preserved", () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      record_hash: "nulls",
      started_at: "2026-10-17T08:15:00.000Z",
    });

    const rows = parseCsv(exportCsv(db));
    const record = rows[1] as string[];
    const get = (column: string): string =>
      record[EVENT_COLUMNS.indexOf(column as (typeof EVENT_COLUMNS)[number])] as string;

    expect(record).toHaveLength(EVENT_COLUMNS.length);
    expect(get("title")).toBe("");
    expect(get("parent_title")).toBe("");
    expect(get("external_ids")).toBe("");
    expect(get("raw")).toBe("");
    expect(get("ended_at")).toBe("");
    expect(get("progress")).toBe("");
    expect(get("started_at")).toBe("2026-10-17T08:15:00.000Z");
    expect(get("record_hash")).toBe("nulls");

    db.close();
  });

  test("escapeCsvField quotes only when needed and doubles inner quotes", () => {
    expect(escapeCsvField("plain")).toBe("plain");
    expect(escapeCsvField(42)).toBe("42");
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField("line\nbreak")).toBe('"line\nbreak"');
    expect(escapeCsvField("carriage\rreturn")).toBe('"carriage\rreturn"');
  });
});

// --- CLI export -----------------------------------------------------------

describe("CLI export", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-export-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function seededDb(): Database {
    const db = openDb(":memory:");
    seedGrowingSession(db);
    return db;
  }

  const baseConfig = (): Config =>
    ({ storage: { db_path: ":memory:" } }) as unknown as Config;

  test("export --format json writes the envelope to a file", async () => {
    const db = seededDb();
    const outPath = join(tempDir, "archive.json");
    let outText = "";
    let errText = "";

    const code = await runCli(["export", "--format", "json", "--out", outPath], {
      loadConfig: baseConfig,
      openDb: () => db,
      out: (line) => {
        outText += `${line}\n`;
      },
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(0);
    expect(outText).toContain(`exported 4 events to ${outPath}`);
    expect(errText).toBe("");

    const parsed = JSON.parse(readFileSync(outPath, "utf8")) as {
      format: string;
      version: number;
      events: EventRow[];
    };
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.events).toHaveLength(4);
  });

  test("export --format csv writes the header and every row", async () => {
    const db = seededDb();
    const outPath = join(tempDir, "archive.csv");
    let outText = "";

    const code = await runCli(
      ["export", "--format=csv", `--out=${outPath}`],
      {
        loadConfig: baseConfig,
        openDb: () => db,
        out: (line) => {
          outText += `${line}\n`;
        },
        err: () => {},
      }
    );

    expect(code).toBe(0);
    expect(outText).toContain(`exported 4 events to ${outPath}`);

    const text = readFileSync(outPath, "utf8");
    expect(text.split("\n")[0]).toBe(EVENT_COLUMNS.join(","));
    expect(parseCsv(text)).toHaveLength(1 + 4);
  });

  test("export uses an injected writer", async () => {
    const db = seededDb();
    const written: { path: string; data: string }[] = [];

    const code = await runCli(["export", "--format", "json", "--out", "ignored.json"], {
      loadConfig: baseConfig,
      openDb: () => db,
      writeFile: (path, data) => {
        written.push({ path, data });
      },
      out: () => {},
      err: () => {},
    });

    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe("ignored.json");
    expect(JSON.parse(written[0]?.data ?? "{}")).toMatchObject({
      format: EXPORT_FORMAT,
    });
  });

  test("missing --format → usage and exit 1", async () => {
    let errText = "";
    const code = await runCli(["export", "--out", "x.csv"], {
      out: () => {},
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(1);
    expect(errText).toContain("Missing --format.");
    expect(errText).toContain("Usage: it");
  });

  test("invalid --format → usage and exit 1", async () => {
    let errText = "";
    const code = await runCli(["export", "--format", "xml", "--out", "x"], {
      out: () => {},
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(1);
    expect(errText).toContain("Invalid --format: xml");
    expect(errText).toContain("Usage: it");
  });

  test("missing --out → usage and exit 1", async () => {
    let errText = "";
    const code = await runCli(["export", "--format", "json"], {
      out: () => {},
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(1);
    expect(errText).toContain("Missing --out.");
    expect(errText).toContain("Usage: it");
  });

  test("unknown export option → usage and exit 1", async () => {
    let errText = "";
    const code = await runCli(["export", "--format", "json", "--out", "x", "--bogus"], {
      out: () => {},
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(1);
    expect(errText).toContain("Unknown option: --bogus");
    expect(errText).toContain("Usage: it");
  });
});
