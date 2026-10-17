/**
 * Pure stats and formatting utilities for InputTracker.
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import { SOURCES, sourceColor } from "./sources";

// Keep the historical export point (`sourceColor` from `stats.ts`) working.
export { sourceColor };

export interface SourceOption {
  readonly value: string;
  readonly label: string;
}

export const STATS_SOURCES: readonly SourceOption[] = [
  { value: "", label: "All sources" },
  ...SOURCES.map((source) => ({ value: source.value, label: source.label })),
];

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Formats minutes into human-readable hours and minutes (e.g. "2h 15m", "45m", "0m").
 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (
    minutes === null ||
    minutes === undefined ||
    Number.isNaN(minutes) ||
    minutes < 0
  ) {
    return "0m";
  }
  const rounded = Math.round(minutes);
  if (rounded === 0) {
    return "0m";
  }
  if (rounded < 60) {
    return `${rounded}m`;
  }
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
}

/** Alias for formatMinutes for descriptive callers. */
export const formatHoursMinutes = formatMinutes;

/**
 * Compact label for bar values: `0m`, `45m`, `1h`, `1.5h`, `48h`.
 * Minutes are rounded first; null/NaN/negative collapse to `"0m"`.
 */
export function formatMinutesShort(
  minutes: number | null | undefined
): string {
  if (
    minutes === null ||
    minutes === undefined ||
    Number.isNaN(minutes) ||
    minutes < 0
  ) {
    return "0m";
  }
  const rounded = Math.round(minutes);
  if (rounded === 0) {
    return "0m";
  }
  if (rounded < 60) {
    return `${rounded}m`;
  }
  if (rounded < 600) {
    const hours = Math.round((rounded / 60) * 10) / 10;
    return `${hours}h`;
  }
  return `${Math.round(rounded / 60)}h`;
}

/** Minimal structural shape needed to fill ISO-week gaps. */
export interface WeekBucketLike {
  readonly week: string;
  readonly by_source: Record<string, number>;
  readonly minutes: number;
}

/** Minimal structural shape needed to fill month gaps. */
export interface MonthBucketLike {
  readonly month: string;
  readonly by_source: Record<string, number>;
  readonly minutes: number;
}

const MS_PER_WEEK = 7 * 24 * 3600 * 1000;

/** Monday (UTC) of the given ISO week key ("YYYY-Www"). */
function isoWeekToMonday(weekKey: string): Date {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!match) {
    throw new Error(`Invalid ISO week key: ${weekKey}`);
  }
  const year = Number.parseInt(match[1]!, 10);
  const week = Number.parseInt(match[2]!, 10);
  // ISO week 1 always contains January 4th.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Offset = (jan4.getUTCDay() + 6) % 7; // 0 = Monday
  const week1Monday = new Date(Date.UTC(year, 0, 4 - jan4Offset));
  return new Date(week1Monday.getTime() + (week - 1) * MS_PER_WEEK);
}

/** ISO week key ("YYYY-Www") for a UTC date. Mirrors `getIsoWeek` in the server. */
function isoWeekFromDate(date: Date): string {
  const target = new Date(date.getTime());
  const dayNr = ((target.getUTCDay() + 6) % 7) + 1; // 1 = Monday .. 7 = Sunday
  target.setUTCDate(target.getUTCDate() + 4 - dayNr);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNr = ((firstThursday.getUTCDay() + 6) % 7) + 1;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDayNr);
  const weekDiff = Math.round(
    (target.getTime() - firstThursday.getTime()) / MS_PER_WEEK
  );
  const weekNr = 1 + weekDiff;
  return `${isoYear}-W${String(weekNr).padStart(2, "0")}`;
}

/**
 * Sorts week buckets and inserts zero-minute buckets for missing ISO weeks
 * between the first and last week present. Existing buckets are preserved.
 */
export function fillWeekGaps<T extends WeekBucketLike>(
  buckets: readonly T[]
): T[] {
  if (buckets.length === 0) {
    return [];
  }
  const byKey = new Map<string, T>();
  for (const bucket of buckets) {
    byKey.set(bucket.week, bucket);
  }
  const keys = [...byKey.keys()].sort();
  const startKey = keys[0]!;
  const endKey = keys[keys.length - 1]!;

  const result: T[] = [];
  const end = isoWeekToMonday(endKey).getTime();
  let cursor = isoWeekToMonday(startKey);
  while (cursor.getTime() <= end) {
    const key = isoWeekFromDate(cursor);
    const existing = byKey.get(key);
    result.push(
      existing ??
        ({ week: key, by_source: {}, minutes: 0 } as unknown as T)
    );
    cursor = new Date(cursor.getTime() + MS_PER_WEEK);
  }
  return result;
}

/**
 * Sorts month buckets and inserts zero-minute buckets for missing months
 * between the first and last month present. Existing buckets are preserved.
 */
export function fillMonthGaps<T extends MonthBucketLike>(
  buckets: readonly T[]
): T[] {
  if (buckets.length === 0) {
    return [];
  }
  const byKey = new Map<string, T>();
  for (const bucket of buckets) {
    byKey.set(bucket.month, bucket);
  }
  const keys = [...byKey.keys()].sort();
  const [startYear, startMonth] = parseMonthKey(keys[0]!);
  const [endYear, endMonth] = parseMonthKey(keys[keys.length - 1]!);

  const result: T[] = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const existing = byKey.get(key);
    result.push(
      existing ??
        ({ month: key, by_source: {}, minutes: 0 } as unknown as T)
    );
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return result;
}

/** Parses a "YYYY-MM" key into `[year, month]` (month 1-12). */
function parseMonthKey(key: string): [number, number] {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!match) {
    throw new Error(`Invalid month key: ${key}`);
  }
  return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10)];
}

/**
 * Calculates the maximum minutes across a list of buckets.
 */
export function computeMaxMinutes(
  buckets: ReadonlyArray<{ minutes: number }>
): number {
  let max = 0;
  for (const b of buckets) {
    if (b.minutes > max) {
      max = b.minutes;
    }
  }
  return max;
}

/**
 * Computes the scaled bar height percentage (0..100) relative to maxMinutes.
 */
export function computeBarHeight(
  minutes: number,
  maxMinutes: number,
  minPercent = 0
): number {
  if (maxMinutes <= 0 || minutes <= 0) {
    return 0;
  }
  const pct = (minutes / maxMinutes) * 100;
  return Math.max(minPercent, Math.min(100, Math.round(pct * 10) / 10));
}

export interface StackedSegment {
  source: string;
  minutes: number;
  percentage: number;
}

/**
 * Computes stacked segments for each source within a bar, relative to totalBarMinutes.
 * The percentages sum to 100% (or 0% if totalBarMinutes is 0).
 */
export function computeStackedSegments(
  bySource: Record<string, number>,
  totalBarMinutes: number
): StackedSegment[] {
  if (totalBarMinutes <= 0) {
    return [];
  }
  const entries = Object.entries(bySource).filter(([, m]) => m > 0);
  return entries.map(([source, minutes]) => ({
    source,
    minutes,
    percentage: Math.round((minutes / totalBarMinutes) * 1000) / 10,
  }));
}

/**
 * Formats a week ("2026-W42") or month ("2026-10") period into a readable label.
 */
export function formatPeriodLabel(
  period: string,
  type: "week" | "month"
): string {
  if (type === "week") {
    // e.g. "2026-W42" -> "W42"
    const match = /^(\d{4})-W(\d{2})$/.exec(period);
    if (match) {
      return `W${match[2]}`;
    }
    return period;
  }

  // e.g. "2026-10" -> "Oct 2026"
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (match) {
    const year = match[1];
    const monthIndex = Number.parseInt(match[2]!, 10) - 1;
    return `${MONTH_NAMES[monthIndex]} ${year}`;
  }
  return period;
}

