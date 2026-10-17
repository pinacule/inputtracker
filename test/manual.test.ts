import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { localParts } from "../src/core/time.ts";
import type { EventRow, IngestRunRow } from "../src/core/schema.ts";
import {
  addManual,
  localToUtcIso,
  MANUAL_SOURCE,
  MANUAL_SOURCE_KIND,
  validateManual,
  type ManualInput,
} from "../src/io/manual.ts";

const TZ = "Europe/Bratislava";

// --- helpers ---------------------------------------------------------------

function manualInput(overrides: Partial<ManualInput> = {}): ManualInput {
  return {
    media_type: "movie",
    title: "Synthetic Movie",
    started_at: "2026-10-17 21:30",
    ...overrides,
  };
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  throw new Error("expected function to throw");
}

function count(db: Database, table: string): number {
  return (
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table};`).get()?.n ?? 0
  );
}

// --- localToUtcIso ---------------------------------------------------------

describe("localToUtcIso", () => {
  test("summer wall-clock time (CEST, +02:00)", () => {
    expect(localToUtcIso("2026-10-17 21:30", TZ)).toBe("2026-10-17T19:30:00.000Z");
  });

  test("winter wall-clock time (CET, +01:00)", () => {
    expect(localToUtcIso("2026-01-15 21:30", TZ)).toBe("2026-01-15T20:30:00.000Z");
  });

  test("space and T separators agree; seconds are optional", () => {
    expect(localToUtcIso("2026-10-17T21:30", TZ)).toBe("2026-10-17T19:30:00.000Z");
    expect(localToUtcIso("2026-10-17 21:30:45", TZ)).toBe("2026-10-17T19:30:45.000Z");
  });

  test("a bare date is local midnight", () => {
    expect(localToUtcIso("2026-10-17", TZ)).toBe("2026-10-16T22:00:00.000Z");
  });

  test("round-trips back to the requested local wall clock", () => {
    const utc = localToUtcIso("2026-10-17 21:30", TZ);
    const parts = localParts(utc, TZ);
    expect(parts.date).toBe("2026-10-17");
    expect(parts.hour).toBe(21);
  });

  test("spring-forward gap shifts the time forward (2026-03-29)", () => {
    // 02:30 does not exist; it is shifted forward to 03:30 local (01:30Z).
    expect(localToUtcIso("2026-03-29 02:30", TZ)).toBe("2026-03-29T01:30:00.000Z");
    // A time just inside the gap behaves the same way.
    expect(localToUtcIso("2026-03-29 02:00", TZ)).toBe("2026-03-29T01:00:00.000Z");
    // Times outside the gap are exact.
    expect(localToUtcIso("2026-03-29 01:30", TZ)).toBe("2026-03-29T00:30:00.000Z");
    expect(localToUtcIso("2026-03-29 03:30", TZ)).toBe("2026-03-29T01:30:00.000Z");
  });

  test("fall-back ambiguity picks the first (earlier) occurrence (2026-10-25)", () => {
    // 02:30 happens twice; the first occurrence is CEST (+02:00).
    expect(localToUtcIso("2026-10-25 02:30", TZ)).toBe("2026-10-25T00:30:00.000Z");
    expect(localToUtcIso("2026-10-25 02:00", TZ)).toBe("2026-10-25T00:00:00.000Z");
  });

  test("explicit Z or offset is respected, not reinterpreted", () => {
    expect(localToUtcIso("2026-10-17T21:30:00Z", TZ)).toBe("2026-10-17T21:30:00.000Z");
    expect(localToUtcIso("2026-10-17T21:30:00+02:00", TZ)).toBe(
      "2026-10-17T19:30:00.000Z"
    );
    expect(localToUtcIso("2026-10-17 21:30+02:00", TZ)).toBe(
      "2026-10-17T19:30:00.000Z"
    );
  });

  test("another timezone (America/New_York)", () => {
    expect(localToUtcIso("2026-10-17 21:30", "America/New_York")).toBe(
      "2026-10-18T01:30:00.000Z"
    );
    expect(localToUtcIso("2026-01-15 21:30", "America/New_York")).toBe(
      "2026-01-16T02:30:00.000Z"
    );
  });

  test("UTC is a passthrough", () => {
    expect(localToUtcIso("2026-10-17 21:30", "UTC")).toBe("2026-10-17T21:30:00.000Z");
  });

  test("invalid input throws", () => {
    expect(() => localToUtcIso("", TZ)).toThrow();
    expect(() => localToUtcIso("   ", TZ)).toThrow();
    expect(() => localToUtcIso("not-a-date", TZ)).toThrow();
    expect(() => localToUtcIso("2026-13-01", TZ)).toThrow();
    expect(() => localToUtcIso("2026-02-30", TZ)).toThrow();
    expect(() => localToUtcIso("2026-10-17 25:00", TZ)).toThrow();
    expect(() => localToUtcIso("2026-10-17 21:60", TZ)).toThrow();
    expect(() => localToUtcIso("2026-10-17 21:30:60", TZ)).toThrow();
  });

  test("an unknown timezone throws a clear error", () => {
    expect(() => localToUtcIso("2026-10-17 21:30", "Not/AZone")).toThrow(/timezone/i);
  });
});

// --- validateManual --------------------------------------------------------

describe("validateManual", () => {
  test("builds a manual NewEvent with the injected id and UTC time", () => {
    const event = validateManual(manualInput(), TZ, { newId: () => "fixed-id" });

    expect(event.source).toBe(MANUAL_SOURCE);
    expect(event.source_kind).toBe(MANUAL_SOURCE_KIND);
    expect(event.source_id).toBe("fixed-id");
    expect(event.media_type).toBe("movie");
    expect(event.title).toBe("Synthetic Movie");
    expect(event.started_at).toBe("2026-10-17T19:30:00.000Z");
    expect(event.ended_at).toBeNull();
    expect(event.duration_seconds).toBeNull();
    expect(event.progress).toBeNull();
    expect(event.raw).toBeNull();
  });

  test("trims the title", () => {
    const event = validateManual(manualInput({ title: "  Spaced Title  " }), TZ, {
      newId: () => "id",
    });
    expect(event.title).toBe("Spaced Title");
  });

  test("keeps valid optional fields", () => {
    const event = validateManual(
      manualInput({
        parent_title: "Synthetic Author",
        season: 2,
        episode: 3,
        progress: 0.5,
        duration_seconds: 600,
        device: "Synthetic Phone",
        ended_at: "2026-10-17 22:00",
        external_ids: { imdb: "tt0000000" },
      }),
      TZ,
      { newId: () => "id" }
    );

    expect(event.parent_title).toBe("Synthetic Author");
    expect(event.season).toBe(2);
    expect(event.episode).toBe(3);
    expect(event.progress).toBe(0.5);
    expect(event.duration_seconds).toBe(600);
    expect(event.device).toBe("Synthetic Phone");
    expect(event.ended_at).toBe("2026-10-17T20:00:00.000Z");
    expect(event.external_ids).toEqual({ imdb: "tt0000000" });
  });

  test("allows zero duration and progress bounds", () => {
    const event = validateManual(
      manualInput({ duration_seconds: 0, progress: 0 }),
      TZ,
      { newId: () => "id" }
    );
    expect(event.duration_seconds).toBe(0);
    expect(event.progress).toBe(0);
  });

  test("missing required fields are reported together", () => {
    const message = thrownMessage(() =>
      validateManual({} as ManualInput, TZ, { newId: () => "id" })
    );
    expect(message).toContain("media_type");
    expect(message).toContain("title");
    expect(message).toContain("started_at");
  });

  test("blank/whitespace title is rejected", () => {
    expect(thrownMessage(() => validateManual(manualInput({ title: "   " }), TZ))).toMatch(
      /title/i
    );
  });

  test("invalid media_type is rejected", () => {
    const message = thrownMessage(() =>
      validateManual(manualInput({ media_type: "xml" as never }), TZ)
    );
    expect(message).toContain("Invalid media_type: 'xml'");
  });

  test("bad progress is rejected", () => {
    expect(
      thrownMessage(() => validateManual(manualInput({ progress: 1.5 }), TZ))
    ).toMatch(/progress/i);
    expect(
      thrownMessage(() => validateManual(manualInput({ progress: -0.1 }), TZ))
    ).toMatch(/progress/i);
    expect(
      thrownMessage(() =>
        validateManual(manualInput({ progress: "half" as never }), TZ)
      )
    ).toMatch(/progress/i);
  });

  test("negative / non-finite duration is rejected", () => {
    expect(
      thrownMessage(() => validateManual(manualInput({ duration_seconds: -5 }), TZ))
    ).toMatch(/duration_seconds/i);
    expect(
      thrownMessage(() =>
        validateManual(manualInput({ duration_seconds: Number.NaN }), TZ)
      )
    ).toMatch(/duration_seconds/i);
  });

  test("season and episode must be integers >= 0", () => {
    expect(
      thrownMessage(() => validateManual(manualInput({ season: -1 }), TZ))
    ).toMatch(/season/i);
    expect(
      thrownMessage(() => validateManual(manualInput({ episode: 1.5 }), TZ))
    ).toMatch(/episode/i);
  });

  test("ended_at before started_at is rejected", () => {
    expect(
      thrownMessage(() =>
        validateManual(manualInput({ ended_at: "2026-10-17 20:00" }), TZ)
      )
    ).toMatch(/ended_at must not be before started_at/);
  });

  test("collects several problems in one error", () => {
    const message = thrownMessage(() =>
      validateManual(
        { media_type: "xml", title: "  ", started_at: "bad", progress: 2 } as unknown as ManualInput,
        TZ
      )
    );
    expect(message).toContain("Invalid media_type");
    expect(message).toContain("title");
    expect(message).toContain("started_at");
    expect(message).toContain("progress");
  });
});

// --- addManual -------------------------------------------------------------

describe("addManual", () => {
  test("inserts one manual row and records an ingest run", () => {
    const db = openDb(":memory:");
    const result = addManual(db, manualInput(), TZ, { newId: () => "manual-abc" });

    expect(result.id).toBe("manual-abc");
    expect(result.inserted).toBe(1);
    expect(result.runId).toBeGreaterThan(0);

    const row = db.query<EventRow, []>("SELECT * FROM events;").get();
    expect(row?.source).toBe("manual");
    expect(row?.source_kind).toBe("history_item");
    expect(row?.source_id).toBe("manual-abc");
    expect(row?.started_at).toBe("2026-10-17T19:30:00.000Z");
    expect(row?.ingest_run_id).toBe(result.runId);

    const run = db
      .query<IngestRunRow, [number]>("SELECT * FROM ingest_runs WHERE id = ?;")
      .get(result.runId);
    expect(run?.source).toBe("manual");
    expect(run?.status).toBe("ok");
    expect(run?.rows_seen).toBe(1);
    expect(run?.rows_inserted).toBe(1);
    expect(run?.finished_at).not.toBeNull();
    db.close();
  });

  test("two entries with different ids produce two rows", () => {
    const db = openDb(":memory:");
    let n = 0;
    addManual(db, manualInput({ title: "First" }), TZ, { newId: () => `id-${++n}` });
    addManual(db, manualInput({ title: "Second" }), TZ, { newId: () => `id-${++n}` });

    expect(count(db, "events")).toBe(2);
    expect(count(db, "events_latest")).toBe(2);
    expect(count(db, "ingest_runs")).toBe(2);
    db.close();
  });

  test("the same id twice is deduplicated but still records a run", () => {
    const db = openDb(":memory:");
    const first = addManual(db, manualInput(), TZ, { newId: () => "same-id" });
    const second = addManual(db, manualInput(), TZ, { newId: () => "same-id" });

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(count(db, "events")).toBe(1);
    expect(count(db, "ingest_runs")).toBe(2);
    db.close();
  });

  test("invalid input leaves no row and no run", () => {
    const db = openDb(":memory:");
    expect(() =>
      addManual(db, manualInput({ progress: 3 }), TZ, { newId: () => "bad" })
    ).toThrow(/progress/i);
    expect(count(db, "events")).toBe(0);
    expect(count(db, "ingest_runs")).toBe(0);
    db.close();
  });
});

// --- CLI -------------------------------------------------------------------

describe("CLI add", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-manual-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function cliDeps(dbPath: string): {
    loadConfig: () => Config;
    newId: () => string;
    out: (line: string) => void;
    err: (line: string) => void;
    captured: { out: string; err: string };
  } {
    const captured = { out: "", err: "" };
    let n = 0;
    return {
      loadConfig: () =>
        ({ storage: { db_path: dbPath }, timezone: TZ }) as unknown as Config,
      newId: () => `uuid-${++n}`,
      out: (line) => {
        captured.out += `${line}\n`;
      },
      err: (line) => {
        captured.err += `${line}\n`;
      },
      captured,
    };
  }

  test("adds an entry and prints it", async () => {
    const dbPath = join(tempDir, "add.db");
    const deps = cliDeps(dbPath);

    const code = await runCli(
      ["add", "--type", "movie", "--title", "Synthetic Movie", "--start", "2026-10-17 21:30"],
      deps
    );

    expect(code).toBe(0);
    expect(deps.captured.err).toBe("");
    expect(deps.captured.out).toContain("added Synthetic Movie (uuid-1)");

    const db = openDb(dbPath);
    const row = db.query<EventRow, []>("SELECT * FROM events;").get();
    expect(row?.source).toBe("manual");
    expect(row?.source_kind).toBe("history_item");
    expect(row?.source_id).toBe("uuid-1");
    expect(row?.started_at).toBe("2026-10-17T19:30:00.000Z");
    db.close();
  });

  test("--end derives duration_seconds", async () => {
    const dbPath = join(tempDir, "add-end.db");
    const deps = cliDeps(dbPath);

    const code = await runCli(
      [
        "add",
        "--type",
        "movie",
        "--title",
        "Synthetic Movie",
        "--start",
        "2026-10-17 21:30",
        "--end",
        "2026-10-17 22:15",
      ],
      deps
    );

    expect(code).toBe(0);
    const db = openDb(dbPath);
    const row = db.query<EventRow, []>("SELECT * FROM events;").get();
    expect(row?.duration_seconds).toBe(45 * 60);
    db.close();
  });

  test("--duration-min converts minutes to seconds and wins over --end", async () => {
    const dbPath = join(tempDir, "add-min.db");
    const deps = cliDeps(dbPath);

    const code = await runCli(
      [
        "add",
        "--type",
        "book",
        "--title",
        "Synthetic Book",
        "--start",
        "2026-01-15 21:30",
        "--end",
        "2026-01-15 22:15",
        "--duration-min",
        "90",
      ],
      deps
    );

    expect(code).toBe(0);
    const db = openDb(dbPath);
    const row = db.query<EventRow, []>("SELECT * FROM events;").get();
    expect(row?.duration_seconds).toBe(90 * 60);
    expect(row?.started_at).toBe("2026-01-15T20:30:00.000Z");
    expect(row?.media_type).toBe("book");
    db.close();
  });

  test("missing required flag → usage and exit 1", async () => {
    const deps = cliDeps(join(tempDir, "missing.db"));
    const code = await runCli(["add", "--type", "movie", "--title", "X"], deps);

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("Missing --start.");
    expect(deps.captured.err).toContain("Usage: it");
  });

  test("invalid media_type → exit 1", async () => {
    const deps = cliDeps(join(tempDir, "bad-type.db"));
    const code = await runCli(
      ["add", "--type", "xml", "--title", "X", "--start", "2026-10-17 21:30"],
      deps
    );

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("Invalid media_type");
  });

  test("out-of-range progress → exit 1", async () => {
    const deps = cliDeps(join(tempDir, "bad-progress.db"));
    const code = await runCli(
      [
        "add",
        "--type",
        "movie",
        "--title",
        "X",
        "--start",
        "2026-10-17 21:30",
        "--progress",
        "5",
      ],
      deps
    );

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("progress");
  });

  test("unknown option → usage and exit 1", async () => {
    const deps = cliDeps(join(tempDir, "bogus.db"));
    const code = await runCli(["add", "--bogus"], deps);

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("Unknown option: --bogus");
    expect(deps.captured.err).toContain("Usage: it");
  });
});
