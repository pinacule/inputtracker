import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  ArchiveConsumed,
  ArchiveWhen,
  Category,
  LibraryWork,
  ManualWork,
} from "../api";
import { toggleCategoryChip } from "../lib/category-filter";
import {
  buildArchiveEntryLookup,
  buildHomeCategoryChipTotals,
  buildHomeDayDetailModel,
  buildHomeHash,
  buildInProgressShelf,
  buildLibraryWorkLookup,
  buildMonthModels,
  buildWeekGraphModel,
  filterAndEnrichCalendarDays,
  formatMonthHeading,
  getTodayLocalDate,
  isValidDateStr,
  isValidMonthStr,
  pickDefaultDayForMonth,
  resolveHomeSelection,
  shiftMonth,
} from "../lib/home";
import {
  fetchHomePageBundle,
  type HomePageBundle,
} from "../lib/home-data";
import {
  applyWorkOverridesToList,
  subscribeWorkEdits,
} from "../lib/work-edits";
import {
  AddIcon,
  Button,
  CategoryChips,
  ChevronLeftIcon,
  ChevronRightIcon,
  IconButton,
  Skeleton,
} from "../ui";
import {
  DayDetailPanel,
  InProgressShelf,
  MonthCalendarGrid,
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
  onOpenAdd?: (prefill?: {
    date?: string;
    category?: Category;
    work?: ManualWork;
    editingEntry?: {
      entry_id: string;
      work: ManualWork;
      consumed: ArchiveConsumed;
      when: ArchiveWhen;
      rating?: number | null;
      note?: string | null;
    };
  }) => void;
  onOpenEditWork?: (work: LibraryWork) => void;
}

/**
 * Home Page (`#/calendar`), designed from scratch for v2.2:
 * - Phone-first flow: This Week's 7-day stacked bar graph and Today's detail
 *   sit immediately at the top on mobile, followed by "In the middle of" and
 *   the Month rhythm & calendar grid.
 * - Desktop two-column studio (`>= 1024px`): Month Rhythm Skyline + 7-column
 *   Calendar Grid + "In the middle of" on the left stage; sticky 7-day Week Graph
 *   + Selected Day Detail inspector on the right without any modal.
 * - Graphs over numbers; covers only where a real cover URL exists; YouTube and
 *   music included in "All" with YouTube collapsed to one expandable line per day
 *   and ratings hidden for music.
 */
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

  const [currentMonth, setCurrentMonth] = useState<string>(
    initialResolved.month
  );
  const [selectedDate, setSelectedDate] = useState<string>(
    initialResolved.selectedDate
  );
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

  const dayPanelRef = useRef<HTMLDivElement>(null);

  // Subscribe to optimistic work edits / quick ratings / hides
  useEffect(() => {
    return subscribeWorkEdits(() => setOverrideTick((t) => t + 1));
  }, []);

  // Sync state when route props (`?date=`, `?month=`, `?cat=`) change externally
  useEffect(() => {
    if (isValidDateStr(date)) {
      setSelectedDate(date);
      setCurrentMonth(
        isValidMonthStr(initialMonth) ? initialMonth : date.slice(0, 7)
      );
      setExplicitDate(true);
    } else if (isValidMonthStr(initialMonth)) {
      setCurrentMonth(initialMonth);
      setSelectedDate(
        todayStr.startsWith(initialMonth) ? todayStr : `${initialMonth}-01`
      );
      setExplicitDate(false);
    }
  }, [date, initialMonth, todayStr]);

  useEffect(() => {
    if (initialCategories !== undefined) {
      setSelectedCategories([...initialCategories]);
    } else if (initialCategory !== undefined) {
      setSelectedCategories(initialCategory ? [initialCategory] : []);
    }
  }, [initialCategory, initialCategories]);

  // Fetch calendar month(s), library works, progress, and archive summaries
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchHomePageBundle(currentMonth, selectedDate)
      .then((res) => {
        if (cancelled) return;
        setBundle(res);
        setLoading(false);

        // When viewing a non-current month without an explicit `?date=`,
        // select the most recent active day in that month so the day panel
        // shows real activity right away.
        if (!explicitDate && !todayStr.startsWith(currentMonth)) {
          const bestDay = pickDefaultDayForMonth(
            currentMonth,
            res.days,
            todayStr
          );
          if (bestDay !== selectedDate) {
            setSelectedDate(bestDay);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentMonth, selectedDate, explicitDate, todayStr]);

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

  const handleSelectDate = (nextDate: string, fromMonthGrid = false) => {
    if (!isValidDateStr(nextDate)) return;
    const nextMonth = nextDate.slice(0, 7);
    setSelectedDate(nextDate);
    setExplicitDate(true);
    if (nextMonth !== currentMonth) {
      setCurrentMonth(nextMonth);
    }
    syncUrlHash(nextDate, nextMonth, selectedCategories, true);

    if (
      fromMonthGrid &&
      typeof window !== "undefined" &&
      window.innerWidth < 1024 &&
      dayPanelRef.current
    ) {
      dayPanelRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  };

  const handleStepMonth = (delta: number) => {
    const nextMonth = shiftMonth(currentMonth, delta);
    const nextDate = todayStr.startsWith(nextMonth)
      ? todayStr
      : `${nextMonth}-01`;
    setCurrentMonth(nextMonth);
    setSelectedDate(nextDate);
    setExplicitDate(false);
    syncUrlHash(nextDate, nextMonth, selectedCategories, false);
  };

  const handleJumpToday = () => {
    const todayMonth = todayStr.slice(0, 7);
    setCurrentMonth(todayMonth);
    setSelectedDate(todayStr);
    setExplicitDate(false);
    syncUrlHash(todayStr, todayMonth, selectedCategories, false);
  };

  const handleCategoriesChange = (nextCats: Category[]) => {
    setSelectedCategories(nextCats);
    syncUrlHash(selectedDate, currentMonth, nextCats, explicitDate);
  };

  const handleToggleSingleCategory = (cat: Category) => {
    const next = toggleCategoryChip(selectedCategories, cat);
    handleCategoriesChange(next);
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
            previousMonthMinutes: null,
          }),
    [
      selectedCategories,
      unfilteredMonthModels,
      currentMonth,
      filteredDays,
      selectedDate,
      todayStr,
    ]
  );

  const weekModel = useMemo(
    () =>
      buildWeekGraphModel(
        filteredDays,
        selectedDate,
        todayStr,
        currentMonth
      ),
    [filteredDays, selectedDate, todayStr, currentMonth]
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

  const inProgressWorks = useMemo(
    () =>
      buildInProgressShelf(
        effectiveWorks,
        selectedCategories,
        bundle?.progressItems ?? [],
        6
      ),
    [effectiveWorks, selectedCategories, bundle?.progressItems]
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
    selectedDate === todayStr && currentMonth === todayStr.slice(0, 7);

  return (
    <div class="page-container home-page">
      {/* Top Bar: Month Picker + Today Jump + Primary Add Action */}
      <header class="home-topbar">
        <div class="home-month-nav">
          <IconButton
            label="Previous month"
            variant="default"
            size="sm"
            onClick={() => handleStepMonth(-1)}
          >
            <ChevronLeftIcon size={17} />
          </IconButton>

          <h1 class="home-month-title">
            {formatMonthHeading(currentMonth)}
          </h1>

          <IconButton
            label="Next month"
            variant="default"
            size="sm"
            onClick={() => handleStepMonth(1)}
          >
            <ChevronRightIcon size={17} />
          </IconButton>

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

        <div class="home-topbar-actions">
          {onOpenAdd && (
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<AddIcon size={16} />}
              onClick={() =>
                onOpenAdd({
                  date: selectedDate,
                  category: singleSelectedCategory,
                })
              }
            >
              Add
            </Button>
          )}
        </div>
      </header>

      {/* Multi-Select Category Filter Bar ("All" includes YouTube & Music) */}
      <div class="home-filter-bar">
        <CategoryChips
          selected={selectedCategories}
          onChange={handleCategoriesChange}
          totals={chipTotals}
          availableCategories={unfilteredMonthModels.availableCategories}
          includeYoutubeInAll={true}
          showCounts="hours"
          syncUrl={false}
          ariaLabel="Filter calendar by category"
        />
      </div>

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

      {loading && !bundle ? (
        <div class="home-workspace" aria-busy="true">
          <div class="home-inspector-col">
            <div class="home-card">
              <Skeleton height="120px" />
            </div>
            <div class="home-card">
              <Skeleton height="220px" />
            </div>
          </div>
          <div class="home-stage-col">
            <div class="home-card">
              <Skeleton height="110px" />
            </div>
            <div class="home-card">
              <Skeleton height="360px" />
            </div>
          </div>
        </div>
      ) : (
        <div class="home-workspace">
          {/* Inspector Column: First on Phone (This Week + Selected Day), Sticky Right on Desktop */}
          <div class="home-inspector-col">
            <WeekGraph
              model={weekModel}
              todayStr={todayStr}
              onSelectDate={(d) => handleSelectDate(d, false)}
            />

            <div ref={dayPanelRef}>
              <DayDetailPanel
                model={dayDetailModel}
                singleCategory={singleSelectedCategory}
                onSelectDate={(d) => handleSelectDate(d, false)}
                onOpenAdd={onOpenAdd}
              />
            </div>
          </div>

          {/* Stage Column: In the Middle Of + Month Rhythm Skyline + 7-Column Calendar Grid */}
          <div class="home-stage-col">
            <InProgressShelf
              works={inProgressWorks}
              selectedDate={selectedDate}
              onOpenAdd={onOpenAdd}
            />

            <MonthRhythmCard
              model={monthModels.rhythm}
              todayStr={todayStr}
              selectedCategories={selectedCategories}
              onSelectDate={(d) => handleSelectDate(d, false)}
              onToggleCategory={handleToggleSingleCategory}
            />

            <MonthCalendarGrid
              monthHeading={monthModels.rhythm.heading}
              weeks={monthModels.weeks}
              todayStr={todayStr}
              onSelectDate={handleSelectDate}
            />
          </div>
        </div>
      )}
    </div>
  );
}
