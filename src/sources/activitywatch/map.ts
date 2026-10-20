/**
 * ActivityWatch event mapping (pure).
 *
 * Converts ActivityWatch web.tab.current events into normalized `youtube` events:
 * - Extracts YouTube video IDs from URLs (watch, shorts, live, youtu.be, and optional music).
 * - Filters out incognito events entirely.
 * - Groups events into plays (gap <= 10 min joins, > 10 min splits, other video splits).
 * - Computes watched_seconds from audible events (or all durations if no audible key in bucket).
 * - Drops plays with watched_seconds < 30.
 * - Cleans titles (strips notification counts and " - YouTube" / " - YouTube Music").
 * - Builds deterministic NewEvent objects for idempotent insertion.
 */

import type { NewEvent } from "../../core/events.ts";
import { localParts } from "../../core/time.ts";
import { intervalDayRecords, type TimeInterval } from "../../core/shortform.ts";
import type { AwRawEvent } from "./types.ts";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface MapBucketOptions {
  bucketId: string;
  device: string;
  includeMusic?: boolean;
  shortformTz?: string;
  /** Timezone for per-video per-local-day merging when merging is enabled. */
  tz?: string;
  /** Minimum watched minutes per video per local day (0 disables filtering). */
  minWatchMinutes?: number;
}

export interface MergePlaysByDayOptions {
  tz?: string;
  minWatchMinutes?: number;
}

/**
 * Extracts an 11-character YouTube video ID from a URL, or null if not a video.
 */
export function extractVideoId(
  urlStr: string | undefined | null,
  includeMusic = false
): string | null {
  if (!urlStr || typeof urlStr !== "string") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const isYtHost =
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com" ||
    (includeMusic && hostname === "music.youtube.com");

  if (isYtHost) {
    if (parsed.pathname === "/watch" || parsed.pathname === "/watch/") {
      const v = parsed.searchParams.get("v");
      if (v && VIDEO_ID_RE.test(v)) {
        return v;
      }
    }
    const shortsMatch = parsed.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    if (shortsMatch) {
      return shortsMatch[1];
    }
    const liveMatch = parsed.pathname.match(/^\/live\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    if (liveMatch) {
      return liveMatch[1];
    }
    return null;
  }

  if (hostname === "youtu.be") {
    const youtuMatch = parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    if (youtuMatch) {
      return youtuMatch[1];
    }
    return null;
  }

  return null;
}

/**
 * Checks if a URL host is music.youtube.com.
 */
export function isMusicUrl(urlStr: string | undefined | null): boolean {
  if (!urlStr || typeof urlStr !== "string") {
    return false;
  }
  try {
    return new URL(urlStr).hostname.toLowerCase() === "music.youtube.com";
  } catch {
    return false;
  }
}

/**
 * Cleans a tab title by removing leading notification counts like "(3) "
 * and trailing " - YouTube" or " - YouTube Music". Returns null if empty.
 */
export function cleanTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  let clean = title.trim();
  if (clean === "") {
    return null;
  }

  // Remove leading notification count like (3) or (99+)
  clean = clean.replace(/^\(\d+\+?\)\s*/, "");

  // Remove trailing " - YouTube" or " - YouTube Music"
  clean = clean.replace(/(?:^|\s+)-\s*YouTube(?:\s+Music)?$/i, "");

  clean = clean.trim();
  return clean.length > 0 ? clean : null;
}

/**
 * Normalizes an ISO timestamp (possibly with microseconds or offsets)
 * to standard UTC ISO 8601 with milliseconds (e.g. 2026-10-17T18:02:11.123Z).
 */
export function normalizeTimestamp(dateOrIso: string | Date | number): string {
  if (dateOrIso instanceof Date) {
    return dateOrIso.toISOString();
  }
  if (typeof dateOrIso === "number") {
    return new Date(dateOrIso).toISOString();
  }
  const str = dateOrIso.trim();
  const hasTimezone = /([Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(str);
  const normalizedStr = hasTimezone ? str : `${str.replace(" ", "T")}Z`;
  return new Date(normalizedStr).toISOString();
}

interface RawPlay {
  videoId: string;
  events: AwRawEvent[];
}

/**
 * Maps raw ActivityWatch bucket events into NewEvent array.
 */
export function mapBucketEvents(
  rawEvents: AwRawEvent[],
  options: MapBucketOptions
): NewEvent[] {
  // Sort events by start time ascending
  const sorted = [...rawEvents].sort((a, b) => {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  // Check if any event in the whole bucket response has an audible key
  const hasAnyAudibleKey = sorted.some(
    (e) =>
      e.data &&
      typeof e.data === "object" &&
      "audible" in e.data &&
      e.data.audible !== undefined
  );

  const plays: RawPlay[] = [];
  const shorts: TimeInterval[] = [];
  let currentPlay: RawPlay | null = null;
  let previousEventEndMs = 0;

  for (const ev of sorted) {
    if (ev.data?.incognito === true) {
      continue;
    }

    const videoId = extractVideoId(ev.data?.url, options.includeMusic);
    if (!videoId) {
      // Non-video events in between don't end the play
      continue;
    }

    if (/\/shorts\//.test(new URL(ev.data!.url!).pathname)) {
      if (currentPlay) { plays.push(currentPlay); currentPlay = null; }
      // Foreground Shorts time is useful even when muted; no per-item minimum.
      const start = Date.parse(normalizeTimestamp(ev.timestamp));
      const duration = ev.duration;
      if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
        shorts.push([start, start + duration * 1000]);
      }
      continue;
    }

    const evStartMs = new Date(ev.timestamp).getTime();
    const evDurationMs = Math.round((ev.duration ?? 0) * 1000);
    const evEndMs = evStartMs + evDurationMs;

    if (!currentPlay) {
      currentPlay = { videoId, events: [ev] };
      previousEventEndMs = evEndMs;
    } else if (currentPlay.videoId === videoId) {
      const gapMs = evStartMs - previousEventEndMs;
      if (gapMs <= 10 * 60 * 1000) {
        // Gap <= 10 min joins
        currentPlay.events.push(ev);
        previousEventEndMs = evEndMs;
      } else {
        // Gap > 10 min splits
        plays.push(currentPlay);
        currentPlay = { videoId, events: [ev] };
        previousEventEndMs = evEndMs;
      }
    } else {
      // Event for a different video id ends the play
      plays.push(currentPlay);
      currentPlay = { videoId, events: [ev] };
      previousEventEndMs = evEndMs;
    }
  }

  if (currentPlay) {
    plays.push(currentPlay);
  }

  const result: NewEvent[] = intervalDayRecords(shorts, "aw", options.shortformTz ?? options.tz ?? "Europe/Bratislava");

  for (const play of plays) {
    let audibleDuration = 0;
    let totalDuration = 0;

    for (const ev of play.events) {
      const dur =
        typeof ev.duration === "number" && Number.isFinite(ev.duration)
          ? ev.duration
          : 0;
      totalDuration += dur;
      if (ev.data?.audible === true) {
        audibleDuration += dur;
      }
    }

    const watched_seconds = Math.round(
      hasAnyAudibleKey ? audibleDuration : totalDuration
    );

    if (watched_seconds < 30) {
      // Plays with watched_seconds < 30 are dropped
      continue;
    }

    const firstEvent = play.events[0];
    const lastEvent = play.events[play.events.length - 1];

    const started_at = normalizeTimestamp(firstEvent.timestamp);

    const lastEventStartMs = new Date(lastEvent.timestamp).getTime();
    const lastEventDurationMs = Math.round((lastEvent.duration ?? 0) * 1000);
    const ended_at = new Date(lastEventStartMs + lastEventDurationMs).toISOString();

    // Last non-empty tab title of the play, with notification count and YouTube suffix removed
    let rawTitle: string | null = null;
    for (let i = play.events.length - 1; i >= 0; i--) {
      const t = play.events[i].data?.title;
      if (typeof t === "string" && t.trim() !== "") {
        rawTitle = t;
        break;
      }
    }
    const title = cleanTitle(rawTitle);

    const audible_seconds = Math.round(audibleDuration * 1000) / 1000;
    const total_seconds = Math.round(totalDuration * 1000) / 1000;

    const isMusic = play.events.some((ev) => isMusicUrl(ev.data?.url));

    result.push({
      source: "youtube",
      source_kind: "aw_play",
      source_id: `${play.videoId}:${started_at}`,
      media_type: isMusic ? "music" : "video",
      title,
      parent_title: null,
      started_at,
      ended_at,
      duration_seconds: watched_seconds,
      progress: null,
      device: options.device,
      external_ids: { youtube_video: play.videoId },
      raw: {
        bucket: options.bucketId,
        events: play.events.length,
        audible_seconds,
        total_seconds,
      },
    });
  }

  if (options.tz !== undefined || options.minWatchMinutes !== undefined) {
    return mergePlaysByVideoDay(result, {
      tz: options.tz,
      minWatchMinutes: options.minWatchMinutes,
    });
  }

  return result;
}

/**
 * Merge ActivityWatch plays per video per local day in `tz` and filter out
 * video-days below `minWatchMinutes` (0 disables filtering).
 *
 * The merged play uses the earliest `started_at` on that local day as its
 * `started_at` and `source_id` (`${videoId}:${started_at}`), so repeat syncs
 * and plays that grow or cross the limit later on the same day update the same
 * `(source, source_kind, source_id)` key in `events_latest` without double
 * counting.
 */
export function mergePlaysByVideoDay(
  plays: readonly NewEvent[],
  opts: MergePlaysByDayOptions = {}
): NewEvent[] {
  const tz = opts.tz ?? "Europe/Bratislava";
  const minSeconds = Math.max(0, (opts.minWatchMinutes ?? 0) * 60);

  const kept: NewEvent[] = [];
  const groups = new Map<string, NewEvent[]>();

  for (const play of plays) {
    if (play.media_type === "music" || play.source_kind === "shortform_day") {
      kept.push(play);
      continue;
    }

    const ext = play.external_ids as Record<string, unknown> | null | undefined;
    const videoId =
      typeof ext?.["youtube_video"] === "string"
        ? ext["youtube_video"]
        : play.source_id.split(":")[0] ?? "unknown";
    const localDate = localParts(play.started_at, tz).date;
    const groupKey = `${videoId}\0${localDate}`;

    let group = groups.get(groupKey);
    if (!group) {
      group = [];
      groups.set(groupKey, group);
    }
    group.push(play);
  }

  for (const [groupKey, group] of groups.entries()) {
    const videoId = groupKey.split("\0")[0]!;
    const sorted = [...group].sort((a, b) =>
      a.started_at.localeCompare(b.started_at)
    );

    let merged: NewEvent;
    if (sorted.length === 1) {
      merged = sorted[0]!;
    } else {
      const first = sorted[0]!;
      const started_at = first.started_at;
      let ended_at: string | null = first.ended_at ?? null;
      let totalWatched = 0;
      let title: string | null = null;
      let rawEventsCount = 0;
      let rawAudibleSeconds = 0;
      let rawTotalSeconds = 0;
      let bucket = "";

      for (const p of sorted) {
        totalWatched += p.duration_seconds ?? 0;
        if (p.ended_at && (!ended_at || p.ended_at > ended_at)) {
          ended_at = p.ended_at;
        }
        if (typeof p.title === "string" && p.title.trim() !== "") {
          title = p.title;
        }
        const r = (p.raw ?? null) as Record<string, unknown> | null;
        if (r && typeof r === "object") {
          if (typeof r.bucket === "string" && bucket === "") {
            bucket = r.bucket;
          }
          if (typeof r.events === "number" && Number.isFinite(r.events)) {
            rawEventsCount += r.events;
          }
          if (
            typeof r.audible_seconds === "number" &&
            Number.isFinite(r.audible_seconds)
          ) {
            rawAudibleSeconds += r.audible_seconds;
          }
          if (
            typeof r.total_seconds === "number" &&
            Number.isFinite(r.total_seconds)
          ) {
            rawTotalSeconds += r.total_seconds;
          }
        }
      }

      merged = {
        ...first,
        source_id: `${videoId}:${started_at}`,
        title,
        started_at,
        ended_at,
        duration_seconds: totalWatched,
        raw: {
          bucket,
          events: rawEventsCount,
          audible_seconds: Math.round(rawAudibleSeconds * 1000) / 1000,
          total_seconds: Math.round(rawTotalSeconds * 1000) / 1000,
        },
      };
    }

    if (minSeconds > 0 && (merged.duration_seconds ?? 0) < minSeconds) {
      continue;
    }

    kept.push(merged);
  }

  kept.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return kept;
}
