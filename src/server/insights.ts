/**
 * Read-only insights: streaks (F2) and "On this day" (F6).
 *
 * Rules:
 * - Events come from `getLatestConsumptionEvents` (reads `events_latest`,
 *   consumption kinds only). The pure functions filter by `CONSUMPTION_KINDS`
 *   again so they stay correct for any input.
 * - Days are local calendar days in the configured timezone, derived with
 *   `formatLocalParts` exactly like the Calendar page buckets events.
 * - Sources are free strings: never hard-code a list, only report sources
 *   actually present in the events.
 * - Nothing here writes to the database.
 */

import type { Database } from "bun:sqlite";
import { categoryOf } from "../core/category.ts";
import { isShortform } from "./shortform.ts";
import {
  CONSUMPTION_KINDS,
  coverUrlFor,
  eventPrecision,
  formatLocalParts,
  getDisplayConsumptionEvents,
  getSeriesOrTitle,
  type ConsumptionEvent,
} from "./aggregate.ts";
import {
  type CategoryFilter,
  matchesCategoryFilter,
} from "./overrides.ts";

export interface StreakInfo {
  /** Consecutive active days ending today (or yesterday when today is empty so far). */
  current: number;
  /** Longest run of consecutive active days anywhere. */
  longest: number;
  /** First local day ("YYYY-MM-DD") of the longest run, null with no events. */
  longest_start: string | null;
  /** Last local day of the longest run, null with no events. */
  longest_end: string | null;
  /** Last local day with an event, null with no events. */
  last_active: string | null;
}

export interface StreaksResult {
  /** "Today" as passed in (local "YYYY-MM-DD"), echoed for the client. */
  today: string;
  overall: StreakInfo;
  by_source: Record<string, StreakInfo>;
}

export interface OnThisDayItem {
  /** `getSeriesOrTitle(event)`: series title for episodes, else the title. */
  title: string;
  source: string;
  media_type: string | null;
  /** UTC ISO as stored (first occurrence of a merged title). */
  started_at: string;
  /** `/api/cover/...`, `/api/poster/simkl/...` or `/api/thumb/youtube/...`, else null. */
  cover_url: string | null;
}

export interface OnThisDayYear {
  year: number;
  years_ago: number;
  items: OnThisDayItem[];
}

export interface OnThisDayResult {
  /** The reference local date ("YYYY-MM-DD") the years are compared to. */
  date: string;
  /** Earlier years only, newest year first. */
  years: OnThisDayYear[];
}

export interface InsightsResult {
  streaks: StreaksResult;
  on_this_day: OnThisDayResult;
}

/** Max merged items shown per earlier year. */
export const ON_THIS_DAY_MAX_PER_YEAR = 20;

// --- Local-day calendar helpers (pure string math on "YYYY-MM-DD") ----------

/** Adds `delta` days to a local date string, as pure UTC calendar math. */
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-");
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + delta));
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True when `today`'s year is a leap year (Gregorian). */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Local active days for the whole set and per source. */
function activeDaysBySource(
  events: readonly ConsumptionEvent[],
  tz: string
): Map<string, Set<string>> {
  const bySource = new Map<string, Set<string>>();
  for (const event of events) {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      continue;
    }
    if (isShortform(event) && !(event.duration_seconds && event.duration_seconds > 0)) continue;
    if (eventPrecision(event) !== "day") {
      continue;
    }
    const { date } = formatLocalParts(event.started_at, tz);
    let days = bySource.get(event.source);
    if (!days) {
      days = new Set<string>();
      bySource.set(event.source, days);
    }
    days.add(date);
  }
  return bySource;
}

/** Streaks for one set of active local days. */
function streakInfoFor(days: ReadonlySet<string>, today: string): StreakInfo {
  if (days.size === 0) {
    return {
      current: 0,
      longest: 0,
      longest_start: null,
      longest_end: null,
      last_active: null,
    };
  }

  // Current streak: count back from today, or from yesterday when today has no
  // event yet (the streak stays alive). Any earlier gap means it is dead.
  let cursor = days.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (days.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  // Longest streak: scan sorted days for runs of consecutive local days,
  // seeded with the first day so a set of one day yields 1. `>=` on a tie
  // keeps the most recent run.
  const sorted = Array.from(days).sort((a, b) => a.localeCompare(b));
  let longest = 1;
  let longestStart = sorted[0]!;
  let longestEnd = sorted[0]!;
  let runStart = sorted[0]!;
  let prev = sorted[0]!;
  let runLength = 1;
  for (let i = 1; i < sorted.length; i++) {
    const day = sorted[i]!;
    if (addDays(prev, 1) === day) {
      runLength += 1;
    } else {
      runStart = day;
      runLength = 1;
    }
    if (runLength >= longest) {
      longest = runLength;
      longestStart = runStart;
      longestEnd = day;
    }
    prev = day;
  }

  return {
    current,
    longest,
    longest_start: longestStart,
    longest_end: longestEnd,
    last_active: sorted[sorted.length - 1]!,
  };
}

/**
 * Pure streak computation. `today` is a local "YYYY-MM-DD" (a parameter so
 * tests are deterministic; the route derives it from the current time in tz).
 */
export function computeStreaks(
  events: readonly ConsumptionEvent[],
  tz: string,
  today: string
): StreaksResult {
  const bySource = activeDaysBySource(events, tz);

  const allDays = new Set<string>();
  for (const days of bySource.values()) {
    for (const day of days) {
      allDays.add(day);
    }
  }

  const by_source: Record<string, StreakInfo> = {};
  for (const source of Array.from(bySource.keys()).sort((a, b) => a.localeCompare(b))) {
    by_source[source] = streakInfoFor(bySource.get(source)!, today);
  }

  return {
    today,
    overall: streakInfoFor(allDays, today),
    by_source,
  };
}

/** Month-day strings ("MM-DD") that count as "on this day" for `today`. */
function onThisDayMonthDays(today: string): string[] {
  const monthDay = today.slice(5);
  if (monthDay === "02-28" && !isLeapYear(Number(today.slice(0, 4)))) {
    // Feb 28 in a non-leap year also covers Feb 29 of earlier leap years.
    return ["02-28", "02-29"];
  }
  return [monthDay];
}

/**
 * Pure "On this day" computation: events whose local month and day match
 * `today`'s, in earlier years only. Same title+source in one year merges into a
 * single item (first `started_at`), so repeated sessions of one title appear
 * once. Within a year items are ordered by `started_at` ascending and capped at
 * {@link ON_THIS_DAY_MAX_PER_YEAR}; years are returned newest first.
 */
export function computeOnThisDay(
  events: readonly ConsumptionEvent[],
  tz: string,
  today: string
): OnThisDayResult {
  const currentYear = Number(today.slice(0, 4));
  const monthDays = onThisDayMonthDays(today);

  // year -> merged key -> item, with insertion order kept per started_at.
  const byYear = new Map<number, Map<string, OnThisDayItem>>();

  const candidates = events
    .filter(
      (event) =>
        CONSUMPTION_KINDS.has(event.source_kind) &&
        !isShortform(event) &&
        eventPrecision(event) === "day"
    )
    .map((event) => ({
      event,
      local: formatLocalParts(event.started_at, tz),
    }))
    .filter(({ local }) => {
      const year = Number(local.date.slice(0, 4));
      return year < currentYear && monthDays.includes(local.date.slice(5));
    })
    .sort((a, b) => {
      const byTime = a.event.started_at.localeCompare(b.event.started_at);
      return byTime !== 0 ? byTime : a.event.id - b.event.id;
    });

  for (const { event } of candidates) {
    const local = formatLocalParts(event.started_at, tz);
    const year = Number(local.date.slice(0, 4));
    let items = byYear.get(year);
    if (!items) {
      items = new Map<string, OnThisDayItem>();
      byYear.set(year, items);
    }
    const title = getSeriesOrTitle(event);
    // Same title and source on the anniversary merge into one item. For a
    // non-leap Feb 28 both Feb 28 and Feb 29 of an earlier leap year map to
    // the same anniversary, so they merge too.
    const key = `${event.source}:::${title}`;
    if (items.has(key)) {
      continue;
    }
    items.set(key, {
      title,
      source: event.source,
      media_type: event.media_type ?? null,
      started_at: event.started_at,
      cover_url: coverUrlFor(event),
    });
  }

  const years: OnThisDayYear[] = Array.from(byYear.keys())
    .sort((a, b) => b - a)
    .map((year) => ({
      year,
      years_ago: currentYear - year,
      items: Array.from(byYear.get(year)!.values())
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
        .slice(0, ON_THIS_DAY_MAX_PER_YEAR),
    }));

  return { date: today, years };
}

// --- Database wrapper -------------------------------------------------------

export interface GetInsightsOptions {
  tz: string;
  today: string;
  source?: string;
  categoryFilter?: CategoryFilter;
}

/**
 * Reads consumption events through `getLatestConsumptionEvents` (never the
 * `events` table) and computes both insights for the given "today".
 */
export function getInsights(
  db: Database,
  opts: GetInsightsOptions
): InsightsResult {
  let events = getDisplayConsumptionEvents(db, opts.source, opts.tz);
  if (opts.categoryFilter) {
    events = events.filter((e) =>
      matchesCategoryFilter(categoryOf(e), opts.categoryFilter)
    );
  }
  return {
    streaks: computeStreaks(events, opts.tz, opts.today),
    on_this_day: computeOnThisDay(events, opts.tz, opts.today),
  };
}
