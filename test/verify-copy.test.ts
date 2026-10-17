/**
 * `it verify-copy` tests — two real temp SQLite databases, no network.
 *
 * Both databases are created with `openDb` + synthetic events, then compared by
 * `runVerifyCopy` (and once through `runCli`). The tests also assert that the
 * comparison leaves both files byte-for-byte unchanged and creates no `-wal`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import { runVerifyCopy } from "../src/cli/verify-copy.ts";
import type { Config } from "../src/core/config.ts";
import { migrations, openDb } from "../src/core/db.ts";
import {
  insertEvents,
  recordHash,
  startRun,
  type NewEvent,
} from "../src/core/events.ts";

/** Highest schema version the code knows; tests must not hard-code it. */
const LATEST_SCHEMA = Math.max(...migrations.map((m) => m.version));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "it-verify-copy-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A synthetic manual event; `i` makes the record hash unique. */
function evt(i: number): NewEvent {
  const day = String((i % 28) + 1).padStart(2, "0");
  return {
    source: "manual",
    source_kind: "manual",
    source_id: `synthetic-${i}`,
    media_type: "movie",
    title: `Synthetic Movie ${i}`,
    started_at: `2026-10-${day}T10:00:00.000Z`,
  };
}

/** Create a DB at `path` holding the events for the given indices. */
function makeDb(path: string, ids: number[]): void {
  const db = openDb(path);
  const run = startRun(db, "test");
  insertEvents(db, run, ids.map(evt));
  db.close();
}

function configFor(dbPath: string): Config {
  return { storage: { db_path: dbPath } } as unknown as Config;
}

interface Captured {
  lines: string[];
  errs: string[];
}

function deps(config: Config, captured: Captured) {
  return {
    loadConfig: () => config,
    out: (line: string) => captured.lines.push(line),
    err: (line: string) => captured.errs.push(line),
    usage: () => "usage-test",
  };
}

const HASH_LINE = /^ {2}[0-9a-f]{64}$/;

describe("it verify-copy", () => {
  test("an identical copy exits 0 with `copy OK`", () => {
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");
    makeDb(refPath, [0, 1, 2, 3, 4]);
    makeDb(copyPath, [0, 1, 2, 3, 4]);

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy([copyPath], deps(configFor(refPath), captured));

    expect(code).toBe(0);
    expect(captured.errs).toEqual([]);
    const text = captured.lines.join("\n");
    expect(text).toContain("reference events: 5");
    expect(text).toContain("copy events: 5");
    expect(text).toContain("missing in copy: 0");
    expect(text).toContain("extra in copy: 0");
    expect(text).toContain("copy OK: every event present");
    expect(text).not.toContain("WARN");
  });

  test("a copy missing rows exits 1 and prints the count and at most 5 hashes", () => {
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");
    const ids = Array.from({ length: 10 }, (_, i) => i);
    makeDb(refPath, ids);
    // Copy holds only the first two: eight are missing.
    makeDb(copyPath, [0, 1]);

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy([copyPath], deps(configFor(refPath), captured));
    const text = captured.lines.join("\n");

    expect(code).toBe(1);
    expect(text).toContain("reference events: 10");
    expect(text).toContain("copy events: 2");
    expect(text).toContain("missing in copy: 8");
    // Exactly five hashes are listed, not eight.
    const hashLines = captured.lines.filter((line) => HASH_LINE.test(line));
    expect(hashLines).toHaveLength(5);
    // The five printed hashes are among the genuinely missing ones.
    const missingHashes = ids.slice(2).map((i) => recordHash(evt(i)));
    for (const line of hashLines) {
      expect(missingHashes).toContain(line.slice(2));
    }
    expect(text).not.toContain("copy OK");
  });

  test("a copy with extra rows exits 0 and reports the extra count", () => {
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");
    makeDb(refPath, [0, 1, 2]);
    makeDb(copyPath, [0, 1, 2, 3, 4]);

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy([copyPath], deps(configFor(refPath), captured));
    const text = captured.lines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("missing in copy: 0");
    expect(text).toContain("extra in copy: 2");
    expect(text).toContain("copy OK: every event present");
  });

  test("a schema version mismatch prints a WARN but still exits 0", () => {
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");
    makeDb(refPath, [0, 1]);
    makeDb(copyPath, [0, 1]);
    const copy = openDb(copyPath);
    copy.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);", [
      99,
      "2026-01-01T00:00:00.000Z",
    ]);
    copy.close();

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy([copyPath], deps(configFor(refPath), captured));
    const text = captured.lines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain(`schema: reference v${LATEST_SCHEMA}, copy v99`);
    expect(text).toContain("WARN schema version differs");
  });

  test("a missing copy file exits 2 with a clear message", () => {
    const refPath = join(root, "ref.db");
    makeDb(refPath, [0]);

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy(
      [join(root, "does-not-exist.db")],
      deps(configFor(refPath), captured)
    );

    expect(code).toBe(2);
    expect(captured.errs.join("\n")).toContain("copy database not found");
  });

  test("a non-SQLite copy exits 2 with a clear message", () => {
    const refPath = join(root, "ref.db");
    makeDb(refPath, [0]);
    const junkPath = join(root, "junk.db");
    writeFileSync(junkPath, "this is not a sqlite database");

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy([junkPath], deps(configFor(refPath), captured));

    expect(code).toBe(2);
    expect(captured.errs.join("\n")).toContain("not a readable database");
  });

  test("a missing argument exits 1 with usage", () => {
    const refPath = join(root, "ref.db");
    makeDb(refPath, [0]);

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy([], deps(configFor(refPath), captured));

    expect(code).toBe(1);
    expect(captured.errs.join("\n")).toContain("Missing <copy.db>");
    expect(captured.errs.join("\n")).toContain("usage-test");
  });

  test("leaves both databases unmodified (no new files, same bytes)", () => {
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");
    makeDb(refPath, [0, 1, 2]);
    makeDb(copyPath, [0, 1, 2]);

    const before = readdirSync(root).sort();
    const refBefore = readFileSync(refPath);
    const copyBefore = readFileSync(copyPath);

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy([copyPath], deps(configFor(refPath), captured));

    expect(code).toBe(0);
    // No file (and no `-wal`/`-shm`) is created or removed, and neither database
    // file changes byte-for-byte.
    expect(readdirSync(root).sort()).toEqual(before);
    expect(readFileSync(refPath).equals(refBefore)).toBe(true);
    expect(readFileSync(copyPath).equals(copyBefore)).toBe(true);
  });

  test("a snapshot copy (no WAL sidecars) gains no `-wal`", () => {
    // A `VACUUM INTO` snapshot is a self-contained, cleanly closed database.
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");
    const base = openDb(join(root, "base.db"));
    const run = startRun(base, "test");
    insertEvents(base, run, [evt(0), evt(1)]);
    base.run("VACUUM INTO ?", [refPath]);
    base.run("VACUUM INTO ?", [copyPath]);
    base.close();

    expect(existsSync(`${refPath}-wal`)).toBe(false);
    expect(existsSync(`${copyPath}-wal`)).toBe(false);

    const captured: Captured = { lines: [], errs: [] };
    const code = runVerifyCopy([copyPath], deps(configFor(refPath), captured));

    expect(code).toBe(0);
    expect(existsSync(`${refPath}-wal`)).toBe(false);
    expect(existsSync(`${refPath}-shm`)).toBe(false);
    expect(existsSync(`${copyPath}-wal`)).toBe(false);
    expect(existsSync(`${copyPath}-shm`)).toBe(false);
  });

  test("is wired into runCli", async () => {
    const refPath = join(root, "ref.db");
    const copyPath = join(root, "copy.db");
    makeDb(refPath, [0, 1]);
    makeDb(copyPath, [0]);

    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runCli(["verify-copy", copyPath], {
      loadConfig: () => configFor(refPath),
      out: (line) => lines.push(line),
      err: (line) => errs.push(line),
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("missing in copy: 1");
  });
});
