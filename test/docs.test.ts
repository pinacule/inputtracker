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
    expect(commands).toEqual(["sync", "auth", "add", "export", "import", "backup"]);
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

  test("ts.net hosts are only the <your-machine>.<your-tailnet> placeholder", () => {
    const allowedPrefix = "<your-machine>.<your-tailnet>";
    for (const [name, text] of files) {
      let index = text.indexOf(".ts.net");
      while (index !== -1) {
        expect(
          text.slice(0, index).endsWith(allowedPrefix),
          `${name}: a ts.net host must be the placeholder ${allowedPrefix}.ts.net`
        ).toBe(true);
        index = text.indexOf(".ts.net", index + 1);
      }
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
