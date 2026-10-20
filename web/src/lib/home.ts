/**
 * Pure, DOM-free domain logic and visual models for the v2.2 Home Page (`#/calendar`).
 *
 * Design principles:
 * - Phone-first ("Today & This week" immediately visible), desktop two-column studio.
 * - Graphs over numbers: 7-day Week Stacked Bar Graph, 31-day Month Skyline Graph,
 *   proportional Category Share bars, and heat-washed Month Calendar Grid.
 * - Covers only where they carry meaning (real cover URLs on the Day Detail & In-Progress
 *   shelf; never bloated with fake letter-tile covers when `cover_url` is absent).
 * - YouTube and music belong on the home page and calendar ("All" includes both),
 *   but YouTube collapses into one calm expandable line per day ("12 videos · 48m"),
 *   and multiple music plays collapse cleanly as well.
 * - Ratings are hidden for music (`isRateableCategory("music") === false`).
 * - Day headings are plain words ("Today", "Yesterday", "Saturday 17 October") with
 *   no duplicate numeric date above them.
 */

import type {
  ArchiveConsumed,
  ArchiveEntrySummary,
  ArchiveWhen,
  CalendarDay,
  CalendarItem,
  Category,
  CategoryTotal,
  LibraryWork,
  ManualWork,
  ProgressItem,
  WorkStatus,
} from "../api";
import { buildMonthGrid, formatDuration, formatSeasonEpisode, shiftMonth } from "./calendar";
import {
  CATEGORIES,
  categoryPluralLabel,
  formatCategoryUnits,
  isCategory,
  resolveItemCategory,
} from "./categories";
import { DEFAULT_TIMEZONE, formatCleanDayHeading } from "./format-date";
import { formatMinutes, formatMinutesShort } from "./stats";
import { computeDayIntensity, type IntensityLevel } from "./ui-helpers";
import { getWorkOverride, getWorkRatingOverride } from "./work-edits";

export { formatCleanDayHeading, shiftMonth };

const MONTH_FULL_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTH_SHORT_NAMES = [
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

const WEEKDAY_SHORT_MON_FIRST = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

const WEEKDAY_LETTER_MON_FIRST = ["M", "T", "W", "T", "F", "S", "S"] as const;

// --- 1. Date, Week, and Month Pure Helpers ---------------------------------

/**
 * Formats a `Date` as a local `"YYYY-MM-DD"` string in the configured timezone
 * (`Europe/Bratislava` by default).
 */
export function getTodayLocalDate(
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    let y = "";
    let m = "";
    let d = "";
    for (const part of parts) {
      if (part.type === "year") y = part.value;
      if (part.type === "month") m = part.value;
      if (part.type === "day") d = part.value;
    }
    if (/^\d{4}$/.test(y) && /^\d{2}$/.test(m) && /^\d{2}$/.test(d)) {
      return `${y}-${m}-${d}`;
    }
  } catch {
    // Fallback to UTC components if timezone is invalid in test environment.
  }
  const y = String(now.getUTCFullYear()).padStart(4, "0");
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidDateStr(value: string | undefined | null): value is string {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map((n) => Number.parseInt(n, 10));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m! - 1 &&
    dt.getUTCDate() === d
  );
}

export function isValidMonthStr(value: string | undefined | null): value is string {
  return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value));
}

/**
 * Shifts a local `"YYYY-MM-DD"` date string by `deltaDays` without timezone drift.
 */
export function shiftDateStr(dateStr: string, deltaDays: number): string {
  if (!isValidDateStr(dateStr)) {
    return dateStr;
  }
  const y = Number.parseInt(dateStr.slice(0, 4), 10);
  const m = Number.parseInt(dateStr.slice(5, 7), 10);
  const d = Number.parseInt(dateStr.slice(8, 10), 10);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yOut = String(dt.getUTCFullYear()).padStart(4, "0");
  const mOut = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dOut = String(dt.getUTCDate()).padStart(2, "0");
  return `${yOut}-${mOut}-${dOut}`;
}

/**
 * Returns the number of days in a `"YYYY-MM"` month.
 */
export function getDaysInMonth(monthStr: string): number {
  if (!isValidMonthStr(monthStr)) {
    return 30;
  }
  const y = Number.parseInt(monthStr.slice(0, 4), 10);
  const m = Number.parseInt(monthStr.slice(5, 7), 10);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Formats `"YYYY-MM"` into a clean literary heading:
 * - `"October 2026"`
 */
export function formatMonthHeading(monthStr: string): string {
  if (!isValidMonthStr(monthStr)) {
    return monthStr;
  }
  const y = Number.parseInt(monthStr.slice(0, 4), 10);
  const m = Number.parseInt(monthStr.slice(5, 7), 10);
  return `${MONTH_FULL_NAMES[m - 1] ?? ""} ${y}`;
}

/**
 * Returns the 7 `"YYYY-MM-DD"` dates (Monday .. Sunday) of the week containing `dateStr`.
 */
export function getWeekDatesForDay(dateStr: string): string[] {
  if (!isValidDateStr(dateStr)) {
    return [];
  }
  const y = Number.parseInt(dateStr.slice(0, 4), 10);
  const m = Number.parseInt(dateStr.slice(5, 7), 10);
  const d = Number.parseInt(dateStr.slice(8, 10), 10);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const monOffset = (dt.getUTCDay() + 6) % 7; // 0 = Mon .. 6 = Sun
  const mondayStr = shiftDateStr(dateStr, -monOffset);
  return Array.from({ length: 7 }, (_, idx) => shiftDateStr(mondayStr, idx));
}

/**
 * Returns the unique `"YYYY-MM"` months needed to cover both `currentMonth`
 * and the 7-day week around `selectedDate` (at most 2 months).
 */
export function getRequiredMonthsForView(
  currentMonth: string,
  selectedDate: string
): string[] {
  const months = new Set<string>();
  if (isValidMonthStr(currentMonth)) {
    months.add(currentMonth);
  }
  const weekDates = getWeekDatesForDay(selectedDate);
  for (const d of weekDates) {
    const m = d.slice(0, 7);
    if (isValidMonthStr(m)) {
      months.add(m);
    }
  }
  return [...months];
}

export interface ResolvedHomeSelection {
  readonly month: string;
  readonly selectedDate: string;
  readonly explicitDate: boolean;
}

/**
 * Resolves the active `month` and `selectedDate` from route props (`date`, `initialMonth`)
 * and `todayStr`.
 */
export function resolveHomeSelection(
  props: { date?: string; initialMonth?: string },
  todayStr: string
): ResolvedHomeSelection {
  if (isValidDateStr(props.date)) {
    const month = isValidMonthStr(props.initialMonth)
      ? props.initialMonth
      : props.date.slice(0, 7);
    return {
      month,
      selectedDate: props.date,
      explicitDate: true,
    };
  }

  if (isValidMonthStr(props.initialMonth)) {
    const month = props.initialMonth;
    if (todayStr.startsWith(month)) {
      return { month, selectedDate: todayStr, explicitDate: false };
    }
    return {
      month,
      selectedDate: `${month}-01`,
      explicitDate: false,
    };
  }

  const fallbackMonth = isValidDateStr(todayStr)
    ? todayStr.slice(0, 7)
    : "2026-10";
  const fallbackDate = isValidDateStr(todayStr) ? todayStr : "2026-10-18";
  return {
    month: fallbackMonth,
    selectedDate: fallbackDate,
    explicitDate: false,
  };
}

/**
 * When viewing a past/future month without an explicit `?date=`, picks the most
 * recent active day in that month so the Day Detail panel shows meaningful activity
 * immediately; falls back to `${month}-01` when the month is empty.
 */
export function pickDefaultDayForMonth(
  month: string,
  days: readonly CalendarDay[],
  todayStr: string
): string {
  if (todayStr.startsWith(month)) {
    return todayStr;
  }
  const activeInMonth = days
    .filter(
      (d) =>
        d.date.startsWith(month) &&
        ((d.minutes ?? 0) > 0 || (d.count ?? 0) > 0 || (d.items?.length ?? 0) > 0)
    )
    .map((d) => d.date)
    .sort();
  if (activeInMonth.length > 0) {
    return activeInMonth[activeInMonth.length - 1]!;
  }
  return `${month}-01`;
}

/**
 * Builds the canonical `#/calendar` hash preserving `date`, `month`, and `cat` filters.
 */
export function buildHomeHash(params: {
  selectedDate: string;
  currentMonth: string;
  todayStr: string;
  selectedCategories: readonly Category[];
  explicitDate?: boolean;
}): string {
  const search = new URLSearchParams();
  const { selectedDate, currentMonth, todayStr, selectedCategories, explicitDate } =
    params;

  if (explicitDate || selectedDate !== todayStr) {
    search.set("date", selectedDate);
  }
  if (
    currentMonth !== selectedDate.slice(0, 7) ||
    (!search.has("date") && currentMonth !== todayStr.slice(0, 7))
  ) {
    search.set("month", currentMonth);
  }
  if (selectedCategories.length > 0) {
    search.set("cat", selectedCategories.join(","));
  }
  const qs = search.toString();
  return qs ? `#/calendar?${qs}` : "#/calendar";
}

/**
 * Keyboard navigation inside the month grid:
 * - `ArrowLeft` / `ArrowRight`: ±1 day
 * - `ArrowUp` / `ArrowDown`: ±7 days
 * - `Home` / `End`: Monday / Sunday of the current week
 * - `PageUp` / `PageDown`: same day number in previous / next month (clamped)
 */
export function stepCalendarDateByKey(
  selectedDate: string,
  key: string
): string | null {
  if (!isValidDateStr(selectedDate)) {
    return null;
  }
  switch (key) {
    case "ArrowLeft":
      return shiftDateStr(selectedDate, -1);
    case "ArrowRight":
      return shiftDateStr(selectedDate, 1);
    case "ArrowUp":
      return shiftDateStr(selectedDate, -7);
    case "ArrowDown":
      return shiftDateStr(selectedDate, 7);
    case "Home": {
      const week = getWeekDatesForDay(selectedDate);
      return week[0] ?? null;
    }
    case "End": {
      const week = getWeekDatesForDay(selectedDate);
      return week[6] ?? null;
    }
    case "PageUp":
    case "PageDown": {
      const delta = key === "PageUp" ? -1 : 1;
      const targetMonth = shiftMonth(selectedDate.slice(0, 7), delta);
      const dayNum = Number.parseInt(selectedDate.slice(8, 10), 10);
      const maxDay = getDaysInMonth(targetMonth);
      const clampedDay = String(Math.min(dayNum, maxDay)).padStart(2, "0");
      return `${targetMonth}-${clampedDay}`;
    }
    default:
      return null;
  }
}

// --- 2. Category Rules (v2.2 Section 15: YouTube & Music Included) ---------

/**
 * Per v2.2 spec section 15:
 * - YouTube and music appear on the Home page / Calendar in "All" by default.
 * - Ratings are hidden for music (`category !== "music"`).
 */
export function isRateableCategory(category: Category): boolean {
  return category !== "music";
}

/**
 * Matches an item's category against the Home page's selected category chips.
 * Unlike Library "All", Home "All" (`selected.length === 0`) includes EVERY
 * category (including YouTube and music).
 */
export function matchesHomeCategory(
  category: Category,
  selected: readonly Category[]
): boolean {
  if (selected.length === 0) {
    return true;
  }
  return selected.includes(category);
}

/**
 * Resolves the work title for a calendar item, grouping episodes under their
 * series/anime/podcast name when `parent_title` is a series name.
 */
export function resolveHomeItemWorkTitle(item: CalendarItem): string {
  const cat = resolveItemCategory(item);
  if (
    (cat === "anime" ||
      cat === "series" ||
      cat === "podcast" ||
      item.media_type === "episode") &&
    item.parent_title &&
    item.parent_title.trim() !== ""
  ) {
    return item.parent_title.trim();
  }
  return (item.title ?? item.parent_title ?? "Untitled").trim() || "Untitled";
}

/**
 * Filters a list of `CalendarDay`s by the active `selectedCategories` and applies
 * any in-memory optimistic work edits (category overrides, title overrides, hidden works).
 */
export function filterAndEnrichCalendarDays(
  days: readonly CalendarDay[],
  selectedCategories: readonly Category[],
  libraryLookup?: ReadonlyMap<string, LibraryWork>
): CalendarDay[] {
  const result: CalendarDay[] = [];

  for (const day of days) {
    const rawItems = day.items ?? [];
    if (rawItems.length === 0) {
      if (selectedCategories.length === 0 && (day.minutes > 0 || day.count > 0)) {
        result.push(day);
      } else {
        result.push({
          date: day.date,
          count: 0,
          minutes: 0,
          items: [],
        });
      }
      continue;
    }

    const keptItems: CalendarItem[] = [];
    let totalSeconds = 0;

    for (const rawItem of rawItems) {
      const baseCat = resolveItemCategory(rawItem);
      const baseTitle = resolveHomeItemWorkTitle(rawItem);
      const lookupKey = `${baseCat}:${baseTitle.toLowerCase()}`;
      const matchedWork = baseCat === "shortform" ? undefined :
        libraryLookup?.get(lookupKey) ??
        libraryLookup?.get(`title:${baseTitle.toLowerCase()}`);

      const override = baseCat === "shortform" ? undefined : matchedWork
        ? getWorkOverride(matchedWork.key)
        : getWorkOverride(lookupKey);

      if (override?.hidden === true) {
        continue;
      }

      const effectiveCat: Category =
        override?.category && isCategory(override.category)
          ? override.category
          : matchedWork?.category ?? baseCat;

      if (!matchesHomeCategory(effectiveCat, selectedCategories)) {
        continue;
      }

      const effectiveTitle =
        override?.title && override.title.trim() !== ""
          ? override.title.trim()
          : rawItem.title;

      const enrichedItem: CalendarItem =
        effectiveCat !== rawItem.category || effectiveTitle !== rawItem.title
          ? {
              ...rawItem,
              category: effectiveCat,
              title: effectiveTitle,
            }
          : rawItem.category
            ? rawItem
            : { ...rawItem, category: effectiveCat };

      keptItems.push(enrichedItem);
      if (
        enrichedItem.duration_seconds !== null &&
        enrichedItem.duration_seconds !== undefined &&
        enrichedItem.duration_seconds > 0
      ) {
        totalSeconds += enrichedItem.duration_seconds;
      }
    }

    const computedMinutes =
      totalSeconds > 0
        ? Math.round(totalSeconds / 60)
        : selectedCategories.length === 0 && keptItems.length === rawItems.length
          ? Math.round(day.minutes ?? 0)
          : 0;

    result.push({
      date: day.date,
      count: keptItems.filter((item) => resolveItemCategory(item) !== "shortform").length,
      minutes: computedMinutes,
      items: keptItems,
    });
  }

  return result;
}

// --- 3. Category Segment Proportions ---------------------------------------

export interface CategoryBarSegment {
  readonly category: Category;
  readonly minutes: number;
  readonly count: number;
  /** Percentage `0..100` (sums to ~100 across the bar). */
  readonly sharePct: number;
}

/**
 * Computes proportional category segments for a set of `CalendarItem`s.
 * Uses minutes when any item has duration > 0; falls back to item count when all items are 0m.
 */
export function computeCategorySegmentsFromItems(
  items: readonly CalendarItem[]
): CategoryBarSegment[] {
  if (items.length === 0) {
    return [];
  }

  const byCat = new Map<Category, { seconds: number; count: number }>();
  let totalSeconds = 0;

  for (const item of items) {
    const cat = resolveItemCategory(item);
    const sec =
      item.duration_seconds !== null &&
      item.duration_seconds !== undefined &&
      item.duration_seconds > 0
        ? item.duration_seconds
        : 0;
    totalSeconds += sec;
    const prev = byCat.get(cat);
    if (prev) {
      prev.seconds += sec;
      prev.count += cat === "shortform" ? 0 : 1;
    } else {
      byCat.set(cat, { seconds: sec, count: cat === "shortform" ? 0 : 1 });
    }
  }

  const useSeconds = totalSeconds > 0;
  let totalWeight = 0;
  for (const entry of byCat.values()) {
    totalWeight += useSeconds ? Math.max(60, entry.seconds) : entry.count;
  }

  const segments: CategoryBarSegment[] = [];
  for (const cat of CATEGORIES) {
    const entry = byCat.get(cat);
    if (!entry) continue;
    const weight = useSeconds ? Math.max(60, entry.seconds) : entry.count;
    const sharePct =
      totalWeight > 0 ? Math.round((weight / totalWeight) * 1000) / 10 : 0;
    segments.push({
      category: cat,
      minutes: Math.round(entry.seconds / 60),
      count: entry.count,
      sharePct,
    });
  }

  return segments;
}

// --- 4. Graph 1: 7-Day Week Stacked Bar Graph ------------------------------

export interface WeekDayBar {
  readonly date: string;
  readonly dayOfMonth: number;
  readonly weekdayShort: string;
  readonly weekdayLetter: string;
  readonly isToday: boolean;
  readonly isSelected: boolean;
  readonly isCurrentMonth: boolean;
  readonly totalMinutes: number;
  readonly totalCount: number;
  readonly heightRatio: number;
  readonly durationLabel: string;
  readonly segments: readonly CategoryBarSegment[];
}

export interface WeekGraphModel {
  readonly startDate: string;
  readonly endDate: string;
  readonly heading: string;
  readonly isCurrentWeek: boolean;
  readonly todayMinutes: number;
  readonly weekMinutes: number;
  readonly activeDays: number;
  readonly maxDayMinutes: number;
  readonly days: readonly WeekDayBar[];
}

/**
 * Formats a Monday–Sunday week range into a plain-words heading:
 * - `"This week"` when `todayStr` is inside the week
 * - `"Last week"` when the week immediately precedes `todayStr`'s week
 * - `"5–11 Oct"` or `"28 Sep – 4 Oct"` otherwise
 */
export function formatWeekRangeHeading(
  weekDates: readonly string[],
  todayStr: string
): { heading: string; isCurrentWeek: boolean } {
  if (weekDates.length === 0) {
    return { heading: "This week", isCurrentWeek: true };
  }
  const first = weekDates[0]!;
  const last = weekDates[weekDates.length - 1]!;

  if (weekDates.includes(todayStr)) {
    return { heading: "This week", isCurrentWeek: true };
  }

  const todayWeek = getWeekDatesForDay(todayStr);
  if (todayWeek.length > 0 && shiftDateStr(todayWeek[0]!, -7) === first) {
    return { heading: "Last week", isCurrentWeek: false };
  }

  const m1 = Number.parseInt(first.slice(5, 7), 10) - 1;
  const d1 = Number.parseInt(first.slice(8, 10), 10);
  const m2 = Number.parseInt(last.slice(5, 7), 10) - 1;
  const d2 = Number.parseInt(last.slice(8, 10), 10);
  const y1 = first.slice(0, 4);
  const y2 = last.slice(0, 4);
  const todayYear = todayStr.slice(0, 4);

  const mon1 = MONTH_SHORT_NAMES[m1] ?? "";
  const mon2 = MONTH_SHORT_NAMES[m2] ?? "";

  if (y1 !== y2) {
    return {
      heading: `${d1} ${mon1} ${y1} – ${d2} ${mon2} ${y2}`,
      isCurrentWeek: false,
    };
  }
  const yearSuffix = y1 !== todayYear ? ` ${y1}` : "";
  if (m1 === m2) {
    return {
      heading: `${d1}–${d2} ${mon1}${yearSuffix}`,
      isCurrentWeek: false,
    };
  }
  return {
    heading: `${d1} ${mon1} – ${d2} ${mon2}${yearSuffix}`,
    isCurrentWeek: false,
  };
}

/**
 * Builds the 7-day stacked bar graph model for the week containing `selectedDate`.
 */
export function buildWeekGraphModel(
  allDays: readonly CalendarDay[],
  selectedDate: string,
  todayStr: string,
  currentMonth: string
): WeekGraphModel {
  const weekDates = getWeekDatesForDay(selectedDate);
  const dayMap = new Map<string, CalendarDay>();
  for (const d of allDays) {
    dayMap.set(d.date, d);
  }

  const { heading, isCurrentWeek } = formatWeekRangeHeading(weekDates, todayStr);

  let weekMinutes = 0;
  let activeDays = 0;
  let maxDayMinutes = 0;

  const rawBars = weekDates.map((dateStr, idx) => {
    const dayData = dayMap.get(dateStr);
    const mins = Math.max(0, Math.round(dayData?.minutes ?? 0));
    const count = Math.max(0, dayData?.count ?? 0);
    const segments = computeCategorySegmentsFromItems(dayData?.items ?? []);

    weekMinutes += mins;
    if (mins > 0 || count > 0) {
      activeDays += 1;
    }
    if (mins > maxDayMinutes) {
      maxDayMinutes = mins;
    }

    return {
      dateStr,
      idx,
      mins,
      count,
      segments,
    };
  });

  // Scale bars against the week's busiest day (with a 60m floor so a 15m day looks gentle)
  const scaleCeiling = Math.max(maxDayMinutes, 60);

  const days: WeekDayBar[] = rawBars.map(({ dateStr, idx, mins, count, segments }) => {
    const dayOfMonth = Number.parseInt(dateStr.slice(8, 10), 10);
    const heightRatio =
      mins > 0
        ? Math.max(0.14, Math.min(1, Math.round((mins / scaleCeiling) * 100) / 100))
        : count > 0
          ? 0.16
          : 0;

    const durationLabel =
      mins > 0
        ? formatMinutesShort(mins)
        : count > 0
          ? `${count}`
          : "";

    return {
      date: dateStr,
      dayOfMonth,
      weekdayShort: WEEKDAY_SHORT_MON_FIRST[idx] ?? "",
      weekdayLetter: WEEKDAY_LETTER_MON_FIRST[idx] ?? "",
      isToday: dateStr === todayStr,
      isSelected: dateStr === selectedDate,
      isCurrentMonth: dateStr.startsWith(currentMonth),
      totalMinutes: mins,
      totalCount: count,
      heightRatio,
      durationLabel,
      segments,
    };
  });

  const todayEntry = dayMap.get(todayStr);
  const todayMinutes = Math.max(0, Math.round(todayEntry?.minutes ?? 0));

  return {
    startDate: weekDates[0] ?? selectedDate,
    endDate: weekDates[6] ?? selectedDate,
    heading,
    isCurrentWeek,
    todayMinutes,
    weekMinutes,
    activeDays,
    maxDayMinutes,
    days,
  };
}

// --- 5. Graph 2 & 3: Month Rhythm Skyline & Calm Month Calendar Grid -------

export interface MonthSkylineBar {
  readonly date: string;
  readonly dayOfMonth: number;
  readonly totalMinutes: number;
  readonly totalCount: number;
  readonly heightRatio: number;
  readonly isToday: boolean;
  readonly isSelected: boolean;
  readonly segments: readonly CategoryBarSegment[];
}

export interface MonthCategoryShareItem {
  readonly category: Category;
  readonly label: string;
  readonly totalMinutes: number;
  readonly units: number;
  readonly works: number;
  readonly sharePct: number;
}

export interface MonthRhythmModel {
  readonly month: string;
  readonly heading: string;
  readonly totalMinutes: number;
  readonly activeDays: number;
  readonly daysInMonth: number;
  readonly maxDayMinutes: number;
  readonly previousMonthMinutes: number | null;
  readonly deltaLabel: string | null;
  readonly categoryShares: readonly MonthCategoryShareItem[];
  readonly skyline: readonly MonthSkylineBar[];
}

export interface CalmCellLine {
  readonly key: string;
  readonly label: string;
  readonly metaLabel: string | null;
  readonly category: Category;
  readonly minutes: number;
}

export interface MonthCalendarCellModel {
  readonly date: string;
  readonly dayOfMonth: number;
  readonly inCurrentMonth: boolean;
  readonly isToday: boolean;
  readonly isSelected: boolean;
  readonly totalMinutes: number;
  readonly totalCount: number;
  readonly durationLabel: string;
  readonly intensity: IntensityLevel;
  readonly barWidthRatio: number;
  readonly segments: readonly CategoryBarSegment[];
  readonly calmLines: readonly CalmCellLine[];
  readonly overflowCount: number;
}

/**
 * Builds the calm lines shown inside a desktop calendar cell (max 2 lines):
 * - YouTube items on that day ALWAYS collapse into a single line: `"YouTube"` (`"48m"` or `"6 videos"`),
 *   so 40 short videos never flood a calendar cell with truncated video titles.
 * - Multiple music plays on that day collapse into `"Music"` (`"35m"`), or the track/album title if just 1.
 * - Long-form works (anime, series, film, book, audiobook, podcast) show their deduplicated work title.
 */
export function buildCalmCellLines(
  items: readonly CalendarItem[],
  maxLines = 2
): { lines: CalmCellLine[]; overflowCount: number } {
  if (items.length === 0 || maxLines <= 0) {
    return { lines: [], overflowCount: 0 };
  }

  const workGroups = new Map<
    string,
    { title: string; category: Category; seconds: number; count: number }
  >();
  let ytSeconds = 0;
  let ytCount = 0;
  const musicItems: CalendarItem[] = [];
  let musicSeconds = 0;

  for (const item of items) {
    const cat = resolveItemCategory(item);
    const sec =
      item.duration_seconds !== null &&
      item.duration_seconds !== undefined &&
      item.duration_seconds > 0
        ? item.duration_seconds
        : 0;

    if (cat === "youtube") {
      ytSeconds += sec;
      ytCount += 1;
      continue;
    }

    if (cat === "music") {
      musicItems.push(item);
      musicSeconds += sec;
      continue;
    }

    const title = resolveHomeItemWorkTitle(item);
    const key = `${cat}:${title.toLowerCase()}`;
    const existing = workGroups.get(key);
    if (existing) {
      existing.seconds += sec;
      existing.count += 1;
    } else {
      workGroups.set(key, {
        title,
        category: cat,
        seconds: sec,
        count: 1,
      });
    }
  }

  const candidates: CalmCellLine[] = [];

  for (const [key, g] of workGroups.entries()) {
    const mins = Math.round(g.seconds / 60);
    candidates.push({
      key,
      label: g.title,
      metaLabel: mins > 0 ? formatMinutesShort(mins) : null,
      category: g.category,
      minutes: mins,
    });
  }

  if (musicItems.length === 1) {
    const singleMusic = musicItems[0]!;
    const title = resolveHomeItemWorkTitle(singleMusic);
    const mins = Math.round(musicSeconds / 60);
    candidates.push({
      key: `music:${title.toLowerCase()}`,
      label: title,
      metaLabel: mins > 0 ? formatMinutesShort(mins) : null,
      category: "music",
      minutes: mins,
    });
  } else if (musicItems.length > 1) {
    const mins = Math.round(musicSeconds / 60);
    candidates.push({
      key: "music:__summary__",
      label: "Music",
      metaLabel: mins > 0 ? formatMinutesShort(mins) : `${musicItems.length} plays`,
      category: "music",
      minutes: mins,
    });
  }

  if (ytCount > 0) {
    const mins = Math.round(ytSeconds / 60);
    candidates.push({
      key: "youtube:__summary__",
      label: "YouTube",
      metaLabel:
        mins > 0
          ? formatMinutesShort(mins)
          : `${ytCount} ${ytCount === 1 ? "video" : "videos"}`,
      category: "youtube",
      minutes: mins,
    });
  }

  candidates.sort((a, b) => {
    // Prioritize story/long-form works ahead of aggregated YouTube/Music when tied or close
    const aIsAgg = a.key.endsWith(":__summary__") ? 1 : 0;
    const bIsAgg = b.key.endsWith(":__summary__") ? 1 : 0;
    if (aIsAgg !== bIsAgg && a.minutes > 0 && b.minutes > 0) {
      return aIsAgg - bIsAgg;
    }
    if (b.minutes !== a.minutes) {
      return b.minutes - a.minutes;
    }
    return a.label.localeCompare(b.label);
  });

  const lines = candidates.slice(0, maxLines);
  const overflowCount = Math.max(0, candidates.length - lines.length);

  return { lines, overflowCount };
}

/**
 * Builds both the `MonthRhythmModel` (Category Share + 31-day Skyline Graph)
 * and the 7-column `weeks` grid of `MonthCalendarCellModel`s.
 */
export function buildMonthModels(params: {
  month: string;
  days: readonly CalendarDay[];
  selectedDate: string;
  todayStr: string;
  previousMonthMinutes?: number | null;
}): {
  rhythm: MonthRhythmModel;
  weeks: MonthCalendarCellModel[][];
  availableCategories: Category[];
} {
  const { month, days, selectedDate, todayStr, previousMonthMinutes = null } =
    params;

  const dayMap = new Map<string, CalendarDay>();
  for (const d of days) {
    dayMap.set(d.date, d);
  }

  const daysInMonth = getDaysInMonth(month);
  let totalMinutes = 0;
  let activeDays = 0;
  let maxDayMinutes = 0;

  const catTotals = new Map<
    Category,
    { seconds: number; units: number; works: Set<string> }
  >();

  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const dateStr = `${month}-${String(dayNum).padStart(2, "0")}`;
    const d = dayMap.get(dateStr);
    const mins = Math.max(0, Math.round(d?.minutes ?? 0));
    const count = Math.max(0, d?.count ?? 0);

    totalMinutes += mins;
    if (mins > 0 || count > 0) {
      activeDays += 1;
      if (mins > maxDayMinutes) {
        maxDayMinutes = mins;
      }
    }

    for (const item of d?.items ?? []) {
      const cat = resolveItemCategory(item);
      const sec =
        item.duration_seconds !== null &&
        item.duration_seconds !== undefined &&
        item.duration_seconds > 0
          ? item.duration_seconds
          : 0;
      const workTitle = resolveHomeItemWorkTitle(item).toLowerCase();
      const prev = catTotals.get(cat);
      if (prev) {
        prev.seconds += sec;
        prev.units += cat === "shortform" ? 0 : 1;
        if (cat !== "shortform") prev.works.add(workTitle);
      } else {
        catTotals.set(cat, {
          seconds: sec,
          units: cat === "shortform" ? 0 : 1,
          works: new Set(cat === "shortform" ? [] : [workTitle]),
        });
      }
    }
  }

  // Category share breakdown
  let totalCatWeight = 0;
  const hasTimedCat = [...catTotals.values()].some((c) => c.seconds > 0);
  for (const entry of catTotals.values()) {
    totalCatWeight += hasTimedCat
      ? Math.max(60, entry.seconds)
      : entry.units;
  }

  const categoryShares: MonthCategoryShareItem[] = [];
  const availableCategories: Category[] = [];

  for (const cat of CATEGORIES) {
    const entry = catTotals.get(cat);
    if (!entry || (entry.seconds <= 0 && entry.units <= 0)) {
      continue;
    }
    availableCategories.push(cat);
    const weight = hasTimedCat ? Math.max(60, entry.seconds) : entry.units;
    const sharePct =
      totalCatWeight > 0
        ? Math.round((weight / totalCatWeight) * 1000) / 10
        : 0;
    categoryShares.push({
      category: cat,
      label: categoryPluralLabel(cat),
      totalMinutes: Math.round(entry.seconds / 60),
      units: entry.units,
      works: entry.works.size,
      sharePct,
    });
  }

  categoryShares.sort((a, b) => {
    if (b.totalMinutes !== a.totalMinutes) return b.totalMinutes - a.totalMinutes;
    return b.units - a.units;
  });

  // 31-day Skyline bars
  const skylineScale = Math.max(maxDayMinutes, 60);
  const skyline: MonthSkylineBar[] = [];
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
    const dateStr = `${month}-${String(dayNum).padStart(2, "0")}`;
    const d = dayMap.get(dateStr);
    const mins = Math.max(0, Math.round(d?.minutes ?? 0));
    const count = Math.max(0, d?.count ?? 0);
    const segments = computeCategorySegmentsFromItems(d?.items ?? []);
    const heightRatio =
      mins > 0
        ? Math.max(0.12, Math.min(1, Math.round((mins / skylineScale) * 100) / 100))
        : count > 0
          ? 0.14
          : 0;

    skyline.push({
      date: dateStr,
      dayOfMonth: dayNum,
      totalMinutes: mins,
      totalCount: count,
      heightRatio,
      isToday: dateStr === todayStr,
      isSelected: dateStr === selectedDate,
      segments,
    });
  }

  let deltaLabel: string | null = null;
  if (
    previousMonthMinutes !== null &&
    previousMonthMinutes > 0 &&
    totalMinutes > 0
  ) {
    const diff = totalMinutes - previousMonthMinutes;
    const absDiff = Math.abs(diff);
    if (absDiff >= 30) {
      const sign = diff > 0 ? "+" : "−";
      deltaLabel = `${sign}${formatMinutesShort(absDiff)} vs last month`;
    }
  }

  // 7-column Month Calendar Grid
  const rawGridWeeks = buildMonthGrid(month);
  const weeks: MonthCalendarCellModel[][] = rawGridWeeks.map((weekRow) =>
    weekRow.map((dateStr) => {
      const inCurrentMonth = dateStr.startsWith(month);
      const dayOfMonth = Number.parseInt(dateStr.slice(8, 10), 10);
      const d = dayMap.get(dateStr);
      const mins = Math.max(0, Math.round(d?.minutes ?? 0));
      const count = Math.max(0, d?.count ?? 0);
      const items = d?.items ?? [];

      const intensity = computeDayIntensity(mins, count, maxDayMinutes);
      const barWidthRatio =
        mins > 0
          ? Math.max(0.24, Math.min(1, Math.round((mins / skylineScale) * 100) / 100))
          : count > 0
            ? 0.28
            : 0;
      const segments = computeCategorySegmentsFromItems(items);
      const { lines, overflowCount } = buildCalmCellLines(items, 2);

      const durationLabel =
        mins > 0
          ? formatMinutesShort(mins)
          : count > 0
            ? `${count}`
            : "";

      return {
        date: dateStr,
        dayOfMonth,
        inCurrentMonth,
        isToday: dateStr === todayStr,
        isSelected: dateStr === selectedDate,
        totalMinutes: mins,
        totalCount: count,
        durationLabel,
        intensity,
        barWidthRatio,
        segments,
        calmLines: lines,
        overflowCount,
      };
    })
  );

  return {
    rhythm: {
      month,
      heading: formatMonthHeading(month),
      totalMinutes,
      activeDays,
      daysInMonth,
      maxDayMinutes,
      previousMonthMinutes,
      deltaLabel,
      categoryShares,
      skyline,
    },
    weeks,
    availableCategories,
  };
}

// --- 6. Selected Day Detail Model (Work-Grouped + Collapsed YouTube/Music) -

export interface HomeDayWorkRow {
  readonly key: string;
  readonly workKey: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly creator: string | null;
  readonly category: Category;
  readonly source: string;
  readonly mediaType: string;
  /** Non-null ONLY when a real cover URL exists; never a synthetic letter tile. */
  readonly coverUrl: string | null;
  readonly totalMinutes: number;
  readonly totalSeconds: number;
  readonly sessionCount: number;
  readonly durationLabel: string;
  readonly barRatio: number;
  readonly rating: number | null;
  readonly status?: WorkStatus;
  /** True for anime, series, film, book, audiobook, podcast, other; false for music. */
  readonly canRate: boolean;
  readonly entryId: string | null;
  readonly archiveConsumed?: ArchiveConsumed;
  readonly archiveWhen?: ArchiveWhen;
  readonly latestLocalTime: string;
  readonly timeUncertain: boolean;
}

export interface HomeYoutubeVideoItem {
  readonly id: number;
  readonly workKey: string;
  readonly title: string;
  readonly channel: string;
  readonly durationSeconds: number;
  readonly durationLabel: string;
  readonly localTime: string;
  readonly rating: number | null;
}

export interface HomeYoutubeChannelGroup {
  readonly channel: string;
  readonly count: number;
  readonly totalMinutes: number;
  readonly totalSeconds: number;
  readonly durationLabel: string;
  readonly barRatio: number;
  readonly videos: readonly HomeYoutubeVideoItem[];
}

export interface HomeYoutubeDayGroup {
  readonly count: number;
  readonly totalMinutes: number;
  readonly totalSeconds: number;
  /** e.g. "12 videos · 48m" or "40 videos · 2h 15m" */
  readonly summaryLabel: string;
  /** Top channels preview, e.g. "Technology Connections, Veritasium +2 more" */
  readonly channelsPreview: string;
  readonly channels: readonly HomeYoutubeChannelGroup[];
}

export interface HomeMusicTrackItem {
  readonly id: number;
  readonly workKey: string;
  readonly title: string;
  readonly artist: string | null;
  readonly coverUrl: string | null;
  readonly durationSeconds: number;
  readonly durationLabel: string;
  readonly localTime: string;
}

export interface HomeMusicDayGroup {
  readonly count: number;
  readonly totalMinutes: number;
  readonly totalSeconds: number;
  /** e.g. "14 plays · 52m" */
  readonly summaryLabel: string;
  readonly artistsPreview: string;
  /** True when there are > 2 music plays on the day, so they collapse to one expandable line. */
  readonly collapsedByDefault: boolean;
  readonly tracks: readonly HomeMusicTrackItem[];
}

export interface HomeDayDetailModel {
  readonly shortformMinutes: number;
  readonly date: string;
  readonly heading: string;
  readonly totalMinutes: number;
  readonly totalCount: number;
  readonly isEmpty: boolean;
  readonly segments: readonly CategoryBarSegment[];
  readonly works: readonly HomeDayWorkRow[];
  readonly youtube: HomeYoutubeDayGroup | null;
  readonly music: HomeMusicDayGroup | null;
}

/**
 * Builds a lookup map from `(category:lowercase_title)` and `(title:lowercase_title)`
 * to `LibraryWork` so day items inherit stable work keys, ratings, creators, and covers.
 */
export function buildLibraryWorkLookup(
  works: readonly LibraryWork[]
): Map<string, LibraryWork> {
  const map = new Map<string, LibraryWork>();
  for (const w of works) {
    const normTitle = w.title.trim().toLowerCase();
    const catKey = `${w.category}:${normTitle}`;
    if (!map.has(catKey)) {
      map.set(catKey, w);
    }
    const titleKey = `title:${normTitle}`;
    if (!map.has(titleKey)) {
      map.set(titleKey, w);
    }
  }
  return map;
}

/**
 * Builds a lookup map from `(category:lowercase_title:date)` or `(category:lowercase_title)`
 * to `ArchiveEntrySummary` so manual archive entries on a day can be edited or deleted.
 */
export function buildArchiveEntryLookup(
  entries: readonly ArchiveEntrySummary[]
): Map<string, ArchiveEntrySummary> {
  const map = new Map<string, ArchiveEntrySummary>();
  for (const entry of entries) {
    const normTitle = entry.title.trim().toLowerCase();
    const catKey = `${entry.category}:${normTitle}`;
    if (!map.has(catKey)) {
      map.set(catKey, entry);
    }
    if (entry.when.date) {
      map.set(`${catKey}:${entry.when.date}`, entry);
    }
  }
  return map;
}

function summarizeWorkItemsSubtitle(
  category: Category,
  workTitle: string,
  creator: string | null,
  items: readonly CalendarItem[]
): string | null {
  if (items.length === 0) return creator;

  if (items.length === 1) {
    const it = items[0]!;
    const se = formatSeasonEpisode(it.season, it.episode);
    const rawTitle = (it.title ?? "").trim();
    const hasDistinctItemTitle =
      rawTitle !== "" && rawTitle.toLowerCase() !== workTitle.toLowerCase();

    if (se && hasDistinctItemTitle) {
      return `${se} · ${rawTitle}`;
    }
    if (se) {
      return creator ? `${se} · ${creator}` : se;
    }
    if (hasDistinctItemTitle) {
      return rawTitle;
    }
    const parent = (it.parent_title ?? "").trim();
    if (parent !== "" && parent.toLowerCase() !== workTitle.toLowerCase()) {
      return parent;
    }
    return creator;
  }

  // Multiple episodes or sessions on the same day
  const withEpisodes = items
    .filter((i) => i.episode !== null && i.episode !== undefined)
    .sort((a, b) => {
      if ((a.season ?? 0) !== (b.season ?? 0)) {
        return (a.season ?? 0) - (b.season ?? 0);
      }
      return (a.episode ?? 0) - (b.episode ?? 0);
    });

  if (withEpisodes.length >= 2) {
    const first = withEpisodes[0]!;
    const last = withEpisodes[withEpisodes.length - 1]!;
    const firstSe = formatSeasonEpisode(first.season, first.episode);
    if (first.season === last.season && first.episode !== last.episode) {
      const epPad = String(last.episode).padStart(2, "0");
      return `${firstSe}–E${epPad} · ${items.length} episodes`;
    }
    const lastSe = formatSeasonEpisode(last.season, last.episode);
    if (firstSe && lastSe && firstSe !== lastSe) {
      return `${firstSe}–${lastSe} · ${items.length} episodes`;
    }
  }

  const withSeasonsOnly = items
    .filter(
      (i) =>
        i.season !== null &&
        i.season !== undefined &&
        (i.episode === null || i.episode === undefined)
    )
    .map((i) => i.season!)
    .sort((a, b) => a - b);

  if (withSeasonsOnly.length >= 2) {
    const uniqueSeasons = [...new Set(withSeasonsOnly)];
    if (uniqueSeasons.length >= 2) {
      return `Seasons ${uniqueSeasons[0]}–${uniqueSeasons[uniqueSeasons.length - 1]}`;
    }
  }

  const unitStr = formatCategoryUnits(category, items.length);
  return creator ? `${creator} · ${unitStr}` : unitStr;
}

/**
 * Builds the complete `HomeDayDetailModel` for the selected calendar date.
 */
export function buildHomeDayDetailModel(params: {
  date: string;
  todayStr: string;
  day: CalendarDay | undefined;
  libraryLookup?: ReadonlyMap<string, LibraryWork>;
  archiveLookup?: ReadonlyMap<string, ArchiveEntrySummary>;
}): HomeDayDetailModel {
  const { date, todayStr, day, libraryLookup, archiveLookup } = params;
  const heading = formatCleanDayHeading(date, todayStr);
  const items = day?.items ?? [];
  const totalMinutes = Math.max(0, Math.round(day?.minutes ?? 0));
  const totalCount = Math.max(0, day?.count ?? items.length);

  if (items.length === 0) {
    return {
      date,
      heading,
      totalMinutes,
      totalCount,
      isEmpty: true,
      segments: [],
      works: [],
      youtube: null,
      music: null,
      shortformMinutes: 0,
    };
  }

  const segments = computeCategorySegmentsFromItems(items);

  // 1. Collect non-YouTube, non-Music works (plus 1-2 Music tracks if few)
  const workMap = new Map<
    string,
    {
      workTitle: string;
      category: Category;
      source: string;
      mediaType: string;
      coverUrl: string | null;
      totalSeconds: number;
      latestLocalTime: string;
      timeUncertain: boolean;
      items: CalendarItem[];
    }
  >();

  const ytItems: CalendarItem[] = [];
  let ytTotalSeconds = 0;

  const musicItems: CalendarItem[] = [];
  let musicTotalSeconds = 0;
  let shortformSeconds = 0;

  for (const item of items) {
    const cat = resolveItemCategory(item);
    const sec =
      item.duration_seconds !== null &&
      item.duration_seconds !== undefined &&
      item.duration_seconds > 0
        ? item.duration_seconds
        : 0;

    if (cat === "shortform") { shortformSeconds += sec; continue; }
    if (cat === "youtube") {
      ytItems.push(item);
      ytTotalSeconds += sec;
      continue;
    }

    if (cat === "music") {
      musicItems.push(item);
      musicTotalSeconds += sec;
      continue;
    }

    const workTitle = resolveHomeItemWorkTitle(item);
    const groupKey = `${cat}:${workTitle.toLowerCase()}`;
    const existing = workMap.get(groupKey);
    if (existing) {
      existing.totalSeconds += sec;
      if (!existing.coverUrl && item.cover_url) {
        existing.coverUrl = item.cover_url;
      }
      if (item.local_time && item.local_time > existing.latestLocalTime) {
        existing.latestLocalTime = item.local_time;
      }
      if (item.time_uncertain) {
        existing.timeUncertain = true;
      }
      existing.items.push(item);
    } else {
      workMap.set(groupKey, {
        workTitle,
        category: cat,
        source: item.source,
        mediaType: item.media_type,
        coverUrl: item.cover_url ?? null,
        totalSeconds: sec,
        latestLocalTime: item.local_time ?? "",
        timeUncertain: Boolean(item.time_uncertain),
        items: [item],
      });
    }
  }

  // If there are only 1 or 2 music plays on the day, should they be in `music` or `works`?
  // Keeping all music in `music` (with `collapsedByDefault: musicItems.length > 2`) OR
  // rendering 1-2 tracks directly as rows without ratings and 3+ as a collapsible drawer
  // makes both 1 album and 30 songs feel natural!

  let maxWorkSeconds = 0;
  for (const g of workMap.values()) {
    if (g.totalSeconds > maxWorkSeconds) {
      maxWorkSeconds = g.totalSeconds;
    }
  }
  const workBarCeiling = Math.max(maxWorkSeconds, 1800);

  const works: HomeDayWorkRow[] = [...workMap.entries()]
    .map(([groupKey, g]) => {
      const matchedWork =
        libraryLookup?.get(groupKey) ??
        libraryLookup?.get(`title:${g.workTitle.toLowerCase()}`);

      const workKey = matchedWork?.key ?? groupKey;
      const effectiveRating = getWorkRatingOverride(
        workKey,
        matchedWork?.rating ?? null
      );
      const coverUrl = g.coverUrl ?? matchedWork?.cover_url ?? null;
      const creator = matchedWork?.creator ?? null;

      const archiveEntry =
        archiveLookup?.get(`${groupKey}:${date}`) ??
        (g.source === "manual" ? archiveLookup?.get(groupKey) : undefined);

      const mins = Math.round(g.totalSeconds / 60);
      const durationLabel =
        g.totalSeconds >= 60
          ? formatMinutes(mins)
          : g.totalSeconds > 0
            ? "<1m"
            : formatCategoryUnits(g.category, g.items.length);

      const barRatio =
        g.totalSeconds > 0
          ? Math.max(
              0.1,
              Math.min(1, Math.round((g.totalSeconds / workBarCeiling) * 100) / 100)
            )
          : 0.12;

      return {
        key: groupKey,
        workKey,
        title: matchedWork?.title ?? g.workTitle,
        subtitle: summarizeWorkItemsSubtitle(
          g.category,
          g.workTitle,
          creator,
          g.items
        ),
        creator,
        category: g.category,
        source: g.source,
        mediaType: g.mediaType,
        coverUrl,
        totalMinutes: mins,
        totalSeconds: g.totalSeconds,
        sessionCount: g.items.length,
        durationLabel,
        barRatio,
        rating: effectiveRating,
        status: matchedWork?.status,
        canRate: isRateableCategory(g.category),
        entryId: archiveEntry?.entry_id ?? null,
        archiveConsumed: archiveEntry?.consumed,
        archiveWhen: archiveEntry?.when,
        latestLocalTime: g.latestLocalTime,
        timeUncertain: g.timeUncertain,
      };
    })
    .sort((a, b) => {
      if (b.totalSeconds !== a.totalSeconds) {
        return b.totalSeconds - a.totalSeconds;
      }
      return a.title.localeCompare(b.title);
    });

  // 2. Build YouTube Day Summary (always 1 calm collapsible line)
  let youtube: HomeYoutubeDayGroup | null = null;
  if (ytItems.length > 0) {
    const channelMap = new Map<
      string,
      { channel: string; seconds: number; videos: HomeYoutubeVideoItem[] }
    >();

    for (const item of ytItems) {
      const channelName = (item.parent_title ?? "YouTube").trim() || "YouTube";
      const videoTitle = (item.title ?? "YouTube video").trim() || "YouTube video";
      const sec =
        item.duration_seconds !== null &&
        item.duration_seconds !== undefined &&
        item.duration_seconds > 0
          ? item.duration_seconds
          : 0;
      const matchedVideoWork =
        libraryLookup?.get(`youtube:${videoTitle.toLowerCase()}`) ??
        libraryLookup?.get(`title:${videoTitle.toLowerCase()}`);
      const videoWorkKey =
        matchedVideoWork?.key ?? `youtube:${videoTitle.toLowerCase()}`;
      const videoRating = getWorkRatingOverride(
        videoWorkKey,
        matchedVideoWork?.rating ?? null
      );

      const videoEntry: HomeYoutubeVideoItem = {
        id: item.id,
        workKey: videoWorkKey,
        title: videoTitle,
        channel: channelName,
        durationSeconds: sec,
        durationLabel: sec >= 60 ? formatMinutes(Math.round(sec / 60)) : sec > 0 ? "<1m" : "watched",
        localTime: item.local_time ?? "",
        rating: videoRating,
      };

      const existingCh = channelMap.get(channelName);
      if (existingCh) {
        existingCh.seconds += sec;
        existingCh.videos.push(videoEntry);
      } else {
        channelMap.set(channelName, {
          channel: channelName,
          seconds: sec,
          videos: [videoEntry],
        });
      }
    }

    const sortedChannels = [...channelMap.values()].sort((a, b) => {
      if (b.seconds !== a.seconds) return b.seconds - a.seconds;
      if (b.videos.length !== a.videos.length) return b.videos.length - a.videos.length;
      return a.channel.localeCompare(b.channel);
    });

    const maxChSeconds = Math.max(
      ...sortedChannels.map((c) => c.seconds),
      600
    );

    const channels: HomeYoutubeChannelGroup[] = sortedChannels.map((c) => {
      const mins = Math.round(c.seconds / 60);
      return {
        channel: c.channel,
        count: c.videos.length,
        totalMinutes: mins,
        totalSeconds: c.seconds,
        durationLabel:
          c.seconds >= 60
            ? formatMinutes(mins)
            : `${c.videos.length} ${c.videos.length === 1 ? "video" : "videos"}`,
        barRatio:
          c.seconds > 0
            ? Math.max(0.12, Math.min(1, Math.round((c.seconds / maxChSeconds) * 100) / 100))
            : Math.min(1, c.videos.length / Math.max(1, ytItems.length)),
        videos: c.videos,
      };
    });

    const ytMinutes = Math.round(ytTotalSeconds / 60);
    const countPart = `${ytItems.length} ${
      ytItems.length === 1 ? "video" : "videos"
    }`;
    const summaryLabel =
      ytTotalSeconds >= 60
        ? `${countPart} · ${formatMinutes(ytMinutes)}`
        : countPart;

    const distinctChannelNames = channels
      .map((c) => c.channel)
      .filter((name) => name !== "YouTube");

    let channelsPreview = "";
    if (distinctChannelNames.length > 0) {
      const topNames = distinctChannelNames.slice(0, 2);
      const rest = distinctChannelNames.length - topNames.length;
      channelsPreview =
        rest > 0 ? `${topNames.join(", ")} +${rest}` : topNames.join(", ");
    } else if (ytItems.length === 1 && ytItems[0]?.title) {
      channelsPreview = ytItems[0].title;
    }

    youtube = {
      count: ytItems.length,
      totalMinutes: ytMinutes,
      totalSeconds: ytTotalSeconds,
      summaryLabel,
      channelsPreview,
      channels,
    };
  }

  // 3. Build Music Day Group (no ratings on music tracks!)
  let music: HomeMusicDayGroup | null = null;
  if (musicItems.length > 0) {
    // Group identical track plays on the same day or keep distinct tracks
    const trackMap = new Map<
      string,
      {
        id: number;
        workKey: string;
        title: string;
        artist: string | null;
        coverUrl: string | null;
        seconds: number;
        localTime: string;
      }
    >();

    for (const item of musicItems) {
      const title = (item.title ?? "Untitled track").trim() || "Untitled track";
      const artist =
        item.parent_title && item.parent_title.trim() !== ""
          ? item.parent_title.trim()
          : null;
      const sec =
        item.duration_seconds !== null &&
        item.duration_seconds !== undefined &&
        item.duration_seconds > 0
          ? item.duration_seconds
          : 0;
      const lookupKey = `music:${title.toLowerCase()}`;
      const matchedWork =
        libraryLookup?.get(lookupKey) ??
        libraryLookup?.get(`title:${title.toLowerCase()}`);
      const workKey = matchedWork?.key ?? lookupKey;
      const effectiveArtist = artist ?? matchedWork?.creator ?? null;
      const effectiveCover = item.cover_url ?? matchedWork?.cover_url ?? null;

      const existing = trackMap.get(lookupKey);
      if (existing) {
        existing.seconds += sec;
        if (!existing.coverUrl && effectiveCover) {
          existing.coverUrl = effectiveCover;
        }
      } else {
        trackMap.set(lookupKey, {
          id: item.id,
          workKey,
          title,
          artist: effectiveArtist,
          coverUrl: effectiveCover,
          seconds: sec,
          localTime: item.local_time ?? "",
        });
      }
    }

    const tracks: HomeMusicTrackItem[] = [...trackMap.values()]
      .sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title))
      .map((t) => ({
        id: t.id,
        workKey: t.workKey,
        title: t.title,
        artist: t.artist,
        coverUrl: t.coverUrl,
        durationSeconds: t.seconds,
        durationLabel:
          t.seconds >= 60
            ? formatMinutes(Math.round(t.seconds / 60))
            : formatDuration(t.seconds),
        localTime: t.localTime,
      }));

    const musicMinutes = Math.round(musicTotalSeconds / 60);
    const countPart = `${musicItems.length} ${
      musicItems.length === 1 ? "play" : "plays"
    }`;
    const summaryLabel =
      musicTotalSeconds >= 60
        ? `${countPart} · ${formatMinutes(musicMinutes)}`
        : countPart;

    const artists = [
      ...new Set(tracks.map((t) => t.artist).filter((a): a is string => Boolean(a))),
    ];
    const topArtists = artists.slice(0, 2);
    const restArtists = artists.length - topArtists.length;
    const artistsPreview =
      topArtists.length > 0
        ? restArtists > 0
          ? `${topArtists.join(", ")} +${restArtists}`
          : topArtists.join(", ")
        : tracks
            .slice(0, 2)
            .map((t) => t.title)
            .join(", ");

    music = {
      count: musicItems.length,
      totalMinutes: musicMinutes,
      totalSeconds: musicTotalSeconds,
      summaryLabel,
      artistsPreview,
      collapsedByDefault: tracks.length > 2,
      tracks,
    };
  }

  return {
    date,
    heading,
    totalMinutes,
    totalCount,
    isEmpty: works.length === 0 && youtube === null && music === null && shortformSeconds === 0,
    segments,
    works,
    youtube,
    music,
    shortformMinutes: shortformSeconds / 60,
  };
}

// --- 7. "In the Middle Of" (In-Progress Works Shelf) -----------------------

export interface HomeInProgressWork {
  readonly key: string;
  readonly title: string;
  readonly creator: string | null;
  readonly category: Category;
  readonly coverUrl: string | null;
  readonly totalMinutes: number;
  readonly durationLabel: string;
  /** Explicit v2.2 progress text, e.g. "2 of 4 seasons · 24 of 48 ep" or "64% · 8h 20m" */
  readonly progressLabel: string;
  /** Progress percentage `0..100` when known, else `null`. */
  readonly progressPercent: number | null;
  readonly rating: number | null;
  readonly canRate: boolean;
  readonly lastAt: string | null;
  readonly manualWorkPrefill: ManualWork;
}

/**
 * Formats explicit v2.2 season/episode progress (`LibraryWork.progress`) or
 * audiobook/book fractional progress into a clear, jargon-free label and percentage.
 */
export function formatHomeWorkProgress(
  work: LibraryWork,
  progressFraction: number | null = null
): { label: string; percent: number | null } {
  const prog = work.progress;
  if (prog) {
    const parts: string[] = [];
    if (prog.seasons_total && prog.seasons_total > 0) {
      parts.push(`${prog.seasons_watched} of ${prog.seasons_total} seasons`);
    } else if (prog.seasons_watched > 0) {
      parts.push(
        `${prog.seasons_watched} ${
          prog.seasons_watched === 1 ? "season" : "seasons"
        }`
      );
    }

    if (prog.episodes_total && prog.episodes_total > 0) {
      parts.push(`${prog.episodes_watched} of ${prog.episodes_total} ep`);
    } else if (prog.episodes_watched > 0) {
      parts.push(`${prog.episodes_watched} ep`);
    }

    let percent: number | null = null;
    if (prog.episodes_total && prog.episodes_total > 0) {
      percent = Math.max(
        0,
        Math.min(100, Math.round((prog.episodes_watched / prog.episodes_total) * 100))
      );
    } else if (prog.seasons_total && prog.seasons_total > 0) {
      percent = Math.max(
        0,
        Math.min(100, Math.round((prog.seasons_watched / prog.seasons_total) * 100))
      );
    }

    if (parts.length > 0) {
      return { label: parts.join(" · "), percent };
    }
  }

  if (
    progressFraction !== null &&
    progressFraction > 0 &&
    progressFraction <= 1
  ) {
    const pct = Math.round(progressFraction * 100);
    const timeStr =
      work.total_minutes > 0 ? ` · ${formatMinutes(work.total_minutes)}` : "";
    return {
      label: `${pct}%${timeStr}`,
      percent: pct,
    };
  }

  if (work.total_minutes > 0) {
    return {
      label: `${formatMinutes(work.total_minutes)} logged`,
      percent: null,
    };
  }

  return {
    label: formatCategoryUnits(work.category, work.units),
    percent: null,
  };
}

/**
 * Builds the "In the middle of" shelf from `LibraryWork[]` and optional `/api/progress` items.
 */
export function buildInProgressShelf(
  works: readonly LibraryWork[],
  selectedCategories: readonly Category[],
  progressItems: readonly ProgressItem[] = [],
  limit = 4
): HomeInProgressWork[] {
  const progressByTitle = new Map<string, number>();
  for (const p of progressItems) {
    if (p.progress !== null && p.progress > 0) {
      const t = (p.group_title || p.title || "").trim().toLowerCase();
      if (t && !progressByTitle.has(t)) {
        progressByTitle.set(t, p.progress);
      }
    }
  }

  const inProgress = works
    .filter((w) => {
      if (w.status !== "in_progress") return false;
      // Leave YouTube videos and single music tracks out: nothing to be in the middle of.
      if (w.category === "youtube" || w.category === "music") return false;
      return matchesHomeCategory(w.category, selectedCategories);
    })
    .sort((a, b) => {
      const aLast = a.last_at ?? "";
      const bLast = b.last_at ?? "";
      if (bLast !== aLast) return bLast.localeCompare(aLast);
      return b.total_minutes - a.total_minutes;
    })
    .slice(0, limit);

  return inProgress.map((w) => {
    const frac = progressByTitle.get(w.title.trim().toLowerCase()) ?? null;
    const { label, percent } = formatHomeWorkProgress(w, frac);
    const nextSeasonNum = (w.progress?.seasons_watched ?? 0) + 1;

    const manualWorkPrefill: ManualWork = {
      provider: "manual",
      category: w.category,
      title: w.title,
      year: null,
      creators: w.creator ? [w.creator] : [],
      seasons:
        w.category === "anime" || w.category === "series"
          ? [
              {
                number: nextSeasonNum,
                title: `Season ${nextSeasonNum}`,
                year: null,
                episodes: 12,
                episode_minutes: 24,
                total_minutes: 288,
                provider_id: null,
              },
            ]
          : [],
      runtime_minutes: w.category === "film" ? 120 : null,
      pages: w.category === "book" ? 300 : null,
    };

    return {
      key: w.key,
      title: w.title,
      creator: w.creator,
      category: w.category,
      coverUrl: w.cover_url,
      totalMinutes: w.total_minutes,
      durationLabel:
        w.total_minutes > 0
          ? formatMinutes(w.total_minutes)
          : formatCategoryUnits(w.category, w.units),
      progressLabel: label,
      progressPercent: percent,
      rating: getWorkRatingOverride(w.key, w.rating),
      canRate: isRateableCategory(w.category),
      lastAt: w.last_at,
      manualWorkPrefill,
    };
  });
}

/**
 * Merges global library category totals with the current month's category totals
 * so `<CategoryChips />` shows every category that has data and displays the
 * current month's hours on each chip.
 */
export function buildHomeCategoryChipTotals(
  monthShares: readonly MonthCategoryShareItem[],
  libraryCategories: readonly CategoryTotal[]
): CategoryTotal[] {
  const monthMap = new Map<Category, MonthCategoryShareItem>();
  for (const s of monthShares) {
    monthMap.set(s.category, s);
  }
  const libMap = new Map<Category, CategoryTotal>();
  for (const c of libraryCategories) {
    libMap.set(c.category, c);
  }

  const result: CategoryTotal[] = [];
  for (const cat of CATEGORIES) {
    const m = monthMap.get(cat);
    const l = libMap.get(cat);
    if (!m && !l) continue;
    result.push({
      category: cat,
      total_minutes: m?.totalMinutes ?? 0,
      works: m?.works ?? (l?.works ? 1 : 0),
      units: m?.units ?? (l?.units ? 1 : 0),
    });
  }
  return result;
}
