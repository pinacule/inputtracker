/**
 * InputTracker CLI entry point.
 *
 * `it sync audiobookshelf` loads the config, opens the database at the
 * configured path, builds the source client and runs the sync, printing the
 * row counts. Failures print a redacted message and exit 2; bad usage exits 1.
 * The command logic lives in `runCli` (no `process.exit` inside) so it can be
 * tested without spawning a process.
 */

import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import {
  loadConfig,
  redact,
  redactString,
  type Config,
  type LoadConfigOptions,
} from "../core/config.ts";
import { openDb } from "../core/db.ts";
import type { MediaType } from "../core/events.ts";
import { LocalDbSink, type Sink } from "../core/sink.ts";
import { buildNotifier, reportSyncResult, type Notifier } from "../notify/index.ts";
import { runBackup } from "../io/backup.ts";
import { prefetchCovers } from "../server/covers.ts";
import { countEvents, exportJson } from "../io/export-json.ts";
import { exportCsv } from "../io/export-csv.ts";
import { detectFormat, importNative } from "../io/import-native.ts";
import { addManual, localToUtcIso, type ManualInput } from "../io/manual.ts";
import { createAbsClient, type AbsClient } from "../sources/audiobookshelf/client.ts";
import {
  ABS_SOURCE,
  syncAudiobookshelf,
  type AbsSyncResult,
  type SyncAbsDeps,
} from "../sources/audiobookshelf/sync.ts";
import { runSimklAuth } from "../sources/simkl/auth.ts";
import {
  createSimklClient,
  type FetchFn,
  type SimklClient,
  type SimklClientDeps,
} from "../sources/simkl/client.ts";
import {
  readSimklToken,
  writeSimklToken,
  type SimklToken,
} from "../sources/simkl/token.ts";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_FAILURE = 2;

export function usage(): string {
  return [
    "inputtracker — personal input tracking",
    "",
    "Usage: it <command> [options]",
    "",
    "Commands:",
    "  sync audiobookshelf                      fetch new Audiobookshelf activity into the DB",
    "  auth simkl [--status]                    connect or inspect Simkl authorization",
    "  add --type <t> --title <title> --start <local>   add a consumed item manually",
    "  export --format json|csv --out <file>    export the full events archive to a file",
    "  import <file> [--format json|csv]        import a native export file into the DB",
    "  backup                                   snapshot the DB + JSON export into backup_dir",
    "",
    "More commands (serve) will be added in later tasks.",
  ].join("\n");
}

export interface CliDeps {
  loadConfig?: (opts?: LoadConfigOptions) => Config;
  openDb?: (path: string) => Database;
  createAbsClient?: (cfg: Config) => AbsClient;
  sinkFor?: (db: Database) => Sink;
  syncAudiobookshelf?: (deps: SyncAbsDeps) => Promise<AbsSyncResult>;
  /** Cover cache fill after a successful sync; defaults to the real `prefetchCovers`. */
  prefetchCovers?: typeof prefetchCovers;
  buildNotifier?: (cfg: Config) => Notifier;
  reportSyncResult?: typeof reportSyncResult;
  writeFile?: (path: string, data: string) => void;
  readFile?: (path: string) => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  newId?: () => string;
  /** Timestamp used for the backup date stamp; defaults to the current time. */
  now?: Date;
  fetch?: typeof fetch | FetchFn;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  createSimklClient?: (cfg: Config["simkl"], deps: SimklClientDeps) => SimklClient;
  readSimklToken?: (path: string) => SimklToken | null;
  writeSimklToken?: (path: string, token: SimklToken) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redactMessage(message: string, config?: Config): string {
  return config ? redactString(message, config) : redact(message);
}

interface SyncContext {
  deps: CliDeps;
  out: (line: string) => void;
  err: (line: string) => void;
}

async function runSync(
  source: string | undefined,
  ctx: SyncContext
): Promise<number> {
  const { deps, out, err } = ctx;

  if (source === undefined || source === "") {
    err("Missing source.");
    err(usage());
    return EXIT_USAGE;
  }

  if (source !== ABS_SOURCE) {
    err(`Unknown source: ${source}`);
    err(usage());
    return EXIT_USAGE;
  }

  const doLoadConfig = deps.loadConfig ?? loadConfig;
  const doOpenDb = deps.openDb ?? openDb;
  const makeClient = deps.createAbsClient ?? ((cfg: Config) => createAbsClient(cfg));
  const sinkFor = deps.sinkFor ?? ((db: Database) => new LocalDbSink(db));
  const doSync = deps.syncAudiobookshelf ?? syncAudiobookshelf;
  const makeNotifier = deps.buildNotifier ?? buildNotifier;
  const report = deps.reportSyncResult ?? reportSyncResult;

  let config: Config;
  try {
    config = doLoadConfig(deps.env ? { env: deps.env } : undefined);
  } catch (caught) {
    err(redactMessage(errorText(caught)));
    return EXIT_FAILURE;
  }

  let db: Database;
  try {
    db = doOpenDb(config.storage.db_path);
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  }

  let notifier: Notifier;
  try {
    notifier = makeNotifier(config);
  } catch {
    notifier = { notify: async () => {} };
  }

  try {
    const sink = sinkFor(db);
    const client = makeClient(config);
    const result = await doSync({ client, sink, db, config });
    out(`synced ${ABS_SOURCE}: seen ${result.seen}, inserted ${result.inserted}`);
    // Cache covers while the items still exist on the server (never throws).
    await (deps.prefetchCovers ?? prefetchCovers)(db, result.runId, {
      config,
      createAbsClient: () => client,
    });
    await reportSyncSafely(report, db, ABS_SOURCE, true, undefined, notifier);
    return EXIT_OK;
  } catch (caught) {
    const message = redactMessage(errorText(caught), config);
    err(message);
    await reportSyncSafely(report, db, ABS_SOURCE, false, message, notifier);
    return EXIT_FAILURE;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Report one sync result, swallowing every notification error so it can never
 * change the sync exit code.
 */
async function reportSyncSafely(
  report: typeof reportSyncResult,
  db: Database,
  source: string,
  ok: boolean,
  message: string | undefined,
  notifier: Notifier
): Promise<void> {
  try {
    await report(db, source, ok, message, notifier);
  } catch {
    // Notification errors must never affect the sync result.
  }
}

interface ExportArgs {
  format: "json" | "csv";
  out: string;
}

type ExportParseResult =
  | { ok: true; value: ExportArgs }
  | { ok: false; message: string };

function parseExportArgs(args: string[]): ExportParseResult {
  let format: string | undefined;
  let out: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg === "--format" ? args[i + 1] : arg.slice("--format=".length);
      if (arg === "--format") {
        i += 1;
      }
      if (value === undefined || value === "") {
        return { ok: false, message: "Missing value for --format." };
      }
      format = value;
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? args[i + 1] : arg.slice("--out=".length);
      if (arg === "--out") {
        i += 1;
      }
      if (value === undefined || value === "") {
        return { ok: false, message: "Missing value for --out." };
      }
      out = value;
    } else {
      return { ok: false, message: `Unknown option: ${arg}` };
    }
  }

  if (format === undefined) {
    return { ok: false, message: "Missing --format." };
  }
  if (format !== "json" && format !== "csv") {
    return {
      ok: false,
      message: `Invalid --format: ${format} (expected json or csv).`,
    };
  }
  if (out === undefined) {
    return { ok: false, message: "Missing --out." };
  }

  return { ok: true, value: { format, out } };
}

function runExport(args: string[], ctx: SyncContext): number {
  const { deps, out, err } = ctx;

  const parsed = parseExportArgs(args);
  if (!parsed.ok) {
    err(parsed.message);
    err(usage());
    return EXIT_USAGE;
  }
  const { format, out: outPath } = parsed.value;

  const doLoadConfig = deps.loadConfig ?? loadConfig;
  const doOpenDb = deps.openDb ?? openDb;
  const doWriteFile =
    deps.writeFile ??
    ((path: string, data: string) => writeFileSync(path, data, "utf8"));

  let config: Config;
  try {
    config = doLoadConfig(deps.env ? { env: deps.env } : undefined);
  } catch (caught) {
    err(redactMessage(errorText(caught)));
    return EXIT_FAILURE;
  }

  let db: Database;
  try {
    db = doOpenDb(config.storage.db_path);
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  }

  try {
    const text = format === "json" ? exportJson(db) : exportCsv(db);
    const count = countEvents(db);
    doWriteFile(outPath, text);
    out(`exported ${count} events to ${outPath}`);
    return EXIT_OK;
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

interface ImportArgs {
  file: string;
  format: "json" | "csv";
}

type ImportParseResult =
  | { ok: true; value: ImportArgs }
  | { ok: false; message: string };

function parseImportArgs(args: string[]): ImportParseResult {
  let file: string | undefined;
  let format: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;

    if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg === "--format" ? args[i + 1] : arg.slice("--format=".length);
      if (arg === "--format") {
        i += 1;
      }
      if (value === undefined || value === "") {
        return { ok: false, message: "Missing value for --format." };
      }
      format = value;
    } else if (arg.startsWith("-") && arg !== "-") {
      return { ok: false, message: `Unknown option: ${arg}` };
    } else if (file === undefined) {
      file = arg;
    } else {
      return { ok: false, message: `Unexpected argument: ${arg}` };
    }
  }

  if (file === undefined) {
    return { ok: false, message: "Missing <file>." };
  }

  let resolved = format;
  if (resolved === undefined) {
    const detected = detectFormat(file);
    if (detected === null) {
      return {
        ok: false,
        message: `Cannot infer format from '${file}'; use --format json or --format csv.`,
      };
    }
    resolved = detected;
  }
  if (resolved !== "json" && resolved !== "csv") {
    return {
      ok: false,
      message: `Invalid --format: ${resolved} (expected json or csv).`,
    };
  }

  return { ok: true, value: { file, format: resolved } };
}

function runImport(args: string[], ctx: SyncContext): number {
  const { deps, out, err } = ctx;

  const parsed = parseImportArgs(args);
  if (!parsed.ok) {
    err(parsed.message);
    err(usage());
    return EXIT_USAGE;
  }
  const { file, format } = parsed.value;

  const doLoadConfig = deps.loadConfig ?? loadConfig;
  const doOpenDb = deps.openDb ?? openDb;
  const doReadFile =
    deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  let config: Config;
  try {
    config = doLoadConfig(deps.env ? { env: deps.env } : undefined);
  } catch (caught) {
    err(redactMessage(errorText(caught)));
    return EXIT_FAILURE;
  }

  let text: string;
  try {
    text = doReadFile(file);
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  }

  let db: Database;
  try {
    db = doOpenDb(config.storage.db_path);
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  }

  try {
    const result = importNative(db, text, format);
    out(`imported ${result.inserted} new of ${result.seen} events from ${file}`);
    return EXIT_OK;
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

function runBackupCommand(args: string[], ctx: SyncContext): number {
  const { deps, out, err } = ctx;

  if (args.length > 0) {
    err(`Unknown option: ${args[0]}`);
    err(usage());
    return EXIT_USAGE;
  }

  const doLoadConfig = deps.loadConfig ?? loadConfig;
  const doOpenDb = deps.openDb ?? openDb;

  let config: Config;
  try {
    config = doLoadConfig(deps.env ? { env: deps.env } : undefined);
  } catch (caught) {
    err(redactMessage(errorText(caught)));
    return EXIT_FAILURE;
  }

  let db: Database;
  try {
    db = doOpenDb(config.storage.db_path);
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  }

  try {
    const result = runBackup(db, {
      dir: config.storage.backup_dir,
      keep: config.storage.backup_keep,
      now: deps.now,
    });
    out(
      `backup written: ${result.dbPath}, ${result.jsonPath}; pruned ${result.pruned.length} files`
    );
    return EXIT_OK;
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

interface AddArgs {
  type: string;
  title: string;
  start: string;
  end?: string;
  durationMin?: number;
  parent?: string;
  season?: number;
  episode?: number;
  progress?: number;
  device?: string;
}

type AddParseResult =
  | { ok: true; value: AddArgs }
  | { ok: false; message: string };

const ADD_STRING_FLAGS = new Set([
  "--type",
  "--title",
  "--start",
  "--end",
  "--parent",
  "--device",
]);
const ADD_NUMBER_FLAGS = new Set([
  "--duration-min",
  "--season",
  "--episode",
  "--progress",
]);

function parseAddArgs(args: string[]): AddParseResult {
  const strings: Record<string, string> = {};
  const numbers: Record<string, number> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;

    let flag = arg;
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      flag = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else if (ADD_STRING_FLAGS.has(arg) || ADD_NUMBER_FLAGS.has(arg)) {
      value = args[i + 1];
      i += 1;
    }

    if (!ADD_STRING_FLAGS.has(flag) && !ADD_NUMBER_FLAGS.has(flag)) {
      return { ok: false, message: `Unknown option: ${arg}` };
    }
    if (value === undefined || value === "") {
      return { ok: false, message: `Missing value for ${flag}.` };
    }

    if (ADD_STRING_FLAGS.has(flag)) {
      strings[flag] = value;
    } else {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return { ok: false, message: `Invalid value for ${flag}: ${value}` };
      }
      numbers[flag] = parsed;
    }
  }

  if (strings["--type"] === undefined) {
    return { ok: false, message: "Missing --type." };
  }
  if (strings["--title"] === undefined) {
    return { ok: false, message: "Missing --title." };
  }
  if (strings["--start"] === undefined) {
    return { ok: false, message: "Missing --start." };
  }

  return {
    ok: true,
    value: {
      type: strings["--type"] as string,
      title: strings["--title"] as string,
      start: strings["--start"] as string,
      end: strings["--end"],
      durationMin: numbers["--duration-min"],
      parent: strings["--parent"],
      season: numbers["--season"],
      episode: numbers["--episode"],
      progress: numbers["--progress"],
      device: strings["--device"],
    },
  };
}

function runAdd(args: string[], ctx: SyncContext): number {
  const { deps, out, err } = ctx;

  const parsed = parseAddArgs(args);
  if (!parsed.ok) {
    err(parsed.message);
    err(usage());
    return EXIT_USAGE;
  }
  const addArgs = parsed.value;

  const doLoadConfig = deps.loadConfig ?? loadConfig;
  const doOpenDb = deps.openDb ?? openDb;

  let config: Config;
  try {
    config = doLoadConfig(deps.env ? { env: deps.env } : undefined);
  } catch (caught) {
    err(redactMessage(errorText(caught)));
    return EXIT_FAILURE;
  }

  let db: Database;
  try {
    db = doOpenDb(config.storage.db_path);
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  }

  try {
    const tz = config.timezone;

    // `--duration-min` wins; otherwise derive the duration from `--end`.
    let durationSeconds: number | null = null;
    if (addArgs.durationMin !== undefined) {
      durationSeconds = addArgs.durationMin * 60;
    } else if (addArgs.end !== undefined) {
      const startUtc = localToUtcIso(addArgs.start, tz);
      const endUtc = localToUtcIso(addArgs.end, tz);
      durationSeconds = (Date.parse(endUtc) - Date.parse(startUtc)) / 1000;
    }

    const title = addArgs.title.trim();
    const input: ManualInput = {
      media_type: addArgs.type as MediaType,
      title,
      parent_title: addArgs.parent ?? null,
      season: addArgs.season ?? null,
      episode: addArgs.episode ?? null,
      started_at: addArgs.start,
      ended_at: addArgs.end ?? null,
      duration_seconds: durationSeconds,
      progress: addArgs.progress ?? null,
      device: addArgs.device ?? null,
    };

    const result = addManual(db, input, tz, { newId: deps.newId });
    out(`added ${title} (${result.id})`);
    return EXIT_OK;
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_USAGE;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

async function runAuth(args: string[], ctx: SyncContext): Promise<number> {
  const { deps, out, err } = ctx;
  const [target, ...rest] = args;

  if (target === undefined || target === "") {
    err("Missing auth target.");
    err(usage());
    return EXIT_USAGE;
  }

  if (target !== "simkl") {
    err(`Unknown auth target: ${target}`);
    err(usage());
    return EXIT_USAGE;
  }

  let status = false;
  for (const arg of rest) {
    if (arg === "--status") {
      status = true;
    } else {
      err(`Unknown option: ${arg}`);
      err(usage());
      return EXIT_USAGE;
    }
  }

  const doLoadConfig = deps.loadConfig ?? loadConfig;
  let config: Config;
  try {
    config = doLoadConfig(deps.env ? { env: deps.env } : undefined);
  } catch (caught) {
    err(redactMessage(errorText(caught)));
    return EXIT_FAILURE;
  }

  const makeSimklClient = (cfg: Config["simkl"], clientDeps: SimklClientDeps) => {
    if (deps.createSimklClient) {
      return deps.createSimklClient(cfg, clientDeps);
    }
    return createSimklClient(cfg, {
      fetch: deps.fetch,
      sleep: deps.sleep,
      now: deps.nowMs,
      ...clientDeps,
    });
  };

  return await runSimklAuth(
    { status },
    {
      config,
      createClient: makeSimklClient,
      readToken: deps.readSimklToken,
      writeToken: deps.writeSimklToken,
      sleep: deps.sleep,
      now: deps.nowMs,
      out,
      err,
    }
  );
}

/**
 * Run the CLI for the given argument list (without the program name).
 * Returns the process exit code; never calls `process.exit`.
 */
export async function runCli(
  argv: string[],
  deps: CliDeps = {}
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));

  const [command, ...rest] = argv;

  const isHelp =
    command === "help" || command === "--help" || command === "-h";
  const isBare = command === undefined || command === "";

  if (isHelp || isBare) {
    (isHelp ? out : err)(usage());
    return isHelp ? EXIT_OK : EXIT_USAGE;
  }

  if (command === "sync") {
    return await runSync(rest[0], { deps, out, err });
  }

  if (command === "auth") {
    return await runAuth(rest, { deps, out, err });
  }

  if (command === "add") {
    return runAdd(rest, { deps, out, err });
  }

  if (command === "export") {
    return runExport(rest, { deps, out, err });
  }

  if (command === "import") {
    return runImport(rest, { deps, out, err });
  }

  if (command === "backup") {
    return runBackupCommand(rest, { deps, out, err });
  }

  err(`Unknown command: ${command}`);
  err(usage());
  return EXIT_USAGE;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
