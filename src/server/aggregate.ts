/**
 * Pure aggregation functions for calendar, heat map, stats, and in-progress items.
 *
 * Critical rules:
 * - Read `events_latest` only; never aggregate over `events`.
 * - Only consumption kinds count as activity: `source_kind IN ('listening_session','watch','history_item','aw_play','phone_play')`.
 *   `media_progress` and `daily_stat` never count in calendar/heat map/stats.
 * - Timestamps are stored UTC; bucketed by local day/hour in the configured timezone using `Intl`.
 * - Minutes = `duration_seconds / 60` (null -> 0 minutes, still counts as 1 item).
 * - Count = number of latest rows.
 * - A session whose listening time is longer than its wall-clock span (see
 *   `isTimeUncertain`) was synced in a batch from an offline device: it stays on
 *   its sync day, but its time of day is unknown, so the hour grid leaves it out.
 */

import { cachedUntilWrite } from "./db-version-cache.ts";
import type { Database } from "bun:sqlite";
import { categoryOf, type Category } from "../core/category.ts";
import type { DatePrecision } from "../core/contract.ts";
import { isValidSimklPoster } from "./posters.ts";
import { isValidYoutubeVideoId } from "./thumbs.ts";
import { dedupeConsumption, type DedupedEvent } from "./dedup.ts";
import {
  annotationMapKey,
  getAnnotationsFor,
  type AnnotationKey,
} from "./annotations.ts";
import {
  applyWorkOverridesToEvents,
  type CategoryFilter,
  type CategoryFilterInput,
  matchesCategoryFilter,
  parseCategoryFilter,
} from "./overrides.ts";
import { filterShortYoutubeEvents } from "./youtube-filter.ts";
import { isShortform } from "./shortform.ts";

export const CONSUMPTION_KINDS = new Set([
  "listening_session",
  "watch",
  "history_item",
  "aw_play",
  "phone_play",
  "archive",
]);

/** SQL list of `CONSUMPTION_KINDS`, so the queries can never drift from the set. */
const CONSUMPTION_KINDS_SQL = [...CONSUMPTION_KINDS].map((kind) => `'${kind}'`).join(", ");

export interface ConsumptionEvent {
  id: number;
  source: string;
  source_kind: string;
  source_id?: string;
  external_ids?: unknown;
  media_type: string;
  title: string | null;
  parent_title?: string | null;
  season?: number | null;
  episode?: number | null;
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  progress?: number | null;
  raw?: unknown;
}

/** Rounding slack (s) between listening time and wall-clock span before a session counts as uncertain. */
export const UNCERTAIN_SLACK_SECONDS = 60;

/**
 * True when the event reports more listening time than fits between its start and
 * end. The Audiobookshelf Android app does this for sessions played offline: the
 * server stamps start and end at sync time, while the listening happened earlier.
 */
export function isTimeUncertain(event: {
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
}): boolean {
  if (event.ended_at === null || event.ended_at === undefined) return false;
  if (event.duration_seconds === null || event.duration_seconds === undefined) return false;
  const start = Date.parse(event.started_at);
  const end = Date.parse(event.ended_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  const wallSeconds = Math.max(0, (end - start) / 1000);
  return event.duration_seconds > wallSeconds + UNCERTAIN_SLACK_SECONDS;
}

export interface CalendarItem {
  id: number;
  source: string;
  media_type: string;
  category: Category;
  title: string | null;
  parent_title: string | null;
  season: number | null;
  episode: number | null;
  started_at: string;
  local_time: string;
  duration_seconds: number | null;
  /** `/api/cover/<abs_item>` for ABS items, else null. */
  cover_url: string | null;
  /** Synced later from an offline device: the day is the sync day, the time is unknown. */
  time_uncertain: boolean;
  also_from?: string[];
}

export interface CalendarDay {
  date: string;
  count: number;
  minutes: number;
  items: CalendarItem[];
}

export interface CalendarResult {
  month: string;
  days: CalendarDay[];
}

export interface HeatmapDay {
  date: string;
  count: number;
  minutes: number;
}

export interface HeatmapDaysResult {
  year: string;
  days: HeatmapDay[];
}

export interface HeatmapHourCell {
  weekday: number; // 0-6 (Mon=0, Sun=6)
  hour: number; // 0-23
  count: number;
  minutes: number;
}

export interface HeatmapHoursResult {
  cells: HeatmapHourCell[];
  /** Sessions left out of the grid because their time of day is unknown. */
  unplaced_count: number;
  unplaced_minutes: number;
}

export interface StatBucket {
  count: number;
  items: number;
  minutes: number;
}

export interface WeekStatBucket {
  week: string; // "2026-W42" (ISO week, local)
  by_source: Record<string, number>;
  minutes: number;
  /** Number of items in the bucket. */
  count: number;
  /** Number of items per source in the bucket. */
  count_by_source: Record<string, number>;
}

export interface MonthStatBucket {
  month: string; // "2026-10"
  by_source: Record<string, number>;
  minutes: number;
  /** Number of items in the bucket. */
  count: number;
  /** Number of items per source in the bucket. */
  count_by_source: Record<string, number>;
}

export interface TopItem {
  title: string;
  source: string;
  media_type: string;
  category: Category;
  minutes: number;
  count: number;
}

export interface StatsResult {
  total_items: number;
  total_minutes: number;
  by_source: Record<string, StatBucket>;
  by_media_type: Record<string, StatBucket>;
  by_week: WeekStatBucket[];
  by_month: MonthStatBucket[];
  top_items: TopItem[];
}

export interface InProgressItem {
  id: number;
  source: string;
  title: string | null;
  parent_title: string | null;
  progress: number | null;
  started_at: string;
  /** `/api/cover/<abs_item>` for ABS items, else null. */
  cover_url: string | null;
}

/** One item in the in-progress or finished progress list. */
export interface ProgressItem {
  id: number;
  source: string;
  title: string | null;
  parent_title: string | null;
  /** Fraction 0..1, or null when the source gave no progress value. */
  progress: number | null;
  is_finished: boolean;
  /** UTC ISO of the latest progress update (= `events_latest.started_at`). */
  last_update: string;
  /** UTC ISO when the item was finished, or null when unknown. */
  finished_at: string | null;
  /** `/api/cover/<abs_item>` for ABS items, else null. */
  cover_url: string | null;
  /**
   * Latest rating (1–10) for this item's title group, or null when unrated.
   * Looked up in one batch query by `getProgressLists`.
   */
  rating: number | null;
  /**
   * The title group this item's rating/annotation belongs to:
   * `getSeriesOrTitle` of the underlying event. The web uses
   * `(source, group_title)` as the annotation key when opening the editor.
   */
  group_title: string;
}

export interface ProgressLists {
  in_progress: ProgressItem[];
  finished: ProgressItem[];
}

/** Parse a JSON-object column (`raw` or `external_ids`) from SQLite. */
export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Parse an `external_ids` value (JSON string from SQLite, or an object). */
export function parseExternalIds(
  value: unknown
): Record<string, unknown> | null {
  return parseJsonObject(value);
}

/**
 * Date precision of an event. Non-archive events always have exact `"day"`
 * precision; archive events store their precision in `raw.when.precision`.
 */
export function eventPrecision(event: {
  source_kind?: string;
  raw?: unknown;
}): DatePrecision {
  if (event.source_kind !== "archive") {
    return "day";
  }
  const raw = parseJsonObject(event.raw);
  const when = parseJsonObject(raw?.["when"]);
  const p = when?.["precision"];
  if (p === "day" || p === "month" || p === "year" || p === "unknown") {
    return p;
  }
  return "day";
}

export const VALID_META_PROVIDERS: ReadonlySet<string> = new Set([
  "anilist",
  "tvmaze",
  "cinemeta",
  "itunes",
  "openlibrary",
  "tmdb",
  "steam",
]);

export const META_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/api/cover/<abs_item>` for Audiobookshelf events carrying an `abs_item`
 * external id (real field `libraryItemId`), otherwise null. `media_progress`
 * rows have no external ids: their `source_id` is the library item id. The id is
 * re-validated so a malformed value can never be turned into a URL/path.
 *
 * `/api/poster/simkl/<path>` for Simkl events carrying a `simkl_poster` path
 * (validated against `SIMKL_POSTER_RE`), otherwise null.
 *
 * `/api/thumb/youtube/<id>` for YouTube events carrying a `youtube_video` id
 * (validated against `YOUTUBE_VIDEO_RE`), otherwise null.
 *
 * `/api/meta-cover/<meta_provider>/<meta_id>` for archive events carrying a
 * valid `meta_provider` and `meta_id`.
 */
export function coverUrlFor(event: {
  source?: string;
  source_kind?: string;
  source_id?: string;
  external_ids?: unknown;
}): string | null {
  const topIds = parseExternalIds(event.external_ids);
  if (topIds?.["meta_unlinked"] === "1") return null;
  if (topIds?.["meta_override"] === "1") {
    const metaProvider = topIds["meta_provider"];
    const metaId = topIds["meta_id"];
    if (
      typeof metaProvider === "string" &&
      VALID_META_PROVIDERS.has(metaProvider) &&
      typeof metaId === "string" &&
      META_ID_RE.test(metaId)
    ) {
      return `/api/meta-cover/${metaProvider}/${metaId}`;
    }
  }
  if (event.source === "simkl") {
    const ids = parseExternalIds(event.external_ids);
    const poster = ids?.["simkl_poster"];
    if (typeof poster === "string" && isValidSimklPoster(poster)) {
      return `/api/poster/simkl/${poster}`;
    }
    return null;
  }
  if (event.source === "youtube") {
    const ids = parseExternalIds(event.external_ids);
    const video = ids?.["youtube_video"];
    if (typeof video === "string" && isValidYoutubeVideoId(video)) {
      return `/api/thumb/youtube/${video}`;
    }
    return null;
  }
  if (event.source === "audiobookshelf") {
    const ids = parseExternalIds(event.external_ids);
    const absItem =
      ids?.["abs_item"] ??
      (event.source_kind === "media_progress" ? event.source_id : undefined);
    if (typeof absItem !== "string" || !/^[A-Za-z0-9_-]+$/.test(absItem)) {
      return null;
    }
    return `/api/cover/${absItem}`;
  }
  const ids = parseExternalIds(event.external_ids);
  const metaProvider = ids?.["meta_provider"];
  const metaId = ids?.["meta_id"];
  if (
    typeof metaProvider === "string" &&
    VALID_META_PROVIDERS.has(metaProvider) &&
    typeof metaId === "string" &&
    META_ID_RE.test(metaId)
  ) {
    return `/api/meta-cover/${metaProvider}/${metaId}`;
  }
  return null;
}

/**
 * Progress rows from Audiobookshelf `/api/me` carry no title when the payload
 * lacks one (the mapper then stores the item id). Fall back to the title of the
 * newest listening session for the same library item. Used as `title` column.
 */
const PROGRESS_TITLE_SQL = `COALESCE(
    NULLIF(NULLIF(p.title, ''), p.source_id),
    (SELECT s.title FROM events_latest s
      WHERE s.source = p.source
        AND s.source_kind = 'listening_session'
        AND json_extract(s.external_ids, '$.abs_item') = p.source_id
      ORDER BY s.id DESC LIMIT 1),
    p.title) AS title`;

/** Raw `events_latest` row for the in-progress query (before `cover_url`). */
interface InProgressRow {
  id: number;
  source: string;
  source_kind: string;
  source_id: string;
  title: string | null;
  parent_title: string | null;
  progress: number | null;
  started_at: string;
  external_ids: unknown;
}

function toInProgressItem(row: InProgressRow): InProgressItem {
  return {
    id: row.id,
    source: row.source,
    title: row.title ?? null,
    parent_title: row.parent_title ?? null,
    progress: row.progress ?? null,
    started_at: row.started_at,
    cover_url: coverUrlFor(row),
  };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (fmt !== undefined) {
    return fmt;
  }
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    throw new Error(`Invalid timezone: "${tz}"`);
  }
  formatterCache.set(tz, fmt);
  return fmt;
}

/** ISO 1=Mon .. 7=Sun, indexed by `Date.getUTCDay()` (0=Sun .. 6=Sat). */
const ISO_WEEKDAY = [7, 1, 2, 3, 4, 5, 6] as const;

export interface LocalTimeParts {
  date: string;
  hour: number;
  weekday: number; // 1=Mon .. 7=Sun
  localTime: string; // "HH:mm"
}

/**
 * Every read re-buckets the same archive timestamps, and `formatToParts` dominates a cold
 * page load on a small server CPU, so results are memoised per timezone. They depend only
 * on the input, are frozen, and the memo is dropped wholesale once it grows large.
 */
const localPartsCache = new Map<string, Map<string, Readonly<LocalTimeParts>>>();
const LOCAL_PARTS_CACHE_MAX = 200_000;

export function formatLocalParts(iso: string, tz: string): LocalTimeParts {
  let byIso = localPartsCache.get(tz);
  if (byIso === undefined) {
    byIso = new Map();
    localPartsCache.set(tz, byIso);
  }
  const cached = byIso.get(iso);
  if (cached !== undefined) {
    return cached;
  }
  const parts = Object.freeze(computeLocalParts(iso, tz));
  if (byIso.size >= LOCAL_PARTS_CACHE_MAX) {
    byIso.clear();
  }
  byIso.set(iso, parts);
  return parts;
}

function computeLocalParts(iso: string, tz: string): LocalTimeParts {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: "${iso}"`);
  }

  const formatter = getFormatter(tz);
  let year = "";
  let month = "";
  let day = "";
  let hourRaw = "";
  let minute = "";

  for (const part of formatter.formatToParts(date)) {
    switch (part.type) {
      case "year":
        year = part.value;
        break;
      case "month":
        month = part.value;
        break;
      case "day":
        day = part.value;
        break;
      case "hour":
        hourRaw = part.value;
        break;
      case "minute":
        minute = part.value;
        break;
      default:
        break;
    }
  }

  if (!year || !month || !day || !hourRaw || !minute) {
    throw new Error(`Could not determine local time parts for timezone "${tz}"`);
  }

  const hour = Number.parseInt(hourRaw, 10) % 24;
  const dateStr = `${year}-${month}-${day}`;
  const weekday =
    ISO_WEEKDAY[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  const localTime = `${hour.toString().padStart(2, "0")}:${minute.padStart(2, "0")}`;

  return { date: dateStr, hour, weekday, localTime };
}

/** Pure calendar aggregation. */
export function aggregateCalendar(
  events: readonly ConsumptionEvent[],
  month: string,
  tz: string
): CalendarResult {
  const monthPrefix = `${month}-`;
  const daysMap = new Map<
    string,
    { date: string; items: CalendarItem[]; totalSeconds: number }
  >();

  for (const event of events) {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      continue;
    }
    if (eventPrecision(event) !== "day") {
      continue;
    }
    const local = formatLocalParts(event.started_at, tz);
    if (!local.date.startsWith(monthPrefix)) {
      continue;
    }
    let day = daysMap.get(local.date);
    if (!day) {
      day = { date: local.date, items: [], totalSeconds: 0 };
      daysMap.set(local.date, day);
    }
    const durationSeconds = event.duration_seconds ?? null;
    const item: CalendarItem = {
      id: event.id,
      source: event.source,
      media_type: event.media_type,
      category: categoryOf(event),
      title: event.title ?? null,
      parent_title: event.parent_title ?? null,
      season: event.season ?? null,
      episode: event.episode ?? null,
      started_at: event.started_at,
      local_time: local.localTime,
      duration_seconds: durationSeconds,
      cover_url: coverUrlFor(event),
      time_uncertain: isShortform(event) || isTimeUncertain(event),
    };
    if ("also_from" in event && (event as DedupedEvent).also_from) {
      item.also_from = (event as DedupedEvent).also_from;
    }
    day.items.push(item);
    day.totalSeconds += durationSeconds ?? 0;
  }

  const days: CalendarDay[] = Array.from(daysMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      day.items.sort(
        (a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id
      );
      return {
        date: day.date,
        count: day.items.filter((e) => !isShortform(e)).length,
        minutes: day.totalSeconds / 60,
        items: day.items,
      };
    });

  return { month, days };
}

/** Pure heat map days aggregation. */
export function aggregateHeatmapDays(
  events: readonly ConsumptionEvent[],
  year: string | number,
  tz: string
): HeatmapDaysResult {
  const yearStr = String(year);
  const yearPrefix = `${yearStr}-`;
  const daysMap = new Map<
    string,
    { date: string; count: number; totalSeconds: number }
  >();

  for (const event of events) {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      continue;
    }
    if (eventPrecision(event) !== "day") {
      continue;
    }
    const local = formatLocalParts(event.started_at, tz);
    if (!local.date.startsWith(yearPrefix)) {
      continue;
    }
    let day = daysMap.get(local.date);
    if (!day) {
      day = { date: local.date, count: 0, totalSeconds: 0 };
      daysMap.set(local.date, day);
    }
    day.count += isShortform(event) ? 0 : 1;
    day.totalSeconds += event.duration_seconds ?? 0;
  }

  const days: HeatmapDay[] = Array.from(daysMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      date: day.date,
      count: day.count,
      minutes: day.totalSeconds / 60,
    }));

  return { year: yearStr, days };
}

/** Pure heat map hours aggregation. */
export function aggregateHeatmapHours(
  events: readonly ConsumptionEvent[],
  year: string | number | undefined,
  tz: string
): HeatmapHoursResult {
  const yearPrefix = year !== undefined && year !== "" ? `${String(year)}-` : null;
  const cellsMap = new Map<
    string,
    { weekday: number; hour: number; count: number; totalSeconds: number }
  >();
  let unplacedCount = 0;
  let unplacedSeconds = 0;

  for (const event of events) {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      continue;
    }
    if (eventPrecision(event) !== "day") {
      continue;
    }
    const local = formatLocalParts(event.started_at, tz);
    if (yearPrefix !== null && !local.date.startsWith(yearPrefix)) {
      continue;
    }
    if (isShortform(event) || isTimeUncertain(event)) {
      unplacedCount += isShortform(event) ? 0 : 1;
      unplacedSeconds += event.duration_seconds ?? 0;
      continue;
    }
    const cellWeekday = local.weekday - 1; // 0=Mon .. 6=Sun
    const cellHour = local.hour; // 0-23
    const key = `${cellWeekday}_${cellHour}`;
    let cell = cellsMap.get(key);
    if (!cell) {
      cell = { weekday: cellWeekday, hour: cellHour, count: 0, totalSeconds: 0 };
      cellsMap.set(key, cell);
    }
    cell.count += 1;
    cell.totalSeconds += event.duration_seconds ?? 0;
  }

  const cells: HeatmapHourCell[] = Array.from(cellsMap.values())
    .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour)
    .map((cell) => ({
      weekday: cell.weekday,
      hour: cell.hour,
      count: cell.count,
      minutes: cell.totalSeconds / 60,
    }));

  return { cells, unplaced_count: unplacedCount, unplaced_minutes: unplacedSeconds / 60 };
}

/** Options for stats aggregation. */
export interface AggregateStatsOptions {
  from?: string;
  to?: string;
  source?: string;
  tz?: string;
}

/**
 * Calculates the ISO 8601 week string ("YYYY-Www") from a local date ("YYYY-MM-DD").
 */
export function getIsoWeek(dateStr: string): string {
  const parts = dateStr.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  const target = new Date(Date.UTC(year, month - 1, day));
  // ISO day of week: 1 (Mon) .. 7 (Sun)
  const dayNr = ((target.getUTCDay() + 6) % 7) + 1;
  // Nearest Thursday in current week decides the ISO year
  target.setUTCDate(target.getUTCDate() + 4 - dayNr);
  const isoYear = target.getUTCFullYear();
  // First day of ISO year is 4th of January
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNr = ((firstThursday.getUTCDay() + 6) % 7) + 1;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDayNr);
  // Difference in weeks
  const weekDiff = Math.round(
    (target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000)
  );
  const weekNr = 1 + weekDiff;
  return `${isoYear}-W${String(weekNr).padStart(2, "0")}`;
}

/**
 * Returns series/show title if the event has one, else title.
 */
export function getSeriesOrTitle(event: ConsumptionEvent): string {
  const isSeriesOrShow =
    event.media_type === "episode" ||
    event.media_type === "show" ||
    event.media_type === "podcast" ||
    event.media_type === "podcast_episode" ||
    (event.season !== null && event.season !== undefined) ||
    (event.episode !== null && event.episode !== undefined);

  if (isSeriesOrShow && event.parent_title && event.parent_title.trim() !== "") {
    return event.parent_title.trim();
  }
  return event.title?.trim() || event.parent_title?.trim() || "Untitled";
}

/** Pure stats aggregation. */
export function aggregateStats(
  events: readonly ConsumptionEvent[],
  opts?: AggregateStatsOptions
): StatsResult {
  const tz = opts?.tz ?? "Europe/Bratislava";
  const from = opts?.from;
  const to = opts?.to;
  const sourceFilter = opts?.source;

  let totalItems = 0;
  let totalSeconds = 0;
  const bySourceData: Record<string, { count: number; totalSeconds: number }> = {};
  const byMediaTypeData: Record<string, { count: number; totalSeconds: number }> = {};

  const byWeekMap = new Map<
    string,
    {
      week: string;
      bySourceSeconds: Record<string, number>;
      bySourceCount: Record<string, number>;
      totalSeconds: number;
      count: number;
    }
  >();
  const byMonthMap = new Map<
    string,
    {
      month: string;
      bySourceSeconds: Record<string, number>;
      bySourceCount: Record<string, number>;
      totalSeconds: number;
      count: number;
    }
  >();
  const topItemsMap = new Map<
    string,
    {
      title: string;
      source: string;
      media_type: string;
      category: Category;
      totalSeconds: number;
      count: number;
    }
  >();

  for (const event of events) {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      continue;
    }
    if (sourceFilter !== undefined && sourceFilter !== "" && event.source !== sourceFilter) {
      continue;
    }

    const precision = eventPrecision(event);
    const hasDateFilter =
      (from !== undefined && from !== "") || (to !== undefined && to !== "");
    if (hasDateFilter && precision === "unknown") {
      continue;
    }

    const local = formatLocalParts(event.started_at, tz);
    if (from !== undefined && from !== "" && local.date < from) {
      continue;
    }
    if (to !== undefined && to !== "" && local.date > to) {
      continue;
    }

    const itemCount = isShortform(event) ? 0 : 1;
    totalItems += itemCount;
    const dur = event.duration_seconds ?? 0;
    totalSeconds += dur;

    // by_source
    if (!bySourceData[event.source]) {
      bySourceData[event.source] = { count: 0, totalSeconds: 0 };
    }
    const src = bySourceData[event.source]!;
    src.count += itemCount;
    src.totalSeconds += dur;

    // by_media_type
    if (!byMediaTypeData[event.media_type]) {
      byMediaTypeData[event.media_type] = { count: 0, totalSeconds: 0 };
    }
    const mt = byMediaTypeData[event.media_type]!;
    mt.count += itemCount;
    mt.totalSeconds += dur;

    // by_week (day precision only)
    if (precision === "day") {
      const week = getIsoWeek(local.date);
      let weekEntry = byWeekMap.get(week);
      if (!weekEntry) {
        weekEntry = {
          week,
          bySourceSeconds: {},
          bySourceCount: {},
          totalSeconds: 0,
          count: 0,
        };
        byWeekMap.set(week, weekEntry);
      }
      weekEntry.bySourceSeconds[event.source] =
        (weekEntry.bySourceSeconds[event.source] ?? 0) + dur;
      weekEntry.bySourceCount[event.source] =
        (weekEntry.bySourceCount[event.source] ?? 0) + itemCount;
      weekEntry.totalSeconds += dur;
      weekEntry.count += itemCount;
    }

    // by_month (day and month precision only)
    if (precision === "day" || precision === "month") {
      const month = local.date.slice(0, 7);
      let monthEntry = byMonthMap.get(month);
      if (!monthEntry) {
        monthEntry = {
          month,
          bySourceSeconds: {},
          bySourceCount: {},
          totalSeconds: 0,
          count: 0,
        };
        byMonthMap.set(month, monthEntry);
      }
      monthEntry.bySourceSeconds[event.source] =
        (monthEntry.bySourceSeconds[event.source] ?? 0) + dur;
      monthEntry.bySourceCount[event.source] =
        (monthEntry.bySourceCount[event.source] ?? 0) + itemCount;
      monthEntry.totalSeconds += dur;
      monthEntry.count += itemCount;
    }

    // top_items
    if (isShortform(event)) continue;
    const effectiveTitle = getSeriesOrTitle(event);
    const itemKey = `${event.source}:::${effectiveTitle}`;
    let itemEntry = topItemsMap.get(itemKey);
    if (!itemEntry) {
      itemEntry = {
        title: effectiveTitle,
        source: event.source,
        media_type: event.media_type,
        category: categoryOf(event),
        totalSeconds: 0,
        count: 0,
      };
      topItemsMap.set(itemKey, itemEntry);
    }
    itemEntry.totalSeconds += dur;
    itemEntry.count += 1;
  }

  const by_source: Record<string, StatBucket> = {};
  for (const [key, val] of Object.entries(bySourceData)) {
    by_source[key] = {
      count: val.count,
      items: val.count,
      minutes: val.totalSeconds / 60,
    };
  }

  const by_media_type: Record<string, StatBucket> = {};
  for (const [key, val] of Object.entries(byMediaTypeData)) {
    by_media_type[key] = {
      count: val.count,
      items: val.count,
      minutes: val.totalSeconds / 60,
    };
  }

  const by_week: WeekStatBucket[] = Array.from(byWeekMap.values())
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((w) => {
      const by_source: Record<string, number> = {};
      for (const [src, sec] of Object.entries(w.bySourceSeconds)) {
        by_source[src] = sec / 60;
      }
      return {
        week: w.week,
        by_source,
        minutes: w.totalSeconds / 60,
        count: w.count,
        count_by_source: { ...w.bySourceCount },
      };
    });

  const by_month: MonthStatBucket[] = Array.from(byMonthMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const by_source: Record<string, number> = {};
      for (const [src, sec] of Object.entries(m.bySourceSeconds)) {
        by_source[src] = sec / 60;
      }
      return {
        month: m.month,
        by_source,
        minutes: m.totalSeconds / 60,
        count: m.count,
        count_by_source: { ...m.bySourceCount },
      };
    });

  const top_items: TopItem[] = Array.from(topItemsMap.values())
    .map((it) => ({
      title: it.title,
      source: it.source,
      media_type: it.media_type,
      category: it.category,
      minutes: it.totalSeconds / 60,
      count: it.count,
    }))
    .sort((a, b) => b.minutes - a.minutes || b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 10);

  return {
    total_items: totalItems,
    total_minutes: totalSeconds / 60,
    by_source,
    by_media_type,
    by_week,
    by_month,
    top_items,
  };
}

/** Pure in-progress filtering. */
export function filterInProgress(
  events: readonly {
    id: number;
    source: string;
    source_kind: string;
    title: string | null;
    parent_title?: string | null;
    progress?: number | null;
    started_at: string;
    external_ids?: unknown;
  }[],
  source?: string
): InProgressItem[] {
  return events
    .filter((e) => {
      if (e.source_kind !== "media_progress") {
        return false;
      }
      if (source !== undefined && source !== "" && e.source !== source) {
        return false;
      }
      return (
        e.progress !== null &&
        e.progress !== undefined &&
        e.progress > 0 &&
        e.progress < 1
      );
    })
    .map((e) => ({
      id: e.id,
      source: e.source,
      title: e.title ?? null,
      parent_title: e.parent_title ?? null,
      progress: e.progress ?? null,
      started_at: e.started_at,
      cover_url: coverUrlFor(e),
    }));
}

// --- Database queries reading events_latest only --------------------------

export function getLatestConsumptionEvents(
  db: Database,
  source?: string
): ConsumptionEvent[] {
  if (source !== undefined && source !== "") {
    return db
      .query<ConsumptionEvent, [string]>(
        `SELECT
          id,
          source,
          source_kind,
          source_id,
          external_ids,
          media_type,
          title,
          parent_title,
          season,
          episode,
          started_at,
          ended_at,
          duration_seconds,
          progress,
          raw
        FROM events_latest
        WHERE source_kind IN (${CONSUMPTION_KINDS_SQL})
          AND source = ?
        ORDER BY started_at ASC, id ASC;`
      )
      .all(source);
  }

  return db
    .query<ConsumptionEvent, []>(
      `SELECT
        id,
        source,
        source_kind,
        source_id,
        external_ids,
        media_type,
        title,
        parent_title,
        season,
        episode,
        started_at,
        ended_at,
        duration_seconds,
        progress,
        raw
      FROM events_latest
      WHERE source_kind IN (${CONSUMPTION_KINDS_SQL})
      ORDER BY started_at ASC, id ASC;`
    )
    .all();
}

/**
 * Display events are rebuilt from the whole archive (filter, dedupe, overrides), which
 * takes seconds on a small server CPU and is needed by most endpoints, so they are kept
 * until the database changes. Cached events are frozen: a caller can never alter them.
 */
export function getDisplayConsumptionEvents(
  db: Database,
  source?: string,
  tz: string = "Europe/Bratislava"
): DedupedEvent[] {
  return [...cachedUntilWrite(db, `display\u0000${source ?? ""}\u0000${tz}`, () =>
    buildDisplayConsumptionEvents(db, source, tz).map((e) => Object.freeze(e)))];
}

/** Latest consumption events without short YouTube video-days (shared by every read). */
export function getFilteredConsumptionEvents(
  db: Database,
  source: string | undefined,
  tz: string
): ConsumptionEvent[] {
  return [...cachedUntilWrite(db, `filtered\u0000${source ?? ""}\u0000${tz}`, () =>
    filterShortYoutubeEvents(getLatestConsumptionEvents(db, source), tz, db).map((e) => Object.freeze(e)))];
}

function buildDisplayConsumptionEvents(
  db: Database,
  source: string | undefined,
  tz: string
): DedupedEvent[] {
  const deduped = dedupeConsumption(getFilteredConsumptionEvents(db, source, tz), tz);
  // Time-only rows have no work key or editable library identity.
  const timeOnly = deduped.filter(isShortform);
  return [...applyWorkOverridesToEvents(db, deduped.filter((e) => !isShortform(e))), ...timeOnly];
}

export function getCalendar(
  db: Database,
  month: string,
  tz: string,
  source?: string,
  categoryFilter?: CategoryFilter
): CalendarResult {
  let events = getDisplayConsumptionEvents(db, source, tz);
  if (categoryFilter) {
    events = events.filter((e) =>
      matchesCategoryFilter(categoryOf(e), categoryFilter)
    );
  }
  return aggregateCalendar(events, month, tz);
}

export function getHeatmapDays(
  db: Database,
  year: string | number,
  tz: string,
  source?: string,
  categoryFilter?: CategoryFilter
): HeatmapDaysResult {
  let events = getDisplayConsumptionEvents(db, source, tz);
  if (categoryFilter) {
    events = events.filter((e) =>
      matchesCategoryFilter(categoryOf(e), categoryFilter)
    );
  }
  return aggregateHeatmapDays(events, year, tz);
}

export function getHeatmapHours(
  db: Database,
  year: string | number | undefined,
  tz: string,
  source?: string,
  categoryFilter?: CategoryFilter
): HeatmapHoursResult {
  let events = getDisplayConsumptionEvents(db, source, tz);
  if (categoryFilter) {
    events = events.filter((e) =>
      matchesCategoryFilter(categoryOf(e), categoryFilter)
    );
  }
  return aggregateHeatmapHours(events, year, tz);
}

export interface GetStatsOptions {
  from?: string;
  to?: string;
  source?: string;
  category?: CategoryFilterInput;
  exclude?: CategoryFilterInput;
  tz?: string;
}

export function getStats(
  db: Database,
  optsOrSource?: GetStatsOptions | string,
  tzParam?: string
): StatsResult {
  let source: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let category: CategoryFilterInput;
  let exclude: CategoryFilterInput;
  let tz = "Europe/Bratislava";

  if (typeof optsOrSource === "string") {
    source = optsOrSource;
    if (tzParam) {
      tz = tzParam;
    }
  } else if (optsOrSource) {
    source = optsOrSource.source;
    from = optsOrSource.from;
    to = optsOrSource.to;
    category = optsOrSource.category;
    exclude = optsOrSource.exclude;
    if (optsOrSource.tz) {
      tz = optsOrSource.tz;
    }
  }
  if (tzParam && typeof optsOrSource !== "string") {
    tz = tzParam;
  }

  let events = getDisplayConsumptionEvents(db, source, tz);
  const filter = parseCategoryFilter(category, exclude);
  if (filter) {
    events = events.filter((e) =>
      matchesCategoryFilter(categoryOf(e), filter)
    );
  }
  return aggregateStats(events, { from, to, source, tz });
}

export function getInProgress(
  db: Database,
  source?: string
): InProgressItem[] {
  if (source !== undefined && source !== "") {
    return db
      .query<InProgressRow, [string]>(
        `SELECT
          p.id,
          p.source,
          p.source_kind,
          p.source_id,
          ${PROGRESS_TITLE_SQL},
          p.parent_title,
          p.progress,
          p.started_at,
          p.external_ids
        FROM events_latest p
        WHERE p.source_kind = 'media_progress'
          AND p.progress > 0
          AND p.progress < 1
          AND p.source = ?
        ORDER BY p.started_at DESC, p.id DESC;`
      )
      .all(source)
      .map(toInProgressItem);
  }

  return db
    .query<InProgressRow, []>(
      `SELECT
        p.id,
        p.source,
        p.source_kind,
        p.source_id,
        ${PROGRESS_TITLE_SQL},
        p.parent_title,
        p.progress,
        p.started_at,
        p.external_ids
      FROM events_latest p
      WHERE p.source_kind = 'media_progress'
        AND p.progress > 0
        AND p.progress < 1
      ORDER BY p.started_at DESC, p.id DESC;`
    )
    .all()
    .map(toInProgressItem);
}

// --- In-progress / finished progress lists (F10) --------------------------

/** Raw `events_latest` row for the progress lists (before classification). */
interface ProgressRow {
  id: number;
  source: string;
  source_kind: string;
  source_id: string;
  title: string | null;
  parent_title: string | null;
  media_type: string;
  season: number | null;
  episode: number | null;
  progress: number | null;
  started_at: string;
  ended_at: string | null;
  external_ids: unknown;
  raw: unknown;
}

const PROGRESS_LIST_COLUMNS = `
  p.id,
  p.source,
  p.source_kind,
  p.source_id,
  ${PROGRESS_TITLE_SQL},
  p.parent_title,
  p.media_type,
  p.season,
  p.episode,
  p.progress,
  p.started_at,
  p.ended_at,
  p.external_ids,
  p.raw`;

/**
 * An item counts as finished when it has an end timestamp, reached 100%
 * progress, or Audiobookshelf stored `isFinished: true` in the raw payload.
 */
function isFinishedProgressRow(row: ProgressRow): boolean {
  if (row.ended_at !== null && row.ended_at !== undefined) {
    return true;
  }
  if (
    row.progress !== null &&
    row.progress !== undefined &&
    row.progress >= 1
  ) {
    return true;
  }
  const raw = parseJsonObject(row.raw);
  return raw !== null && raw["isFinished"] === true;
}

function toProgressItem(row: ProgressRow): ProgressItem {
  return {
    id: row.id,
    source: row.source,
    title: row.title ?? null,
    parent_title: row.parent_title ?? null,
    progress: row.progress ?? null,
    is_finished: isFinishedProgressRow(row),
    last_update: row.started_at,
    finished_at: row.ended_at ?? null,
    cover_url: coverUrlFor(row),
    // No annotation lookup here; `getProgressLists` fills in the rating in
    // one batch query for all items.
    rating: null,
    group_title: getSeriesOrTitle({
      id: row.id,
      source: row.source,
      source_kind: row.source_kind,
      media_type: row.media_type,
      title: row.title,
      parent_title: row.parent_title,
      season: row.season,
      episode: row.episode,
      started_at: row.started_at,
    }),
  };
}

/**
 * Reads the latest `media_progress` row per item from `events_latest` and
 * splits it into in-progress and finished lists, each sorted by last update
 * descending. In progress = `progress > 0` and not finished; everything
 * finished (end timestamp, `progress >= 1`, or raw `isFinished`) goes to
 * `finished`. `progress` 0 / null items that are not finished appear nowhere.
 */
export function getProgressLists(db: Database, source?: string): ProgressLists {
  const rows =
    source !== undefined && source !== ""
      ? db
          .query<ProgressRow, [string]>(
            `SELECT ${PROGRESS_LIST_COLUMNS}
             FROM events_latest p
             WHERE p.source_kind = 'media_progress'
               AND p.source = ?
             ORDER BY p.started_at DESC, p.id DESC;`
          )
          .all(source)
      : db
          .query<ProgressRow, []>(
            `SELECT ${PROGRESS_LIST_COLUMNS}
             FROM events_latest p
             WHERE p.source_kind = 'media_progress'
             ORDER BY p.started_at DESC, p.id DESC;`
          )
          .all();

  const in_progress: ProgressItem[] = [];
  const finished: ProgressItem[] = [];

  for (const row of rows) {
    const item = toProgressItem(row);
    if (item.is_finished) {
      finished.push(item);
    } else if (item.progress !== null && item.progress > 0) {
      in_progress.push(item);
    }
  }

  // One batch annotation lookup for every item in the response.
  const allItems = [...in_progress, ...finished];
  const keys: AnnotationKey[] = allItems.map((item) => ({
    source: item.source,
    title: item.group_title,
  }));
  const annotations = getAnnotationsFor(db, keys);
  for (const item of allItems) {
    const annotation = annotations.get(
      annotationMapKey(item.source, item.group_title)
    );
    item.rating = annotation?.rating ?? null;
  }

  return { in_progress, finished };
}
