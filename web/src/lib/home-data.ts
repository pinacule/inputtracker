/**
 * Data fetching helper for the v2.2 Home Page (`#/calendar`).
 *
 * Fetches and merges:
 * - Calendar days for the active month AND any adjacent month spanned by the
 *   rolling seven-day window (complete on month boundaries).
 * - Library works (`getLibrary`), the 62-day norm history (`getSeries`), and
 *   archive entry summaries (`listArchive`) for work linking, covers, explicit
 *   v2.2 season/episode progress, and quick edit/delete actions.
 * - Optional month review (`getMonthReview`) for previous-month comparison.
 */

import {
  getCalendar,
  getLibrary,
  getMonthReview,
  getSeries,
  listArchive,
  type ArchiveEntrySummary,
  type CalendarDay,
  type Category,
  type CategoryTotal,
  type LibraryWork,
  type MonthReview,
  type SeriesResult,
} from "../api";
import { shiftDateStr } from "./home";
import { rollingWindowDates } from "./home-norm";

export interface HomePageBundle {
  readonly days: CalendarDay[];
  readonly libraryWorks: LibraryWork[];
  readonly libraryCategories: CategoryTotal[];
  readonly normSeries: SeriesResult;
  readonly archiveEntries: ArchiveEntrySummary[];
  readonly monthReview: MonthReview | null;
}

/**
 * Merges `CalendarDay[][]` from one or more months, deduplicating by `day.date`.
 */
export function mergeCalendarMonthDays(
  monthResults: ReadonlyArray<readonly CalendarDay[]>
): CalendarDay[] {
  const byDate = new Map<string, CalendarDay>();
  for (const list of monthResults) {
    for (const day of list) {
      if (!byDate.has(day.date)) {
        byDate.set(day.date, day);
      }
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetches all data needed for the Home page in parallel, degrading gracefully
 * if secondary endpoints fail.
 */
export async function fetchHomePageBundle(
  currentMonth: string,
  windowEnd: string,
  categories: readonly Category[] = []
): Promise<HomePageBundle> {
  const monthsToFetch = [...new Set([currentMonth, ...rollingWindowDates(windowEnd).map((d) => d.slice(0, 7))])];

  const calendarPromises = monthsToFetch.map((m) =>
    getCalendar(m).then((res) => res.days ?? [])
  );

  const libraryPromise = getLibrary({ sort: "recent" }).catch(() => ({
    categories: [] as CategoryTotal[],
    works: [] as LibraryWork[],
    total_minutes: 0,
  }));

  // Include eight full preceding weeks for the earliest pill, not just the last.
  const normPromise = getSeries({ bucket: "day", from: shiftDateStr(windowEnd, -62), to: windowEnd,
    category: categories.length ? categories : undefined });

  const archivePromise = listArchive().catch(
    () => [] as ArchiveEntrySummary[]
  );

  const reviewPromise = getMonthReview(currentMonth, { category: categories.length ? categories : undefined }).catch(() => null);

  const [monthDayArrays, libraryRes, normSeries, archiveEntries, monthReview] =
    await Promise.all([
      Promise.all(calendarPromises),
      libraryPromise,
      normPromise,
      archivePromise,
      reviewPromise,
    ]);

  return {
    days: mergeCalendarMonthDays(monthDayArrays),
    libraryWorks: libraryRes.works ?? [],
    libraryCategories: libraryRes.categories ?? [],
    normSeries,
    archiveEntries,
    monthReview,
  };
}
