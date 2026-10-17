import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { insertEvents, type NewEvent } from "../src/core/events.ts";
import type { EventRow, IngestRunRow } from "../src/core/schema.ts";
import { escapeCsvField, exportCsv } from "../src/io/export-csv.ts";
import { EVENT_COLUMNS, exportJson } from "../src/io/export-json.ts";
import {
  detectFormat,
  importNative,
  parseCsvRows,
  parseNativeCsv,
  parseNativeJson,
} from "../src/io/import-native.ts";

// --- helpers --------------------------------------------------------------

/** Three synthetic rows: messy text, JSON columns and a fully-null row. */
function sampleEvents(): NewEvent[] {
  return [
    {
      source: "audiobookshelf",
      source_kind: "listening_session",
      source_id: "sess-1",
      external_ids: { asin: "B000FAKE", title: "Synthetic" },
      media_type: "audiobook",
      title: "Synthetic Book",
      parent_title: "Synthetic Author",
      season: 1,
      episode: 2,
      started_at: "2026-10-17T08:15:00.000Z",
      ended_at: "2026-10-17T08:35:00.000Z",
      duration_seconds: 1200.5,
      progress: 0.75,
      device: "Synthetic Phone",
      raw: { server_id: "abs-srv-01", extra: 42 },
    },
    {
      source: "youtube",
      source_kind: "watch",
      source_id: "vid-9",
      media_type: "video",
      title: 'Comma, "quoted" and\nnewline',
      parent_title: "Author, with comma",
      started_at: "2026-10-17T09:00:00.000Z",
      duration_seconds: 900,
      raw: "plain-string",
    },
    {
      source: "manual",
      source_kind: "manual",
      source_id: "manual-1",
      media_type: "book",
      started_at: "2026-10-17T10:00:00.000Z",
    },
  ];
}

function seed(db: Database, events: NewEvent[] = sampleEvents()): Database {
  insertEvents(db, null, events);
  return db;
}

type ComparableRow = Omit<EventRow, "id" | "ingested_at" | "ingest_run_id">;

/** Every event column except the identity/ingest bookkeeping ones. */
function comparableRows(db: Database): ComparableRow[] {
  const rows = db
    .query<EventRow, []>("SELECT * FROM events ORDER BY record_hash ASC;")
    .all();
  return rows.map((row) => {
    const { id, ingested_at, ingest_run_id, ...rest } = row;
    return rest;
  });
}

function hashes(db: Database): string[] {
  return db
    .query<{ record_hash: string }, []>(
      "SELECT record_hash FROM events ORDER BY record_hash ASC;"
    )
    .all()
    .map((row) => row.record_hash);
}

function count(db: Database, table: string): number {
  return (
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table};`).get()?.n ?? 0
  );
}

// --- JSON round-trip ------------------------------------------------------

describe("importNative / parseNativeJson", () => {
  test("re-importing an unchanged JSON export into the same DB inserts nothing", () => {
    const db = seed(openDb(":memory:"));
    const text = exportJson(db);

    const result = importNative(db, text, "json");

    expect(result.seen).toBe(3);
    expect(result.inserted).toBe(0);
    expect(result.runId).toBeGreaterThan(0);
    expect(count(db, "events")).toBe(3);
  });

  test("importing into an empty DB reproduces the rows exactly", () => {
    const source = seed(openDb(":memory:"));
    const text = exportJson(source);

    const target = openDb(":memory:");
    const result = importNative(target, text, "json");

    expect(result).toMatchObject({ seen: 3, inserted: 3 });
    expect(comparableRows(target)).toEqual(comparableRows(source));
    expect(hashes(target)).toEqual(hashes(source));
  });

  test("records an ok ingest run for the import", () => {
    const db = seed(openDb(":memory:"));
    const { runId } = importNative(db, exportJson(db), "json");

    const run = db
      .query<IngestRunRow, [number]>("SELECT * FROM ingest_runs WHERE id = ?;")
      .get(runId);

    expect(run?.source).toBe("native-import");
    expect(run?.status).toBe("ok");
    expect(run?.rows_seen).toBe(3);
    expect(run?.rows_inserted).toBe(0);
    expect(run?.finished_at).not.toBeNull();
  });

  test("rejects a wrong format/version/events envelope", () => {
    expect(() => parseNativeJson("not json")).toThrow(/invalid json/i);
    expect(() =>
      parseNativeJson('{"format":"other","version":1,"events":[]}')
    ).toThrow(/format/i);
    expect(() =>
      parseNativeJson('{"format":"inputtracker-export","version":2,"events":[]}')
    ).toThrow(/version/i);
    expect(() =>
      parseNativeJson('{"format":"inputtracker-export","version":1,"events":{}}')
    ).toThrow(/array/i);
  });

  test("ignores id, record_hash, ingested_at and ingest_run_id from the file", () => {
    const orig = seed(openDb(":memory:"));
    const envelope = JSON.parse(exportJson(orig)) as {
      events: Record<string, unknown>[];
    };
    envelope.events = envelope.events.map((e) => ({
      ...e,
      id: 999999,
      record_hash: "tampered-hash",
      ingested_at: "1999-01-01T00:00:00.000Z",
      ingest_run_id: 12345,
    }));

    const target = openDb(":memory:");
    const result = importNative(target, JSON.stringify(envelope), "json");

    expect(result.inserted).toBe(3);
    expect(hashes(target)).toEqual(hashes(orig));
    const raw = target
      .query<{ ingested_at: string }, []>("SELECT ingested_at FROM events;")
      .all();
    for (const row of raw) {
      expect(row.ingested_at).not.toBe("1999-01-01T00:00:00.000Z");
    }
  });

  test("a file with an edited record_hash still inserts nothing into the same DB", () => {
    const db = seed(openDb(":memory:"));
    const envelope = JSON.parse(exportJson(db)) as {
      events: Record<string, unknown>[];
    };
    envelope.events = envelope.events.map((e, i) => ({
      ...e,
      record_hash: `edited-${i}`,
    }));

    const result = importNative(db, JSON.stringify(envelope), "json");

    expect(result.seen).toBe(3);
    expect(result.inserted).toBe(0);
    expect(count(db, "events")).toBe(3);
  });
});

// --- CSV round-trip -------------------------------------------------------

describe("importNative / parseNativeCsv", () => {
  test("re-importing an unchanged CSV export into the same DB inserts nothing", () => {
    const db = seed(openDb(":memory:"));
    const text = exportCsv(db);

    const result = importNative(db, text, "csv");

    expect(result.seen).toBe(3);
    expect(result.inserted).toBe(0);
    expect(count(db, "events")).toBe(3);
  });

  test("importing messy CSV into an empty DB reproduces the rows exactly", () => {
    const source = seed(openDb(":memory:"));
    const text = exportCsv(source);
    // Sanity: the messy title really is quoted in the file.
    expect(text).toContain('"Comma, ""quoted"" and\nnewline"');

    const target = openDb(":memory:");
    const result = importNative(target, text, "csv");

    expect(result).toMatchObject({ seen: 3, inserted: 3 });
    expect(comparableRows(target)).toEqual(comparableRows(source));
    expect(hashes(target)).toEqual(hashes(source));
  });

  test("a CSV file with an edited record_hash inserts nothing into the same DB", () => {
    const db = seed(openDb(":memory:"));
    const rows = parseCsvRows(exportCsv(db));
    const hashCol = EVENT_COLUMNS.indexOf("record_hash");
    for (let r = 1; r < rows.length; r += 1) {
      rows[r]![hashCol] = `edited-${r}`;
    }
    const text = rows
      .map((row) => row.map((value) => escapeCsvField(value)).join(","))
      .join("\n");

    const result = importNative(db, text, "csv");

    expect(result.inserted).toBe(0);
    expect(count(db, "events")).toBe(3);
  });

  test("rejects a header that is missing required columns", () => {
    expect(() => parseNativeCsv("source,source_kind\nx,y\n")).toThrow(
      /missing column/i
    );
  });

  test("rejects a row with the wrong field count and a bad number", () => {
    const header = EVENT_COLUMNS.join(",");
    expect(() => parseNativeCsv(`${header}\n1,2,3\n`)).toThrow(/field/i);

    // A well-formed row whose progress is not a number must fail at insert.
    const bad = [
      "1",
      "h",
      "manual",
      "manual",
      "m-1",
      "",
      "book",
      "T",
      "",
      "",
      "",
      "2026-10-17T08:15:00.000Z",
      "",
      "",
      "not-a-number",
      "",
      "",
      "2026-10-17T08:16:00.000Z",
      "",
    ].join(",");

    const db = openDb(":memory:");
    expect(() => importNative(db, `${header}\n${bad}\n`, "csv")).toThrow(
      /number/i
    );
    expect(count(db, "events")).toBe(0);
  });

  test("parses CRLF endings and embedded newlines/quotes", () => {
    const rows = parseCsvRows(
      'a,b\r\n"x,1","line\n2"\r\n"say ""hi""",\r\n'
    );
    expect(rows).toEqual([
      ["a", "b"],
      ["x,1", "line\n2"],
      ['say "hi"', ""],
    ]);
  });
});

// --- growing session ------------------------------------------------------

describe("growing session", () => {
  test("several rows of one session all round-trip", () => {
    const events: NewEvent[] = [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "grow-1",
        media_type: "audiobook",
        title: "Synthetic Book",
        started_at: "2026-10-17T08:15:00.000Z",
        duration_seconds: 60,
        progress: 0.1,
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "grow-1",
        media_type: "audiobook",
        title: "Synthetic Book",
        started_at: "2026-10-17T08:15:00.000Z",
        duration_seconds: 360,
        progress: 0.6,
      },
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "grow-1",
        media_type: "audiobook",
        title: "Synthetic Book",
        started_at: "2026-10-17T08:15:00.000Z",
        duration_seconds: 600,
        progress: 1,
      },
    ];
    const source = seed(openDb(":memory:"), events);

    for (const format of ["json", "csv"] as const) {
      const target = openDb(":memory:");
      const text = format === "json" ? exportJson(source) : exportCsv(source);
      const result = importNative(target, text, format);

      expect(result.inserted).toBe(3);
      expect(count(target, "events")).toBe(3);
      expect(count(target, "events_latest")).toBe(1);
      expect(comparableRows(target)).toEqual(comparableRows(source));
    }
  });
});

// --- invalid rows are atomic ----------------------------------------------

describe("invalid imports", () => {
  test("a missing required field fails the import and writes nothing", () => {
    const db = openDb(":memory:");
    const bad = JSON.stringify({
      format: "inputtracker-export",
      version: 1,
      events: [
        {
          source_kind: "manual",
          source_id: "m-1",
          media_type: "book",
          started_at: "2026-10-17T00:00:00.000Z",
        },
      ],
    });

    expect(() => importNative(db, bad, "json")).toThrow(/source/i);
    expect(count(db, "events")).toBe(0);

    const run = db
      .query<IngestRunRow, []>("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1;")
      .get();
    expect(run?.source).toBe("native-import");
    expect(run?.status).toBe("failed");
    expect(run?.error).not.toBeNull();
  });

  test("an invalid row after a valid one still writes nothing (rollback)", () => {
    const db = openDb(":memory:");
    const bad = JSON.stringify({
      format: "inputtracker-export",
      version: 1,
      events: [
        {
          source: "manual",
          source_kind: "manual",
          source_id: "ok-1",
          media_type: "book",
          started_at: "2026-10-17T00:00:00.000Z",
        },
        {
          source: "manual",
          source_kind: "manual",
          source_id: "bad-1",
          media_type: "book",
          started_at: "not-a-timestamp",
        },
      ],
    });

    expect(() => importNative(db, bad, "json")).toThrow(/timestamp/i);
    expect(count(db, "events")).toBe(0);
  });

  test("an invalid envelope writes nothing and starts no run", () => {
    const db = openDb(":memory:");
    expect(() =>
      importNative(db, '{"format":"nope","version":1,"events":[]}', "json")
    ).toThrow(/format/i);
    expect(count(db, "events")).toBe(0);
    expect(count(db, "ingest_runs")).toBe(0);
  });

  test("a CSV export missing a column writes nothing and starts no run", () => {
    const db = openDb(":memory:");
    expect(() => importNative(db, "source,source_kind\nx,y\n", "csv")).toThrow(
      /missing column/i
    );
    expect(count(db, "events")).toBe(0);
    expect(count(db, "ingest_runs")).toBe(0);
  });
});

// --- detectFormat ---------------------------------------------------------

describe("detectFormat", () => {
  test("uses extensions and falls back to sniffing", () => {
    expect(detectFormat("archive.json")).toBe("json");
    expect(detectFormat("/tmp/ARCHIVE.CSV")).toBe("csv");
    expect(detectFormat('{"format":"inputtracker-export"}')).toBe("json");
    expect(detectFormat("no-extension")).toBeNull();
  });
});

// --- CLI ------------------------------------------------------------------

describe("CLI import", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-import-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeArchive(name: string, format: "json" | "csv"): string {
    const source = seed(openDb(":memory:"));
    const path = join(tempDir, name);
    const text = format === "json" ? exportJson(source) : exportCsv(source);
    writeFileSync(path, text, "utf8");
    return path;
  }

  function cliDeps(dbPath: string): {
    loadConfig: () => Config;
    readFile: (path: string) => string;
    out: (line: string) => void;
    err: (line: string) => void;
    captured: { out: string; err: string };
  } {
    const captured = { out: "", err: "" };
    return {
      loadConfig: () =>
        ({ storage: { db_path: dbPath } }) as unknown as Config,
      readFile: (path) => readFileSync(path, "utf8"),
      out: (line) => {
        captured.out += `${line}\n`;
      },
      err: (line) => {
        captured.err += `${line}\n`;
      },
      captured,
    };
  }

  test("import <file.json> infers JSON and loads the rows", async () => {
    const file = writeArchive("archive.json", "json");
    const dbPath = join(tempDir, "import-json.db");
    const deps = cliDeps(dbPath);

    const code = await runCli(["import", file], deps);

    expect(code).toBe(0);
    expect(deps.captured.err).toBe("");
    expect(deps.captured.out).toContain(
      `imported 3 new of 3 events from ${file}`
    );

    const db = openDb(dbPath);
    expect(count(db, "events")).toBe(3);
    db.close();
  });

  test("import <file.csv> --format csv loads the rows", async () => {
    const file = writeArchive("archive.data", "csv");
    const dbPath = join(tempDir, "import-csv.db");
    const deps = cliDeps(dbPath);

    const code = await runCli(["import", file, "--format", "csv"], deps);

    expect(code).toBe(0);
    expect(deps.captured.out).toContain(
      `imported 3 new of 3 events from ${file}`
    );

    const db = openDb(dbPath);
    expect(count(db, "events")).toBe(3);
    db.close();
  });

  test("importing twice into the same DB reports 0 new", async () => {
    const file = writeArchive("archive.json", "json");
    const dbPath = join(tempDir, "import-twice.db");
    const first = cliDeps(dbPath);
    await runCli(["import", file], first);
    const second = cliDeps(dbPath);

    const code = await runCli(["import", file], second);

    expect(code).toBe(0);
    expect(second.captured.out).toContain(
      `imported 0 new of 3 events from ${file}`
    );
  });

  test("missing file argument → usage and exit 1", async () => {
    const deps = cliDeps(join(tempDir, "x.db"));
    const code = await runCli(["import"], deps);

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("Missing <file>.");
    expect(deps.captured.err).toContain("Usage: it");
  });

  test("unknown extension without --format → usage and exit 1", async () => {
    const deps = cliDeps(join(tempDir, "x.db"));
    const code = await runCli(["import", "archive.bin"], deps);

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("Cannot infer format");
    expect(deps.captured.err).toContain("Usage: it");
  });

  test("invalid --format → usage and exit 1", async () => {
    const deps = cliDeps(join(tempDir, "x.db"));
    const code = await runCli(["import", "archive.json", "--format", "xml"], deps);

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("Invalid --format: xml");
  });

  test("unknown option → usage and exit 1", async () => {
    const deps = cliDeps(join(tempDir, "x.db"));
    const code = await runCli(["import", "archive.json", "--bogus"], deps);

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("Unknown option: --bogus");
  });

  test("a bad import file → exit 2 with a clear message", async () => {
    const file = join(tempDir, "broken.json");
    writeFileSync(file, '{"format":"nope","version":1,"events":[]}', "utf8");
    const deps = cliDeps(join(tempDir, "broken.db"));

    const code = await runCli(["import", file], deps);

    expect(code).toBe(2);
    expect(deps.captured.err).toContain("format");
  });
});
