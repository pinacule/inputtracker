/**
 * `it verify-copy <copy.db>` — prove that a copied database holds every event of
 * the configured database.
 *
 * The reference is `config.storage.db_path`; the copy is the argument. Both are
 * opened **read-only** (`new Database(path, { readonly: true })`) and are never
 * migrated, so no new file is created and no row is written. Only
 * `events.record_hash` is compared (a `Set` per database, so ~100k events stay
 * fast). Extra rows in the copy are reported but are not a failure — the copy
 * may simply have synced more since it was taken.
 *
 * Exit codes: 0 when every reference event is present, 1 when some are missing,
 * 2 on a usage/IO error (missing argument or unreadable database is 2).
 */

import { Database } from "bun:sqlite";
import { existsSync, rmSync, statSync } from "node:fs";

import {
  loadConfig,
  redact,
  type Config,
  type LoadConfigOptions,
} from "../core/config.ts";

export const VERIFY_COPY_EXIT_OK = 0;
/** Bad usage and "events are missing from the copy" both exit 1. */
export const VERIFY_COPY_EXIT_USAGE = 1;
export const VERIFY_COPY_EXIT_MISSING = 1;
/** Missing/unreadable database file. */
export const VERIFY_COPY_EXIT_FAILURE = 2;

/** How many missing hashes are printed (the count is always printed in full). */
export const MAX_PRINTED_HASHES = 5;

export interface VerifyCopyDeps {
  loadConfig: (opts?: LoadConfigOptions) => Config;
  out: (line: string) => void;
  err: (line: string) => void;
  usage: () => string;
}

interface DbSnapshot {
  events: Set<string>;
  eventCount: number;
  ingestRuns: number;
  schemaVersion: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redactText(text: string): string {
  const stripped = text.replace(/\b(?:simkl_at_|simkl_rt_)[A-Za-z0-9_\-]+\b/gi, "***");
  try {
    return redact(stripped);
  } catch {
    return stripped;
  }
}

/**
 * Read the comparison data from `path` read-only. SQLite may create empty
 * `-wal`/`-shm` sidecars for a closed WAL database even on a read-only
 * connection; only sidecars that did not exist before and that our connection
 * created are removed afterwards, so a live database keeps its own sidecars and
 * a closed one is left exactly as it was.
 */
function readSnapshot(path: string): DbSnapshot {
  const sidecars = [`${path}-wal`, `${path}-shm`];
  const existed = sidecars.map((p) => existsSync(p));
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query<{ record_hash: string }, []>("SELECT record_hash FROM events;")
      .all();
    const events = new Set(rows.map((row) => row.record_hash));
    const ingestRuns =
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ingest_runs;")
        .get()?.n ?? 0;
    const schemaVersion =
      db
        .query<{ v: number | null }, []>(
          "SELECT MAX(version) AS v FROM schema_migrations;"
        )
        .get()?.v ?? 0;
    return { events, eventCount: events.size, ingestRuns, schemaVersion };
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

/**
 * Compare a copied database with the configured one. `args` are the CLI
 * arguments after `verify-copy`.
 */
export function runVerifyCopy(args: string[], deps: VerifyCopyDeps): number {
  const copyPath = args[0];

  if (copyPath === undefined || copyPath === "") {
    deps.err("Missing <copy.db>.");
    deps.err(deps.usage());
    return VERIFY_COPY_EXIT_USAGE;
  }
  if (args.length > 1) {
    deps.err(`Unexpected argument: ${args[1]}`);
    deps.err(deps.usage());
    return VERIFY_COPY_EXIT_USAGE;
  }

  let config: Config;
  try {
    config = deps.loadConfig();
  } catch (caught) {
    deps.err(redactText(errorText(caught)));
    return VERIFY_COPY_EXIT_FAILURE;
  }

  const refPath = config.storage.db_path;
  if (!existsSync(refPath)) {
    deps.err(`reference database not found: ${refPath}`);
    return VERIFY_COPY_EXIT_FAILURE;
  }
  if (!existsSync(copyPath)) {
    deps.err(`copy database not found: ${copyPath}`);
    return VERIFY_COPY_EXIT_FAILURE;
  }

  let ref: DbSnapshot;
  try {
    ref = readSnapshot(refPath);
  } catch (caught) {
    deps.err(
      `reference is not a readable database: ${refPath} (${redactText(errorText(caught))})`
    );
    return VERIFY_COPY_EXIT_FAILURE;
  }

  let copy: DbSnapshot;
  try {
    copy = readSnapshot(copyPath);
  } catch (caught) {
    deps.err(
      `copy is not a readable database: ${copyPath} (${redactText(errorText(caught))})`
    );
    return VERIFY_COPY_EXIT_FAILURE;
  }

  const missing: string[] = [];
  for (const hash of ref.events) {
    if (!copy.events.has(hash)) {
      missing.push(hash);
    }
  }
  let extra = 0;
  for (const hash of copy.events) {
    if (!ref.events.has(hash)) {
      extra += 1;
    }
  }

  deps.out(`reference events: ${ref.eventCount}`);
  deps.out(`copy events: ${copy.eventCount}`);
  deps.out(`missing in copy: ${missing.length}`);
  for (const hash of missing.slice(0, MAX_PRINTED_HASHES)) {
    deps.out(`  ${hash}`);
  }
  deps.out(`extra in copy: ${extra}`);
  deps.out(`ingest_runs: reference ${ref.ingestRuns}, copy ${copy.ingestRuns}`);
  deps.out(`schema: reference v${ref.schemaVersion}, copy v${copy.schemaVersion}`);
  if (ref.schemaVersion !== copy.schemaVersion) {
    deps.out(
      `WARN schema version differs: reference v${ref.schemaVersion}, ` +
        `copy v${copy.schemaVersion}`
    );
  }

  if (missing.length > 0) {
    deps.out(`copy is missing ${missing.length} event(s)`);
    return VERIFY_COPY_EXIT_MISSING;
  }

  deps.out("copy OK: every event present");
  return VERIFY_COPY_EXIT_OK;
}
