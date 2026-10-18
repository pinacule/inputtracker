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
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  isIngestEnabled,
  loadConfig,
  redact,
  redactString,
  type Config,
  type LoadConfigOptions,
} from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { runDoctor, type DoctorDeps } from "./doctor.ts";
import { runVerifyCopy } from "./verify-copy.ts";
import type { MediaType } from "../core/events.ts";
import { LocalDbSink, type Sink } from "../core/sink.ts";
import {
  buildChannels,
  buildNotifier,
  buildWeeklySummary,
  reportSyncResult,
  type NotifyChannel,
  type Notifier,
} from "../notify/index.ts";
import {
  runBackup as defaultRunBackup,
  type BackupOptions,
  type BackupResult,
} from "../io/backup.ts";
import { prefetchCovers } from "../server/covers.ts";
import { countEvents, exportJson } from "../io/export-json.ts";
import { exportCsv } from "../io/export-csv.ts";
import { detectFormat, importNative } from "../io/import-native.ts";
import { addManual, localToUtcIso, type ManualInput } from "../io/manual.ts";
import { importYoutubeTakeout } from "../sources/youtube/takeout.ts";
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
  simklTokenPath,
  writeSimklToken,
  type SimklToken,
} from "../sources/simkl/token.ts";
import {
  isSimklAuthorised,
  isSimklConfigured,
  syncSimkl,
  type SimklSyncResult,
  type SyncSimklDeps,
} from "../sources/simkl/sync.ts";
import {
  createActivityWatchClient,
  type ActivityWatchClient,
} from "../sources/activitywatch/client.ts";
import {
  ACTIVITYWATCH_SOURCE,
  syncActivityWatch,
  type ActivityWatchSyncResult,
  type SyncActivityWatchDeps,
} from "../sources/activitywatch/sync.ts";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_FAILURE = 2;

/** Message sent by `it notify test` to every configured channel. */
const TEST_NOTICE_TITLE = "InputTracker test notification";
const TEST_NOTICE_BODY = "InputTracker test notification";

export function usage(): string {
  return [
    "inputtracker — personal input tracking",
    "",
    "Usage: it <command> [options]",
    "",
    "Commands:",
    "  sync audiobookshelf|simkl|activitywatch  fetch new source activity into the DB",
    "  auth simkl [--status]                    connect or inspect Simkl authorization",
    "  add --type <t> --title <title> --start <local>   add a consumed item manually",
    "  export --format json|csv --out <file>    export the full events archive to a file",
    "  import <file> [--format json|csv]        import a native export file into the DB",
    "    import youtube-takeout <file>          import a YouTube Takeout watch-history JSON file",
    "  backup                                   snapshot the DB + JSON export into backup_dir",
    "  notify test                              test every configured notification channel",
    "  notify weekly                            push the weekly summary (needs notify.weekly_summary)",
    "  ingest token                             print a fresh phone-ingest token",
    "  ingest status                            show whether ingest is enabled",
    "  doctor                                   check the environment before/after a move",
    "  verify-copy <copy.db>                    check a copied DB has every event of the configured DB",
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
  syncSimkl?: (deps: SyncSimklDeps) => Promise<SimklSyncResult>;
  /** Cover cache fill after a successful sync; defaults to the real `prefetchCovers`. */
  prefetchCovers?: typeof prefetchCovers;
  buildNotifier?: (cfg: Config) => Notifier;
  buildChannels?: (cfg: Config) => NotifyChannel[];
  reportSyncResult?: typeof reportSyncResult;
  /** Backup executor override (tests); defaults to `runBackup`. */
  runBackup?: (db: Database, options: BackupOptions) => BackupResult;
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
  createActivityWatchClient?: (
    cfg: Config["activitywatch"],
    opts?: { fetch?: typeof fetch | FetchFn }
  ) => ActivityWatchClient;
  syncActivityWatch?: (
    deps: SyncActivityWatchDeps
  ) => Promise<ActivityWatchSyncResult>;
  /** Override for `it doctor` (tests inject mocked environment deps). */
  runDoctor?: (overrides?: Partial<DoctorDeps>) => Promise<number>;
  /** Environment deps merged into the doctor defaults. */
  doctor?: Partial<DoctorDeps>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const SIMKL_TOKEN_PATTERN = /\b(?:simkl_at_|simkl_rt_)[A-Za-z0-9_\-]+\b/gi;

function redactMessage(message: string, config?: Config): string {
  let clean = message.replace(SIMKL_TOKEN_PATTERN, "***");
  if (config) {
    clean = redactString(clean, config);
    try {
      const tok = readSimklToken(simklTokenPath(config));
      if (tok?.access_token) clean = clean.split(tok.access_token).join("***");
      if (tok?.refresh_token) clean = clean.split(tok.refresh_token).join("***");
    } catch {}
    return clean;
  }
  return redact(clean);
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

  if (source !== ABS_SOURCE && source !== "simkl" && source !== ACTIVITYWATCH_SOURCE) {
    err(`Unknown source: ${source}`);
    err(usage());
    return EXIT_USAGE;
  }

  if (source === ACTIVITYWATCH_SOURCE) {
    const doLoadConfig = deps.loadConfig ?? loadConfig;
    const doOpenDb = deps.openDb ?? openDb;
    const sinkFor = deps.sinkFor ?? ((db: Database) => new LocalDbSink(db));
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
      const makeClient =
        deps.createActivityWatchClient ??
        ((cfg, opts) => createActivityWatchClient(cfg, opts));
      const client = makeClient(config.activitywatch, { fetch: deps.fetch });
      const doSync = deps.syncActivityWatch ?? syncActivityWatch;
      const result = await doSync({ client, sink, db, config, out });
      out(
        `activitywatch: ${result.seen} seen, ${result.inserted} new (${result.buckets} ${result.buckets === 1 ? "bucket" : "buckets"})`
      );
      await reportSyncSafely(
        report,
        db,
        ACTIVITYWATCH_SOURCE,
        true,
        undefined,
        notifier
      );
      return EXIT_OK;
    } catch (caught) {
      const message = redactMessage(errorText(caught), config);
      err(message);
      await reportSyncSafely(
        report,
        db,
        ACTIVITYWATCH_SOURCE,
        false,
        message,
        notifier
      );
      return EXIT_FAILURE;
    } finally {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }

  if (source === "simkl") {
    const doLoadConfig = deps.loadConfig ?? loadConfig;
    const doOpenDb = deps.openDb ?? openDb;
    const sinkFor = deps.sinkFor ?? ((db: Database) => new LocalDbSink(db));
    const makeNotifier = deps.buildNotifier ?? buildNotifier;
    const report = deps.reportSyncResult ?? reportSyncResult;

    let config: Config;
    try {
      config = doLoadConfig(deps.env ? { env: deps.env } : undefined);
    } catch (caught) {
      err(redactMessage(errorText(caught)));
      return EXIT_FAILURE;
    }

    if (!isSimklConfigured(config)) {
      out("Simkl is not configured: set simkl.client_id in inputtracker.config.toml");
      return EXIT_OK;
    }

    const tokenReader = deps.readSimklToken ?? readSimklToken;
    if (!isSimklAuthorised(config, tokenReader)) {
      out("Simkl is not authorised; run: bun run it auth simkl");
      return EXIT_OK;
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
      const makeSimkl =
        deps.createSimklClient ??
        ((cfg, clientDeps) => createSimklClient(cfg, clientDeps));
      const tokenPath = simklTokenPath(config);
      const client = makeSimkl(config.simkl, {
        fetch: deps.fetch,
        sleep: deps.sleep,
        now: deps.nowMs,
        tokenPath,
        readToken: () => tokenReader(tokenPath),
        writeToken: deps.writeSimklToken
          ? (t) => deps.writeSimklToken!(tokenPath, t)
          : undefined,
      });
      const doSync = deps.syncSimkl ?? syncSimkl;
      const result = await doSync({ client, sink, db, config });
      out(`simkl: ${result.seen} seen, ${result.inserted} new (${result.mode})`);
      await reportSyncSafely(report, db, "simkl", true, undefined, notifier);
      return EXIT_OK;
    } catch (caught) {
      const message = redactMessage(errorText(caught), config);
      err(message);
      await reportSyncSafely(report, db, "simkl", false, message, notifier);
      return EXIT_FAILURE;
    } finally {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
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

  if (args[0] === "youtube-takeout") {
    return runYoutubeTakeoutImport(args.slice(1), ctx);
  }

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
    out(
      `imported ${result.events.inserted} new of ${result.events.seen} events, ` +
        `${result.goals.inserted} new of ${result.goals.seen} goals, ` +
        `${result.annotations.inserted} new of ${result.annotations.seen} annotations from ${file}`
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

function runYoutubeTakeoutImport(args: string[], ctx: SyncContext): number {
  const { deps, out, err } = ctx;

  const file = args[0];
  if (file === undefined || file === "") {
    err("Missing <file>.");
    err(usage());
    return EXIT_USAGE;
  }
  if (args.length > 1) {
    err(`Unexpected argument: ${args[1] as string}`);
    err(usage());
    return EXIT_USAGE;
  }

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
    const result = importYoutubeTakeout(db, text);
    const { skipped } = result;
    out(
      `youtube-takeout: ${result.records} records, ${result.seen} views, ` +
        `${result.inserted} new, skipped ${skipped.ads} ads, ` +
        `${skipped.no_video} without video, ${skipped.other} other, ` +
        `${skipped.invalid} invalid`
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

async function runBackupCommand(
  args: string[],
  ctx: SyncContext
): Promise<number> {
  const { deps, out, err } = ctx;

  if (args.length > 0) {
    err(`Unknown option: ${args[0]}`);
    err(usage());
    return EXIT_USAGE;
  }

  const doLoadConfig = deps.loadConfig ?? loadConfig;
  const doOpenDb = deps.openDb ?? openDb;
  const doBackup = deps.runBackup ?? defaultRunBackup;
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

  // The notifier is best-effort: a broken channel must not affect the backup.
  let notifier: Notifier;
  try {
    notifier = makeNotifier(config);
  } catch {
    notifier = { notify: async () => {} };
  }

  try {
    const result = doBackup(db, {
      dir: config.storage.backup_dir,
      keep: config.storage.backup_keep,
      now: deps.now,
    });
    out(
      `backup written: ${result.dbPath}, ${result.jsonPath}; pruned ${result.pruned.length} files`
    );
    // Value alerts reuse the once-per-outage state logic of the sync alerts.
    await reportSyncSafely(report, db, "backup", true, undefined, notifier);
    return EXIT_OK;
  } catch (caught) {
    const message = redactMessage(errorText(caught), config);
    err(message);
    await reportSyncSafely(report, db, "backup", false, message, notifier);
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
 * Send the test notification through every configured channel and report each
 * channel by name only — never a URL, a topic or a token. Exit codes: 0 when
 * at least one channel succeeded, 2 when none did (but some were configured),
 * 1 when no channel is configured at all.
 */
async function runNotifyTest(ctx: SyncContext): Promise<number> {
  const { deps, out, err } = ctx;
  const makeChannels =
    deps.buildChannels ??
    ((cfg: Config) => buildChannels(cfg, { sleep: deps.sleep }));

  let config: Config;
  try {
    config = (deps.loadConfig ?? loadConfig)(
      deps.env ? { env: deps.env } : undefined
    );
  } catch (caught) {
    err(redactMessage(errorText(caught)));
    return EXIT_FAILURE;
  }

  let channels: NotifyChannel[];
  try {
    channels = makeChannels(config);
  } catch {
    channels = [];
  }

  if (channels.length === 0) {
    out("No notification channel is configured.");
    out("Set notify.ntfy_url (or enable notify.desktop) and retry.");
    return EXIT_USAGE;
  }

  const title = TEST_NOTICE_TITLE;
  const body = TEST_NOTICE_BODY;
  const results: string[] = [];
  let anyOk = false;
  for (const channel of channels) {
    let ok = false;
    try {
      await channel.notifier.notify(title, body, "test");
      ok = true;
      anyOk = true;
    } catch {
      // The channel name is enough; the error text may name a URL-shaped value.
      ok = false;
    }
    results.push(`${channel.name}: ${ok ? "ok" : "failed"}`);
  }
  for (const line of results) {
    out(line);
  }
  return anyOk ? EXIT_OK : EXIT_FAILURE;
}

/**
 * Push the weekly summary through every configured channel. Disabled by
 * default (`notify.weekly_summary`), in which case nothing is sent.
 * Exit codes mirror the test command: 0 ok, 2 all channels failed, 1 when no
 * channel is configured.
 */
async function runNotifyWeekly(ctx: SyncContext): Promise<number> {
  const { deps, out, err } = ctx;
  const makeChannels =
    deps.buildChannels ??
    ((cfg: Config) => buildChannels(cfg, { sleep: deps.sleep }));

  let config: Config;
  try {
    config = (deps.loadConfig ?? loadConfig)(
      deps.env ? { env: deps.env } : undefined
    );
  } catch (caught) {
    err(redactMessage(errorText(caught)));
    return EXIT_FAILURE;
  }

  if (!config.notify?.weekly_summary) {
    out("weekly summary disabled");
    return EXIT_OK;
  }

  let channels: NotifyChannel[];
  try {
    channels = makeChannels(config);
  } catch {
    channels = [];
  }
  if (channels.length === 0) {
    out("No notification channel is configured.");
    out("Set notify.ntfy_url (or enable notify.desktop) and retry.");
    return EXIT_USAGE;
  }

  let summary: { title: string; body: string };
  try {
    const db = (deps.openDb ?? openDb)(config.storage.db_path);
    try {
      summary = buildWeeklySummary(db, {
        tz: config.timezone,
        now: deps.now,
      });
    } finally {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  } catch (caught) {
    err(redactMessage(errorText(caught), config));
    return EXIT_FAILURE;
  }

  const results: string[] = [];
  let anyOk = false;
  for (const channel of channels) {
    let ok = false;
    try {
      await channel.notifier.notify(summary.title, summary.body, "summary");
      ok = true;
      anyOk = true;
    } catch {
      ok = false;
    }
    results.push(`${channel.name}: ${ok ? "sent" : "failed"}`);
  }
  for (const line of results) {
    out(line);
  }
  return anyOk ? EXIT_OK : EXIT_FAILURE;
}

/**
 * `it ingest token` — print a fresh random ingest token (32 random bytes,
 * base64url, no padding) plus a one-line hint. It never reads the config
 * and never writes a file: the user pastes the token into the config.
 */
export function generateIngestToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

async function runIngest(args: string[], ctx: SyncContext): Promise<number> {
  const { deps, out, err } = ctx;
  const sub = args[0];

  if (sub === "token") {
    if (args.length > 1) {
      err(`Unexpected argument: ${args[1]}`);
      err(usage());
      return EXIT_USAGE;
    }
    out(generateIngestToken());
    out("add it to [ingest] token in your config, then restart the server");
    return EXIT_OK;
  }

  if (sub === "status") {
    if (args.length > 1) {
      err(`Unexpected argument: ${args[1]}`);
      err(usage());
      return EXIT_USAGE;
    }
    const doLoadConfig = deps.loadConfig ?? loadConfig;
    let config: Config;
    try {
      config = doLoadConfig(deps.env ? { env: deps.env } : undefined);
    } catch (caught) {
      err(redactMessage(errorText(caught)));
      return EXIT_FAILURE;
    }
    out(`ingest: ${isIngestEnabled(config) ? "enabled" : "disabled"}`);
    return EXIT_OK;
  }

  err("Usage: it ingest token|status");
  return EXIT_USAGE;
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
    return await runBackupCommand(rest, { deps, out, err });
  }

  if (command === "notify") {
    const sub = rest[0];
    if (sub === "test") {
      return await runNotifyTest({ deps, out, err });
    }
    if (sub === "weekly") {
      return await runNotifyWeekly({ deps, out, err });
    }
    err("Usage: it notify test|weekly");
    return EXIT_USAGE;
  }

  if (command === "ingest") {
    return await runIngest(rest, { deps, out, err });
  }

  if (command === "doctor") {
    const runner = deps.runDoctor ?? runDoctor;
    return await runner({ ...deps.doctor, out });
  }

  if (command === "verify-copy") {
    return runVerifyCopy(rest, {
      loadConfig: deps.loadConfig ?? loadConfig,
      out,
      err,
      usage,
    });
  }

  err(`Unknown command: ${command}`);
  err(usage());
  return EXIT_USAGE;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
