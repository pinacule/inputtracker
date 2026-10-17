/**
 * `it doctor` tests — every environment dependency is mocked.
 *
 * The database checks use real temp files (that is what makes "read-only, no
 * file created" meaningful), but the architecture, config, PATH, spawned
 * commands and port probe are all injected. Nothing here touches the network,
 * the real config or the real user's systemd session.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  runDoctor,
  type DoctorDeps,
  type DoctorRunResult,
} from "../src/cli/doctor.ts";
import { loadConfig, type Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { simklTokenPath } from "../src/sources/simkl/token.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "it-doctor-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface MakeConfigOptions {
  dbPath: string;
  backupDir: string;
  url?: string;
  token?: string;
  clientId?: string;
}

/** A plain synthetic `Config` good enough for doctor (no real file is read). */
function makeConfig(opts: MakeConfigOptions): Config {
  return {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: opts.dbPath, backup_dir: opts.backupDir, backup_keep: 14 },
    audiobookshelf: {
      url: opts.url ?? "http://abs.example:13378",
      token: opts.token ?? "",
      timeout_s: 20,
    },
    simkl: {
      client_id: opts.clientId ?? "",
      base_url: "https://api.simkl.com",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: { desktop: true, ntfy_url: "" },
    toJSON: () => ({}),
    toString: () => "{}",
  };
}

/** All-OK deps with per-test overrides; output is captured into `lines`. */
function makeDeps(
  config: Config,
  lines: string[],
  over: Partial<DoctorDeps> = {}
): DoctorDeps {
  return {
    arch: "x64",
    bunVersion: "1.2.3",
    loadConfig: () => config,
    exists: (path) => existsSync(path),
    isWritableDir: () => true,
    which: (cmd) => `/usr/bin/${cmd}`,
    run: (cmd): DoctorRunResult =>
      cmd === "systemctl"
        ? { code: 0, stdout: "running\n" }
        : { code: 0, stdout: "Linger=yes\n" },
    isPortFree: () => true,
    env: {},
    user: "tester",
    out: (line) => lines.push(line),
    ...over,
  };
}

/** Create a real temp DB with the given schema_migrations version. */
function makeDb(path: string, version = 1): void {
  const db = openDb(path);
  if (version !== 1) {
    db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);", [
      version,
      new Date().toISOString(),
    ]);
  }
  db.close();
}

describe("it doctor", () => {
  test("an all-OK environment exits 0 and prints every check as OK", async () => {
    const dbPath = join(root, "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    makeDb(dbPath);
    const config = makeConfig({ dbPath, backupDir });
    const lines: string[] = [];

    const code = await runDoctor(makeDeps(config, lines));
    const text = lines.join("\n");

    expect(code).toBe(0);
    for (const name of [
      "arch",
      "bun",
      "config",
      "db",
      "backup_dir",
      "port",
      "systemd",
      "linger",
      "tailscale",
    ]) {
      expect(text, `expected a line for ${name}`).toContain(`${name}:`);
    }
    expect(text).toContain("OK   arch: x86_64");
    expect(text).toContain("OK   bun: 1.2.3");
    expect(text).toContain("schema v1 (latest)");
    expect(text).not.toContain("FAIL");
    expect(text).not.toContain("WARN");
  });

  test("an unsupported architecture fails and exits 1", async () => {
    const dbPath = join(root, "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    makeDb(dbPath);
    const lines: string[] = [];

    const code = await runDoctor(
      makeDeps(makeConfig({ dbPath, backupDir }), lines, { arch: "riscv64" })
    );

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain(
      "FAIL arch: unsupported architecture: riscv64"
    );
  });

  test("a config load error fails with a redacted message and skips config checks", async () => {
    const dbPath = join(root, "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    makeDb(dbPath);

    // Seed the active config so `redact()` knows the token to mask.
    const cfgFile = join(root, "inputtracker.config.toml");
    writeFileSync(cfgFile, '[audiobookshelf]\ntoken = "test-abs-token-123"\n');
    loadConfig({ path: cfgFile, env: {} });

    const lines: string[] = [];
    const code = await runDoctor(
      makeDeps(makeConfig({ dbPath, backupDir }), lines, {
        loadConfig: () => {
          throw new Error('invalid config: token = "test-abs-token-123"');
        },
      })
    );

    const text = lines.join("\n");
    expect(code).toBe(1);
    expect(text).toContain("FAIL config:");
    expect(text).toContain("***");
    expect(text).not.toContain("test-abs-token-123");
    // Checks that need the config are skipped.
    expect(text).not.toContain("backup_dir:");
    expect(text).not.toContain("port:");
  });

  test("a database newer than the latest known version fails", async () => {
    const dbPath = join(root, "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    makeDb(dbPath, 99);
    const lines: string[] = [];

    const code = await runDoctor(makeDeps(makeConfig({ dbPath, backupDir }), lines));
    const text = lines.join("\n");

    expect(code).toBe(1);
    expect(text).toContain("FAIL db:");
    expect(text).toContain("schema v99");
    expect(text).toContain("newer");
  });

  test("a database older than the latest known version warns but exits 0", async () => {
    const dbPath = join(root, "old.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    const raw = new Database(dbPath);
    raw.run(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"
    );
    raw.run("INSERT INTO schema_migrations VALUES (0, '2026-01-01T00:00:00.000Z');");
    raw.close();
    const lines: string[] = [];

    const code = await runDoctor(makeDeps(makeConfig({ dbPath, backupDir }), lines));
    const text = lines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("WARN db:");
    expect(text).toContain("schema v0");
    expect(text).toContain("migrates on next start");
  });

  test("a missing DB with a writable parent is OK and creates no file", async () => {
    const dbPath = join(root, "nested", "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    const lines: string[] = [];

    const code = await runDoctor(makeDeps(makeConfig({ dbPath, backupDir }), lines));
    const text = lines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("OK   db:");
    expect(text).toContain("will be created");
    expect(existsSync(dbPath)).toBe(false);
  });

  test("an unwritable backup directory fails", async () => {
    const dbPath = join(root, "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    makeDb(dbPath);
    const lines: string[] = [];

    const code = await runDoctor(
      makeDeps(makeConfig({ dbPath, backupDir }), lines, {
        isWritableDir: (path) => path !== backupDir,
      })
    );

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain(`FAIL backup_dir: ${backupDir} not writable`);
  });

  test("port in use, no linger, no tailscale and no systemctl are warnings only", async () => {
    const dbPath = join(root, "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    makeDb(dbPath);
    const lines: string[] = [];

    const code = await runDoctor(
      makeDeps(makeConfig({ dbPath, backupDir }), lines, {
        isPortFree: () => false,
        which: (cmd) => (cmd === "loginctl" ? "/usr/bin/loginctl" : null),
        run: () => ({ code: 1, stdout: "Linger=no\n" }),
      })
    );
    const text = lines.join("\n");

    expect(code).toBe(0);
    expect(text).not.toContain("FAIL");
    expect(text).toContain("WARN port:");
    expect(text).toContain("WARN systemd:");
    expect(text).toContain("WARN linger:");
    expect(text).toContain("WARN tailscale:");
    expect(text).toContain("loginctl enable-linger tester");
  });

  test("never prints the ABS or Simkl token values", async () => {
    const dbPath = join(root, "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    makeDb(dbPath);
    const config = makeConfig({
      dbPath,
      backupDir,
      token: "test-abs-token-123",
      clientId: "fake-client-id",
    });
    const tokenFile = simklTokenPath(config);
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(
      tokenFile,
      JSON.stringify({
        access_token: "simkl_at_fake123",
        refresh_token: "simkl_rt_fake456",
        scope: "media:read",
        expires_at: "2030-01-01T00:00:00.000Z",
        obtained_at: "2026-01-01T00:00:00.000Z",
      })
    );
    const lines: string[] = [];

    const code = await runDoctor(makeDeps(config, lines));
    const text = lines.join("\n");

    expect(code).toBe(0);
    expect(text).toContain("audiobookshelf token: set");
    expect(text).toContain("simkl client_id: set");
    expect(text).toContain("simkl token file: present");
    expect(text).not.toContain("test-abs-token-123");
    expect(text).not.toContain("simkl_at_fake123");
    expect(text).not.toContain("simkl_rt_fake456");
  });

  test("leaves the database file unchanged and creates no sidecars", async () => {
    const dbPath = join(root, "inputtracker.db");
    const backupDir = join(root, "backups");
    mkdirSync(backupDir);
    makeDb(dbPath);

    const before = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath).mtimeMs;

    const lines: string[] = [];
    const code = await runDoctor(makeDeps(makeConfig({ dbPath, backupDir }), lines));

    expect(code).toBe(0);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(statSync(dbPath).mtimeMs).toBe(beforeMtime);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
