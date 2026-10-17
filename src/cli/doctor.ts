/**
 * `it doctor` — a read-only environment check.
 *
 * Every check prints one line as `OK   <name>: <detail>`, `WARN <name>: <detail>`
 * or `FAIL <name>: <detail>`; the command exits 1 when any check fails, else 0.
 *
 * Doctor is strictly diagnostic: it never creates, migrates or writes a
 * database, and the only connection it opens is `readonly`. All environment
 * access goes through the injectable {@link DoctorDeps} object, so tests can
 * mock the architecture, Bun version, config, filesystem, PATH lookups, spawned
 * commands and the port probe.
 *
 * Secrets never reach the output: token-like values (including a token that
 * might appear inside a config-load error) are passed through `redact()`, and
 * the Simkl token is only ever checked for existence, never read.
 */

import { Database } from "bun:sqlite";
import { accessSync, constants, existsSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname } from "node:path";

import {
  loadConfig,
  isIngestEnabled,
  redact,
  redactString,
  type Config,
  type LoadConfigOptions,
} from "../core/config.ts";
import { migrations } from "../core/db.ts";
import { simklTokenPath } from "../sources/simkl/token.ts";

export type DoctorStatus = "OK" | "WARN" | "FAIL";

export interface DoctorRunResult {
  /** Process exit code, or `null` when the command could not be started. */
  code: number | null;
  stdout: string;
}

export interface DoctorDeps {
  /** `process.arch` by default. */
  arch: string;
  /** `Bun.version` by default. */
  bunVersion: string;
  loadConfig: (opts?: LoadConfigOptions) => Config;
  exists: (path: string) => boolean;
  isWritableDir: (path: string) => boolean;
  /** Resolve a command on PATH; `null` when missing. */
  which: (cmd: string) => string | null;
  /** Run a command and capture its exit code + stdout. */
  run: (cmd: string, args: string[]) => DoctorRunResult;
  /** Try to bind `bind:port`; resolves/returns true when the port is free. */
  isPortFree: (bind: string, port: number) => boolean | Promise<boolean>;
  env: Record<string, string | undefined>;
  user: string;
  out: (line: string) => void;
}

const ARCH_NAMES: Readonly<Record<string, string>> = {
  x64: "x86_64",
  arm64: "aarch64",
};

const SYSTEMD_STATES = new Set(["running", "degraded", "starting"]);

const SIMKL_TOKEN_PATTERN = /\b(?:simkl_at_|simkl_rt_)[A-Za-z0-9_\-]+\b/gi;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mask the configured token plus any `simkl_*` token that slips into a message. */
function redactText(text: string): string {
  const stripped = text.replace(SIMKL_TOKEN_PATTERN, "***");
  try {
    return redact(stripped);
  } catch {
    return stripped;
  }
}

/**
 * Open a database read-only, run `fn`, then close it. SQLite creates empty
 * `-wal`/`-shm` sidecars for a *closed* WAL database even on a read-only
 * connection; we remove only the sidecars our own connection created (never one
 * that was already there, because a live writer owns those) so the on-disk
 * state is exactly what it was before. Nothing is ever written to the database.
 */
function withReadOnlyDb<T>(path: string, fn: (db: Database) => T): T {
  const sidecars = [`${path}-wal`, `${path}-shm`];
  const existed = sidecars.map((p) => existsSync(p));
  const db = new Database(path, { readonly: true });
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
    for (let i = 0; i < sidecars.length; i += 1) {
      const sidecar = sidecars[i] as string;
      if (existed[i] === true || !existsSync(sidecar)) {
        continue;
      }
      try {
        if (sidecar.endsWith("-wal") && statSync(sidecar).size > 0) {
          continue;
        }
        rmSync(sidecar, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

/** Highest schema version this build knows about. */
function latestKnownVersion(): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

/** Nearest existing ancestor of `path` (including `path` itself), or `null`. */
function nearestExistingDir(
  path: string,
  exists: (p: string) => boolean
): string | null {
  let dir = path;
  for (;;) {
    if (exists(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir || parent === "") {
      return null;
    }
    dir = parent;
  }
}

function defaultIsWritableDir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) {
      return false;
    }
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRun(cmd: string, args: string[]): DoctorRunResult {
  try {
    const proc = Bun.spawnSync({
      cmd: [cmd, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode ?? null,
      stdout: proc.stdout ? proc.stdout.toString() : "",
    };
  } catch {
    // A missing executable makes spawn throw; treat it as "not available".
    return { code: null, stdout: "" };
  }
}

function defaultIsPortFree(bind: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    try {
      server.listen(port, bind);
    } catch {
      resolve(false);
    }
  });
}

/** Real-system defaults for every dependency. */
export function defaultDoctorDeps(): DoctorDeps {
  return {
    arch: process.arch,
    bunVersion: Bun.version,
    loadConfig,
    exists: (path) => existsSync(path),
    isWritableDir: defaultIsWritableDir,
    which: (cmd) => Bun.which(cmd),
    run: defaultRun,
    isPortFree: defaultIsPortFree,
    env: process.env,
    user: process.env.USER ?? userInfo().username,
    out: (line) => console.log(line),
  };
}

type Emit = (status: DoctorStatus, name: string, detail: string) => void;

function configDetail(config: Config, deps: DoctorDeps): string {
  const tokenSet =
    typeof config.audiobookshelf.token === "string" &&
    config.audiobookshelf.token !== "";
  const clientIdSet =
    typeof config.simkl.client_id === "string" && config.simkl.client_id !== "";
  const tokenFile = deps.exists(simklTokenPath(config)) ? "present" : "absent";

  return [
    `timezone=${config.timezone}`,
    `server=${config.server.bind}:${config.server.port}`,
    `db_path=${config.storage.db_path}`,
    `backup_dir=${config.storage.backup_dir}`,
    `backup_keep=${config.storage.backup_keep}`,
    `audiobookshelf.url=${redactString(config.audiobookshelf.url, config)}`,
    `audiobookshelf token: ${tokenSet ? "set" : "empty"}`,
    `simkl client_id: ${clientIdSet ? "set" : "empty"}`,
    `simkl token file: ${tokenFile}`,
    `ingest: ${isIngestEnabled(config) ? "enabled" : "disabled"}`,
  ].join(", ");
}

function checkDb(config: Config, deps: DoctorDeps, record: Emit): void {
  const dbPath = config.storage.db_path;

  if (!deps.exists(dbPath)) {
    const parent = nearestExistingDir(dirname(dbPath), deps.exists);
    if (parent !== null && deps.isWritableDir(parent)) {
      record("OK", "db", `${dbPath} not found; will be created`);
    } else {
      record("FAIL", "db", `${dbPath} not found and no writable parent directory`);
    }
    return;
  }

  let version: number;
  try {
    version = withReadOnlyDb(
      dbPath,
      (db) =>
        db
          .query<{ v: number | null }, []>(
            "SELECT MAX(version) AS v FROM schema_migrations;"
          )
          .get()?.v ?? 0
    );
  } catch (caught) {
    record(
      "FAIL",
      "db",
      `cannot read ${dbPath}: ${redactText(errorText(caught))}`
    );
    return;
  }

  const latest = latestKnownVersion();
  if (version > latest) {
    record(
      "FAIL",
      "db",
      `schema v${version}, latest known v${latest} (database is newer than this code)`
    );
  } else if (version < latest) {
    record(
      "WARN",
      "db",
      `schema v${version}, latest known v${latest} (migrates on next start)`
    );
  } else {
    record("OK", "db", `schema v${version} (latest)`);
  }
}

function checkBackupDir(config: Config, deps: DoctorDeps, record: Emit): void {
  const dir = config.storage.backup_dir;

  if (deps.exists(dir)) {
    if (deps.isWritableDir(dir)) {
      record("OK", "backup_dir", `${dir} writable`);
    } else {
      record("FAIL", "backup_dir", `${dir} not writable`);
    }
    return;
  }

  const parent = nearestExistingDir(dirname(dir), deps.exists);
  if (parent !== null && deps.isWritableDir(parent)) {
    record("OK", "backup_dir", `${dir} not found; will be created`);
  } else {
    record("FAIL", "backup_dir", `${dir} not writable and no writable parent`);
  }
}

async function checkPort(
  config: Config,
  deps: DoctorDeps,
  record: Emit
): Promise<void> {
  const { bind, port } = config.server;
  let free: boolean;
  try {
    free = await deps.isPortFree(bind, port);
  } catch {
    free = false;
  }
  if (free) {
    record("OK", "port", `${bind}:${port} free`);
  } else {
    record(
      "WARN",
      "port",
      `${bind}:${port} in use (fine if inputtracker.service is already running)`
    );
  }
}

function checkSystemd(deps: DoctorDeps, record: Emit): void {
  if (deps.which("systemctl") === null) {
    record("WARN", "systemd", "systemctl not found on PATH");
    return;
  }
  const result = deps.run("systemctl", ["--user", "is-system-running"]);
  const status = result.stdout.trim();
  if (SYSTEMD_STATES.has(status)) {
    record("OK", "systemd", `user manager: ${status}`);
  } else {
    record(
      "WARN",
      "systemd",
      status === ""
        ? "no systemd user manager available"
        : `systemd user manager not available (${status})`
    );
  }
}

function checkLinger(deps: DoctorDeps, record: Emit): void {
  const hint = `loginctl enable-linger ${deps.user}`;
  if (deps.which("loginctl") === null) {
    record("WARN", "linger", `loginctl not found; run: ${hint}`);
    return;
  }
  const result = deps.run("loginctl", ["show-user", deps.user, "-p", "Linger"]);
  if (/^Linger=yes$/m.test(result.stdout)) {
    record("OK", "linger", `enabled for ${deps.user}`);
  } else {
    record("WARN", "linger", `not enabled; run: ${hint}`);
  }
}

function checkTailscale(deps: DoctorDeps, record: Emit): void {
  const found = deps.which("tailscale");
  if (found === null) {
    record("WARN", "tailscale", "tailscale not found on PATH");
  } else {
    record("OK", "tailscale", found);
  }
}

/**
 * Run every doctor check and print one line per check. Returns the exit code:
 * 1 when any check fails, 0 otherwise.
 */
export async function runDoctor(
  overrides: Partial<DoctorDeps> = {}
): Promise<number> {
  const deps: DoctorDeps = { ...defaultDoctorDeps(), ...overrides };

  let failed = false;
  const record: Emit = (status, name, detail) => {
    if (status === "FAIL") {
      failed = true;
    }
    deps.out(`${status.padEnd(4)} ${name}: ${detail}`);
  };

  const archName = ARCH_NAMES[deps.arch];
  if (archName !== undefined) {
    record("OK", "arch", archName);
  } else {
    record("FAIL", "arch", `unsupported architecture: ${deps.arch}`);
  }

  record("OK", "bun", deps.bunVersion);

  let config: Config | null = null;
  try {
    config = deps.loadConfig(deps.env ? { env: deps.env } : undefined);
    record("OK", "config", configDetail(config, deps));
  } catch (caught) {
    // A config error could quote a token; never let one reach the output.
    record("FAIL", "config", redactText(errorText(caught)));
  }

  if (config !== null) {
    checkDb(config, deps, record);
    checkBackupDir(config, deps, record);
    await checkPort(config, deps, record);
  }

  checkSystemd(deps, record);
  checkLinger(deps, record);
  checkTailscale(deps, record);

  return failed ? 1 : 0;
}
