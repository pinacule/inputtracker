import type { Database } from "bun:sqlite";

/**
 * Per-database memo for values derived only from the database. Entries live until
 * anything writes to it: `total_changes()` counts this connection's writes and
 * `PRAGMA data_version` moves when another connection (a sync run, the CLI) commits.
 * Values derived from anything else (files, the clock) must not be cached here.
 */
const caches = new WeakMap<Database, { version: string; entries: Map<string, unknown> }>();

function writeVersion(db: Database): string {
  const changes = db.query<{ n: number }, []>("SELECT total_changes() AS n;").get()?.n ?? 0;
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version;").get()?.data_version ?? 0;
  return `${dataVersion}:${changes}`;
}

export function cachedUntilWrite<T>(db: Database, key: string, build: () => T): T {
  const version = writeVersion(db);
  let cache = caches.get(db);
  if (!cache || cache.version !== version) {
    cache = { version, entries: new Map() };
    caches.set(db, cache);
  }
  if (cache.entries.has(key)) return cache.entries.get(key) as T;
  const value = build();
  cache.entries.set(key, value);
  return value;
}
