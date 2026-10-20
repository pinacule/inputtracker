import type { Database } from "bun:sqlite";

/** Immutable edges. Resolving an old URL always reaches the current work. */
export function getWorkKeyAliases(db: Database): Map<string, string> {
  return new Map(db.query<{ old_key: string; new_key: string }, []>(
    "SELECT old_key, new_key FROM work_key_aliases ORDER BY id;"
  ).all().map((row) => [row.old_key, row.new_key]));
}

export function resolveWorkKeyIn(aliases: ReadonlyMap<string, string>, key: string): string {
  const seen = new Set<string>();
  while (aliases.has(key)) {
    if (seen.has(key)) throw new Error("Work key alias cycle");
    seen.add(key);
    key = aliases.get(key)!;
  }
  return key;
}

export function resolveWorkKey(db: Database, key: string): string {
  return resolveWorkKeyIn(getWorkKeyAliases(db), key);
}

export function aliasWorkKey(db: Database, oldKey: string, newKey: string, nowIso: string): string {
  const aliases = getWorkKeyAliases(db);
  const oldResolved = resolveWorkKeyIn(aliases, oldKey);
  const newResolved = resolveWorkKeyIn(aliases, newKey);
  // Renaming back to a former identity needs no reverse edge (and no cycle).
  if (oldResolved !== newResolved) {
    db.run("INSERT OR IGNORE INTO work_key_aliases (old_key, new_key, created_at) VALUES (?, ?, ?);",
      [oldResolved, newResolved, nowIso]);
  }
  return resolveWorkKey(db, oldKey);
}
