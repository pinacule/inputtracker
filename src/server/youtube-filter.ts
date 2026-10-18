/**
 * Shared YouTube read filter and in-memory enrichment join (v2.1 section 10).
 *
 * Rules:
 * - Minimum watch time (`[youtube] min_watch_minutes`, default 5, 0 disables):
 *   a measured YouTube video (`source = 'youtube'`, `media_type = 'video'`,
 *   `duration_seconds != null`) counts only when the sum of its watched seconds
 *   on one local day in the configured timezone is at least
 *   `min_watch_minutes * 60` (e.g. >= 300s for 5 minutes; 5:00 counts).
 * - Video-days below the threshold remain in `events` (append-only) but are
 *   left out of every read, and counted in `YoutubeOverview.short_plays_hidden`.
 * - Enriched channel names and titles cached in `youtube_videos_latest` fill in
 *   missing `parent_title`/`title` on read without touching stored event rows
 *   and without making any network calls.
 */

import type { Database } from "bun:sqlite";
import type { Config, YoutubeConfig } from "../core/config.ts";
import type { YoutubeVideoRow } from "../core/schema.ts";
import {
  formatLocalParts,
  parseExternalIds,
  type ConsumptionEvent,
} from "./aggregate.ts";

export const DEFAULT_MIN_WATCH_MINUTES = 5;

const dbYoutubeConfigMap = new WeakMap<Database, YoutubeConfig>();

/**
 * Associate a `Config` (or `YoutubeConfig`) with a `Database` instance so shared
 * read helpers that only receive `db` respect the configured `min_watch_minutes`.
 */
export function setYoutubeConfigForDb(
  db: Database,
  configOrYoutube: Config | YoutubeConfig | undefined
): void {
  if (!configOrYoutube) {
    return;
  }
  const yt: YoutubeConfig | undefined =
    "youtube" in configOrYoutube ? configOrYoutube.youtube : configOrYoutube;
  if (yt) {
    dbYoutubeConfigMap.set(db, yt);
  }
}

export function getYoutubeMinWatchMinutesForDb(db?: Database): number {
  if (db) {
    const cfg = dbYoutubeConfigMap.get(db);
    if (
      cfg &&
      typeof cfg.min_watch_minutes === "number" &&
      Number.isFinite(cfg.min_watch_minutes) &&
      cfg.min_watch_minutes >= 0
    ) {
      return cfg.min_watch_minutes;
    }
  }
  return DEFAULT_MIN_WATCH_MINUTES;
}

/** Extract the 11-char `youtube_video` id from an event's `external_ids`, or null. */
export function getEventYoutubeVideoId(event: {
  external_ids?: unknown;
}): string | null {
  const ext = parseExternalIds(event.external_ids);
  const vid = ext?.["youtube_video"];
  if (typeof vid === "string" && vid.trim() !== "") {
    return vid.trim();
  }
  return null;
}

/**
 * Grouping key for a YouTube video when summing watched seconds per local day:
 * `youtube_video` id when present, else normalized title / source_id.
 */
export function extractYoutubeVideoKey(event: ConsumptionEvent): string {
  const vid = getEventYoutubeVideoId(event);
  if (vid !== null) {
    return `vid:${vid}`;
  }
  const title = event.title?.trim().toLowerCase();
  if (title) {
    return `title:${title}`;
  }
  return `id:${event.source_id ?? event.id}`;
}

/**
 * True when the event is a YouTube video play with a measured duration
 * (ActivityWatch `aw_play`, phone `phone_play`, etc.). Takeout `history_item`
 * rows have `duration_seconds === null` (unknown duration) and are not filtered.
 */
export function isMeasuredYoutubeVideoEvent(event: ConsumptionEvent): boolean {
  return (
    event.source === "youtube" &&
    event.media_type === "video" &&
    typeof event.duration_seconds === "number" &&
    Number.isFinite(event.duration_seconds)
  );
}

/** Read cached enrichment rows from `youtube_videos_latest` (no network). */
export function readYoutubeEnrichmentByVideoId(
  db: Database
): Map<string, YoutubeVideoRow> {
  const map = new Map<string, YoutubeVideoRow>();
  try {
    const rows = db
      .query<YoutubeVideoRow, []>(
        "SELECT * FROM youtube_videos_latest;"
      )
      .all();
    for (const row of rows) {
      map.set(row.video_id, row);
    }
  } catch {
    // Table/view may not exist on a pre-v7 read-only snapshot.
  }
  return map;
}

/**
 * Apply cached channel/title enrichment from `youtube_videos_latest` to
 * in-memory YouTube events whose `parent_title` or `title` is missing.
 * Events that already carry a channel (Takeout, phone plays) keep their own.
 */
export function applyYoutubeEnrichmentToEvents<T extends ConsumptionEvent>(
  events: readonly T[],
  db?: Database
): T[] {
  if (!db || events.length === 0) {
    return [...events];
  }
  const hasYoutube = events.some((e) => e.source === "youtube");
  if (!hasYoutube) {
    return [...events];
  }
  const enrichment = readYoutubeEnrichmentByVideoId(db);
  if (enrichment.size === 0) {
    return [...events];
  }

  return events.map((ev) => {
    if (ev.source !== "youtube") {
      return ev;
    }
    const vid = getEventYoutubeVideoId(ev);
    if (!vid) {
      return ev;
    }
    const info = enrichment.get(vid);
    if (!info) {
      return ev;
    }

    const existingChannel = ev.parent_title?.trim() ?? "";
    const newChannel =
      existingChannel !== "" ? ev.parent_title : (info.channel ?? ev.parent_title ?? null);

    const existingTitle = ev.title?.trim() ?? "";
    const newTitle =
      existingTitle !== "" ? ev.title : (info.title ?? ev.title ?? null);

    let newExternalIds = ev.external_ids;
    if (info.channel_id) {
      const extObj = parseExternalIds(ev.external_ids) ?? {};
      if (!extObj["youtube_channel"]) {
        newExternalIds = { ...extObj, youtube_channel: info.channel_id };
      }
    }

    if (
      newChannel === ev.parent_title &&
      newTitle === ev.title &&
      newExternalIds === ev.external_ids
    ) {
      return ev;
    }

    return {
      ...ev,
      title: newTitle,
      parent_title: newChannel,
      external_ids: newExternalIds,
    };
  });
}

export interface PartitionYoutubeEventsOptions {
  tz?: string;
  minWatchMinutes?: number;
  db?: Database;
}

export interface PartitionYoutubeEventsResult<T extends ConsumptionEvent> {
  kept: T[];
  /** Number of video-days below `min_watch_minutes` that were filtered out. */
  shortVideoDaysHidden: number;
}

/**
 * ActivityWatch plays stored before per-day merging existed stay in `events_latest` as separate
 * rows; when a later sync re-merges that day it writes the merged play under the first play's key,
 * so the earlier separate rows of the same video and day are covered twice. Plays of one video never
 * overlap, so a play whose interval lies inside another play's interval of the same video and day
 * is such a superseded row: drop it on read (the rows stay; append-only).
 */
export function dropSupersededActivityWatchPlays<T extends ConsumptionEvent>(
  events: readonly T[],
  tz: string
): T[] {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.source !== "youtube" || ev.source_kind !== "aw_play" || !ev.ended_at) continue;
    const key = `${extractYoutubeVideoKey(ev)}\0${formatLocalParts(ev.started_at, tz).date}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }
  const dropped = new Set<number>();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    for (const i of idxs) {
      const a = events[i]!;
      for (const j of idxs) {
        if (i === j || dropped.has(j)) continue;
        const b = events[j]!;
        const covers =
          b.started_at <= a.started_at &&
          (b.ended_at as string) >= (a.ended_at as string) &&
          (b.started_at !== a.started_at || (b.ended_at as string) > (a.ended_at as string));
        if (covers) {
          dropped.add(i);
          break;
        }
      }
    }
  }
  return dropped.size === 0 ? [...events] : events.filter((_, i) => !dropped.has(i));
}

/**
 * Drop YouTube Takeout views (`source = 'youtube'`, `source_kind = 'history_item'`)
 * on read when a measured play (`aw_play` or `phone_play`) of the same video
 * exists on the same local day in `tz`. If the measured play lacks a channel
 * (`parent_title`), it inherits the channel from the dropped Takeout view.
 */
export function dropTakeoutCoveredByMeasuredPlays<T extends ConsumptionEvent>(
  events: readonly T[],
  tz: string
): T[] {
  const measuredVideoDays = new Set<string>();
  const takeoutChannelByVideoDay = new Map<
    string,
    { parent_title: string | null; youtube_channel: string | null }
  >();
  let hasTakeout = false;

  for (const ev of events) {
    if (ev.source !== "youtube") {
      continue;
    }
    if (ev.source_kind === "aw_play" || ev.source_kind === "phone_play") {
      const key = `${extractYoutubeVideoKey(ev)}\0${formatLocalParts(ev.started_at, tz).date}`;
      measuredVideoDays.add(key);
    } else if (ev.source_kind === "history_item") {
      hasTakeout = true;
      const key = `${extractYoutubeVideoKey(ev)}\0${formatLocalParts(ev.started_at, tz).date}`;
      const ch = ev.parent_title?.trim() || null;
      const ext = parseExternalIds(ev.external_ids);
      const ytCh =
        typeof ext?.["youtube_channel"] === "string" &&
        ext["youtube_channel"].trim() !== ""
          ? ext["youtube_channel"].trim()
          : null;
      if (ch !== null || ytCh !== null) {
        const prev = takeoutChannelByVideoDay.get(key);
        takeoutChannelByVideoDay.set(key, {
          parent_title: ch ?? prev?.parent_title ?? null,
          youtube_channel: ytCh ?? prev?.youtube_channel ?? null,
        });
      }
    }
  }

  if (!hasTakeout || measuredVideoDays.size === 0) {
    return [...events];
  }

  const out: T[] = [];
  for (const ev of events) {
    if (ev.source === "youtube" && ev.source_kind === "history_item") {
      const key = `${extractYoutubeVideoKey(ev)}\0${formatLocalParts(ev.started_at, tz).date}`;
      if (measuredVideoDays.has(key)) {
        continue;
      }
      out.push(ev);
      continue;
    }

    if (
      ev.source === "youtube" &&
      (ev.source_kind === "aw_play" || ev.source_kind === "phone_play")
    ) {
      const key = `${extractYoutubeVideoKey(ev)}\0${formatLocalParts(ev.started_at, tz).date}`;
      const info = takeoutChannelByVideoDay.get(key);
      if (info) {
        const hasChannel = Boolean(ev.parent_title && ev.parent_title.trim() !== "");
        const nextParent = hasChannel ? ev.parent_title : info.parent_title;
        let nextExt = ev.external_ids;
        if (info.youtube_channel) {
          const extObj = parseExternalIds(ev.external_ids) ?? {};
          if (!extObj["youtube_channel"]) {
            nextExt = { ...extObj, youtube_channel: info.youtube_channel };
          }
        }
        if (nextParent !== ev.parent_title || nextExt !== ev.external_ids) {
          out.push({
            ...ev,
            parent_title: nextParent,
            external_ids: nextExt,
          });
          continue;
        }
      }
    }

    out.push(ev);
  }

  return out;
}

/**
 * Partition events by the YouTube minimum watch time per video per local day,
 * also applying cached channel enrichment when `db` is provided.
 */
export function partitionYoutubeEvents<T extends ConsumptionEvent>(
  events: readonly T[],
  opts: PartitionYoutubeEventsOptions = {}
): PartitionYoutubeEventsResult<T> {
  const tz = opts.tz ?? "Europe/Bratislava";
  const minWatchMinutes =
    opts.minWatchMinutes ?? getYoutubeMinWatchMinutesForDb(opts.db);
  const minSeconds = minWatchMinutes * 60;

  const enriched = dropTakeoutCoveredByMeasuredPlays(
    dropSupersededActivityWatchPlays(
      applyYoutubeEnrichmentToEvents(events, opts.db),
      tz
    ),
    tz
  );

  if (minSeconds <= 0) {
    return { kept: enriched, shortVideoDaysHidden: 0 };
  }

  // Sum watched seconds per (videoKey, localDate) for measured YouTube video events.
  const secondsByVideoDay = new Map<string, number>();
  const videoDayKeyByIndex = new Map<number, string>();

  for (let i = 0; i < enriched.length; i++) {
    const ev = enriched[i]!;
    if (!isMeasuredYoutubeVideoEvent(ev)) {
      continue;
    }
    const localDate = formatLocalParts(ev.started_at, tz).date;
    const videoKey = extractYoutubeVideoKey(ev);
    const dayKey = `${videoKey}\0${localDate}`;
    videoDayKeyByIndex.set(i, dayKey);
    secondsByVideoDay.set(
      dayKey,
      (secondsByVideoDay.get(dayKey) ?? 0) + Math.max(0, ev.duration_seconds ?? 0)
    );
  }

  if (secondsByVideoDay.size === 0) {
    return { kept: enriched, shortVideoDaysHidden: 0 };
  }

  let shortVideoDaysHidden = 0;
  for (const totalSec of secondsByVideoDay.values()) {
    if (totalSec < minSeconds) {
      shortVideoDaysHidden += 1;
    }
  }

  if (shortVideoDaysHidden === 0) {
    return { kept: enriched, shortVideoDaysHidden: 0 };
  }

  const kept: T[] = [];
  for (let i = 0; i < enriched.length; i++) {
    const ev = enriched[i]!;
    const dayKey = videoDayKeyByIndex.get(i);
    if (dayKey !== undefined) {
      const totalSec = secondsByVideoDay.get(dayKey) ?? 0;
      if (totalSec < minSeconds) {
        continue;
      }
    }
    kept.push(ev);
  }

  return { kept, shortVideoDaysHidden };
}

/**
 * Shared read filter: removes YouTube video plays whose per-video per-local-day
 * watched time is below `min_watch_minutes` (default 5, 0 disables), and fills
 * in cached channel names from `youtube_videos_latest`.
 */
export function filterShortYoutubeEvents<T extends ConsumptionEvent>(
  events: readonly T[],
  tz: string = "Europe/Bratislava",
  db?: Database,
  minWatchMinutes?: number
): T[] {
  return partitionYoutubeEvents(events, { tz, db, minWatchMinutes }).kept;
}
