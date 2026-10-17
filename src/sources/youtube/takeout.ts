/**
 * YouTube Takeout watch-history import.
 *
 * Reads Google Takeout's `YouTube and YouTube Music/history/watch-history.json`
 * (a JSON array of activity records) and maps each record to an InputTracker
 * event. There is **no network** here: the file is parsed locally, once, with
 * `JSON.parse`.
 *
 * Skip rules (checked in this order) and the event mapping are documented in
 * `docs/youtube-takeout.md`. Every record ends up either as one event or as one
 * counted skip reason, so `records === seen + ads + no_video + other + invalid`.
 */

import type { Database } from "bun:sqlite";
import {
  finishRun,
  insertEvents,
  startRun,
  type NewEvent,
} from "../../core/events.ts";
import { toUtcIso } from "../../core/time.ts";

/** `events` source used for the ingest run recorded by a Takeout import. */
export const YOUTUBE_TAKEOUT_SOURCE = "youtube-takeout";

/** One `insertEvents` call per batch; each call is a single transaction. */
const BATCH_SIZE = 1000;

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** The only title prefix stripped; other UI languages keep their title as-is. */
const WATCHED_PREFIX = "Watched ";

const TAKEOUT_ERROR =
  "not a YouTube Takeout watch-history JSON array; choose JSON, not HTML, in Takeout";

export type SkipReason = "ads" | "no_video" | "other" | "invalid";

export interface TakeoutSkipCounts {
  ads: number;
  no_video: number;
  other: number;
  invalid: number;
}

export type TakeoutMapResult =
  | { kind: "event"; event: NewEvent }
  | { kind: "skip"; reason: SkipReason };

export interface ImportYoutubeTakeoutResult {
  /** Number of records in the JSON array. */
  records: number;
  /** Number of records mapped to an event. */
  seen: number;
  /** Number of events actually inserted (duplicates are ignored). */
  inserted: number;
  /** Records skipped, by reason. */
  skipped: TakeoutSkipCounts;
  /** Id of the `ingest_runs` row written for this import. */
  runId: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract the YouTube video id from a `titleUrl`.
 *
 * Accepts `watch?v=<id>` on `www.youtube.com`, `m.youtube.com` and
 * `music.youtube.com`, plus `youtu.be/<id>`. Anything else (unknown host,
 * missing/invalid id, unparseable URL) returns `null` and never throws.
 */
export function extractVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (host === "youtu.be") {
    const first = parsed.pathname.split("/").find((segment) => segment !== "");
    return first !== undefined && VIDEO_ID_RE.test(first) ? first : null;
  }

  if (
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com"
  ) {
    const id = parsed.searchParams.get("v");
    return id !== null && VIDEO_ID_RE.test(id) ? id : null;
  }

  return null;
}

/** Extract the channel id from a `subtitles[0].url` like `.../channel/<id>`. */
function extractChannelId(url: unknown): string | null {
  if (typeof url !== "string") {
    return null;
  }
  const match = /\/channel\/([A-Za-z0-9_-]+)/.exec(url);
  return match !== null ? (match[1] as string) : null;
}

/**
 * Map one Takeout record to an event or a skip reason.
 *
 * Rules, checked in order: invalid (no/!parseable `time`) → ads → other
 * (`products` without `"YouTube"`) → no_video (no usable `titleUrl`) → event.
 */
export function mapTakeoutRecord(record: unknown): TakeoutMapResult {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { kind: "skip", reason: "invalid" };
  }
  const rec = record as Record<string, unknown>;

  // 1. `time` must be present and parseable.
  let startedAt: string;
  try {
    startedAt = toUtcIso(rec.time as number | string | Date);
  } catch {
    return { kind: "skip", reason: "invalid" };
  }

  // 2. `details` with a Google Ads entry marks an advertisement.
  if (Array.isArray(rec.details)) {
    for (const detail of rec.details) {
      if (
        detail !== null &&
        typeof detail === "object" &&
        (detail as Record<string, unknown>).name === "From Google Ads"
      ) {
        return { kind: "skip", reason: "ads" };
      }
    }
  }

  // 3. `products` present but without "YouTube" is not watch history.
  if (Array.isArray(rec.products) && !rec.products.includes("YouTube")) {
    return { kind: "skip", reason: "other" };
  }

  // 4. A record without a usable video id is a removed/private video, survey…
  const titleUrl = rec.titleUrl;
  const videoId =
    typeof titleUrl === "string" ? extractVideoId(titleUrl) : null;
  if (videoId === null) {
    return { kind: "skip", reason: "no_video" };
  }

  // 5. One event per view.
  let parentTitle: string | null = null;
  let channelId: string | null = null;
  if (Array.isArray(rec.subtitles) && rec.subtitles.length > 0) {
    const first = rec.subtitles[0];
    if (first !== null && typeof first === "object") {
      const sub = first as Record<string, unknown>;
      parentTitle = typeof sub.name === "string" ? sub.name : null;
      channelId = extractChannelId(sub.url);
    }
  }

  let title: string | null = null;
  if (typeof rec.title === "string") {
    title = rec.title.startsWith(WATCHED_PREFIX)
      ? rec.title.slice(WATCHED_PREFIX.length)
      : rec.title;
  }

  const externalIds: Record<string, unknown> = {
    youtube_video: videoId,
    youtube_channel: channelId,
  };
  if (rec.header === "YouTube Music") {
    externalIds.youtube_music = true;
  }

  return {
    kind: "event",
    event: {
      source: "youtube",
      source_kind: "history_item",
      source_id: `${videoId}:${startedAt}`,
      external_ids: externalIds,
      media_type: "video",
      title,
      parent_title: parentTitle,
      started_at: startedAt,
      ended_at: null,
      duration_seconds: null,
      progress: null,
      raw: rec,
    },
  };
}

/**
 * `true` when `text` looks like a Takeout watch-history export: the first
 * non-whitespace character is `[`. The native export is a JSON object (`{`)
 * and CSV starts with a header, so this is a cheap discriminator, not a parse.
 */
export function looksLikeTakeout(text: string): boolean {
  return text.trimStart().startsWith("[");
}

/**
 * Import a YouTube Takeout watch-history JSON array into `events`.
 *
 * The whole file is parsed once; events are inserted in batches of
 * `BATCH_SIZE`. An `ingest_runs` row is always written, `ok` on success and
 * `failed` (with the error text) when the file is not a JSON array or anything
 * else throws.
 */
export function importYoutubeTakeout(
  db: Database,
  text: string
): ImportYoutubeTakeoutResult {
  const runId = startRun(db, YOUTUBE_TAKEOUT_SOURCE);
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(TAKEOUT_ERROR);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(TAKEOUT_ERROR);
    }

    const events: NewEvent[] = [];
    const skipped: TakeoutSkipCounts = {
      ads: 0,
      no_video: 0,
      other: 0,
      invalid: 0,
    };

    for (const record of parsed) {
      const mapped = mapTakeoutRecord(record);
      if (mapped.kind === "event") {
        events.push(mapped.event);
      } else {
        skipped[mapped.reason] += 1;
      }
    }

    const seen = events.length;
    let inserted = 0;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      inserted += insertEvents(db, runId, batch).inserted;
    }

    finishRun(db, runId, {
      status: "ok",
      rowsSeen: seen,
      rowsInserted: inserted,
    });
    return { records: parsed.length, seen, inserted, skipped, runId };
  } catch (caught) {
    finishRun(db, runId, {
      status: "failed",
      rowsSeen: 0,
      rowsInserted: 0,
      error: errorText(caught),
    });
    throw caught;
  }
}
