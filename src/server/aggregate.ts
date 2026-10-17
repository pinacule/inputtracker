/**
 * Pure aggregation functions for calendar, heat map, stats, and in-progress items.
 *
 * Critical rules:
 * - Read `events_latest` only; never aggregate over `events`.
 * - Only consumption kinds count as activity: `source_kind IN ('listening_session','watch','history_item')`.
 *   `media_progress` and `daily_stat` never count in calendar/heat map/stats.
 * - Timestamps are stored UTC; bucketed by local day/hour in the configured timezone using `Intl`.
 * - Minutes = `duration_seconds / 60` (null -> 0 minutes, still counts as 1 item).
 * - Count = number of latest rows.
 */

import type { Database } from "bun:sqlite";

export const CONSUMPTION_KINDS = new Set([
  "listening_session",
  "watch",
  "history_item",
]);

export interface ConsumptionEvent {
  id: number;
  source: string;
  source_kind: string;
  source_id?: string;
  media_type: string;
  title: string | null;
  parent_title?: string | null;
  season?: number | null;
  episode?: number | null;
  started_at: string;
  duration_seconds?: number | null;
}

export interface CalendarItem {
  id: number;
  source: string;
  media_type: string;
  title: string | null;
  parent_title: string | null;
  season: number | null;
  episode: number | null;
  started_at: string;
  local_time: string;
  duration_seconds: number | null;
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
}

export interface StatBucket {
  count: number;
  items: number;
  minutes: number;
}

export interface StatsResult {
  total_items: number;
  total_minutes: number;
  by_source: Record<string, StatBucket>;
  by_media_type: Record<string, StatBucket>;
}

export interface InProgressItem {
  id: number;
  source: string;
  title: string | null;
  parent_title: string | null;
  progress: number | null;
  started_at: string;
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

export function formatLocalParts(iso: string, tz: string): LocalTimeParts {
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
    day.items.push({
      id: event.id,
      source: event.source,
      media_type: event.media_type,
      title: event.title ?? null,
      parent_title: event.parent_title ?? null,
      season: event.season ?? null,
      episode: event.episode ?? null,
      started_at: event.started_at,
      local_time: local.localTime,
      duration_seconds: durationSeconds,
    });
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
        count: day.items.length,
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
    const local = formatLocalParts(event.started_at, tz);
    if (!local.date.startsWith(yearPrefix)) {
      continue;
    }
    let day = daysMap.get(local.date);
    if (!day) {
      day = { date: local.date, count: 0, totalSeconds: 0 };
      daysMap.set(local.date, day);
    }
    day.count += 1;
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

  for (const event of events) {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      continue;
    }
    const local = formatLocalParts(event.started_at, tz);
    if (yearPrefix !== null && !local.date.startsWith(yearPrefix)) {
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

  return { cells };
}

/** Pure stats aggregation. */
export function aggregateStats(
  events: readonly ConsumptionEvent[]
): StatsResult {
  let totalItems = 0;
  let totalSeconds = 0;
  const bySourceData: Record<string, { count: number; totalSeconds: number }> = {};
  const byMediaTypeData: Record<string, { count: number; totalSeconds: number }> = {};

  for (const event of events) {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      continue;
    }
    totalItems += 1;
    const dur = event.duration_seconds ?? 0;
    totalSeconds += dur;

    if (!bySourceData[event.source]) {
      bySourceData[event.source] = { count: 0, totalSeconds: 0 };
    }
    const src = bySourceData[event.source]!;
    src.count += 1;
    src.totalSeconds += dur;

    if (!byMediaTypeData[event.media_type]) {
      byMediaTypeData[event.media_type] = { count: 0, totalSeconds: 0 };
    }
    const mt = byMediaTypeData[event.media_type]!;
    mt.count += 1;
    mt.totalSeconds += dur;
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

  return {
    total_items: totalItems,
    total_minutes: totalSeconds / 60,
    by_source,
    by_media_type,
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
          media_type,
          title,
          parent_title,
          season,
          episode,
          started_at,
          duration_seconds
        FROM events_latest
        WHERE source_kind IN ('listening_session', 'watch', 'history_item')
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
        media_type,
        title,
        parent_title,
        season,
        episode,
        started_at,
        duration_seconds
      FROM events_latest
      WHERE source_kind IN ('listening_session', 'watch', 'history_item')
      ORDER BY started_at ASC, id ASC;`
    )
    .all();
}

export function getCalendar(
  db: Database,
  month: string,
  tz: string,
  source?: string
): CalendarResult {
  const events = getLatestConsumptionEvents(db, source);
  return aggregateCalendar(events, month, tz);
}

export function getHeatmapDays(
  db: Database,
  year: string | number,
  tz: string,
  source?: string
): HeatmapDaysResult {
  const events = getLatestConsumptionEvents(db, source);
  return aggregateHeatmapDays(events, year, tz);
}

export function getHeatmapHours(
  db: Database,
  year: string | number | undefined,
  tz: string,
  source?: string
): HeatmapHoursResult {
  const events = getLatestConsumptionEvents(db, source);
  return aggregateHeatmapHours(events, year, tz);
}

export function getStats(db: Database, source?: string): StatsResult {
  const events = getLatestConsumptionEvents(db, source);
  return aggregateStats(events);
}

export function getInProgress(
  db: Database,
  source?: string
): InProgressItem[] {
  if (source !== undefined && source !== "") {
    return db
      .query<InProgressItem, [string]>(
        `SELECT
          id,
          source,
          title,
          parent_title,
          progress,
          started_at
        FROM events_latest
        WHERE source_kind = 'media_progress'
          AND progress > 0
          AND progress < 1
          AND source = ?
        ORDER BY started_at DESC, id DESC;`
      )
      .all(source);
  }

  return db
    .query<InProgressItem, []>(
      `SELECT
        id,
        source,
        title,
        parent_title,
        progress,
        started_at
      FROM events_latest
      WHERE source_kind = 'media_progress'
        AND progress > 0
        AND progress < 1
      ORDER BY started_at DESC, id DESC;`
    )
    .all();
}
