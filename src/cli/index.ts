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
import {
  loadConfig,
  redact,
  redactString,
  type Config,
  type LoadConfigOptions,
} from "../core/config.ts";
import { openDb } from "../core/db.ts";
import { LocalDbSink, type Sink } from "../core/sink.ts";
import { createAbsClient, type AbsClient } from "../sources/audiobookshelf/client.ts";
import {
  ABS_SOURCE,
  syncAudiobookshelf,
  type AbsSyncResult,
  type SyncAbsDeps,
} from "../sources/audiobookshelf/sync.ts";

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
    "  sync audiobookshelf    fetch new Audiobookshelf activity into the DB",
    "",
    "More commands (import, export, add, serve) will be added in later tasks.",
  ].join("\n");
}

export interface CliDeps {
  loadConfig?: (opts?: LoadConfigOptions) => Config;
  openDb?: (path: string) => Database;
  createAbsClient?: (cfg: Config) => AbsClient;
  sinkFor?: (db: Database) => Sink;
  syncAudiobookshelf?: (deps: SyncAbsDeps) => Promise<AbsSyncResult>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
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
    const sink = sinkFor(db);
    const client = makeClient(config);
    const result = await doSync({ client, sink, db, config });
    out(`synced ${ABS_SOURCE}: seen ${result.seen}, inserted ${result.inserted}`);
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

  err(`Unknown command: ${command}`);
  err(usage());
  return EXIT_USAGE;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
