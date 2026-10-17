/**
 * Documentation checks.
 *
 * These tests keep `README.md` and `DATA_FORMAT.md` in step with the code:
 * the table columns come from a fresh database, the CLI commands come from
 * `usage()`, and the install flags come from `scripts/install.sh`. They also
 * assert the docs contain no real host, path or secret.
 *
 * No network, and the database is `:memory:` so there are no temp files.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { usage } from "../src/cli/index.ts";

const REPO = join(import.meta.dir, "..");

function readDoc(name: string): string {
  return readFileSync(join(REPO, name), "utf8");
}

const README = readDoc("README.md");
const DATA_FORMAT = readDoc("DATA_FORMAT.md");
const MIGRATION = readDoc("MIGRATION.md");
const INSTALL_SH = readDoc(join("scripts", "install.sh"));

/** Column names of a table, from `PRAGMA table_info`. */
function tableColumns(table: string): string[] {
  const db = openDb(":memory:");
  try {
    return db
      .query<{ name: string }, []>(`PRAGMA table_info(${table});`)
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

/**
 * Command words listed in the `Commands:` block of `usage()`. Each command is
 * the first token of its line; the block ends at the first blank line.
 */
function cliCommands(): string[] {
  const lines = usage().split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  const commands: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      break;
    }
    const match = /^ {2}(\S+)/.exec(line);
    if (match) {
      commands.push(match[1] as string);
    }
  }
  return commands;
}

/**
 * Long option names handled by `scripts/install.sh`'s argument `case`. Anchored
 * to the start of a line so `-h|--help)` is not picked up as `--help`.
 */
function installFlags(): string[] {
  const flags: string[] = [];
  const re = /^\s+(--[a-z][a-z0-9-]*)\)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(INSTALL_SH)) !== null) {
    const flag = match[1] as string;
    if (!flags.includes(flag)) {
      flags.push(flag);
    }
  }
  return flags;
}

describe("DATA_FORMAT.md matches the database", () => {
  test("documents every column of events, ingest_runs and sync_state", () => {
    for (const table of ["events", "ingest_runs", "sync_state"]) {
      const columns = tableColumns(table);
      expect(columns.length, `${table} should have columns`).toBeGreaterThan(0);
      for (const name of columns) {
        expect(
          DATA_FORMAT,
          `DATA_FORMAT.md must document ${table}.${name}`
        ).toContain(`\`${name}\``);
      }
    }
  });

  test("mentions the events_latest view and the export format", () => {
    expect(DATA_FORMAT).toContain("events_latest");
    expect(DATA_FORMAT).toContain("inputtracker-export");
    expect(DATA_FORMAT).toContain('"format": "inputtracker-export"');
  });
});

describe("README.md matches the code", () => {
  test("mentions every top-level CLI command from usage()", () => {
    const commands = cliCommands();
    expect(commands).toEqual([
      "sync",
      "auth",
      "add",
      "export",
      "import",
      "backup",
      "doctor",
      "verify-copy",
    ]);
    for (const command of commands) {
      expect(
        README,
        `README.md must mention the 'it ${command}' command`
      ).toContain(`it ${command}`);
    }
  });

  test("mentions every scripts/install.sh flag", () => {
    const flags = installFlags().sort();
    expect(flags).toEqual(["--dry-run", "--no-build", "--no-start"]);
    for (const flag of flags) {
      expect(README, `README.md must mention ${flag}`).toContain(flag);
    }
  });
});

describe("docs contain no real host, path or secret", () => {
  const files: ReadonlyArray<readonly [string, string]> = [
    ["README.md", README],
    ["DATA_FORMAT.md", DATA_FORMAT],
    ["MIGRATION.md", MIGRATION],
  ];

  test("no absolute /home/ paths", () => {
    for (const [name, text] of files) {
      expect(text, `${name} must not contain /home/`).not.toContain("/home/");
    }
  });

  test("no literal localhost:13378", () => {
    for (const [name, text] of files) {
      expect(text, `${name} must not contain localhost:13378`).not.toContain(
        "localhost:13378"
      );
    }
  });

  test("ts.net hosts are only angle-bracket placeholders", () => {
    // A real tailnet host looks like `something.tailnet.ts.net`; only a
    // `<label>.<your-tailnet>.ts.net` placeholder is allowed (any label, e.g.
    // `<vm-name>`, so MIGRATION.md can name the PC and the VM separately).
    const placeholder = /<[a-z0-9-]+>\.<your-tailnet>\.ts\.net/g;
    for (const [name, text] of files) {
      const remaining = text.replace(placeholder, "");
      expect(
        remaining,
        `${name}: every ts.net host must be a <label>.<your-tailnet>.ts.net placeholder`
      ).not.toContain(".ts.net");
    }
  });

  test("no literal token = \"...\" with a non-placeholder value", () => {
    const re = /token\s*=\s*"([^"]*)"/gi;
    for (const [name, text] of files) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const value = match[1] as string;
        const isPlaceholder =
          value === "" || /YOUR|PLACEHOLDER|CHANGE|^<.*>$|\.\.\.|xxx/i.test(value);
        expect(
          isPlaceholder,
          `${name}: token value '${value}' is not a placeholder`
        ).toBe(true);
      }
    }
  });
});

describe("README.md documents the phase-2 sources", () => {
  test("mentions the Simkl app type and auth commands", () => {
    expect(README).toContain("it auth simkl");
    expect(README).toContain("auth simkl");
    expect(README).toContain("TV, devices & command line");
    expect(README).toContain("simkl-token.json");
  });

  test("mentions the YouTube Takeout import and the JSON export format", () => {
    expect(README).toContain("import youtube-takeout");
    expect(README).toContain("watch-history.json");

    // The Takeout steps must say to export History as JSON (HTML is unsupported).
    const start = README.indexOf("YouTube watch history");
    const end = README.indexOf("Phone install");
    expect(start, "README.md must describe the Takeout steps").toBeGreaterThan(0);
    expect(end, "the Takeout steps must come before the phone section").toBeGreaterThan(
      start
    );
    const steps = README.slice(start, end);
    expect(steps).toContain("JSON");
  });
});

describe("DATA_FORMAT.md documents the phase-2 sources", () => {
  test("names the Simkl and YouTube sources and their key fields", () => {
    expect(DATA_FORMAT).toContain("simkl");
    expect(DATA_FORMAT).toContain("youtube");
    expect(DATA_FORMAT).toContain("history_item");
    expect(DATA_FORMAT).toContain("simkl_poster");
    expect(DATA_FORMAT).toContain("youtube_video");
  });

  test("documents the Simkl source_id formats", () => {
    expect(DATA_FORMAT).toContain("movie:<simkl id>:<started_at>");
    expect(DATA_FORMAT).toContain(
      "ep:<show simkl id>:<season>:<episode>:<started_at>"
    );
  });
});

describe("MIGRATION.md documents the move checks", () => {
  test("mentions the doctor and verify-copy commands", () => {
    expect(MIGRATION).toContain("it doctor");
    expect(MIGRATION).toContain("it verify-copy");
  });

  test("uses the correct sync/backup unit names", () => {
    expect(MIGRATION).toContain("inputtracker-sync@audiobookshelf.timer");
    expect(MIGRATION).toContain("inputtracker-sync@simkl.timer");
    expect(MIGRATION).toContain("inputtracker-backup.timer");
    // The old doc used a non-existent `--now` flag and a wrong unit glob.
    expect(MIGRATION).not.toContain("backup --now");
    expect(MIGRATION).not.toContain("inputtracker-sync-*");
  });
});
