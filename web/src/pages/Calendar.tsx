import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getCalendar,
  getLibrary,
  type CalendarDay,
  type CalendarResult,
  type Category,
  type LibraryWork,
  type ManualWork,
} from "../api";
import {
  buildMonthGrid,
  formatDuration,
  shiftMonth,
} from "../lib/calendar";
import {
  buildCategoryFilterParams,
  matchesCategorySelection,
} from "../lib/category-filter";
import {
  DEFAULT_TIMEZONE,
  formatCleanDayHeading,
} from "../lib/format-date";
import { formatMinutes } from "../lib/stats";
import {
  categoryCssColor,
  categoryLabel,
  groupDayPanelItems,
  resolveItemCategory,
  summarizeCalendarMonthV2,
  summarizeCurrentWeek,
  summarizeDayCellV2,
} from "../lib/ui-helpers";
import {
  applyWorkOverridesToList,
  subscribeWorkEdits,
} from "../lib/work-edits";
import {
  AddIcon,
  Button,
  Card,
  CategoryChips,
  CategoryShareChart,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  Cover,
  EmptyState,
  IconButton,
  MoreIcon,
  QuickRatingPill,
  Sheet,
  Skeleton,
  Sparkline,
  YoutubeIcon,
  bindContextMenu,
  openContextMenu,
  type EditableWorkTarget,
} from "../ui";

export interface CalendarProps {
  /** Optional date in `YYYY-MM-DD` format to select on mount (`#/calendar?date=...`). */
  date?: string;
  /** Optional month in `YYYY-MM` format. */
  initialMonth?: string;
  /** Optional single category filter (legacy). */
  initialCategory?: Category;
  /** Optional multi-select category filter (`?cat=anime,film`). */
  initialCategories?: readonly Category[];
  /** Whether "All" includes YouTube (default false). */
  includeYoutubeInAll?: boolean;
  /** Callback to open the Add to Archive flow. */
  onOpenAdd?: (opts?: {
    date?: string;
    category?: Category;
    work?: ManualWork;
  }) => void;
  /** Callback to open the Edit Work sheet. */
  onOpenEditWork?: (work: EditableWorkTarget) => void;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function isMobileViewport(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.innerWidth < 768;
}

function getCurrentMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatMonthTitle(month: string): string {
  const [yStr, mStr] = month.split("-");
  const y = parseInt(yStr ?? "2026", 10);
  const m = parseInt(mStr ?? "1", 10);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

interface DayDetailContentProps {
  dateStr: string;
  todayStr: string;
  day: CalendarDay | undefined;
  workLookup: ReadonlyMap<string, LibraryWork>;
  onClose?: () => void;
  onOpenAdd?: (opts?: {
    date?: string;
    category?: Category;
    work?: ManualWork;
  }) => void;
  showHeader?: boolean;
}

function DayDetailContent({
  dateStr,
  todayStr,
  day,
  workLookup,
  onClose,
  onOpenAdd,
  showHeader = true,
}: DayDetailContentProps) {
  const items = day?.items ?? [];
  const minutes = day?.minutes ?? 0;
  const [youtubeExpanded, setYoutubeExpanded] = useState(false);

  useEffect(() => {
    setYoutubeExpanded(false);
  }, [dateStr]);

  const grouped = useMemo(() => groupDayPanelItems(items), [items]);
  const cellSummary = useMemo(
    () => summarizeDayCellV2(day, Math.max(minutes, 60), 0),
    [day, minutes]
  );

  const headingText = formatCleanDayHeading(dateStr, todayStr);
  const hasAnyActivity =
    grouped.workGroups.length > 0 || grouped.youtubeSummary !== null;

  return (
    <div class="calendar-detail-content">
      {showHeader && (
        <div class="calendar-detail-header">
          <div class="calendar-detail-headline">
            <h2 id="calendar-detail-heading" class="calendar-detail-date">
              {headingText}
            </h2>
            <span class="calendar-detail-summary tabular-nums">
              {minutes > 0
                ? formatDuration(minutes * 60)
                : hasAnyActivity
                  ? `${items.length} ${items.length === 1 ? "item" : "items"}`
                  : "Quiet day"}
            </span>
          </div>
          <div class="calendar-detail-header-actions">
            <Button
              variant="ghost"
              size="sm"
              href={`#/add?date=${dateStr}`}
              onClick={
                onOpenAdd
                  ? (e) => {
                      e.preventDefault();
                      onOpenAdd({ date: dateStr });
                    }
                  : undefined
              }
              leadingIcon={<AddIcon size={14} />}
            >
              Add
            </Button>
            {onClose && (
              <IconButton
                label="Close day detail"
                variant="ghost"
                size="sm"
                onClick={onClose}
              >
                <CloseIcon size={18} />
              </IconButton>
            )}
          </div>
        </div>
      )}

      {/* Day Category Share Strip */}
      {cellSummary.categorySegments.length > 0 && (
        <div class="calendar-detail-cat-strip">
          <div class="calendar-detail-cat-bar" aria-hidden="true">
            {cellSummary.categorySegments.map((seg) => (
              <span
                key={seg.category}
                class="calendar-detail-cat-seg"
                style={{
                  width: `${Math.max(4, seg.sharePct)}%`,
                  backgroundColor: categoryCssColor(seg.category),
                }}
              />
            ))}
          </div>
          <div class="calendar-detail-cat-pills">
            {cellSummary.categorySegments.map((seg) => (
              <span
                key={seg.category}
                class="calendar-detail-cat-pill tabular-nums"
              >
                <span
                  class={`ui-tab-dot ui-tab-dot--${seg.category}`}
                  aria-hidden="true"
                />
                {categoryLabel(seg.category)}{" "}
                {seg.minutes > 0
                  ? formatMinutes(seg.minutes)
                  : `${seg.count}×`}
              </span>
            ))}
          </div>
        </div>
      )}

      {!hasAnyActivity ? (
        <EmptyState
          compact
          title="Nothing logged on this day"
          description="Select another date or add an entry for this day."
          actions={
            <Button
              variant="secondary"
              size="sm"
              href={`#/add?date=${dateStr}`}
              onClick={
                onOpenAdd
                  ? (e) => {
                      e.preventDefault();
                      onOpenAdd({ date: dateStr });
                    }
                  : undefined
              }
              leadingIcon={<AddIcon size={15} />}
            >
              Add to archive
            </Button>
          }
        />
      ) : (
        <div class="calendar-compact-list">
          {/* Compact rows grouped by work */}
          {grouped.workGroups.map((group) => {
            const matchedWork = workLookup.get(group.key);
            const workKey = matchedWork?.key ?? group.key;
            const workHref = matchedWork
              ? `#/library?work=${encodeURIComponent(matchedWork.key)}`
              : `#/library?q=${encodeURIComponent(group.workTitle)}`;

            const menuTarget = {
              kind: "day-work" as const,
              workKey,
              title: group.workTitle,
              category: group.category,
              status: matchedWork?.status,
              rating: matchedWork?.rating ?? null,
              href: workHref,
              source: group.source,
            };

            return (
              <div
                key={group.key}
                class="calendar-compact-row"
                tabIndex={0}
                {...bindContextMenu(menuTarget)}
              >
                {/* Only render a cover thumbnail when an actual image URL exists; never render heavy letter tiles for music/entries without art */}
                {group.coverUrl ? (
                  <Cover
                    src={group.coverUrl}
                    title={group.workTitle}
                    category={group.category}
                    size="xs"
                    aspect="square"
                  />
                ) : (
                  <span
                    class={`ui-tab-dot ui-tab-dot--${group.category} calendar-compact-dot`}
                    aria-hidden="true"
                  />
                )}

                <div class="calendar-compact-main">
                  <div class="calendar-compact-title-line">
                    <a
                      href={workHref}
                      class="calendar-compact-title"
                      title={group.workTitle}
                    >
                      {group.workTitle}
                    </a>
                    {group.detailLabel && (
                      <span
                        class="calendar-compact-detail"
                        title={group.detailLabel}
                      >
                        {group.detailLabel}
                      </span>
                    )}
                  </div>
                </div>

                <div class="calendar-compact-right tabular-nums">
                  {group.totalSeconds > 0 && (
                    <span class="calendar-compact-duration">
                      {formatDuration(group.totalSeconds)}
                    </span>
                  )}
                  <QuickRatingPill
                    workKey={workKey}
                    title={group.workTitle}
                    category={group.category}
                    rating={matchedWork?.rating ?? null}
                    source={group.source}
                    variant="inline"
                  />
                  <button
                    type="button"
                    class="ui-row-menu-btn"
                    aria-label={`More actions for ${group.workTitle}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = (
                        e.currentTarget as HTMLElement
                      ).getBoundingClientRect();
                      openContextMenu(
                        menuTarget,
                        { x: rect.left, y: rect.bottom + 4 },
                        e.currentTarget as HTMLElement
                      );
                    }}
                  >
                    <MoreIcon size={15} />
                  </button>
                </div>
              </div>
            );
          })}

          {/* YouTube collapsed into a single expandable line ("12 videos · 48 min") */}
          {grouped.youtubeSummary && (
            <div class="calendar-yt-collapse">
              <button
                type="button"
                class="calendar-yt-summary-row"
                aria-expanded={youtubeExpanded}
                onClick={() => setYoutubeExpanded((v) => !v)}
              >
                <span class="calendar-yt-summary-left">
                  <span
                    class="ui-tab-dot ui-tab-dot--youtube"
                    aria-hidden="true"
                  />
                  <YoutubeIcon size={14} />
                  <strong class="calendar-yt-summary-title">YouTube</strong>
                  <span class="calendar-yt-summary-meta tabular-nums">
                    {grouped.youtubeSummary.summaryLabel}
                  </span>
                </span>
                <span class="calendar-yt-summary-chevron">
                  {youtubeExpanded ? "Hide" : "Show"}
                </span>
              </button>

              {youtubeExpanded && (
                <ul class="calendar-yt-expanded-list">
                  {grouped.youtubeSummary.items.map((item) => {
                    const videoTitle = item.title ?? "YouTube video";
                    const channel = item.parent_title;
                    const ytKey = `youtube:${videoTitle.toLowerCase()}`;
                    const menuTarget = {
                      kind: "youtube-video" as const,
                      workKey: ytKey,
                      title: videoTitle,
                      category: "youtube" as const,
                      channel: channel ?? null,
                      source: "youtube",
                    };
                    return (
                      <li
                        key={item.id}
                        class="calendar-yt-item"
                        tabIndex={0}
                        {...bindContextMenu(menuTarget)}
                      >
                        <div class="calendar-yt-item-main">
                          <a
                            href={
                              channel
                                ? `#/library?cat=youtube&channel=${encodeURIComponent(
                                    channel
                                  )}`
                                : "#/library?cat=youtube"
                            }
                            class="calendar-yt-item-title"
                          >
                            {videoTitle}
                          </a>
                          {channel && (
                            <span class="calendar-yt-item-channel">
                              {channel}
                            </span>
                          )}
                        </div>
                        <div class="calendar-compact-right tabular-nums">
                          {item.duration_seconds &&
                            item.duration_seconds > 0 && (
                              <span class="calendar-compact-duration">
                                {formatDuration(item.duration_seconds)}
                              </span>
                            )}
                          <QuickRatingPill
                            workKey={ytKey}
                            title={videoTitle}
                            category="youtube"
                            rating={null}
                            source="youtube"
                            variant="inline"
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Calendar({
  date,
  initialMonth,
  initialCategory,
  initialCategories,
  includeYoutubeInAll = false,
  onOpenAdd,
}: CalendarProps = {}) {
  const currentMonth = getCurrentMonth();
  const today = getTodayDate();

  const [month, setMonth] = useState<string>(() => {
    if (date && /^\d{4}-\d{2}/.test(date)) {
      return date.slice(0, 7);
    }
    if (initialMonth && /^\d{4}-\d{2}$/.test(initialMonth)) {
      return initialMonth;
    }
    return currentMonth;
  });

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

  const [selectedDate, setSelectedDate] = useState<string | null>(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date;
    }
    return today;
  });

  const [mobileSheetOpen, setMobileSheetOpen] = useState<boolean>(false);

  const [data, setData] = useState<CalendarResult | null>(null);
  const [libraryWorks, setLibraryWorks] = useState<LibraryWork[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideTick, setOverrideTick] = useState(0);

  useEffect(() => {
    return subscribeWorkEdits(() => setOverrideTick((t) => t + 1));
  }, []);

  useEffect(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setMonth(date.slice(0, 7));
      setSelectedDate(date);
      if (isMobileViewport()) {
        setMobileSheetOpen(true);
      } else {
        setMobileSheetOpen(false);
      }
    }
  }, [date]);

  useEffect(() => {
    if (initialCategories !== undefined) {
      setSelectedCategories([...initialCategories]);
    } else if (initialCategory !== undefined) {
      setSelectedCategories(initialCategory ? [initialCategory] : []);
    }
  }, [initialCategory, initialCategories]);

  // Fetch calendar data + library works (for "Continue" in-progress shelf & ratings)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const filterParams = buildCategoryFilterParams(
      selectedCategories,
      includeYoutubeInAll
    );

    const fetchCal = getCalendar(month, filterParams).catch(() =>
      // Graceful fallback if server doesn't yet accept category/exclude on /api/calendar
      getCalendar(month)
    );

    const fetchLib = getLibrary({ sort: "recent" }).catch(() => null);

    Promise.all([fetchCal, fetchLib])
      .then(([calRes, libRes]) => {
        if (cancelled) return;
        setData(calRes);
        if (libRes?.works) {
          setLibraryWorks(libRes.works);
        }
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
  }, [month, selectedCategories, includeYoutubeInAll]);

  const effectiveWorks = useMemo(
    () => applyWorkOverridesToList(libraryWorks),
    [libraryWorks, overrideTick]
  );

  const workLookup = useMemo(() => {
    const map = new Map<string, LibraryWork>();
    for (const w of effectiveWorks) {
      map.set(w.key, w);
      map.set(`${w.category}:${w.title.toLowerCase().trim()}`, w);
    }
    return map;
  }, [effectiveWorks]);

  // Continue / In Progress works (not YouTube or single music tracks: nothing to continue)
  const continueWorks = useMemo(
    () =>
      effectiveWorks
        .filter(
          (w) =>
            w.status === "in_progress" &&
            w.category !== "youtube" &&
            w.category !== "music"
        )
        .slice(0, 4),
    [effectiveWorks]
  );

  // Filter days by multi-select category chips and includeYoutubeInAll
  const filteredDays = useMemo<CalendarDay[]>(() => {
    const rawDays = data?.days ?? [];
    return rawDays.map((d) => {
      const matchingItems = (d.items ?? []).filter((it) => {
        const cat = resolveItemCategory(it);
        return matchesCategorySelection(
          cat,
          selectedCategories,
          includeYoutubeInAll
        );
      });
      const min = matchingItems.reduce((acc, it) => {
        const sec = it.duration_seconds ?? 0;
        return acc + (sec > 0 ? sec / 60 : 0);
      }, 0);
      return {
        date: d.date,
        count: matchingItems.length,
        minutes: Math.round(min),
        items: matchingItems,
      };
    });
  }, [data, selectedCategories, includeYoutubeInAll]);

  const daysMap = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    for (const d of filteredDays) {
      map.set(d.date, d);
    }
    return map;
  }, [filteredDays]);

  // All-categories summary for the filter chip counts
  const fullMonthSummary = useMemo(
    () => summarizeCalendarMonthV2(data?.days ?? [], month),
    [data, month]
  );

  // Filtered month summary for the active view
  const monthSummary = useMemo(
    () => summarizeCalendarMonthV2(filteredDays, month),
    [filteredDays, month]
  );

  // Today & This Week summary
  const weekSummary = useMemo(
    () =>
      summarizeCurrentWeek(
        filteredDays,
        month === currentMonth ? today : `${month}-15`
      ),
    [filteredDays, month, currentMonth, today]
  );

  const weeks = useMemo(() => {
    try {
      return buildMonthGrid(month);
    } catch {
      return [];
    }
  }, [month]);

  useEffect(() => {
    if (!selectedDate || !selectedDate.startsWith(month)) {
      if (today.startsWith(month)) {
        setSelectedDate(today);
      } else if (filteredDays.length > 0) {
        const lastActive = [...filteredDays]
          .filter(
            (d) => d.date.startsWith(month) && (d.count > 0 || d.minutes > 0)
          )
          .sort((a, b) => b.date.localeCompare(a.date))[0];
        setSelectedDate(lastActive ? lastActive.date : `${month}-01`);
      } else {
        setSelectedDate(`${month}-01`);
      }
    }
  }, [month, filteredDays, today, selectedDate]);

  const handlePrevMonth = () => {
    setMonth((m) => shiftMonth(m, -1));
    setMobileSheetOpen(false);
  };

  const handleNextMonth = () => {
    setMonth((m) => shiftMonth(m, 1));
    setMobileSheetOpen(false);
  };

  const handleToday = () => {
    const curMonth = getCurrentMonth();
    const curDay = getTodayDate();
    setMonth(curMonth);
    setSelectedDate(curDay);
  };

  const handleDaySelect = (cellDate: string) => {
    if (!cellDate.startsWith(month)) {
      setMonth(cellDate.slice(0, 7));
    }
    setSelectedDate(cellDate);
    if (isMobileViewport()) {
      setMobileSheetOpen(true);
    }
  };

  const selectedDay = selectedDate ? daysMap.get(selectedDate) : undefined;
  const singleCategory =
    selectedCategories.length === 1 ? selectedCategories[0] : undefined;

  return (
    <section class="page-container calendar-page" aria-label="Calendar">
      {/* Top Header & Month Stepper */}
      <header class="calendar-toolbar">
        <div class="calendar-toolbar-top">
          <div class="calendar-title-block">
            <div class="calendar-title-row">
              <h1 class="calendar-month-heading">{formatMonthTitle(month)}</h1>
              {loading && (
                <span class="calendar-loading-pill" role="status">
                  Updating…
                </span>
              )}
            </div>
          </div>

          <div
            class="calendar-nav-controls"
            role="toolbar"
            aria-label="Month navigation"
          >
            <div class="calendar-month-stepper">
              <IconButton
                label="Previous month"
                variant="ghost"
                size="sm"
                onClick={handlePrevMonth}
              >
                <ChevronLeftIcon size={18} />
              </IconButton>
              <button
                type="button"
                class="calendar-today-btn"
                onClick={handleToday}
              >
                Today
              </button>
              <IconButton
                label="Next month"
                variant="ghost"
                size="sm"
                onClick={handleNextMonth}
              >
                <ChevronRightIcon size={18} />
              </IconButton>
            </div>

            <Button
              variant="primary"
              size="sm"
              href="#/add"
              onClick={
                onOpenAdd
                  ? (e) => {
                      e.preventDefault();
                      onOpenAdd({
                        date: selectedDate ?? undefined,
                        category: singleCategory,
                      });
                    }
                  : undefined
              }
              leadingIcon={<AddIcon size={16} />}
            >
              Add
            </Button>
          </div>
        </div>

        {/* Multi-Select Category Chips */}
        <CategoryChips
          selected={selectedCategories}
          onChange={setSelectedCategories}
          totals={fullMonthSummary.categories}
          includeYoutubeInAll={includeYoutubeInAll}
          ariaLabel="Filter calendar by category"
          showCounts="hours"
        />
      </header>

      {error && (
        <div class="calendar-error" role="alert">
          <span>
            <strong>Could not load calendar:</strong> {error}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setMonth((m) => m)}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Clear At-a-Glance Strip: Today, This Week, This Month, and Continue */}
      <div class="home-glance-grid">
        <Card padding="sm" class="home-glance-card">
          <span class="home-glance-label">Today</span>
          <div class="home-glance-value tabular-nums">
            {formatMinutes(weekSummary.todayMinutes)}
          </div>
          <span class="home-glance-sub tabular-nums">
            {weekSummary.todayWorks > 0
              ? `${weekSummary.todayWorks} ${
                  weekSummary.todayWorks === 1 ? "work" : "works"
                } logged`
              : "Nothing logged yet today"}
          </span>
        </Card>

        <Card padding="sm" class="home-glance-card">
          <div class="home-glance-row">
            <div>
              <span class="home-glance-label">This week</span>
              <div class="home-glance-value tabular-nums">
                {formatMinutes(weekSummary.weekMinutes)}
              </div>
            </div>
            <Sparkline
              values={weekSummary.weekDailyMinutes}
              category={singleCategory}
              width={72}
              height={26}
              label="This week daily minutes"
            />
          </div>
          <span class="home-glance-sub tabular-nums">
            {weekSummary.weekActiveDays} of 7 days active
          </span>
        </Card>

        <Card padding="sm" class="home-glance-card home-glance-card--month">
          <div class="home-glance-row">
            <div>
              <span class="home-glance-label">{formatMonthTitle(month)}</span>
              <div class="home-glance-value tabular-nums">
                {formatMinutes(monthSummary.totalMinutes)}
              </div>
              <span class="home-glance-sub tabular-nums">
                {monthSummary.activeDays} active{" "}
                {monthSummary.activeDays === 1 ? "day" : "days"}
              </span>
            </div>
            <div class="home-glance-share">
              <CategoryShareChart
                categories={monthSummary.categories}
                selectedCategory={singleCategory ?? ""}
                onSelectCategory={(cat) =>
                  setSelectedCategories(cat ? [cat] : [])
                }
                compact
                title={`Category share for ${formatMonthTitle(month)}`}
              />
            </div>
          </div>
        </Card>
      </div>

      {/* Continue (In the middle of) Shelf */}
      {continueWorks.length > 0 && (
        <div class="home-continue-strip" aria-label="In progress">
          <div class="home-continue-header">
            <span class="home-glance-label">Continue</span>
            <a href="#/library?status=in_progress" class="ui-inline-link">
              All in progress →
            </a>
          </div>
          <div class="home-continue-list">
            {continueWorks.map((work) => {
              const workHref = `#/library?work=${encodeURIComponent(work.key)}`;
              const menuTarget = {
                kind: "work" as const,
                workKey: work.key,
                title: work.title,
                category: work.category,
                status: work.status,
                rating: work.rating,
                href: workHref,
              };
              return (
                <a
                  key={work.key}
                  href={workHref}
                  class="home-continue-item"
                  {...bindContextMenu(menuTarget)}
                >
                  {work.cover_url ? (
                    <Cover
                      src={work.cover_url}
                      title={work.title}
                      category={work.category}
                      size="xs"
                      aspect="poster"
                    />
                  ) : (
                    <span
                      class={`ui-tab-dot ui-tab-dot--${work.category}`}
                      aria-hidden="true"
                    />
                  )}
                  <div class="home-continue-info">
                    <span class="home-continue-title">{work.title}</span>
                    <span class="home-continue-meta tabular-nums">
                      {categoryLabel(work.category)}
                      {work.total_minutes > 0
                        ? ` · ${formatMinutes(work.total_minutes)}`
                        : ""}
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Calendar Workspace: Calm 7-Col Month Grid + Day Detail Panel */}
      <div class="calendar-workspace">
        <div class="calendar-board">
          <div class="calendar-weekdays" aria-hidden="true">
            {WEEKDAYS.map((wd) => (
              <div key={wd} class="calendar-weekday-label">
                {wd}
              </div>
            ))}
          </div>

          {loading && !data ? (
            <div class="calendar-grid" aria-busy="true">
              {Array.from({ length: 5 }).map((_, wIdx) => (
                <div key={wIdx} class="calendar-week-row">
                  {Array.from({ length: 7 }).map((__, dIdx) => (
                    <Skeleton key={dIdx} height={74} />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div
              class="calendar-grid"
              role="grid"
              aria-label={`Monthly activity grid for ${formatMonthTitle(month)}`}
            >
              {weeks.map((week, wIdx) => (
                <div key={wIdx} class="calendar-week-row" role="row">
                  {week.map((cellDate) => {
                    const isCurrentMonth = cellDate.startsWith(month);
                    const isToday = cellDate === today;
                    const isSelected = cellDate === selectedDate;
                    const dayData = daysMap.get(cellDate);
                    const dayNum = Number(cellDate.slice(8, 10));

                    const cellSummary = summarizeDayCellV2(
                      dayData,
                      monthSummary.maxDayMinutes,
                      0
                    );
                    const count = cellSummary.count;
                    const minutes = cellSummary.minutes;
                    const intensity = isCurrentMonth ? cellSummary.intensity : 0;

                    const classNames = [
                      "calendar-day",
                      isCurrentMonth ? "" : "calendar-day--outside",
                      isToday ? "calendar-day--today" : "",
                      isSelected ? "calendar-day--selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");

                    const ariaLabel = `${cellDate}${
                      isToday ? " (Today)" : ""
                    }${
                      count > 0
                        ? `, ${count} ${
                            count === 1 ? "item" : "items"
                          }, ${minutes} minutes`
                        : ", no activity"
                    }`;

                    return (
                      <button
                        key={cellDate}
                        type="button"
                        class={classNames}
                        data-intensity={intensity}
                        onClick={() => handleDaySelect(cellDate)}
                        aria-label={ariaLabel}
                        aria-pressed={isSelected}
                      >
                        <div class="calendar-day-top">
                          <span class="calendar-day-num">{dayNum}</span>
                          {count > 0 && (
                            <span class="calendar-day-duration">
                              {minutes >= 1
                                ? formatDuration(minutes * 60)
                                : `${count}×`}
                            </span>
                          )}
                        </div>

                        {/* Calm Category Dots + Proportional Time Bar (No Truncated Titles) */}
                        {count > 0 &&
                          cellSummary.categorySegments.length > 0 && (
                            <div class="calendar-day-media" aria-hidden="true">
                              <div class="calendar-day-dots">
                                {cellSummary.categorySegments.map((seg) => (
                                  <span
                                    key={seg.category}
                                    class={`ui-tab-dot ui-tab-dot--${seg.category}`}
                                    title={`${categoryLabel(seg.category)}: ${
                                      seg.minutes > 0
                                        ? formatMinutes(seg.minutes)
                                        : `${seg.count}×`
                                    }`}
                                  />
                                ))}
                              </div>

                              <div class="calendar-day-bar-track">
                                <div
                                  class="calendar-day-bar-fill"
                                  style={{
                                    width: `${Math.round(
                                      cellSummary.barWidthRatio * 100
                                    )}%`,
                                  }}
                                >
                                  {cellSummary.categorySegments.map((seg) => (
                                    <span
                                      key={seg.category}
                                      class="calendar-day-bar-seg"
                                      style={{
                                        width: `${Math.max(8, seg.sharePct)}%`,
                                        backgroundColor: categoryCssColor(
                                          seg.category
                                        ),
                                      }}
                                    />
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* Intensity & Timezone Legend */}
          <div class="calendar-legend" aria-hidden="true">
            <div class="calendar-legend-scale">
              <span>Less</span>
              <span class="calendar-legend-swatch calendar-legend-swatch--0" />
              <span class="calendar-legend-swatch calendar-legend-swatch--1" />
              <span class="calendar-legend-swatch calendar-legend-swatch--2" />
              <span class="calendar-legend-swatch calendar-legend-swatch--3" />
              <span class="calendar-legend-swatch calendar-legend-swatch--4" />
              <span>More time</span>
            </div>
            <span>Times in {DEFAULT_TIMEZONE}</span>
          </div>
        </div>

        {/* Desktop Sticky Detail Panel (>= 1024px) */}
        {selectedDate && (
          <aside
            class="calendar-detail-aside"
            aria-labelledby="calendar-detail-heading"
          >
            <div class="calendar-detail-card">
              <DayDetailContent
                dateStr={selectedDate}
                todayStr={today}
                day={selectedDay}
                workLookup={workLookup}
                onOpenAdd={onOpenAdd}
                onClose={() => setSelectedDate(null)}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Inline Detail Card (< 1024px) */}
      {selectedDate && (
        <section
          class="calendar-detail-inline"
          aria-label="Selected day details"
        >
          <div class="calendar-detail-card">
            <DayDetailContent
              dateStr={selectedDate}
              todayStr={today}
              day={selectedDay}
              workLookup={workLookup}
              onOpenAdd={onOpenAdd}
              onClose={() => setSelectedDate(null)}
            />
          </div>
        </section>
      )}

      {/* Phone Bottom Sheet (< 768px) */}
      {selectedDate && (
        <Sheet
          open={mobileSheetOpen}
          onClose={() => setMobileSheetOpen(false)}
          title={formatCleanDayHeading(selectedDate, today)}
          subtitle={
            selectedDay && selectedDay.minutes > 0
              ? formatDuration(selectedDay.minutes * 60)
              : selectedDay && selectedDay.count > 0
                ? `${selectedDay.count} ${
                    selectedDay.count === 1 ? "item" : "items"
                  }`
                : "Quiet day"
          }
        >
          <DayDetailContent
            dateStr={selectedDate}
            todayStr={today}
            day={selectedDay}
            workLookup={workLookup}
            onOpenAdd={onOpenAdd}
            showHeader={false}
          />
        </Sheet>
      )}
    </section>
  );
}
