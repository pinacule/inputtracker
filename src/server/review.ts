/**
 * Reviews and time-series charts (v2 section 4):
 * - `GET /api/series` → `SeriesResult`
 * - `GET /api/review/month?month=YYYY-MM` → `MonthReview`
 * - `GET /api/review/year?year=YYYY` → `YearReviewV2`
 *
 * Date precision rules:
 * - Day/week buckets, calendar days, streaks, active days, and hour×weekday
 *   include only `day` precision events.
 * - Month review includes `day` and `month` precision events of that month
 *   (`month` precision also counted in `undated_minutes`).
 * - Year review is built from the 12 months plus `year` precision archive
 *   events (counted in `undated_minutes`); `unknown` precision is excluded.
 */

import type { Database } from "bun:sqlite";
import { CATEGORIES, categoryOf, type Category } from "../core/category.ts";
import type {
  CategoryTotal,
  LibraryWork,
  MonthReview,
  SeriesPoint,
  SeriesResult,
  YearReviewV2,
} from "../core/contract.ts";
import {
  eventPrecision,
  formatLocalParts,
  getDisplayConsumptionEvents,
  getIsoWeek,
  isTimeUncertain,
} from "./aggregate.ts";
import type { DedupedEvent } from "./dedup.ts";
import { computeStreaks } from "./insights.ts";
import { buildAllLibraryWorks, type InternalLibraryWork } from "./library.ts";
import {
  type CategoryFilter,
  type CategoryFilterInput,
  matchesCategoryFilter,
  parseCategoryFilter,
} from "./overrides.ts";

/** Number of days in `YYYY-MM`. */
function daysInMonth(month: string): number {
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Shift `YYYY-MM` by `delta` months. */
function shiftMonthStr(month: string, delta: number): string {
  const [yStr, mStr] = month.split("-");
  const total = Number(yStr) * 12 + (Number(mStr) - 1) + delta;
  const newY = Math.floor(total / 12);
  const newM = (((total % 12) + 12) % 12) + 1;
  return `${String(newY).padStart(4, "0")}-${String(newM).padStart(2, "0")}`;
}

/** Add `delta` days to `"YYYY-MM-DD"`. */
function addDaysStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + delta));
  const ys = String(dt.getUTCFullYear()).padStart(4, "0");
  const ms = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const ds = String(dt.getUTCDate()).padStart(2, "0");
  return `${ys}-${ms}-${ds}`;
}

function enumerateDayBuckets(from: string, to: string): string[] {
  const result: string[] = [];
  let curr = from;
  let guard = 0;
  while (curr <= to && guard < 20_000) {
    result.push(curr);
    curr = addDaysStr(curr, 1);
    guard++;
  }
  return result;
}

function enumerateWeekBuckets(from: string, to: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  let curr = from;
  let guard = 0;
  while (curr <= to && guard < 20_000) {
    const wk = getIsoWeek(curr);
    if (!seen.has(wk)) {
      seen.add(wk);
      result.push(wk);
    }
    curr = addDaysStr(curr, 1);
    guard++;
  }
  return result;
}

function enumerateMonthBuckets(from: string, to: string): string[] {
  const startMonth = from.slice(0, 7);
  const endMonth = to.slice(0, 7);
  const result: string[] = [];
  let curr = startMonth;
  let guard = 0;
  while (curr <= endMonth && guard < 2_400) {
    result.push(curr);
    curr = shiftMonthStr(curr, 1);
    guard++;
  }
  return result;
}

export interface GetSeriesOptions {
  bucket: "day" | "week" | "month";
  from: string;
  to: string;
  category?: CategoryFilterInput;
  exclude?: CategoryFilterInput;
  tz?: string;
}

export function getSeries(
  db: Database,
  opts: GetSeriesOptions
): SeriesResult {
  const tz = opts.tz ?? "Europe/Bratislava";
  const { bucket, from, to } = opts;
  const filter = parseCategoryFilter(opts.category, opts.exclude);
  const events = getDisplayConsumptionEvents(db, undefined, tz);

  const bucketKeys =
    bucket === "day"
      ? enumerateDayBuckets(from, to)
      : bucket === "week"
        ? enumerateWeekBuckets(from, to)
        : enumerateMonthBuckets(from, to);

  const bucketMap = new Map<string, Partial<Record<Category, number>>>();
  for (const key of bucketKeys) {
    bucketMap.set(key, {});
  }

  const fromMonth = from.slice(0, 7);
  const toMonth = to.slice(0, 7);

  for (const ev of events) {
    const precision = eventPrecision(ev);
    if (bucket === "day" || bucket === "week") {
      if (precision !== "day") {
        continue;
      }
    } else {
      if (precision !== "day" && precision !== "month") {
        continue;
      }
    }

    const cat = categoryOf(ev);
    if (!matchesCategoryFilter(cat, filter)) {
      continue;
    }

    const local = formatLocalParts(ev.started_at, tz);
    if (precision === "day") {
      if (local.date < from || local.date > to) {
        continue;
      }
    } else {
      const m = local.date.slice(0, 7);
      if (m < fromMonth || m > toMonth) {
        continue;
      }
    }

    const key =
      bucket === "day"
        ? local.date
        : bucket === "week"
          ? getIsoWeek(local.date)
          : local.date.slice(0, 7);

    let mapEntry = bucketMap.get(key);
    if (!mapEntry) {
      mapEntry = {};
      bucketMap.set(key, mapEntry);
    }
    const mins = (ev.duration_seconds ?? 0) / 60;
    if (mins > 0) {
      mapEntry[cat] = (mapEntry[cat] ?? 0) + mins;
    }
  }

  const points: SeriesPoint[] = bucketKeys.map((bKey) => ({
    bucket: bKey,
    minutes_by_category: bucketMap.get(bKey) ?? {},
  }));

  return {
    bucket,
    from,
    to,
    points,
  };
}

interface IndexedWorkData {
  allWorks: InternalLibraryWork[];
  workByEventId: Map<number, InternalLibraryWork>;
  firstLocalDateByWorkKey: Map<string, string>;
  lastLocalDateByWorkKey: Map<string, string>;
}

function indexLibraryWorks(
  db: Database,
  tz: string,
  filter?: CategoryFilter
): IndexedWorkData {
  const allWorks = buildAllLibraryWorks(db, tz).filter(
    (item) =>
      item.work.status !== "planned" &&
      matchesCategoryFilter(item.work.category, filter)
  );
  const workByEventId = new Map<number, InternalLibraryWork>();
  const firstLocalDateByWorkKey = new Map<string, string>();
  const lastLocalDateByWorkKey = new Map<string, string>();

  for (const item of allWorks) {
    for (const ev of item.events) {
      workByEventId.set(ev.id, item);
      const prec = eventPrecision(ev);
      if (prec === "unknown") {
        continue;
      }
      const localDate = formatLocalParts(ev.started_at, tz).date;
      const prevFirst = firstLocalDateByWorkKey.get(item.work.key);
      if (prevFirst === undefined || localDate < prevFirst) {
        firstLocalDateByWorkKey.set(item.work.key, localDate);
      }
      const prevLast = lastLocalDateByWorkKey.get(item.work.key);
      if (prevLast === undefined || localDate > prevLast) {
        lastLocalDateByWorkKey.set(item.work.key, localDate);
      }
    }
  }

  return {
    allWorks,
    workByEventId,
    firstLocalDateByWorkKey,
    lastLocalDateByWorkKey,
  };
}

function computeMonthMinutes(
  allWorks: readonly InternalLibraryWork[],
  month: string,
  tz: string
): number {
  const prefix = `${month}-`;
  let totalSeconds = 0;
  for (const item of allWorks) {
    for (const ev of item.events) {
      const prec = eventPrecision(ev);
      if (prec !== "day" && prec !== "month") {
        continue;
      }
      const local = formatLocalParts(ev.started_at, tz);
      if (local.date.startsWith(prefix)) {
        totalSeconds += ev.duration_seconds ?? 0;
      }
    }
  }
  return totalSeconds / 60;
}

function computeMonthReviewFromIndexed(
  indexed: IndexedWorkData,
  month: string,
  tz: string
): MonthReview {
  const prefix = `${month}-`;
  const numDays = daysInMonth(month);
  const lastDayStr = `${month}-${String(numDays).padStart(2, "0")}`;

  const dayPointsMap = new Map<string, Partial<Record<Category, number>>>();
  const dayStrings: string[] = [];
  for (let d = 1; d <= numDays; d++) {
    const ds = `${month}-${String(d).padStart(2, "0")}`;
    dayStrings.push(ds);
    dayPointsMap.set(ds, {});
  }

  const hourWeekday: number[][] = Array.from({ length: 24 }, () =>
    Array.from({ length: 7 }, () => 0)
  );

  let totalSeconds = 0;
  let undatedSeconds = 0;
  const dayEvents: DedupedEvent[] = [];

  const catAcc = new Map<
    Category,
    { seconds: number; workKeys: Set<string>; units: number }
  >();
  const workMonthAcc = new Map<
    string,
    { item: InternalLibraryWork; seconds: number; units: number }
  >();

  for (const item of indexed.allWorks) {
    for (const ev of item.events) {
      const prec = eventPrecision(ev);
      if (prec !== "day" && prec !== "month") {
        continue;
      }
      const local = formatLocalParts(ev.started_at, tz);
      if (!local.date.startsWith(prefix)) {
        continue;
      }

      const dur = ev.duration_seconds ?? 0;
      totalSeconds += dur;
      if (prec === "month") {
        undatedSeconds += dur;
      } else {
        dayEvents.push(ev);
        const dayEntry = dayPointsMap.get(local.date);
        if (dayEntry && dur > 0) {
          dayEntry[item.work.category] =
            (dayEntry[item.work.category] ?? 0) + dur / 60;
        }
        if (!isTimeUncertain(ev)) {
          const wIdx = local.weekday - 1; // 0=Mon..6=Sun
          hourWeekday[local.hour]![wIdx]! += dur / 60;
        }
      }

      let cEntry = catAcc.get(item.work.category);
      if (!cEntry) {
        cEntry = { seconds: 0, workKeys: new Set(), units: 0 };
        catAcc.set(item.work.category, cEntry);
      }
      cEntry.seconds += dur;
      cEntry.workKeys.add(item.work.key);
      cEntry.units += 1;

      let wEntry = workMonthAcc.get(item.work.key);
      if (!wEntry) {
        wEntry = { item, seconds: 0, units: 0 };
        workMonthAcc.set(item.work.key, wEntry);
      }
      wEntry.seconds += dur;
      wEntry.units += 1;
    }
  }

  const categories: CategoryTotal[] = [];
  for (const cat of CATEGORIES) {
    const entry = catAcc.get(cat);
    if (entry && entry.units > 0) {
      categories.push({
        category: cat,
        total_minutes: entry.seconds / 60,
        works: entry.workKeys.size,
        units: entry.units,
      });
    }
  }

  const days: SeriesPoint[] = dayStrings.map((ds) => ({
    bucket: ds,
    minutes_by_category: dayPointsMap.get(ds) ?? {},
  }));

  const monthWorks: LibraryWork[] = Array.from(workMonthAcc.values()).map(
    ({ item, seconds, units }) => ({
      ...item.work,
      total_minutes: seconds / 60,
      units,
    })
  );

  const top_works = [...monthWorks]
    .sort(
      (a, b) =>
        b.total_minutes - a.total_minutes ||
        b.units - a.units ||
        a.title.localeCompare(b.title)
    )
    .slice(0, 10);

  const started_works = monthWorks
    .filter((w) => {
      const firstDate = indexed.firstLocalDateByWorkKey.get(w.key);
      return firstDate !== undefined && firstDate.startsWith(prefix);
    })
    .sort(
      (a, b) =>
        (a.first_at ?? "").localeCompare(b.first_at ?? "") ||
        a.title.localeCompare(b.title)
    );

  const finished_works = monthWorks
    .filter((w) => {
      if (w.status !== "finished") return false;
      const lastDate = indexed.lastLocalDateByWorkKey.get(w.key);
      return lastDate !== undefined && lastDate.startsWith(prefix);
    })
    .sort(
      (a, b) =>
        (b.last_at ?? "").localeCompare(a.last_at ?? "") ||
        a.title.localeCompare(b.title)
    );

  const activeDaysSet = new Set<string>();
  for (const ev of dayEvents) {
    activeDaysSet.add(formatLocalParts(ev.started_at, tz).date);
  }
  const streaks = computeStreaks(dayEvents, tz, lastDayStr);

  const prevMonth = shiftMonthStr(month, -1);
  const previousMonthMinutes = computeMonthMinutes(
    indexed.allWorks,
    prevMonth,
    tz
  );

  return {
    month,
    total_minutes: totalSeconds / 60,
    previous_month_minutes: previousMonthMinutes,
    categories,
    days,
    hour_weekday: hourWeekday,
    top_works,
    started_works,
    finished_works,
    active_days: activeDaysSet.size,
    longest_streak_days: streaks.overall.longest,
    undated_minutes: undatedSeconds / 60,
  };
}

export function getMonthReview(
  db: Database,
  month: string,
  tz: string = "Europe/Bratislava",
  filter?: CategoryFilter
): MonthReview {
  const indexed = indexLibraryWorks(db, tz, filter);
  return computeMonthReviewFromIndexed(indexed, month, tz);
}

export function getYearReviewV2(
  db: Database,
  year: number,
  tz: string = "Europe/Bratislava",
  filter?: CategoryFilter
): YearReviewV2 {
  const indexed = indexLibraryWorks(db, tz, filter);
  const yearPrefix = `${year}-`;

  const months: Array<{
    month: string;
    total_minutes: number;
    categories: CategoryTotal[];
  }> = [];

  for (let m = 1; m <= 12; m++) {
    const monthStr = `${year}-${String(m).padStart(2, "0")}`;
    const mr = computeMonthReviewFromIndexed(indexed, monthStr, tz);
    months.push({
      month: monthStr,
      total_minutes: mr.total_minutes,
      categories: mr.categories,
    });
  }

  let undatedSeconds = 0;
  const dayEventsInYear: DedupedEvent[] = [];
  const catAcc = new Map<
    Category,
    { seconds: number; workKeys: Set<string>; units: number }
  >();
  const workYearAcc = new Map<
    string,
    { item: InternalLibraryWork; seconds: number; units: number }
  >();

  for (const item of indexed.allWorks) {
    for (const ev of item.events) {
      const prec = eventPrecision(ev);
      if (prec === "unknown") {
        continue;
      }
      const local = formatLocalParts(ev.started_at, tz);
      if (!local.date.startsWith(yearPrefix)) {
        continue;
      }

      const dur = ev.duration_seconds ?? 0;
      if (prec === "year") {
        undatedSeconds += dur;
      } else if (prec === "day") {
        dayEventsInYear.push(ev);
      }

      let cEntry = catAcc.get(item.work.category);
      if (!cEntry) {
        cEntry = { seconds: 0, workKeys: new Set(), units: 0 };
        catAcc.set(item.work.category, cEntry);
      }
      cEntry.seconds += dur;
      cEntry.workKeys.add(item.work.key);
      cEntry.units += 1;

      let wEntry = workYearAcc.get(item.work.key);
      if (!wEntry) {
        wEntry = { item, seconds: 0, units: 0 };
        workYearAcc.set(item.work.key, wEntry);
      }
      wEntry.seconds += dur;
      wEntry.units += 1;
    }
  }

  const undatedMinutes = undatedSeconds / 60;
  const monthsSumMinutes = months.reduce((sum, m) => sum + m.total_minutes, 0);
  const totalMinutes = monthsSumMinutes + undatedMinutes;

  const categories: CategoryTotal[] = [];
  for (const cat of CATEGORIES) {
    const entry = catAcc.get(cat);
    if (entry && entry.units > 0) {
      categories.push({
        category: cat,
        total_minutes: entry.seconds / 60,
        works: entry.workKeys.size,
        units: entry.units,
      });
    }
  }

  const yearWorks: LibraryWork[] = Array.from(workYearAcc.values()).map(
    ({ item, seconds, units }) => ({
      ...item.work,
      total_minutes: seconds / 60,
      units,
    })
  );

  const top_works = [...yearWorks]
    .sort(
      (a, b) =>
        b.total_minutes - a.total_minutes ||
        b.units - a.units ||
        a.title.localeCompare(b.title)
    )
    .slice(0, 10);

  const finished_works = yearWorks
    .filter((w) => {
      if (w.status !== "finished") return false;
      const lastDate = indexed.lastLocalDateByWorkKey.get(w.key);
      return lastDate !== undefined && lastDate.startsWith(yearPrefix);
    })
    .sort(
      (a, b) =>
        (b.last_at ?? "").localeCompare(a.last_at ?? "") ||
        a.title.localeCompare(b.title)
    );

  const activeDaysSet = new Set<string>();
  for (const ev of dayEventsInYear) {
    activeDaysSet.add(formatLocalParts(ev.started_at, tz).date);
  }
  const streaks = computeStreaks(dayEventsInYear, tz, `${year}-12-31`);

  return {
    year,
    total_minutes: totalMinutes,
    months,
    categories,
    top_works,
    finished_works,
    active_days: activeDaysSet.size,
    longest_streak_days: streaks.overall.longest,
    undated_minutes: undatedMinutes,
  };
}
