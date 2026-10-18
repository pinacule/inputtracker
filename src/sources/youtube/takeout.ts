/**
 * YouTube Takeout import (HTML, JSON, folder, or Takeout zip).
 *
 * Reads Google Takeout's `YouTube and YouTube Music`:
 * - `history/watch-history.html` or `history/watch-history.json`
 * - `playlists/Favorite Songs-videos.csv`
 * - `subscriptions/subscriptions.csv`
 *
 * Applies the gap rule for watch duration estimation, skips views below
 * `[youtube] min_watch_minutes` (default 5, videos only; YouTube Music is
 * exempt), caps durations by known video/track lengths from `youtube_videos_latest`
 * (or 3h for unknown videos, 30m for the newest video view, 4m for unknown
 * music tracks), and skips views when a measured play (`aw_play` / `phone_play`)
 * of the same video exists on the same local day.
 *
 * There is **no network** here: files are parsed locally.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../core/config.ts";
import {
  finishRun,
  insertEvents,
  startRun,
  type MediaType,
  type NewEvent,
} from "../../core/events.ts";
import type {
  EventRow,
  YoutubeFavoriteRow,
  YoutubeSubscriptionRow,
  YoutubeVideoRow,
} from "../../core/schema.ts";
import { localParts, toUtcIso } from "../../core/time.ts";
import { parseCsvRows } from "../../io/csv.ts";
import { isZipBytes, readZip } from "../../io/zip.ts";

/** `events` source used for the ingest run recorded by a Takeout import. */
export const YOUTUBE_TAKEOUT_SOURCE = "youtube-takeout";

/** One `insertEvents` call per batch; each call is a single transaction. */
const BATCH_SIZE = 1000;

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** The only title prefix stripped; other UI languages keep their title as-is. */
const WATCHED_PREFIX = "Watched ";

/** Default minimum watch time in minutes for YouTube video views. */
export const DEFAULT_TAKEOUT_MIN_WATCH_MINUTES = 5;

/** Default cap for a video view when video length is unknown: 3 hours (10800s). */
export const UNKNOWN_VIDEO_CAP_SECONDS = 3 * 3600;

/** Default duration for the newest video view (no next view) when length is unknown: 30 min (1800s). */
export const NEWEST_VIDEO_DEFAULT_SECONDS = 30 * 60;

/** Default cap for a YouTube Music listen when track length is unknown: 4 min (240s). */
export const UNKNOWN_MUSIC_CAP_SECONDS = 4 * 60;

const TAKEOUT_ERROR =
  "not a YouTube Takeout watch-history JSON array or HTML export";

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

export interface ImportYoutubeTakeoutOptions {
  config?: Config;
  tz?: string;
  minWatchMinutes?: number;
  dryRun?: boolean;
  favoritesCsv?: string;
  subscriptionsCsv?: string;
  nowIso?: string;
}

export interface ImportYoutubeTakeoutResult {
  /** Number of activity records in the JSON array or HTML file. */
  records: number;
  /** Number of records mapped to a view (before gap and dedupe rules). */
  seen: number;
  /** Number of events actually inserted (duplicates are ignored; 0 on dry-run). */
  inserted: number;
  /** Records skipped by kind (ads, no_video, other, invalid). */
  skipped: TakeoutSkipCounts;
  /** Id of the `ingest_runs` row written for this import (0 on dry-run). */
  runId: number;
  /** Video views skipped because their gap to the next view is under `min_watch_minutes`. */
  gap_skipped: number;
  /** Views skipped because a measured play (`aw_play` / `phone_play`) exists on the same local day. */
  dedup_skipped: number;
  /** Views kept after gap and dedupe rules (videos + music). */
  stored: number;
  /** YouTube Music views kept. */
  music: number;
  /** Total estimated hours across kept views (`sum(duration_seconds) / 3600`). */
  estimated_hours: number;
  /** Favourite tracks read from `Favorite Songs-videos.csv`. */
  favorites: number;
  /** Favourite tracks newly inserted into `youtube_favorites`. */
  favorites_inserted: number;
  /** Subscriptions read from `subscriptions.csv`. */
  subscriptions: number;
  /** Subscriptions newly inserted into `youtube_subscriptions`. */
  subscriptions_inserted: number;
  /** True when run with `dryRun: true`. */
  dry_run: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  emsp: " ",
  ensp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

/** Decode HTML entities (`&amp;`, `&#39;`, `&#x27;`, `&quot;`, etc.). */
export function decodeTakeoutHtmlEntities(input: string): string {
  if (!input.includes("&")) {
    return input;
  }
  return input.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (full, dec?: string, hex?: string, named?: string) => {
      if (dec !== undefined) {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
      }
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
      }
      if (named !== undefined) {
        const lower = named.toLowerCase();
        if (lower in NAMED_HTML_ENTITIES) {
          return NAMED_HTML_ENTITIES[lower]!;
        }
      }
      return full;
    }
  );
}

/**
 * Extract the YouTube video id from a `titleUrl`.
 *
 * Accepts `watch?v=<id>` on `www.youtube.com`, `m.youtube.com`, `youtube.com` and
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
    host === "youtube.com" ||
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
 * Map one JSON Takeout record to an event or a skip reason.
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

// --- HTML Takeout parsing ----------------------------------------------------

const MONTH_INDEX: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Known timezone abbreviations in Google Takeout HTML exports mapped to their
 * fixed offset from UTC in minutes (east is positive, west is negative).
 * Unknown abbreviations are rejected so entries are skipped and counted.
 */
export const TAKEOUT_TZ_OFFSETS_MINUTES: Readonly<Record<string, number>> = {
  UTC: 0,
  GMT: 0,
  Z: 0,
  WET: 0,
  WEST: 60,
  BST: 60,
  IST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  MSK: 180,
  AST: -240,
  EDT: -240,
  EST: -300,
  CDT: -300,
  CST: -360,
  MDT: -360,
  MST: -420,
  PDT: -420,
  PST: -480,
  AKDT: -480,
  AKST: -540,
  HDT: -540,
  HST: -600,
};

const HTML_DATE_RE =
  /^([A-Za-z]{3,4})\s+(\d{1,2}),\s*(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?\s+([A-Za-z0-9_+-]+)$/i;

/**
 * Parse an English Google Takeout HTML date string like
 * `"Oct 18, 2026, 3:25:57 AM CEST"` (where the space before AM/PM may be
 * `U+202F`) into a UTC ISO 8601 string (`"2026-10-18T01:25:57.000Z"`).
 *
 * Returns `null` when the date or timezone abbreviation is unknown/invalid.
 */
export function parseTakeoutHtmlTimestamp(rawDate: string): string | null {
  if (typeof rawDate !== "string") {
    return null;
  }
  const normalized = decodeTakeoutHtmlEntities(rawDate)
    .replace(/[\s\u00a0\u202f]+/g, " ")
    .trim();
  if (normalized === "") {
    return null;
  }

  const match = HTML_DATE_RE.exec(normalized);
  if (!match) {
    return null;
  }

  const monthStr = match[1]!.toLowerCase();
  const month = MONTH_INDEX[monthStr];
  if (month === undefined) {
    return null;
  }

  const day = Number.parseInt(match[2]!, 10);
  const year = Number.parseInt(match[3]!, 10);
  const rawHour = Number.parseInt(match[4]!, 10);
  const minute = Number.parseInt(match[5]!, 10);
  const second = Number.parseInt(match[6]!, 10);
  const ampm = match[7] ? match[7].toUpperCase() : null;
  const tzAbbr = match[8]!.toUpperCase();

  if (
    day < 1 ||
    day > 31 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  let hour24: number;
  if (ampm !== null) {
    if (rawHour < 1 || rawHour > 12) {
      return null;
    }
    if (ampm === "AM") {
      hour24 = rawHour === 12 ? 0 : rawHour;
    } else {
      hour24 = rawHour === 12 ? 12 : rawHour + 12;
    }
  } else {
    if (rawHour < 0 || rawHour > 23) {
      return null;
    }
    hour24 = rawHour;
  }

  let offsetMinutes: number | undefined = TAKEOUT_TZ_OFFSETS_MINUTES[tzAbbr];
  if (offsetMinutes === undefined) {
    const gmtOffset = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tzAbbr);
    if (gmtOffset) {
      const sign = gmtOffset[1] === "-" ? -1 : 1;
      const hh = Number.parseInt(gmtOffset[2]!, 10);
      const mm = gmtOffset[3] ? Number.parseInt(gmtOffset[3], 10) : 0;
      if (hh <= 14 && mm < 60) {
        offsetMinutes = sign * (hh * 60 + mm);
      }
    }
  }

  if (offsetMinutes === undefined) {
    return null;
  }

  const calCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calCheck.getUTCFullYear() !== year ||
    calCheck.getUTCMonth() !== month - 1 ||
    calCheck.getUTCDate() !== day
  ) {
    return null;
  }

  const utcMs =
    Date.UTC(year, month - 1, day, hour24, minute, second) -
    offsetMinutes * 60_000;
  return new Date(utcMs).toISOString();
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function extractDivByClass(
  blockHtml: string,
  requiredClass: string,
  forbiddenClass?: string
): string | null {
  let searchPos = 0;
  while (searchPos < blockHtml.length) {
    const divIdx = blockHtml.indexOf("<div", searchPos);
    if (divIdx === -1) {
      break;
    }
    const tagEnd = blockHtml.indexOf(">", divIdx);
    if (tagEnd === -1) {
      break;
    }
    const openTag = blockHtml.slice(divIdx, tagEnd + 1);
    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(openTag);
    const classVal = classMatch ? (classMatch[1] ?? classMatch[2] ?? "") : "";

    if (
      classVal.includes(requiredClass) &&
      (!forbiddenClass || !classVal.includes(forbiddenClass))
    ) {
      // Find matching </div>
      let depth = 1;
      let cursor = tagEnd + 1;
      while (cursor < blockHtml.length && depth > 0) {
        const nextOpen = blockHtml.indexOf("<div", cursor);
        const nextClose = blockHtml.indexOf("</div", cursor);
        if (nextClose === -1) {
          cursor = blockHtml.length;
          break;
        }
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth += 1;
          cursor = nextOpen + 4;
        } else {
          depth -= 1;
          if (depth === 0) {
            return blockHtml.slice(tagEnd + 1, nextClose);
          }
          cursor = nextClose + 5;
        }
      }
      return blockHtml.slice(tagEnd + 1);
    }

    searchPos = tagEnd + 1;
  }
  return null;
}

function parseAnchorTag(
  segmentHtml: string
): { prefix: string; href: string | null; text: string } | null {
  const match = /^([\s\S]*?)<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(segmentHtml);
  if (!match) {
    return null;
  }
  const prefix = decodeTakeoutHtmlEntities(stripHtmlTags(match[1]!))
    .replace(/[\s\u00a0\u202f]+/g, " ")
    .trim();
  const attrs = match[2]!;
  const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i.exec(
    attrs
  );
  const rawHref = hrefMatch
    ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? null)
    : null;
  const href = rawHref !== null ? decodeTakeoutHtmlEntities(rawHref).trim() : null;
  const text = decodeTakeoutHtmlEntities(stripHtmlTags(match[3]!)).trim();
  return { prefix, href, text };
}

/**
 * Map one `<div class="outer-cell ...">` HTML block to an event or skip reason.
 */
export function mapTakeoutHtmlBlock(blockHtml: string): TakeoutMapResult {
  // 1. Header ("YouTube" or "YouTube Music")
  let header = "YouTube";
  const titleP =
    /<p\b[^>]*class\s*=\s*(?:"[^"]*mdl-typography--title[^"]*"|'[^']*mdl-typography--title[^']*')[^>]*>([\s\S]*?)<\/p>/i.exec(
      blockHtml
    );
  if (titleP && titleP[1] !== undefined) {
    const parsedHeader = decodeTakeoutHtmlEntities(
      stripHtmlTags(titleP[1].replace(/<br\s*\/?>/gi, " "))
    ).trim();
    if (parsedHeader !== "") {
      header = parsedHeader;
    }
  }

  // 2. Caption cell (Products and From Google Ads)
  const captionHtml = extractDivByClass(blockHtml, "caption") ?? "";
  const captionText = decodeTakeoutHtmlEntities(
    stripHtmlTags(captionHtml.replace(/<br\s*\/?>/gi, "\n"))
  );
  const isAd = /From Google Ads/i.test(captionText);

  let isOtherProduct = false;
  const productsMatch =
    /Products:\s*([\s\S]*?)(?:Details:|Why is this here\?|$)/i.exec(captionText);
  if (productsMatch && productsMatch[1]) {
    const prodSection = productsMatch[1].trim();
    if (prodSection !== "" && !/\bYouTube\b/i.test(prodSection)) {
      isOtherProduct = true;
    }
  }

  // 3. Body cell (`content-cell ... body-1`, skipping `text-right`)
  let bodyHtml =
    extractDivByClass(blockHtml, "body-1", "text-right") ??
    extractDivByClass(blockHtml, "content-cell", "caption");
  if (bodyHtml === null) {
    bodyHtml = blockHtml;
  }

  const pieces = bodyHtml
    .split(/<br\s*\/?>/i)
    .map((p) => p.trim())
    .filter(
      (p) =>
        decodeTakeoutHtmlEntities(stripHtmlTags(p))
          .replace(/[\s\u00a0\u202f]+/g, "") !== ""
    );

  if (pieces.length < 2) {
    return { kind: "skip", reason: "invalid" };
  }

  // Last piece is the English timestamp.
  const datePiece = stripHtmlTags(pieces[pieces.length - 1]!).trim();
  const startedAt = parseTakeoutHtmlTimestamp(datePiece);
  if (startedAt === null) {
    return { kind: "skip", reason: "invalid" };
  }

  if (isAd) {
    return { kind: "skip", reason: "ads" };
  }

  if (isOtherProduct) {
    return { kind: "skip", reason: "other" };
  }

  const firstPiece = pieces[0]!;
  const firstAnchor = parseAnchorTag(firstPiece);

  if (!firstAnchor) {
    const plainFirst = decodeTakeoutHtmlEntities(stripHtmlTags(firstPiece))
      .replace(/[\s\u00a0\u202f]+/g, " ")
      .trim();
    if (plainFirst.startsWith("Watched")) {
      return { kind: "skip", reason: "no_video" };
    }
    return { kind: "skip", reason: "other" };
  }

  if (firstAnchor.prefix !== "Watched") {
    return { kind: "skip", reason: "other" };
  }

  const videoId =
    firstAnchor.href !== null ? extractVideoId(firstAnchor.href) : null;
  if (videoId === null) {
    return { kind: "skip", reason: "no_video" };
  }

  const title = firstAnchor.text !== "" ? firstAnchor.text : videoId;

  // Optional channel line in `pieces[1]` when there are >= 3 pieces.
  let parentTitle: string | null = null;
  let channelId: string | null = null;
  let channelUrl: string | null = null;

  if (pieces.length >= 3) {
    const secondPiece = pieces[1]!;
    const channelAnchor = parseAnchorTag(secondPiece);
    if (channelAnchor) {
      parentTitle = channelAnchor.text !== "" ? channelAnchor.text : null;
      channelUrl = channelAnchor.href;
      channelId = extractChannelId(channelUrl);
    } else {
      const plainChannel = decodeTakeoutHtmlEntities(
        stripHtmlTags(secondPiece)
      ).trim();
      if (plainChannel !== "") {
        parentTitle = plainChannel;
      }
    }
  }

  const externalIds: Record<string, unknown> = {
    youtube_video: videoId,
    youtube_channel: channelId,
  };
  if (header === "YouTube Music") {
    externalIds.youtube_music = true;
  }

  const rawRecord: Record<string, unknown> = {
    header,
    title: `Watched ${title}`,
    titleUrl: firstAnchor.href,
    ...(parentTitle !== null
      ? {
          subtitles: [
            {
              name: parentTitle,
              ...(channelUrl !== null ? { url: channelUrl } : {}),
            },
          ],
        }
      : {}),
    time: startedAt,
    products: ["YouTube"],
  };

  return {
    kind: "event",
    event: {
      source: "youtube",
      source_kind: "history_item",
      source_id: `${videoId}:${startedAt}`,
      external_ids: externalIds,
      media_type: header === "YouTube Music" ? "music" : "video",
      title,
      parent_title: parentTitle,
      started_at: startedAt,
      ended_at: null,
      duration_seconds: null,
      progress: null,
      raw: rawRecord,
    },
  };
}

/**
 * Linear scan over a Google Takeout `watch-history.html` document, extracting
 * every `<div class="outer-cell ...">` entry without a DOM library.
 */
export function parseTakeoutHtml(html: string): {
  records: number;
  events: NewEvent[];
  skipped: TakeoutSkipCounts;
} {
  const events: NewEvent[] = [];
  const skipped: TakeoutSkipCounts = {
    ads: 0,
    no_video: 0,
    other: 0,
    invalid: 0,
  };

  // Collect start offsets of all `<div ... class="...outer-cell..." ...>` blocks.
  const blockStarts: number[] = [];
  let searchPos = 0;
  while (searchPos < html.length) {
    const outerIdx = html.indexOf("outer-cell", searchPos);
    if (outerIdx === -1) {
      break;
    }
    const divStart = html.lastIndexOf("<div", outerIdx);
    const gtBetween =
      divStart !== -1 ? html.indexOf(">", divStart) : -1;
    if (divStart !== -1 && gtBetween >= outerIdx) {
      blockStarts.push(divStart);
      searchPos = gtBetween + 1;
    } else {
      searchPos = outerIdx + 10;
    }
  }

  for (let i = 0; i < blockStarts.length; i++) {
    const start = blockStarts[i]!;
    const end = i + 1 < blockStarts.length ? blockStarts[i + 1]! : html.length;
    const blockHtml = html.slice(start, end);
    const mapped = mapTakeoutHtmlBlock(blockHtml);
    if (mapped.kind === "event") {
      events.push(mapped.event);
    } else {
      skipped[mapped.reason] += 1;
    }
  }

  return {
    records: blockStarts.length,
    events,
    skipped,
  };
}

/**
 * `true` when `text` looks like a Takeout watch-history export (either a JSON
 * array starting with `[` or an HTML document containing `outer-cell` / `<!doctype html`).
 */
export function looksLikeTakeout(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) {
    return true;
  }
  if (trimmed.startsWith("<")) {
    return (
      trimmed.includes("outer-cell") ||
      /^<!doctype\s+html\b|^<html\b/i.test(trimmed)
    );
  }
  return false;
}

// --- Gap rule & duration calculation -----------------------------------------

export interface ApplyTakeoutGapRuleOptions {
  minWatchMinutes?: number;
  /** Known video/track lengths in seconds keyed by `video_id`. */
  videoLengths?: ReadonlyMap<string, number>;
}

export interface ApplyTakeoutGapRuleResult {
  kept: NewEvent[];
  gapSkipped: number;
  musicCount: number;
}

function isMusicTakeoutEvent(ev: NewEvent): boolean {
  if (ev.media_type === "music") {
    return true;
  }
  const ext = ev.external_ids as Record<string, unknown> | null | undefined;
  return ext?.["youtube_music"] === true;
}

function videoIdFromTakeoutEvent(ev: NewEvent): string | null {
  const ext = ev.external_ids as Record<string, unknown> | null | undefined;
  const vid = ext?.["youtube_video"];
  return typeof vid === "string" && vid.trim() !== "" ? vid.trim() : null;
}

/**
 * Compute watch durations using the Takeout gap rule:
 * - Sort all kept views (videos + music) chronologically (`started_at` asc).
 * - `gap` = `next.started_at - this.started_at` in seconds (or `null` for the newest view).
 * - Video views with `gap < minWatchMinutes * 60` are skipped (`gapSkipped`).
 * - Remaining video views get `duration_seconds = min(gap, length ?? 3h)`
 *   (newest view: `length ?? 30m`), `media_type = "video"`, `raw.estimated = "gap"`.
 * - Music views are exempt from the 5-minute rule and get
 *   `duration_seconds = min(gap, length ?? 4m)` (newest view: `length ?? 4m`),
 *   `media_type = "music"`, `raw.estimated = "gap"`.
 */
export function applyTakeoutGapRule(
  views: readonly NewEvent[],
  opts: ApplyTakeoutGapRuleOptions = {}
): ApplyTakeoutGapRuleResult {
  if (views.length === 0) {
    return { kept: [], gapSkipped: 0, musicCount: 0 };
  }

  const minWatchMinutes =
    opts.minWatchMinutes ?? DEFAULT_TAKEOUT_MIN_WATCH_MINUTES;
  const minWatchSeconds = Math.max(0, minWatchMinutes * 60);
  const videoLengths = opts.videoLengths;

  const sorted = [...views].sort(
    (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)
  );

  // Deduplicate exact identical `(source_id)` rows in the same batch so a
  // duplicate line does not create a 0-second gap against itself.
  const uniqueSorted: NewEvent[] = [];
  const seenSourceIds = new Set<string>();
  for (const ev of sorted) {
    if (seenSourceIds.has(ev.source_id)) {
      continue;
    }
    seenSourceIds.add(ev.source_id);
    uniqueSorted.push(ev);
  }

  const kept: NewEvent[] = [];
  let gapSkipped = 0;
  let musicCount = 0;

  for (let i = 0; i < uniqueSorted.length; i++) {
    const ev = uniqueSorted[i]!;
    const nextEv = i + 1 < uniqueSorted.length ? uniqueSorted[i + 1]! : null;
    const gapSeconds =
      nextEv !== null
        ? Math.max(
            0,
            Math.round(
              (Date.parse(nextEv.started_at) - Date.parse(ev.started_at)) / 1000
            )
          )
        : null;

    const isMusic = isMusicTakeoutEvent(ev);
    const vid = videoIdFromTakeoutEvent(ev);
    const rawKnownLen =
      vid !== null && videoLengths ? videoLengths.get(vid) : undefined;
    const knownLength =
      typeof rawKnownLen === "number" &&
      Number.isFinite(rawKnownLen) &&
      rawKnownLen > 0
        ? Math.round(rawKnownLen)
        : null;

    let durationSeconds: number;
    let mediaType: MediaType;

    if (isMusic) {
      const cap = knownLength ?? UNKNOWN_MUSIC_CAP_SECONDS;
      durationSeconds =
        gapSeconds !== null ? Math.min(gapSeconds, cap) : cap;
      mediaType = "music";
      musicCount += 1;
    } else {
      if (gapSeconds !== null && gapSeconds < minWatchSeconds) {
        gapSkipped += 1;
        continue;
      }
      if (gapSeconds === null) {
        durationSeconds = knownLength ?? NEWEST_VIDEO_DEFAULT_SECONDS;
      } else {
        const cap = knownLength ?? UNKNOWN_VIDEO_CAP_SECONDS;
        durationSeconds = Math.min(gapSeconds, cap);
      }
      mediaType = "video";
    }

    const baseRaw =
      ev.raw !== null && typeof ev.raw === "object" && !Array.isArray(ev.raw)
        ? { ...(ev.raw as Record<string, unknown>) }
        : {};
    baseRaw.estimated = "gap";
    baseRaw.gap_seconds = gapSeconds;

    kept.push({
      ...ev,
      media_type: mediaType,
      duration_seconds: durationSeconds,
      raw: baseRaw,
    });
  }

  return { kept, gapSkipped, musicCount };
}

/** Read known positive `length_seconds` per `video_id` from `youtube_videos_latest`. */
export function readKnownYoutubeVideoLengths(
  db: Database
): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = db
      .query<Pick<YoutubeVideoRow, "video_id" | "length_seconds">, []>(
        "SELECT video_id, length_seconds FROM youtube_videos_latest WHERE length_seconds IS NOT NULL AND length_seconds > 0;"
      )
      .all();
    for (const row of rows) {
      if (
        typeof row.length_seconds === "number" &&
        Number.isFinite(row.length_seconds) &&
        row.length_seconds > 0
      ) {
        map.set(row.video_id, Math.round(row.length_seconds));
      }
    }
  } catch {
    // Table/column may not exist on an older schema snapshot.
  }
  return map;
}

/**
 * Build a set of `${videoId}\0${localDate}` keys for all measured YouTube plays
 * (`aw_play` and `phone_play`) currently in `events_latest`.
 */
function readMeasuredPlayVideoDays(db: Database, tz: string): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db
      .query<{ external_ids: string | null; started_at: string }, []>(
        `SELECT external_ids, started_at
         FROM events_latest
         WHERE source = 'youtube'
           AND source_kind IN ('aw_play', 'phone_play');`
      )
      .all();
    for (const row of rows) {
      if (!row.external_ids) continue;
      let ext: unknown;
      try {
        ext = JSON.parse(row.external_ids);
      } catch {
        continue;
      }
      const vid =
        ext && typeof ext === "object" && !Array.isArray(ext)
          ? (ext as Record<string, unknown>)["youtube_video"]
          : null;
      if (typeof vid === "string" && vid.trim() !== "") {
        const localDate = localParts(row.started_at, tz).date;
        set.add(`${vid.trim()}\0${localDate}`);
      }
    }
  } catch {
    // ignore
  }
  return set;
}

/**
 * Re-save any Takeout views (`source = 'youtube'`, `source_kind = 'history_item'`)
 * in `events_latest` whose video now has a known `length_seconds` in
 * `youtube_videos_latest` that changes its capped duration. Append-only: writes
 * new revisions with the same `source_id` so `events_latest` picks the latest.
 */
export function resaveTakeoutViews(db: Database): {
  checked: number;
  resaved: number;
} {
  const lengths = readKnownYoutubeVideoLengths(db);
  if (lengths.size === 0) {
    return { checked: 0, resaved: 0 };
  }

  const rows = db
    .query<EventRow, []>(
      `SELECT *
       FROM events_latest
       WHERE source = 'youtube'
         AND source_kind = 'history_item'
       ORDER BY id ASC;`
    )
    .all();

  if (rows.length === 0) {
    return { checked: 0, resaved: 0 };
  }

  const updates: NewEvent[] = [];

  for (const row of rows) {
    let ext: Record<string, unknown> | null = null;
    if (row.external_ids) {
      try {
        const parsed = JSON.parse(row.external_ids);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          ext = parsed as Record<string, unknown>;
        }
      } catch {
        ext = null;
      }
    }

    const vid =
      typeof ext?.["youtube_video"] === "string"
        ? ext["youtube_video"].trim()
        : null;
    if (!vid) {
      continue;
    }

    const lengthSeconds = lengths.get(vid);
    if (lengthSeconds === undefined || lengthSeconds <= 0) {
      continue;
    }

    let rawObj: Record<string, unknown> = {};
    if (row.raw) {
      try {
        const parsed = JSON.parse(row.raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          rawObj = { ...(parsed as Record<string, unknown>) };
        }
      } catch {
        rawObj = {};
      }
    }

    let newDuration: number;
    if (
      typeof rawObj.gap_seconds === "number" &&
      Number.isFinite(rawObj.gap_seconds) &&
      rawObj.gap_seconds >= 0
    ) {
      newDuration = Math.min(rawObj.gap_seconds, lengthSeconds);
    } else if ("gap_seconds" in rawObj && rawObj.gap_seconds === null) {
      // Newest view (no next view): uses the video/track length when known.
      newDuration = lengthSeconds;
    } else if (
      typeof row.duration_seconds === "number" &&
      Number.isFinite(row.duration_seconds)
    ) {
      newDuration = Math.min(row.duration_seconds, lengthSeconds);
    } else {
      newDuration = lengthSeconds;
    }

    if (row.duration_seconds === newDuration) {
      continue;
    }

    rawObj.estimated = "gap";

    updates.push({
      source: row.source,
      source_kind: row.source_kind,
      source_id: row.source_id,
      external_ids: ext,
      media_type: row.media_type as MediaType,
      title: row.title,
      parent_title: row.parent_title,
      season: row.season,
      episode: row.episode,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_seconds: newDuration,
      progress: row.progress,
      device: row.device,
      raw: rawObj,
    });
  }

  if (updates.length === 0) {
    return { checked: rows.length, resaved: 0 };
  }

  let resaved = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    resaved += insertEvents(db, null, batch).inserted;
  }

  return { checked: rows.length, resaved };
}

// --- Favourites & Subscriptions CSV import -----------------------------------

export function favoriteRecordHash(item: {
  video_id: string;
  added_at: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        video_id: item.video_id,
        added_at: item.added_at,
      })
    )
    .digest("hex");
}

export function subscriptionRecordHash(item: {
  channel_id: string;
  channel_url: string | null;
  channel_title: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        channel_id: item.channel_id,
        channel_url: item.channel_url,
        channel_title: item.channel_title,
      })
    )
    .digest("hex");
}

/**
 * Parse and import `playlists/Favorite Songs-videos.csv`
 * (`Video ID,Playlist Video Creation Timestamp`).
 */
export function importFavoriteSongsCsv(
  db: Database,
  csvText: string,
  opts: { dryRun?: boolean; nowIso?: string } = {}
): { seen: number; inserted: number } {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) {
    return { seen: 0, inserted: 0 };
  }

  let headerRowIdx = -1;
  let videoIdCol = -1;
  let tsCol = -1;

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r]!.map((c) => c.trim().toLowerCase());
    const vIdx = cells.indexOf("video id");
    if (vIdx !== -1) {
      headerRowIdx = r;
      videoIdCol = vIdx;
      tsCol = cells.indexOf("playlist video creation timestamp");
      break;
    }
  }

  if (headerRowIdx === -1 || videoIdCol === -1) {
    return { seen: 0, inserted: 0 };
  }

  const parsedByVideoId = new Map<
    string,
    { video_id: string; added_at: string | null }
  >();

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.every((c) => c.trim() === "")) {
      continue;
    }
    const rawVid = (row[videoIdCol] ?? "").trim();
    if (!VIDEO_ID_RE.test(rawVid)) {
      continue;
    }
    const rawTs = tsCol !== -1 ? (row[tsCol] ?? "").trim() : "";
    let addedAt: string | null = null;
    if (rawTs !== "") {
      try {
        addedAt = toUtcIso(rawTs);
      } catch {
        addedAt = rawTs;
      }
    }
    parsedByVideoId.set(rawVid, { video_id: rawVid, added_at: addedAt });
  }

  const items = Array.from(parsedByVideoId.values());
  if (opts.dryRun || items.length === 0) {
    return { seen: items.length, inserted: 0 };
  }

  const createdAt = opts.nowIso ?? new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO youtube_favorites (
      record_hash,
      video_id,
      added_at,
      created_at
    ) VALUES (?, ?, ?, ?);
  `);

  const tx = db.transaction(() => {
    let inserted = 0;
    for (const item of items) {
      const hash = favoriteRecordHash(item);
      const res = stmt.run(hash, item.video_id, item.added_at, createdAt);
      inserted += res.changes;
    }
    return inserted;
  });

  return { seen: items.length, inserted: tx() };
}

/**
 * Parse and import `subscriptions/subscriptions.csv`
 * (`Channel Id,Channel Url,Channel Title`).
 */
export function importSubscriptionsCsv(
  db: Database,
  csvText: string,
  opts: { dryRun?: boolean; nowIso?: string } = {}
): { seen: number; inserted: number } {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) {
    return { seen: 0, inserted: 0 };
  }

  let headerRowIdx = -1;
  let idCol = -1;
  let urlCol = -1;
  let titleCol = -1;

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r]!.map((c) => c.trim().toLowerCase());
    const cIdx = cells.indexOf("channel id");
    if (cIdx !== -1) {
      headerRowIdx = r;
      idCol = cIdx;
      urlCol = cells.indexOf("channel url");
      titleCol = cells.indexOf("channel title");
      break;
    }
  }

  if (headerRowIdx === -1 || idCol === -1) {
    return { seen: 0, inserted: 0 };
  }

  const parsedByChannelId = new Map<
    string,
    {
      channel_id: string;
      channel_url: string | null;
      channel_title: string | null;
    }
  >();

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.every((c) => c.trim() === "")) {
      continue;
    }
    const channelId = (row[idCol] ?? "").trim();
    if (channelId === "") {
      continue;
    }
    const channelUrl =
      urlCol !== -1 && (row[urlCol] ?? "").trim() !== ""
        ? (row[urlCol] ?? "").trim()
        : null;
    const channelTitle =
      titleCol !== -1 && (row[titleCol] ?? "").trim() !== ""
        ? (row[titleCol] ?? "").trim()
        : null;

    parsedByChannelId.set(channelId, {
      channel_id: channelId,
      channel_url: channelUrl,
      channel_title: channelTitle,
    });
  }

  const items = Array.from(parsedByChannelId.values());
  if (opts.dryRun || items.length === 0) {
    return { seen: items.length, inserted: 0 };
  }

  const createdAt = opts.nowIso ?? new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO youtube_subscriptions (
      record_hash,
      channel_id,
      channel_url,
      channel_title,
      created_at
    ) VALUES (?, ?, ?, ?, ?);
  `);

  const tx = db.transaction(() => {
    let inserted = 0;
    for (const item of items) {
      const hash = subscriptionRecordHash(item);
      const res = stmt.run(
        hash,
        item.channel_id,
        item.channel_url,
        item.channel_title,
        createdAt
      );
      inserted += res.changes;
    }
    return inserted;
  });

  return { seen: items.length, inserted: tx() };
}

/** Read all favourite video IDs from `youtube_favorites_latest`. */
export function getFavoriteVideoIds(db: Database): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db
      .query<Pick<YoutubeFavoriteRow, "video_id">, []>(
        "SELECT video_id FROM youtube_favorites_latest;"
      )
      .all();
    for (const r of rows) {
      if (r.video_id) {
        set.add(r.video_id);
      }
    }
  } catch {
    // Table may not exist on an older schema snapshot.
  }
  return set;
}

/** Read all latest subscription rows from `youtube_subscriptions_latest`. */
export function getYoutubeSubscriptions(
  db: Database
): YoutubeSubscriptionRow[] {
  try {
    return db
      .query<YoutubeSubscriptionRow, []>(
        "SELECT * FROM youtube_subscriptions_latest ORDER BY id ASC;"
      )
      .all();
  } catch {
    return [];
  }
}

// --- Folder & Zip input resolution -------------------------------------------

export interface TakeoutBundleInput {
  historyText?: string;
  favoritesCsv?: string;
  subscriptionsCsv?: string;
}

function readBundleFromDirectory(dirPath: string): TakeoutBundleInput {
  const historyCandidates = [
    join(dirPath, "history", "watch-history.html"),
    join(dirPath, "history", "watch-history.json"),
    join(
      dirPath,
      "YouTube and YouTube Music",
      "history",
      "watch-history.html"
    ),
    join(
      dirPath,
      "YouTube and YouTube Music",
      "history",
      "watch-history.json"
    ),
    join(
      dirPath,
      "Takeout",
      "YouTube and YouTube Music",
      "history",
      "watch-history.html"
    ),
    join(
      dirPath,
      "Takeout",
      "YouTube and YouTube Music",
      "history",
      "watch-history.json"
    ),
    join(dirPath, "watch-history.html"),
    join(dirPath, "watch-history.json"),
  ];

  const favCandidates = [
    join(dirPath, "playlists", "Favorite Songs-videos.csv"),
    join(
      dirPath,
      "YouTube and YouTube Music",
      "playlists",
      "Favorite Songs-videos.csv"
    ),
    join(
      dirPath,
      "Takeout",
      "YouTube and YouTube Music",
      "playlists",
      "Favorite Songs-videos.csv"
    ),
    join(dirPath, "Favorite Songs-videos.csv"),
  ];

  const subCandidates = [
    join(dirPath, "subscriptions", "subscriptions.csv"),
    join(
      dirPath,
      "YouTube and YouTube Music",
      "subscriptions",
      "subscriptions.csv"
    ),
    join(
      dirPath,
      "Takeout",
      "YouTube and YouTube Music",
      "subscriptions",
      "subscriptions.csv"
    ),
    join(dirPath, "subscriptions.csv"),
  ];

  let historyText: string | undefined;
  for (const p of historyCandidates) {
    if (existsSync(p) && statSync(p).isFile()) {
      historyText = readFileSync(p, "utf8");
      break;
    }
  }

  let favoritesCsv: string | undefined;
  for (const p of favCandidates) {
    if (existsSync(p) && statSync(p).isFile()) {
      favoritesCsv = readFileSync(p, "utf8");
      break;
    }
  }
  if (favoritesCsv === undefined) {
    // Case-insensitive fallback scan inside playlists/ if present
    for (const subDir of [
      join(dirPath, "playlists"),
      join(dirPath, "YouTube and YouTube Music", "playlists"),
      join(dirPath, "Takeout", "YouTube and YouTube Music", "playlists"),
    ]) {
      if (existsSync(subDir) && statSync(subDir).isDirectory()) {
        const match = readdirSync(subDir).find(
          (f) => f.toLowerCase() === "favorite songs-videos.csv"
        );
        if (match) {
          favoritesCsv = readFileSync(join(subDir, match), "utf8");
          break;
        }
      }
    }
  }

  let subscriptionsCsv: string | undefined;
  for (const p of subCandidates) {
    if (existsSync(p) && statSync(p).isFile()) {
      subscriptionsCsv = readFileSync(p, "utf8");
      break;
    }
  }

  if (
    historyText === undefined &&
    favoritesCsv === undefined &&
    subscriptionsCsv === undefined
  ) {
    throw new Error(
      `No YouTube Takeout history, Favorite Songs, or subscriptions found in folder: ${dirPath}`
    );
  }

  return { historyText, favoritesCsv, subscriptionsCsv };
}

function readBundleFromZip(bytes: Uint8Array): TakeoutBundleInput {
  const entries = readZip(bytes, {
    maxArchiveBytes: 500 * 1024 * 1024,
    maxEntryBytes: 250 * 1024 * 1024,
    maxTotalUncompressedBytes: 500 * 1024 * 1024,
    maxEntries: 4096,
  });

  let htmlEntry = entries.find(
    (e) => e.baseName.toLowerCase() === "watch-history.html"
  );
  let jsonEntry = entries.find(
    (e) => e.baseName.toLowerCase() === "watch-history.json"
  );
  let favEntry = entries.find(
    (e) => e.baseName.toLowerCase() === "favorite songs-videos.csv"
  );
  let subEntry = entries.find(
    (e) => e.baseName.toLowerCase() === "subscriptions.csv"
  );

  const historyText = htmlEntry
    ? htmlEntry.text()
    : jsonEntry
      ? jsonEntry.text()
      : undefined;
  const favoritesCsv = favEntry ? favEntry.text() : undefined;
  const subscriptionsCsv = subEntry ? subEntry.text() : undefined;

  if (
    historyText === undefined &&
    favoritesCsv === undefined &&
    subscriptionsCsv === undefined
  ) {
    throw new Error(TAKEOUT_ERROR);
  }

  return { historyText, favoritesCsv, subscriptionsCsv };
}

function resolveTakeoutInput(
  input: string | Uint8Array | ArrayBuffer | TakeoutBundleInput,
  opts: ImportYoutubeTakeoutOptions
): TakeoutBundleInput {
  if (input instanceof ArrayBuffer) {
    input = new Uint8Array(input);
  }

  if (input instanceof Uint8Array) {
    if (isZipBytes(input)) {
      return readBundleFromZip(input);
    }
    const decoded = new TextDecoder("utf-8").decode(input);
    return {
      historyText: decoded,
      favoritesCsv: opts.favoritesCsv,
      subscriptionsCsv: opts.subscriptionsCsv,
    };
  }

  if (typeof input === "object" && input !== null) {
    return {
      historyText: input.historyText,
      favoritesCsv: input.favoritesCsv ?? opts.favoritesCsv,
      subscriptionsCsv: input.subscriptionsCsv ?? opts.subscriptionsCsv,
    };
  }

  if (typeof input === "string") {
    const trimmed = input.trimStart();
    if (
      !trimmed.startsWith("[") &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("<") &&
      trimmed.length < 1024 &&
      !trimmed.includes("\n") &&
      existsSync(trimmed)
    ) {
      const st = statSync(trimmed);
      if (st.isDirectory()) {
        return readBundleFromDirectory(trimmed);
      }
      if (st.isFile()) {
        const bytes = new Uint8Array(readFileSync(trimmed));
        if (isZipBytes(bytes)) {
          return readBundleFromZip(bytes);
        }
        const text = new TextDecoder("utf-8").decode(bytes);
        const lower = trimmed.toLowerCase();
        if (lower.endsWith("favorite songs-videos.csv")) {
          return { favoritesCsv: text };
        }
        if (lower.endsWith("subscriptions.csv")) {
          return { subscriptionsCsv: text };
        }
        return {
          historyText: text,
          favoritesCsv: opts.favoritesCsv,
          subscriptionsCsv: opts.subscriptionsCsv,
        };
      }
    }

    return {
      historyText: input,
      favoritesCsv: opts.favoritesCsv,
      subscriptionsCsv: opts.subscriptionsCsv,
    };
  }

  throw new Error(TAKEOUT_ERROR);
}

/**
 * Import a YouTube Takeout watch-history export (HTML, JSON, folder, or zip),
 * plus optional `Favorite Songs-videos.csv` and `subscriptions.csv`.
 */
export function importYoutubeTakeout(
  db: Database,
  input: string | Uint8Array | ArrayBuffer | TakeoutBundleInput,
  opts: ImportYoutubeTakeoutOptions = {}
): ImportYoutubeTakeoutResult {
  const dryRun = opts.dryRun === true;
  const tz = opts.tz ?? opts.config?.timezone ?? "Europe/Bratislava";
  const minWatchMinutes =
    opts.minWatchMinutes ??
    opts.config?.youtube?.min_watch_minutes ??
    DEFAULT_TAKEOUT_MIN_WATCH_MINUTES;

  const runId = dryRun ? 0 : startRun(db, YOUTUBE_TAKEOUT_SOURCE);

  try {
    const bundle = resolveTakeoutInput(input, opts);

    let records = 0;
    const rawViews: NewEvent[] = [];
    const skipped: TakeoutSkipCounts = {
      ads: 0,
      no_video: 0,
      other: 0,
      invalid: 0,
    };

    if (bundle.historyText !== undefined) {
      const trimmed = bundle.historyText.trimStart();
      if (trimmed.startsWith("[")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new Error(TAKEOUT_ERROR);
        }
        if (!Array.isArray(parsed)) {
          throw new Error(TAKEOUT_ERROR);
        }
        records = parsed.length;
        for (const record of parsed) {
          const mapped = mapTakeoutRecord(record);
          if (mapped.kind === "event") {
            rawViews.push(mapped.event);
          } else {
            skipped[mapped.reason] += 1;
          }
        }
      } else if (looksLikeTakeout(trimmed)) {
        const htmlResult = parseTakeoutHtml(bundle.historyText);
        records = htmlResult.records;
        for (const ev of htmlResult.events) {
          rawViews.push(ev);
        }
        skipped.ads += htmlResult.skipped.ads;
        skipped.no_video += htmlResult.skipped.no_video;
        skipped.other += htmlResult.skipped.other;
        skipped.invalid += htmlResult.skipped.invalid;
      } else {
        throw new Error(TAKEOUT_ERROR);
      }
    }

    const seen = rawViews.length;
    const videoLengths = readKnownYoutubeVideoLengths(db);

    const gapResult = applyTakeoutGapRule(rawViews, {
      minWatchMinutes,
      videoLengths,
    });

    // Deduplicate against measured plays (aw_play / phone_play) on the same local day,
    // and preserve existing stored takeout views so overlapping exports never rewrite
    // unchanged views.
    const measuredVideoDays = readMeasuredPlayVideoDays(db, tz);
    const existingTakeoutDurations = new Map<string, number | null>();
    try {
      const existingRows = db
        .query<{ source_id: string; duration_seconds: number | null }, []>(
          `SELECT source_id, duration_seconds
           FROM events_latest
           WHERE source = 'youtube'
             AND source_kind = 'history_item';`
        )
        .all();
      for (const r of existingRows) {
        existingTakeoutDurations.set(r.source_id, r.duration_seconds);
      }
    } catch {
      // ignore
    }

    const eventsToStore: NewEvent[] = [];
    let dedupSkipped = 0;
    let musicStored = 0;
    let totalDurationSeconds = 0;

    for (const ev of gapResult.kept) {
      const vid = videoIdFromTakeoutEvent(ev);
      if (vid !== null) {
        const localDate = localParts(ev.started_at, tz).date;
        if (measuredVideoDays.has(`${vid}\0${localDate}`)) {
          dedupSkipped += 1;
          continue;
        }
      }

      let finalEvent = ev;
      if (existingTakeoutDurations.has(ev.source_id)) {
        const prevDur = existingTakeoutDurations.get(ev.source_id);
        const knownLen = vid !== null ? videoLengths.get(vid) : undefined;
        // Keep the existing duration on overlapping re-imports unless video length
        // enrichment has provided a tighter cap.
        if (
          typeof prevDur === "number" &&
          (knownLen === undefined || prevDur <= knownLen)
        ) {
          finalEvent = { ...ev, duration_seconds: prevDur };
        }
      }

      eventsToStore.push(finalEvent);
      if (finalEvent.media_type === "music") {
        musicStored += 1;
      }
      totalDurationSeconds += finalEvent.duration_seconds ?? 0;
    }

    let inserted = 0;
    if (!dryRun && eventsToStore.length > 0) {
      for (let i = 0; i < eventsToStore.length; i += BATCH_SIZE) {
        const batch = eventsToStore.slice(i, i + BATCH_SIZE);
        inserted += insertEvents(db, runId, batch).inserted;
      }
    }

    let favorites = 0;
    let favoritesInserted = 0;
    if (bundle.favoritesCsv !== undefined) {
      const favRes = importFavoriteSongsCsv(db, bundle.favoritesCsv, {
        dryRun,
        nowIso: opts.nowIso,
      });
      favorites = favRes.seen;
      favoritesInserted = favRes.inserted;
    }

    let subscriptions = 0;
    let subscriptionsInserted = 0;
    if (bundle.subscriptionsCsv !== undefined) {
      const subRes = importSubscriptionsCsv(db, bundle.subscriptionsCsv, {
        dryRun,
        nowIso: opts.nowIso,
      });
      subscriptions = subRes.seen;
      subscriptionsInserted = subRes.inserted;
    }

    if (!dryRun) {
      finishRun(db, runId, {
        status: "ok",
        rowsSeen: seen,
        rowsInserted: inserted,
      });
    }

    return {
      records,
      seen,
      inserted,
      skipped,
      runId,
      gap_skipped: gapResult.gapSkipped,
      dedup_skipped: dedupSkipped,
      stored: eventsToStore.length,
      music: musicStored,
      estimated_hours: totalDurationSeconds / 3600,
      favorites,
      favorites_inserted: favoritesInserted,
      subscriptions,
      subscriptions_inserted: subscriptionsInserted,
      dry_run: dryRun,
    };
  } catch (caught) {
    if (!dryRun) {
      finishRun(db, runId, {
        status: "failed",
        rowsSeen: 0,
        rowsInserted: 0,
        error: errorText(caught),
      });
    }
    throw caught;
  }
}
