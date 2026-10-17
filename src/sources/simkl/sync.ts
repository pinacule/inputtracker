/**
 * Simkl sync: activities snapshot -> all-items / delta -> map -> sink.
 *
 * Rules:
 * - Data calls are GET only via client.get.
 * - One ingest_runs row per run (SIMKL_SOURCE = "simkl").
 * - Snapshot (/sync/activities JSON) saved in sync_state only after success.
 * - First sync (no snapshot): GET /sync/activities in memory, then sequentially
 *   GET /sync/all-items/shows, /movies, /anime with extended=full,
 *   episode_watched_at=yes, include_all_episodes=original. Mode = "full".
 * - Snapshot exists: GET /sync/activities. If top-level `all` equals saved
 *   snapshot's `all` -> mode = "unchanged", 0 seen, snapshot unchanged.
 *   Otherwise GET /sync/all-items with date_from=<saved all>, mode = "delta",
 *   and save new snapshot.
 * - 400 max_items -> retry split by status: watching, plantowatch, hold,
 *   completed, dropped.
 * - On failure: record failed ingest_runs, keep old snapshot, throw SyncFailedError.
 */

import type { Database } from "bun:sqlite";
import { redact, redactString, type Config } from "../../core/config.ts";
import { finishRun, startRun } from "../../core/events.ts";
import type { Sink } from "../../core/sink.ts";
import { SyncFailedError } from "../audiobookshelf/sync.ts";
import {
  SimklApiError,
  SimklAuthError,
  type SimklClient,
} from "./client.ts";
import { mapAll, type SimklAllItems } from "./map.ts";
import {
  readSimklToken,
  simklTokenPath,
  type SimklToken,
} from "./token.ts";

export { SyncFailedError } from "../audiobookshelf/sync.ts";

export const SIMKL_SOURCE = "simkl";
export const SIMKL_SYNC_KIND = "sync";

export type SyncSimklClient = Pick<SimklClient, "get">;

export interface SyncSimklDeps {
  client: SyncSimklClient | SimklClient;
  sink: Sink;
  db: Database;
  config?: Config;
  now?: () => Date;
}

export interface SimklSyncResult {
  runId: number;
  seen: number;
  inserted: number;
  mode: "full" | "delta" | "unchanged";
}

export interface SimklActivities {
  all: string;
  [key: string]: unknown;
}

const ALL_ITEMS_BASE_PARAMS: Record<string, string> = {
  extended: "full",
  episode_watched_at: "yes",
  include_all_episodes: "original",
};

const ALL_STATUSES = [
  "watching",
  "plantowatch",
  "hold",
  "completed",
  "dropped",
] as const;

/**
 * Returns true if simkl.client_id is non-empty.
 */
export function isSimklConfigured(config: Config): boolean {
  return (
    typeof config?.simkl?.client_id === "string" &&
    config.simkl.client_id.trim() !== ""
  );
}

/**
 * Returns true if the Simkl token file exists and is validly readable.
 */
export function isSimklAuthorised(
  config: Config,
  readToken: (path: string) => SimklToken | null = readSimklToken
): boolean {
  const token = readToken(simklTokenPath(config));
  return (
    token !== null &&
    typeof token.access_token === "string" &&
    token.access_token.trim() !== ""
  );
}

const SIMKL_TOKEN_PATTERN = /\b(?:simkl_at_|simkl_rt_)[A-Za-z0-9_\-]+\b/gi;

function redactErrorText(err: unknown, config?: Config): string {
  let raw = err instanceof Error ? err.message : String(err);
  if (err instanceof SimklAuthError && !raw.includes("it auth simkl")) {
    raw = `${raw}: run 'it auth simkl' again`;
  }
  let message = raw.trim() !== "" ? raw : String(err);
  message = message.replace(SIMKL_TOKEN_PATTERN, "***");

  if (config) {
    message = redactString(message, config);
    try {
      const token = readSimklToken(simklTokenPath(config));
      if (token?.access_token) {
        message = message.split(token.access_token).join("***");
      }
      if (token?.refresh_token) {
        message = message.split(token.refresh_token).join("***");
      }
    } catch {
      // ignore
    }
  }
  return redact(message);
}

function readSnapshot(db: Database): SimklActivities | null {
  const row = db
    .query<{ cursor: string | null }, [string]>(
      `SELECT cursor FROM sync_state WHERE source = ?;`
    )
    .get(SIMKL_SOURCE);

  if (!row || !row.cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.cursor);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.all === "string" &&
      parsed.all.trim() !== ""
    ) {
      return parsed as SimklActivities;
    }
    return null;
  } catch {
    return null;
  }
}

function saveSnapshot(
  db: Database,
  activities: unknown,
  now?: () => Date
): void {
  const cursor =
    typeof activities === "string"
      ? activities
      : JSON.stringify(activities);
  const updatedAt = (now ? now() : new Date()).toISOString();
  db.run(
    `INSERT INTO sync_state (source, cursor, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE
       SET cursor = excluded.cursor, updated_at = excluded.updated_at;`,
    [SIMKL_SOURCE, cursor, updatedAt]
  );
}

function unwrapList(res: unknown, type: string): unknown[] {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (typeof res === "object") {
    const dict = res as Record<string, unknown>;
    if (Array.isArray(dict[type])) return dict[type] as unknown[];
    if (Array.isArray(dict.items)) return dict.items as unknown[];
  }
  return [];
}

async function fetchTypeWithRetry(
  client: SyncSimklClient,
  type: "shows" | "movies" | "anime",
  query: Record<string, string | number | boolean>
): Promise<unknown[]> {
  try {
    const res = await client.get(`/sync/all-items/${type}`, query);
    return unwrapList(res, type);
  } catch (err) {
    if (
      err instanceof SimklApiError &&
      err.status === 400 &&
      err.code === "max_items"
    ) {
      const merged: unknown[] = [];
      for (const status of ALL_STATUSES) {
        const res = await client.get(
          `/sync/all-items/${type}/${status}`,
          query
        );
        merged.push(...unwrapList(res, type));
      }
      return merged;
    }
    throw err;
  }
}

async function fetchAllItemsDelta(
  client: SyncSimklClient,
  query: Record<string, string | number | boolean>
): Promise<SimklAllItems> {
  try {
    const res = await client.get<SimklAllItems>("/sync/all-items", query);
    if (res && typeof res === "object" && !Array.isArray(res)) {
      return {
        shows: unwrapList(res, "shows") as any,
        movies: unwrapList(res, "movies") as any,
        anime: unwrapList(res, "anime") as any,
      };
    }
    return { shows: [], movies: [], anime: [] };
  } catch (err) {
    if (
      err instanceof SimklApiError &&
      err.status === 400 &&
      err.code === "max_items"
    ) {
      const shows = (await fetchTypeWithRetry(client, "shows", query)) as any;
      const movies = (await fetchTypeWithRetry(client, "movies", query)) as any;
      const anime = (await fetchTypeWithRetry(client, "anime", query)) as any;
      return { shows, movies, anime };
    }
    throw err;
  }
}

/**
 * Run one Simkl sync.
 * Returns the run id, row counts, and mode ("full" | "delta" | "unchanged").
 * Throws SyncFailedError (after recording a failed run) on any failure.
 */
export async function syncSimkl(deps: SyncSimklDeps): Promise<SimklSyncResult> {
  const { client, sink, db, config, now } = deps;
  const runId = startRun(db, SIMKL_SOURCE, SIMKL_SYNC_KIND);

  let seen = 0;
  let inserted = 0;

  try {
    const savedSnapshot = readSnapshot(db);

    if (!savedSnapshot) {
      // First sync: no snapshot
      const activities = await client.get<SimklActivities>("/sync/activities");

      // Sequentially fetch shows, movies, anime
      const shows = (await fetchTypeWithRetry(
        client,
        "shows",
        ALL_ITEMS_BASE_PARAMS
      )) as any;
      const movies = (await fetchTypeWithRetry(
        client,
        "movies",
        ALL_ITEMS_BASE_PARAMS
      )) as any;
      const anime = (await fetchTypeWithRetry(
        client,
        "anime",
        ALL_ITEMS_BASE_PARAMS
      )) as any;

      const allItems: SimklAllItems = { shows, movies, anime };
      const events = mapAll(allItems);
      const writeResult = await sink.write(events, {
        source: SIMKL_SOURCE,
        runId,
      });

      seen = writeResult.seen;
      inserted = writeResult.inserted;

      finishRun(db, runId, {
        status: "ok",
        rowsSeen: seen,
        rowsInserted: inserted,
      });

      saveSnapshot(db, activities, now);
      return { runId, seen, inserted, mode: "full" };
    }

    // Subsequent sync: snapshot exists
    const newActivities = await client.get<SimklActivities>("/sync/activities");

    if (newActivities.all === savedSnapshot.all) {
      // Nothing changed
      finishRun(db, runId, {
        status: "ok",
        rowsSeen: 0,
        rowsInserted: 0,
      });
      return { runId, seen: 0, inserted: 0, mode: "unchanged" };
    }

    // Changed: delta sync
    const deltaQuery = {
      date_from: savedSnapshot.all,
      ...ALL_ITEMS_BASE_PARAMS,
    };

    const deltaItems = await fetchAllItemsDelta(client, deltaQuery);
    const events = mapAll(deltaItems);
    const writeResult = await sink.write(events, {
      source: SIMKL_SOURCE,
      runId,
    });

    seen = writeResult.seen;
    inserted = writeResult.inserted;

    finishRun(db, runId, {
      status: "ok",
      rowsSeen: seen,
      rowsInserted: inserted,
    });

    saveSnapshot(db, newActivities, now);
    return { runId, seen, inserted, mode: "delta" };
  } catch (err) {
    const message = redactErrorText(err, config);
    try {
      finishRun(db, runId, {
        status: "failed",
        rowsSeen: 0,
        rowsInserted: 0,
        error: message,
      });
    } catch {
      // Never let recording the failure mask the original error.
    }
    throw new SyncFailedError(message, { source: SIMKL_SOURCE, runId });
  }
}
