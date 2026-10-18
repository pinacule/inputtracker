/**
 * `it verify-copy <copy.db>` — prove that a copied database holds every event,
 * goal and annotation of the configured database.
 *
 * The reference is `config.storage.db_path`; the copy is the argument. Both are
 * opened **read-only** (`new Database(path, { readonly: true })`) and are never
 * migrated, so no new file is created and no row is written. Only
 * `record_hash` is compared per table (a `Set` per database, so ~100k events
 * stay fast). Extra rows in the copy are reported but are not a failure — the
 * copy may simply have synced more since it was taken.
 *
 * Exit codes: 0 when every reference row is present, 1 when some are missing,
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

interface TableHashSet {
  hashes: Set<string>;
  count: number;
}

interface DbSnapshot {
  events: Set<string>;
  eventCount: number;
  goals: TableHashSet | null;
  annotations: TableHashSet | null;
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

/** Check if a table exists in the database. */
function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?;"
    )
    .get(tableName);
  return (row?.n ?? 0) > 0;
}

/** Read the hash set for a table, or null if the table doesn't exist. */
function readTableHashes(db: Database, tableName: string): TableHashSet | null {
  if (!tableExists(db, tableName)) {
    return null;
  }
  const rows = db
    .query<{ record_hash: string }, []>(`SELECT record_hash FROM ${tableName};`)
    .all();
  const hashes = new Set(rows.map((row) => row.record_hash));
  return { hashes, count: hashes.size };
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
    const goals = readTableHashes(db, "goals");
    const annotations = readTableHashes(db, "annotations");
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
    return { events, eventCount: events.size, goals, annotations, ingestRuns, schemaVersion };
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

/** Compare hash sets and return missing hashes. */
function compareSets(
  refSet: Set<string>,
  copySet: Set<string>
): { missing: string[]; extra: number } {
  const missing: string[] = [];
  for (const hash of refSet) {
    if (!copySet.has(hash)) {
      missing.push(hash);
    }
  }
  let extra = 0;
  for (const hash of copySet) {
    if (!refSet.has(hash)) {
      extra += 1;
    }
  }
  return { missing, extra };
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

  // Events keep their original output lines; goals and annotations (schema
  // v2/v3) are prefixed with the table name and skipped when the reference has
  // no such table. A copy without the table is missing all of its rows.
  const tables: Array<{ label: string; prefix: string; ref: Set<string> | null; copy: Set<string> | null }> = [
    { label: "event", prefix: "", ref: ref.events, copy: copy.events },
    { label: "goal", prefix: "goals ", ref: ref.goals?.hashes ?? null, copy: copy.goals?.hashes ?? null },
    {
      label: "annotation",
      prefix: "annotations ",
      ref: ref.annotations?.hashes ?? null,
      copy: copy.annotations?.hashes ?? null,
    },
  ];
  const missingParts: string[] = [];
  for (const table of tables) {
    if (table.ref === null) {
      continue;
    }
    const plural = `${table.label}s`;
    deps.out(`reference ${plural}: ${table.ref.size}`);
    deps.out(`copy ${plural}: ${table.copy === null ? "table missing" : table.copy.size}`);
    const { missing, extra } = compareSets(table.ref, table.copy ?? new Set());
    deps.out(`${table.prefix}missing in copy: ${missing.length}`);
    for (const hash of missing.slice(0, MAX_PRINTED_HASHES)) {
      deps.out(`  ${hash}`);
    }
    deps.out(`${table.prefix}extra in copy: ${extra}`);
    if (missing.length > 0) {
      missingParts.push(`${missing.length} ${table.label}(s)`);
    }
  }

  deps.out(`ingest_runs: reference ${ref.ingestRuns}, copy ${copy.ingestRuns}`);
  deps.out(`schema: reference v${ref.schemaVersion}, copy v${copy.schemaVersion}`);
  if (ref.schemaVersion !== copy.schemaVersion) {
    deps.out(
      `WARN schema version differs: reference v${ref.schemaVersion}, ` +
        `copy v${copy.schemaVersion}`
    );
  }

  if (missingParts.length > 0) {
    deps.out(`copy is missing ${missingParts.join(", ")}`);
    return VERIFY_COPY_EXIT_MISSING;
  }

  deps.out("copy OK: every event present");
  return VERIFY_COPY_EXIT_OK;
}
