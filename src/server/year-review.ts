/**
 * Read-only "Year in review" (Z02): one calendar year of consumption summed
 * up in numbers, plus per-month / per-weekday breakdowns, top titles and
 * channels, highlights and the longest streak inside the year.
 *
 * Rules (same as `insights.ts`):
 * - Events come from `getLatestConsumptionEvents` (reads `events_latest`,
 *   consumption kinds only). The pure function filters by `CONSUMPTION_KINDS`
 *   again so it stays correct for any input.
 * - An event belongs to the year of its **local** date, derived with
 *   `formatLocalParts` exactly like the Calendar/Stats pages bucket events.
 * - Minutes = `duration_seconds / 60` (null -> 0 minutes, still 1 item).
 * - Sources are free strings: never hard-code a list, only report sources
 *   actually present in the events.
 * - The longest streak reuses `computeStreaks` fed only that year's events,
 *   so a run crossing New Year is cut at Jan 1.
 * - Nothing here writes to the database.
 */

import type { Database } from "bun:sqlite";
import {
  CONSUMPTION_KINDS,
  coverUrlFor,
  eventPrecision,
  formatLocalParts,
  getDisplayConsumptionEvents,
  getSeriesOrTitle,
  type ConsumptionEvent,
} from "./aggregate.ts";
import { computeStreaks } from "./insights.ts";
import {
  annotationMapKey,
  getAnnotationsFor,
} from "./annotations.ts";

export interface ReviewTotals {
  items: number;
  minutes: number;
  active_days: number;
  titles: number;
}

export interface ReviewTitle {
  title: string;
  source: string;
  media_type: string | null;
  minutes: number;
  count: number;
  cover_url: string | null;
  /**
   * Latest rating (1–10) for this title, or null when unrated. Always set by
   * `getYearReview` (the pure `computeYearReview` below leaves it null: it
   * does no annotation lookup).
   */
  rating: number | null;
}

/** YouTube events grouped by channel (`parent_title`). */
export interface ReviewChannel {
  name: string;
  count: number;
}

/** One month bucket ("2026-01"), zeros filled for empty months. */
export interface ReviewMonth {
  month: string;
  minutes: number;
  count: number;
}

/** One local day ("YYYY-MM-DD"). */
export interface ReviewDay {
  date: string;
  minutes: number;
  count: number;
}

/** Earliest / latest event of the year. */
export interface ReviewMoment {
  title: string;
  source: string;
  /** UTC ISO as stored. */
  started_at: string;
}

export interface YearReview {
  year: number;
  /** True when `today` is inside this year. */
  partial: boolean;
  /** Whole year (365/366), Jan 1..today when partial, 0 for a future year. */
  days_in_range: number;
  /** Every local year with at least one event, newest first. */
  available_years: number[];
  totals: ReviewTotals;
  /** The year before, null when it has no events. */
  previous: ReviewTotals | null;
  by_source: Record<string, ReviewTotals>;
  by_media_type: Record<string, { items: number; minutes: number }>;
  /** Always 12 entries Jan..Dec, zeros filled. */
  by_month: ReviewMonth[];
  /** Always 7 entries, 1 = Monday .. 7 = Sunday, zeros filled. */
  by_weekday: { weekday: number; minutes: number; count: number }[];
  /** Max 10, by minutes desc, then count desc, then title asc. */
  top_titles: ReviewTitle[];
  /** Max 10, YouTube only, by count desc, then name asc. */
  top_channels: ReviewChannel[];
  /** By minutes, then count; tie -> earliest date. */
  busiest_day: ReviewDay | null;
  /** Same rule as `busiest_day`, null when the year is empty. */
  busiest_month: ReviewMonth | null;
  longest_streak: { days: number; start: string | null; end: string | null };
  first: ReviewMoment | null;
  last: ReviewMoment | null;
}

/** True when `year` is a leap year (Gregorian). */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days from Jan 1 of `year` through `today` (local "YYYY-MM-DD"), inclusive. */
function daysUpTo(today: string, year: number): number {
  const [y, m, d] = today.split("-").map(Number);
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(y!, m! - 1, d!);
  return Math.round((end - start) / 86400000) + 1;
}

/** A consumption event reduced to the fields the year review needs. */
interface PreparedEvent {
  event: ConsumptionEvent;
  /** Local date ("YYYY-MM-DD") in `tz`. */
  date: string;
  /** ISO weekday of the local date, 1 = Monday .. 7 = Sunday. */
  weekday: number;
  /** `getSeriesOrTitle(event)`: series title for episodes, else the title. */
  title: string;
  minutes: number;
  precision: "day" | "month" | "year" | "unknown";
}

function prepareEvents(
  events: readonly ConsumptionEvent[],
  tz: string
): PreparedEvent[] {
  return events
    .filter(
      (event) =>
        CONSUMPTION_KINDS.has(event.source_kind) &&
        eventPrecision(event) !== "unknown"
    )
    .map((event) => {
      const local = formatLocalParts(event.started_at, tz);
      return {
        event,
        date: local.date,
        weekday: local.weekday,
        title: getSeriesOrTitle(event),
        minutes: (event.duration_seconds ?? 0) / 60,
        precision: eventPrecision(event),
      };
    });
}

function computeTotals(rows: readonly PreparedEvent[]): ReviewTotals {
  const days = new Set<string>();
  const titles = new Set<string>();
  let seconds = 0;
  for (const row of rows) {
    if (row.precision === "day") {
      days.add(row.date);
    }
    titles.add(`${row.event.source}:::${row.title}`);
    seconds += row.event.duration_seconds ?? 0;
  }
  return {
    items: rows.length,
    minutes: seconds / 60,
    active_days: days.size,
    titles: titles.size,
  };
}

/** Empty totals for a year with no (countable) events. */
const EMPTY_TOTALS: ReviewTotals = {
  items: 0,
  minutes: 0,
  active_days: 0,
  titles: 0,
};

/**
 * Pure "Year in review" computation. `today` is a local "YYYY-MM-DD"
 * (a parameter so tests are deterministic; the route derives it from the
 * current time in tz). A year after `today`'s year returns the empty result
 * with `partial: false` and `days_in_range: 0`; a year with no events returns
 * zeros, empty lists and nulls. Never throws.
 */
export function computeYearReview(
  events: readonly ConsumptionEvent[],
  tz: string,
  year: number,
  today: string
): YearReview {
  const todayYear = Number(today.slice(0, 4));
  const partial = todayYear === year;
  const future = year > todayYear;
  const daysInRange = future
    ? 0
    : partial
      ? daysUpTo(today, year)
      : isLeapYear(year)
        ? 366
        : 365;

  const prepared = prepareEvents(events, tz);

  const available_years = Array.from(
    new Set(prepared.map((row) => Number(row.date.slice(0, 4))))
  ).sort((a, b) => b - a);

  // A future year is always empty, even if (oddly) future-dated rows exist.
  const yearRows = future
    ? []
    : prepared.filter((row) => row.date.startsWith(`${year}-`));
  const prevRows = prepared.filter((row) =>
    row.date.startsWith(`${year - 1}-`)
  );

  const totals = yearRows.length > 0 ? computeTotals(yearRows) : EMPTY_TOTALS;
  const previous = prevRows.length > 0 ? computeTotals(prevRows) : null;

  const rowsBySource = new Map<string, PreparedEvent[]>();
  const byMediaTypeData: Record<string, { items: number; seconds: number }> = {};
  const byMonthData = new Map<string, { minutes: number; count: number }>();
  const byWeekdayData = new Map<number, { minutes: number; count: number }>();
  const byDayData = new Map<string, { minutes: number; count: number }>();
  const titleGroups = new Map<
    string,
    {
      title: string;
      source: string;
      media_type: string | null;
      seconds: number;
      count: number;
      cover_url: string | null;
    }
  >();
  const channelCounts = new Map<string, number>();

  for (const row of yearRows) {
    const source = row.event.source;
    let sourceRows = rowsBySource.get(source);
    if (!sourceRows) {
      sourceRows = [];
      rowsBySource.set(source, sourceRows);
    }
    sourceRows.push(row);

    const mediaType = byMediaTypeData[row.event.media_type] ?? {
      items: 0,
      seconds: 0,
    };
    mediaType.items += 1;
    mediaType.seconds += row.event.duration_seconds ?? 0;
    byMediaTypeData[row.event.media_type] = mediaType;

    if (row.precision === "day" || row.precision === "month") {
      const monthKey = row.date.slice(0, 7);
      const month = byMonthData.get(monthKey) ?? { minutes: 0, count: 0 };
      month.minutes += row.minutes;
      month.count += 1;
      byMonthData.set(monthKey, month);
    }

    if (row.precision === "day") {
      const weekday = byWeekdayData.get(row.weekday) ?? { minutes: 0, count: 0 };
      weekday.minutes += row.minutes;
      weekday.count += 1;
      byWeekdayData.set(row.weekday, weekday);

      const day = byDayData.get(row.date) ?? { minutes: 0, count: 0 };
      day.minutes += row.minutes;
      day.count += 1;
      byDayData.set(row.date, day);
    }

    const titleKey = `${source}:::${row.title}`;
    const group = titleGroups.get(titleKey);
    if (group) {
      group.seconds += row.event.duration_seconds ?? 0;
      group.count += 1;
    } else {
      titleGroups.set(titleKey, {
        title: row.title,
        source,
        media_type: row.event.media_type ?? null,
        seconds: row.event.duration_seconds ?? 0,
        count: 1,
        cover_url: coverUrlFor(row.event),
      });
    }

    if (source === "youtube") {
      const channel = row.event.parent_title?.trim();
      if (channel) {
        channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
      }
    }
  }

  const by_source: Record<string, ReviewTotals> = {};
  for (const [source, rows] of rowsBySource) {
    by_source[source] = computeTotals(rows);
  }

  const by_media_type: Record<string, { items: number; minutes: number }> = {};
  for (const [mediaType, data] of Object.entries(byMediaTypeData)) {
    by_media_type[mediaType] = { items: data.items, minutes: data.seconds / 60 };
  }

  const by_month: ReviewMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    const data = byMonthData.get(key);
    by_month.push({
      month: key,
      minutes: data?.minutes ?? 0,
      count: data?.count ?? 0,
    });
  }

  const by_weekday: { weekday: number; minutes: number; count: number }[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    const data = byWeekdayData.get(weekday);
    by_weekday.push({
      weekday,
      minutes: data?.minutes ?? 0,
      count: data?.count ?? 0,
    });
  }

  const top_titles: ReviewTitle[] = Array.from(titleGroups.values())
    .map((group) => ({
      title: group.title,
      source: group.source,
      media_type: group.media_type,
      minutes: group.seconds / 60,
      count: group.count,
      // First event with a cover wins; titles without one keep null.
      cover_url: group.cover_url,
      // No annotation lookup here; `getYearReview` fills in the rating.
      rating: null,
    }))
    .sort(
      (a, b) =>
        b.minutes - a.minutes ||
        b.count - a.count ||
        a.title.localeCompare(b.title)
    )
    .slice(0, 10);

  const top_channels: ReviewChannel[] = Array.from(channelCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 10);

  // Ties keep the earliest bucket: strictly-greater over ascending keys.
  let busiest_day: ReviewDay | null = null;
  for (const date of Array.from(byDayData.keys()).sort((a, b) =>
    a.localeCompare(b)
  )) {
    const data = byDayData.get(date)!;
    if (
      busiest_day === null ||
      data.minutes > busiest_day.minutes ||
      (data.minutes === busiest_day.minutes && data.count > busiest_day.count)
    ) {
      busiest_day = { date, minutes: data.minutes, count: data.count };
    }
  }

  let busiest_month: ReviewMonth | null = null;
  for (const month of by_month) {
    // Zero-filled months never count as busiest; an empty year stays null.
    if (month.count === 0 && month.minutes === 0) {
      continue;
    }
    if (
      busiest_month === null ||
      month.minutes > busiest_month.minutes ||
      (month.minutes === busiest_month.minutes &&
        month.count > busiest_month.count)
    ) {
      busiest_month = month;
    }
  }

  // The longest streak inside the year reuses the streak logic; feeding it
  // only this year's events cuts runs that cross New Year at Jan 1.
  const streaks = computeStreaks(
    yearRows.map((row) => row.event),
    tz,
    today
  );

  const sortedRows = [...yearRows].sort(
    (a, b) =>
      a.event.started_at.localeCompare(b.event.started_at) ||
      a.event.id - b.event.id
  );
  const firstRow = sortedRows[0];
  const lastRow = sortedRows[sortedRows.length - 1];
  const toMoment = (row: PreparedEvent): ReviewMoment => ({
    title: row.title,
    source: row.event.source,
    started_at: row.event.started_at,
  });

  return {
    year,
    partial,
    days_in_range: daysInRange,
    available_years,
    totals,
    previous,
    by_source,
    by_media_type,
    by_month,
    by_weekday,
    top_titles,
    top_channels,
    busiest_day,
    busiest_month,
    longest_streak: {
      days: streaks.overall.longest,
      start: streaks.overall.longest_start,
      end: streaks.overall.longest_end,
    },
    first: firstRow ? toMoment(firstRow) : null,
    last: lastRow ? toMoment(lastRow) : null,
  };
}

// --- Database wrapper -------------------------------------------------------

export interface GetYearReviewOptions {
  tz: string;
  year: number;
  today: string;
  source?: string;
}

/**
 * Reads consumption events through `getLatestConsumptionEvents` (never the
 * `events` table) and computes the year review. `source` filters everything,
 * including `available_years`. Top titles carry their latest rating, looked
 * up in one batch query.
 */
export function getYearReview(
  db: Database,
  opts: GetYearReviewOptions
): YearReview {
  const events = getDisplayConsumptionEvents(db, opts.source, opts.tz);
  const review = computeYearReview(events, opts.tz, opts.year, opts.today);

  const annotations = getAnnotationsFor(
    db,
    review.top_titles.map((item) => ({
      source: item.source,
      title: item.title,
    }))
  );
  for (const item of review.top_titles) {
    const annotation = annotations.get(
      annotationMapKey(item.source, item.title)
    );
    item.rating = annotation?.rating ?? null;
  }

  return review;
}
