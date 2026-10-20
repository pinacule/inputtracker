import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  Category,
  LibraryWork,
} from "../api";
import type { OpenArchiveOptions } from "../lib/archive-form";
import { categoryPluralLabel } from "../lib/categories";
import { formatMinutes } from "../lib/stats";
import {
  buildArchiveEntryLookup,
  buildHomeCategoryChipTotals,
  buildHomeDayDetailModel,
  buildHomeHash,
  buildLibraryWorkLookup,
  buildMonthModels,
  filterAndEnrichCalendarDays,
  getTodayLocalDate,
  isValidDateStr,
  resolveHomeSelection,
} from "../lib/home";
import { completeHistoryStart } from "../lib/data-completeness";
import { buildRollingGraphModel, clampWindowEnd, rollingWindowDates, shiftWindowEnd } from "../lib/home-norm";
import {
  fetchHomePageBundle,
  type HomePageBundle,
} from "../lib/home-data";
import {
  applyWorkOverridesToList,
  subscribeWorkEdits,
} from "../lib/work-edits";
import {
  Button,
  Skeleton,
} from "../ui";
import {
  DayDetailPanel,
  CategoryIndex,
  MonthRhythmCard,
  WeekGraph,
} from "../ui/home";

/** Props the app shell passes to the home page (`#/calendar`). Keep or extend as needed. */
export interface CalendarProps {
  /** `?date=YYYY-MM-DD`: the day to select. */
  date?: string;
  /** `?month=YYYY-MM`: the month to show. */
  initialMonth?: string;
  initialCategory?: Category;
  initialCategories?: readonly Category[];
  includeYoutubeInAll?: boolean;
  onOpenAdd?: (prefill?: OpenArchiveOptions) => void;
  onOpenEditWork?: (work: LibraryWork) => void;
}

/** An editorial spread: selected-day headline, seven-day ledger, full-width month. */
export function Calendar({
  date,
  initialMonth,
  initialCategory,
  initialCategories,
  onOpenAdd,
}: CalendarProps) {
  const todayStr = useMemo(() => getTodayLocalDate(), []);

  const initialResolved = useMemo(
    () => resolveHomeSelection({ date, initialMonth }, todayStr),
    [date, initialMonth, todayStr]
  );

  const [currentMonth, setCurrentMonth] = useState<string>(() =>
    clampWindowEnd(initialResolved.selectedDate, todayStr).slice(0, 7)
  );
  const [selectedDate, setSelectedDate] = useState<string>(
    clampWindowEnd(initialResolved.selectedDate, todayStr)
  );
  const [windowEnd, setWindowEnd] = useState(() => clampWindowEnd(initialResolved.selectedDate, todayStr));
  const [explicitDate, setExplicitDate] = useState<boolean>(
    initialResolved.explicitDate
  );

  const [selectedCategories, setSelectedCategories] = useState<Category[]>(
    () => {
      if (initialCategories && initialCategories.length > 0) {
        return [...initialCategories];
      }
      if (initialCategory) {
        return [initialCategory];
      }
      return [];
    }
  );

  const [bundle, setBundle] = useState<HomePageBundle | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [overrideTick, setOverrideTick] = useState<number>(0);

  // Subscribe to optimistic work edits / quick ratings / hides
  useEffect(() => {
    return subscribeWorkEdits(() => setOverrideTick((t) => t + 1));
  }, []);

  // Sync state when route props (`?date=`, `?month=`, `?cat=`) change externally
  useEffect(() => {
    const resolved = resolveHomeSelection({ date, initialMonth }, todayStr);
    const end = clampWindowEnd(resolved.selectedDate, todayStr);
    setSelectedDate(end);
    setWindowEnd(end);
    setCurrentMonth(end.slice(0, 7));
    setExplicitDate(resolved.explicitDate);
  }, [date, initialMonth, todayStr]);

  useEffect(() => {
    if (initialCategories !== undefined) {
      setSelectedCategories([...initialCategories]);
    } else if (initialCategory !== undefined) {
      setSelectedCategories(initialCategory ? [initialCategory] : []);
    }
  }, [initialCategory, initialCategories]);

  // Fetch once per window/filter, not for every pill tap.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchHomePageBundle(currentMonth, windowEnd, selectedCategories)
      .then((res) => {
        if (cancelled) return;
        setBundle(res);
        setLoading(false);

      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentMonth, windowEnd, selectedCategories, overrideTick]);

  const syncUrlHash = (
    nextDate: string,
    nextMonth: string,
    nextCats: readonly Category[],
    isExplicit: boolean
  ) => {
    if (typeof window === "undefined") return;
    const nextHash = buildHomeHash({
      selectedDate: nextDate,
      currentMonth: nextMonth,
      todayStr,
      selectedCategories: nextCats,
      explicitDate: isExplicit,
    });
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  };

  const handleSelectDate = (nextDate: string) => {
    if (!isValidDateStr(nextDate) || nextDate > todayStr) return;
    const nextMonth = nextDate.slice(0, 7);
    setSelectedDate(nextDate);
    setExplicitDate(true);
    if (!rollingWindowDates(windowEnd).includes(nextDate)) setWindowEnd(nextDate);
    if (nextMonth !== currentMonth) {
      setCurrentMonth(nextMonth);
    }
    syncUrlHash(nextDate, nextMonth, selectedCategories, true);

  };

  const handleStepWindow = (delta: number) => {
    const nextDate = shiftWindowEnd(windowEnd, delta, todayStr);
    const nextMonth = nextDate.slice(0, 7);
    setWindowEnd(nextDate);
    setCurrentMonth(nextMonth);
    setSelectedDate(nextDate);
    setExplicitDate(true);
    syncUrlHash(nextDate, nextMonth, selectedCategories, true);
  };

  const handleJumpToday = () => {
    const todayMonth = todayStr.slice(0, 7);
    setCurrentMonth(todayMonth);
    setSelectedDate(todayStr);
    setWindowEnd(todayStr);
    setExplicitDate(false);
    syncUrlHash(todayStr, todayMonth, selectedCategories, false);
  };

  const handleCategoriesChange = (nextCats: Category[]) => {
    setSelectedCategories(nextCats);
    syncUrlHash(selectedDate, currentMonth, nextCats, explicitDate);
  };

  // Apply optimistic work overrides to library works
  const effectiveWorks = useMemo(
    () => applyWorkOverridesToList(bundle?.libraryWorks ?? []),
    [bundle?.libraryWorks, overrideTick]
  );

  const libraryLookup = useMemo(
    () => buildLibraryWorkLookup(effectiveWorks),
    [effectiveWorks]
  );

  const archiveLookup = useMemo(
    () => buildArchiveEntryLookup(bundle?.archiveEntries ?? []),
    [bundle?.archiveEntries]
  );

  // Unfiltered days (with overrides applied) for category chip totals
  const allEnrichedDays = useMemo(
    () =>
      filterAndEnrichCalendarDays(
        bundle?.days ?? [],
        [],
        libraryLookup
      ),
    [bundle?.days, libraryLookup, overrideTick]
  );

  // Filtered days matching `selectedCategories` (where "All" includes YouTube & Music)
  const filteredDays = useMemo(
    () =>
      selectedCategories.length === 0
        ? allEnrichedDays
        : filterAndEnrichCalendarDays(
            bundle?.days ?? [],
            selectedCategories,
            libraryLookup
          ),
    [bundle?.days, allEnrichedDays, selectedCategories, libraryLookup]
  );

  const unfilteredMonthModels = useMemo(
    () =>
      buildMonthModels({
        month: currentMonth,
        days: allEnrichedDays,
        selectedDate,
        todayStr,
        previousMonthMinutes:
          bundle?.monthReview?.previous_month_minutes ?? null,
      }),
    [
      currentMonth,
      allEnrichedDays,
      selectedDate,
      todayStr,
      bundle?.monthReview?.previous_month_minutes,
    ]
  );

  const monthModels = useMemo(
    () =>
      selectedCategories.length === 0
        ? unfilteredMonthModels
        : buildMonthModels({
            month: currentMonth,
            days: filteredDays,
            selectedDate,
            todayStr,
            previousMonthMinutes: bundle?.monthReview?.previous_month_minutes ?? null,
          }),
    [
      selectedCategories,
      unfilteredMonthModels,
      currentMonth,
      filteredDays,
      selectedDate,
      todayStr,
      bundle?.monthReview,
    ]
  );

  const weekModel = useMemo(
    () =>
      buildRollingGraphModel(
        filteredDays,
        selectedDate,
        windowEnd,
        todayStr,
        bundle?.normSeries.points ?? [],
        completeHistoryStart(bundle?.normSeries.history_start ?? null)
      ),
    [filteredDays, selectedDate, windowEnd, todayStr, bundle?.normSeries]
  );

  const selectedDayData = useMemo(
    () => filteredDays.find((d) => d.date === selectedDate),
    [filteredDays, selectedDate]
  );

  const dayDetailModel = useMemo(
    () =>
      buildHomeDayDetailModel({
        date: selectedDate,
        todayStr,
        day: selectedDayData,
        libraryLookup,
        archiveLookup,
      }),
    [selectedDate, todayStr, selectedDayData, libraryLookup, archiveLookup]
  );

  const chipTotals = useMemo(
    () =>
      buildHomeCategoryChipTotals(
        unfilteredMonthModels.rhythm.categoryShares,
        bundle?.libraryCategories ?? []
      ),
    [unfilteredMonthModels.rhythm.categoryShares, bundle?.libraryCategories]
  );

  const singleSelectedCategory =
    selectedCategories.length === 1 ? selectedCategories[0] : undefined;

  const isViewingToday =
    selectedDate === todayStr && windowEnd === todayStr;

  // The review also includes month-precision entries; the daily skyline never
  // assigns those minutes to an invented day. Both comparison sides use the filter.
  const monthRhythm = useMemo(() => {
    const rhythm = monthModels.rhythm;
    const review = bundle?.monthReview;
    if (!review || review.month !== currentMonth) return rhythm;
    return {
      ...rhythm,
      totalMinutes: review.total_minutes,
      previousMonthMinutes: review.previous_month_minutes,
      undatedMinutes: review.undated_minutes,
      categoryShares: review.categories.filter((c) => c.total_minutes > 0).map((c) => ({
        category: c.category, label: categoryPluralLabel(c.category), totalMinutes: c.total_minutes,
        units: c.units, works: c.works, sharePct: review.total_minutes ? c.total_minutes / review.total_minutes * 100 : 0,
      })),
      deltaLabel: review.total_minutes === review.previous_month_minutes ? "Same as last month"
        : `${formatMinutes(Math.abs(review.total_minutes - review.previous_month_minutes))} ${review.total_minutes > review.previous_month_minutes ? "more" : "less"} than last month`,
    };
  }, [monthModels.rhythm, bundle?.monthReview, currentMonth]);

  return (
    <div class="page-container home-page">
      {/* Magazine masthead; date navigation lives with the respective sections. */}
      <header class="home-topbar">
        <div class="home-month-nav">
          <div>
            <span class="home-kicker">The personal media journal</span>
            <h1 class="home-month-title">Your days<span class="home-title-stop">.</span></h1>
          </div>

          {!isViewingToday && (
            <button
              type="button"
              class="home-today-btn"
              onClick={handleJumpToday}
            >
              Today
            </button>
          )}
        </div>

      </header>

      <CategoryIndex
        selected={selectedCategories}
        onChange={handleCategoriesChange}
        totals={chipTotals}
        availableCategories={unfilteredMonthModels.availableCategories}
      />

      {error && (
        <div class="home-error-banner" role="alert">
          <span>Could not load calendar data: {error}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOverrideTick((t) => t + 1)}
          >
            Retry
          </Button>
        </div>
      )}

      {loading ? (
        <div class="home-workspace home-loading" aria-busy="true" role="status">
          <span class="sr-only">Loading your journal</span>
          <Skeleton height="280px" />
          <Skeleton height="240px" />
        </div>
      ) : !error && bundle ? (
        <div class="home-workspace" aria-busy={loading}>
          <DayDetailPanel
            model={dayDetailModel}
            usualMinutes={weekModel.hasNorms ? weekModel.norms.get(selectedDate) ?? 0 : null}
            singleCategory={singleSelectedCategory}
            onSelectDate={handleSelectDate}
            todayStr={todayStr}
            onOpenAdd={onOpenAdd}
            weekGraph={
              <WeekGraph
                model={weekModel}
                todayStr={todayStr}
                onSelectDate={handleSelectDate}
                onStepWindow={handleStepWindow}
              />
            }
          />
          <MonthRhythmCard
            model={monthRhythm}
            todayStr={todayStr}
            onSelectDate={handleSelectDate}
          />
        </div>
      ) : null}
    </div>
  );
}
