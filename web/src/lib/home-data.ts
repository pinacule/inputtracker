/**
 * Data fetching helper for the v2.2 Home Page (`#/calendar`).
 *
 * Fetches and merges:
 * - Calendar days for the active month AND any adjacent month spanned by the
 *   selected day's Monday–Sunday week (so "This week" is complete on month boundaries).
 * - Library works (`getLibrary`), progress fractions (`getProgress`), and
 *   archive entry summaries (`listArchive`) for work linking, covers, explicit
 *   v2.2 season/episode progress, and quick edit/delete actions.
 * - Optional month review (`getMonthReview`) for previous-month comparison.
 */

import {
  getCalendar,
  getLibrary,
  getMonthReview,
  getProgress,
  listArchive,
  type ArchiveEntrySummary,
  type CalendarDay,
  type CategoryTotal,
  type LibraryWork,
  type MonthReview,
  type ProgressItem,
} from "../api";
import { getRequiredMonthsForView } from "./home";

export interface HomePageBundle {
  readonly days: CalendarDay[];
  readonly libraryWorks: LibraryWork[];
  readonly libraryCategories: CategoryTotal[];
  readonly progressItems: ProgressItem[];
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
  selectedDate: string
): Promise<HomePageBundle> {
  const monthsToFetch = getRequiredMonthsForView(currentMonth, selectedDate);

  const calendarPromises = monthsToFetch.map((m) =>
    getCalendar(m).then((res) => res.days ?? [])
  );

  const libraryPromise = getLibrary({ sort: "recent" }).catch(() => ({
    categories: [] as CategoryTotal[],
    works: [] as LibraryWork[],
    total_minutes: 0,
  }));

  const progressPromise = getProgress()
    .then((res) => res.in_progress ?? [])
    .catch(() => [] as ProgressItem[]);

  const archivePromise = listArchive().catch(
    () => [] as ArchiveEntrySummary[]
  );

  const reviewPromise = getMonthReview(currentMonth).catch(() => null);

  const [monthDayArrays, libraryRes, progressItems, archiveEntries, monthReview] =
    await Promise.all([
      Promise.all(calendarPromises),
      libraryPromise,
      progressPromise,
      archivePromise,
      reviewPromise,
    ]);

  return {
    days: mergeCalendarMonthDays(monthDayArrays),
    libraryWorks: libraryRes.works ?? [],
    libraryCategories: libraryRes.categories ?? [],
    progressItems,
    archiveEntries,
    monthReview,
  };
}
