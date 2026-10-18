/**
 * ActivityWatch sync: fetch buckets → fetch events → map → sink.
 *
 * Rules:
 * - Read-only: GET requests only via ActivityWatchClient.
 * - One ingest_runs row per run (ACTIVITYWATCH_SOURCE = "activitywatch").
 * - Filters buckets whose type is "web.tab.current".
 * - If no web.tab.current bucket exists: finishes ok with seen 0, prints hint.
 * - Per-bucket cursor in sync_state under "activitywatch:<bucket id>".
 * - Window: start = cursor - 10 min (first run: now - 7 days), end = now.
 * - New cursor = started_at of earliest play that may still be going (ended_at
 *   within 10 minutes of end), otherwise end.
 * - One transaction per bucket via sink.write.
 * - On failure: record failed ingest_runs, throw SyncFailedError.
 */

import type { Database } from "bun:sqlite";
import { redact, redactString, type Config } from "../../core/config.ts";
import { finishRun, startRun, type NewEvent } from "../../core/events.ts";
import type { Sink } from "../../core/sink.ts";
import { DATE_ONLY_RE, localParts, localToUtcIso } from "../../core/time.ts";
import { SyncFailedError } from "../audiobookshelf/sync.ts";
import { enrichYoutubeVideos } from "../youtube/enrich.ts";
import type { ActivityWatchClient, FetchFn } from "./client.ts";
import { mapBucketEvents, mergePlaysByVideoDay } from "./map.ts";

export { SyncFailedError } from "../audiobookshelf/sync.ts";

export const ACTIVITYWATCH_SOURCE = "activitywatch";
export const ACTIVITYWATCH_SYNC_KIND = "sync";
export const ACTIVITYWATCH_BACKFILL_KIND = "backfill";

export interface BackfillActivityWatchDeps {
  client: ActivityWatchClient;
  sink: Sink;
  db: Database;
  since: string;
  config?: Config;
  now?: () => Date;
  out?: (line: string) => void;
  fetch?: typeof fetch | FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncActivityWatchDeps {
  client: ActivityWatchClient;
  sink: Sink;
  db: Database;
  config?: Config;
  now?: () => Date;
  out?: (line: string) => void;
  fetch?: typeof fetch | FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export interface ActivityWatchSyncResult {
  runId: number;
  seen: number;
  inserted: number;
  buckets: number;
}

function sanitizeError(err: unknown, config?: Config): string {
  let raw = err instanceof Error ? err.message : String(err);
  // Ensure no URL query strings are present in the error message
  raw = raw.replace(/\?[^ \t\r\n]*/g, "").trim();
  const msg = raw !== "" ? raw : "activitywatch unreachable";
  return config ? redactString(msg, config) : redact(msg);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

export async function syncActivityWatch(
  deps: SyncActivityWatchDeps
): Promise<ActivityWatchSyncResult> {
  const { client, sink, db, config, now, out } = deps;
  const runId = startRun(db, ACTIVITYWATCH_SOURCE, ACTIVITYWATCH_SYNC_KIND);

  let totalSeen = 0;
  let totalInserted = 0;
  let processedBuckets = 0;

  try {
    const nowDate = now ? now() : new Date();
    const endIso = nowDate.toISOString();

    const allBuckets = await client.getBuckets();
    const matchingBucketIds = Object.keys(allBuckets)
      .filter((id) => allBuckets[id]?.type === "web.tab.current")
      .sort();

    if (matchingBucketIds.length === 0) {
      out?.(
        "No web.tab.current bucket found; is the aw-watcher-web browser extension installed?"
      );
      finishRun(db, runId, {
        status: "ok",
        rowsSeen: 0,
        rowsInserted: 0,
      });
      return { runId, seen: 0, inserted: 0, buckets: 0 };
    }

    const tz = config?.timezone ?? "Europe/Bratislava";
    const device = config?.activitywatch?.device ?? "pc";
    const includeMusic = config?.activitywatch?.include_music ?? false;
    const minWatchMinutes = config?.youtube?.min_watch_minutes ?? 5;
    const todayLocal = localParts(nowDate.toISOString(), tz).date;
    const todayStartMs = new Date(localToUtcIso(todayLocal, tz)).getTime();

    for (const bucketId of matchingBucketIds) {
      const syncKey = `activitywatch:${bucketId}`;
      const cursorRow = db
        .query<{ cursor: string | null }, [string]>(
          `SELECT cursor FROM sync_state WHERE source = ?;`
        )
        .get(syncKey);

      let startIso: string;
      if (cursorRow && cursorRow.cursor) {
        const cursorMs = new Date(cursorRow.cursor).getTime();
        startIso = new Date(
          Math.min(cursorMs - TEN_MINUTES_MS, todayStartMs)
        ).toISOString();
      } else {
        startIso = new Date(nowDate.getTime() - SEVEN_DAYS_MS).toISOString();
      }

      const rawEvents = await client.getEvents(bucketId, startIso, endIso);

      const rawPlays = mapBucketEvents(rawEvents, {
        bucketId,
        device,
        includeMusic,
      });

      const events = mergePlaysByVideoDay(rawPlays, {
        tz,
        minWatchMinutes,
      });

      const writeResult = await sink.write(events, {
        source: ACTIVITYWATCH_SOURCE,
        runId,
      });

      totalSeen += writeResult.seen;
      totalInserted += writeResult.inserted;
      processedBuckets++;

      // Compute new cursor for this bucket:
      // earliest started_at of plays whose ended_at is within 10 minutes of end,
      // otherwise end.
      const windowEndMs = nowDate.getTime();
      let earliestOpenPlayStart: string | null = null;
      let minStartMs = Infinity;

      for (const event of rawPlays) {
        if (event.ended_at) {
          const playEndMs = new Date(event.ended_at).getTime();
          if (windowEndMs - playEndMs <= TEN_MINUTES_MS) {
            const playStartMs = new Date(event.started_at).getTime();
            if (playStartMs < minStartMs) {
              minStartMs = playStartMs;
              earliestOpenPlayStart = event.started_at;
            }
          }
        }
      }

      const newCursor = earliestOpenPlayStart ?? endIso;

      db.run(
        `INSERT INTO sync_state (source, cursor, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE
           SET cursor = excluded.cursor, updated_at = excluded.updated_at;`,
        [syncKey, newCursor, nowDate.toISOString()]
      );
    }

    finishRun(db, runId, {
      status: "ok",
      rowsSeen: totalSeen,
      rowsInserted: totalInserted,
    });

    const enrichFetch = deps.fetch ?? client.fetch;
    await enrichYoutubeVideos(db, {
      config,
      fetch: enrichFetch as typeof fetch | undefined,
      sleep: deps.sleep,
      nowMs: () => nowDate.getTime(),
    });

    return {
      runId,
      seen: totalSeen,
      inserted: totalInserted,
      buckets: processedBuckets,
    };
  } catch (err) {
    const message = sanitizeError(err, config);
    try {
      finishRun(db, runId, {
        status: "failed",
        rowsSeen: 0,
        rowsInserted: 0,
        error: message,
      });
    } catch {
      // Do not let recording failure hide original error
    }
    throw new SyncFailedError(message, {
      source: ACTIVITYWATCH_SOURCE,
      runId,
    });
  }
}

export async function backfillActivityWatch(
  deps: BackfillActivityWatchDeps
): Promise<ActivityWatchSyncResult> {
  const { client, sink, db, since, config, now, out } = deps;
  const tz = config?.timezone ?? "Europe/Bratislava";

  const trimmedSince = since.trim();
  const isDateOnly = DATE_ONLY_RE.test(trimmedSince);
  if (!isDateOnly && !/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(trimmedSince)) {
    throw new Error(`Invalid --since date: "${since}" (expected YYYY-MM-DD)`);
  }

  let sinceUtcIso: string;
  try {
    sinceUtcIso = localToUtcIso(trimmedSince, tz);
  } catch {
    throw new Error(`Invalid --since date: "${since}"`);
  }

  const nowDate = now ? now() : new Date();
  const todayLocal = localParts(nowDate.toISOString(), tz).date;
  if (isDateOnly && trimmedSince > todayLocal) {
    throw new Error(`--since date cannot be in the future: "${since}"`);
  }
  if (new Date(sinceUtcIso).getTime() > nowDate.getTime()) {
    throw new Error(`--since date cannot be in the future: "${since}"`);
  }

  const runId = startRun(db, ACTIVITYWATCH_SOURCE, ACTIVITYWATCH_BACKFILL_KIND);

  let totalSeen = 0;
  let totalInserted = 0;
  let processedBuckets = 0;

  try {
    const allBuckets = await client.getBuckets();
    const matchingBucketIds = Object.keys(allBuckets)
      .filter((id) => allBuckets[id]?.type === "web.tab.current")
      .sort();

    if (matchingBucketIds.length === 0) {
      out?.(
        "No web.tab.current bucket found; is the aw-watcher-web browser extension installed?"
      );
      finishRun(db, runId, {
        status: "ok",
        rowsSeen: 0,
        rowsInserted: 0,
      });
      return { runId, seen: 0, inserted: 0, buckets: 0 };
    }

    const device = config?.activitywatch?.device ?? "pc";
    const includeMusic = config?.activitywatch?.include_music ?? false;
    const minWatchMinutes = config?.youtube?.min_watch_minutes ?? 5;

    for (const bucketId of matchingBucketIds) {
      // Find stored aw_plays for this bucket
      const storedRows = db
        .query<{ started_at: string; ended_at: string }, [string]>(
          `SELECT started_at, COALESCE(ended_at, started_at) AS ended_at
           FROM events_latest
           WHERE source_kind = 'aw_play'
             AND json_extract(raw, '$.bucket') = ?
           ORDER BY started_at ASC;`
        )
        .all(bucketId);

      const oldest =
        storedRows.length > 0
          ? storedRows[0].started_at
          : nowDate.toISOString();

      const windowStartMs = new Date(sinceUtcIso).getTime();
      const windowEndMs = new Date(oldest).getTime();

      let bucketChunks = 0;
      let bucketSeen = 0;
      let bucketInserted = 0;

      if (windowStartMs < windowEndMs) {
        let currentChunkStartMs = windowStartMs;

        while (currentChunkStartMs < windowEndMs) {
          const tentativeEndMs = currentChunkStartMs + SEVEN_DAYS_MS;
          const chunkEndMs = Math.min(tentativeEndMs, windowEndMs);
          const isFinalChunk = chunkEndMs >= windowEndMs;

          const chunkStartIso = new Date(currentChunkStartMs).toISOString();
          const chunkEndIso = new Date(chunkEndMs).toISOString();
          bucketChunks++;

          const rawEvents = await client.getEvents(
            bucketId,
            chunkStartIso,
            chunkEndIso
          );

          const mappedEvents = mapBucketEvents(rawEvents, {
            bucketId,
            device,
            includeMusic,
          });

          let earliestOpenPlayStartMs: number | null = null;
          if (!isFinalChunk) {
            for (const ev of mappedEvents) {
              const pEndMs = ev.ended_at
                ? new Date(ev.ended_at).getTime()
                : new Date(ev.started_at).getTime();
              if (chunkEndMs - pEndMs <= TEN_MINUTES_MS) {
                const pStartMs = new Date(ev.started_at).getTime();
                if (
                  earliestOpenPlayStartMs === null ||
                  pStartMs < earliestOpenPlayStartMs
                ) {
                  earliestOpenPlayStartMs = pStartMs;
                }
              }
            }
          }

          const closedPlays = isFinalChunk
            ? mappedEvents
            : mappedEvents.filter((ev) => {
                const pEndMs = ev.ended_at
                  ? new Date(ev.ended_at).getTime()
                  : new Date(ev.started_at).getTime();
                return chunkEndMs - pEndMs > TEN_MINUTES_MS;
              });

          const closedEvents = mergePlaysByVideoDay(closedPlays, {
            tz,
            minWatchMinutes,
          });

          // Skip any backfill play whose [started_at, ended_at] overlaps a stored aw_play of the same bucket
          const eventsToEmit: NewEvent[] = [];
          for (const ev of closedEvents) {
            const evStartMs = new Date(ev.started_at).getTime();
            const evEndMs = ev.ended_at
              ? new Date(ev.ended_at).getTime()
              : evStartMs;
            const overlaps = storedRows.some((stored) => {
              const sStartMs = new Date(stored.started_at).getTime();
              const sEndMs = new Date(stored.ended_at).getTime();
              return evEndMs >= sStartMs && evStartMs <= sEndMs;
            });
            if (!overlaps) {
              eventsToEmit.push(ev);
            }
          }

          const writeResult = await sink.write(eventsToEmit, {
            source: ACTIVITYWATCH_SOURCE,
            runId,
          });

          bucketSeen += writeResult.seen;
          bucketInserted += writeResult.inserted;

          if (isFinalChunk) {
            currentChunkStartMs = windowEndMs;
          } else if (
            earliestOpenPlayStartMs !== null &&
            earliestOpenPlayStartMs > currentChunkStartMs
          ) {
            currentChunkStartMs = earliestOpenPlayStartMs;
          } else {
            currentChunkStartMs = chunkEndMs;
          }
        }
      }

      totalSeen += bucketSeen;
      totalInserted += bucketInserted;
      processedBuckets++;

      out?.(
        `activitywatch backfill ${bucketId}: ${bucketChunks} chunks, ${bucketSeen} seen, ${bucketInserted} new`
      );
    }

    finishRun(db, runId, {
      status: "ok",
      rowsSeen: totalSeen,
      rowsInserted: totalInserted,
    });

    const enrichFetch = deps.fetch ?? client.fetch;
    await enrichYoutubeVideos(db, {
      config,
      fetch: enrichFetch as typeof fetch | undefined,
      sleep: deps.sleep,
      nowMs: () => nowDate.getTime(),
    });

    return {
      runId,
      seen: totalSeen,
      inserted: totalInserted,
      buckets: processedBuckets,
    };
  } catch (err) {
    const message = sanitizeError(err, config);
    try {
      finishRun(db, runId, {
        status: "failed",
        rowsSeen: 0,
        rowsInserted: 0,
        error: message,
      });
    } catch {
      // Do not let recording failure hide original error
    }
    throw new SyncFailedError(message, {
      source: ACTIVITYWATCH_SOURCE,
      runId,
    });
  }
}

