import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getCalendar,
  type CalendarDay,
  type CalendarItem,
  type CalendarResult,
  type Category,
} from "../api";
import {
  buildMonthGrid,
  formatDuration,
  formatItemTitle,
  formatLocalTime,
  shiftMonth,
} from "../lib/calendar";
import {
  DEFAULT_TIMEZONE,
  formatDateTime,
  formatLocalDay,
} from "../lib/format-date";
import { sourceLabel } from "../lib/sources";
import { formatMinutes } from "../lib/stats";
import {
  CATEGORIES,
  categoryCssColor,
  categoryLabel,
  categoryPluralLabel,
  resolveCalendarWorkTitle,
  resolveItemCategory,
  summarizeCalendarMonthV2,
  summarizeDayCellV2,
} from "../lib/ui-helpers";
import {
  AddIcon,
  Badge,
  Button,
  Card,
  CategoryIcon,
  CategoryShareChart,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  Cover,
  EmptyState,
  IconButton,
  Sheet,
  Skeleton,
  Sparkline,
  Stat,
  Tabs,
  type TabOption,
} from "../ui";

export interface CalendarProps {
  /** Optional date in `YYYY-MM-DD` format to select on mount (`#/calendar?date=...`). */
  date?: string;
  /** Optional month in `YYYY-MM` format. */
  initialMonth?: string;
  /** Optional category filter. */
  initialCategory?: Category;
  /** Callback to open the Add to Archive flow. */
  onOpenAdd?: (opts?: { date?: string; category?: Category }) => void;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const DAY_ITEMS_COLLAPSE_THRESHOLD = 12;

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

function formatDetailDate(dateStr: string): string {
  const [yStr, mStr, dStr] = dateStr.split("-");
  const y = parseInt(yStr ?? "2026", 10);
  const m = parseInt(mStr ?? "1", 10);
  const d = parseInt(dStr ?? "1", 10);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function resolveItemLocalTime(item: CalendarItem): string {
  const fromLocal = formatLocalTime(item.local_time);
  if (fromLocal) {
    return fromLocal;
  }
  const formatted = formatDateTime(item.started_at, DEFAULT_TIMEZONE);
  return formatLocalTime(formatted);
}

interface DayDetailContentProps {
  dateStr: string;
  day: CalendarDay | undefined;
  onClose?: () => void;
  onOpenAdd?: (opts?: { date?: string; category?: Category }) => void;
  showHeader?: boolean;
}

function DayDetailContent({
  dateStr,
  day,
  onClose,
  onOpenAdd,
  showHeader = true,
}: DayDetailContentProps) {
  const items = day?.items ?? [];
  const count = day?.count ?? 0;
  const minutes = day?.minutes ?? 0;
  const [showAllItems, setShowAllItems] = useState(false);

  useEffect(() => {
    setShowAllItems(false);
  }, [dateStr]);

  const cellSummary = useMemo(
    () => summarizeDayCellV2(day, Math.max(minutes, 60), 5),
    [day, minutes]
  );

  const visibleItems =
    !showAllItems && items.length > DAY_ITEMS_COLLAPSE_THRESHOLD
      ? items.slice(0, DAY_ITEMS_COLLAPSE_THRESHOLD)
      : items;
  const hiddenCount = items.length - visibleItems.length;

  return (
    <div class="calendar-detail-content">
      {showHeader && (
        <div class="calendar-detail-header">
          <div class="calendar-detail-titles">
            <span class="page-eyebrow">{formatLocalDay(dateStr)}</span>
            <h2 id="calendar-detail-heading" class="calendar-detail-date">
              {formatDetailDate(dateStr)}
            </h2>
            <div class="calendar-detail-summary">
              {count > 0 ? (
                <>
                  {count} {count === 1 ? "entry" : "entries"}
                  {minutes > 0 ? ` · ${formatDuration(minutes * 60)}` : ""}
                </>
              ) : (
                "Quiet day — no logged media"
              )}
            </div>
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

      {/* Day Category Breakdown Bar when items exist */}
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
                {categoryLabel(seg.category)}:{" "}
                {seg.minutes > 0
                  ? formatMinutes(seg.minutes)
                  : `${seg.count}×`}
              </span>
            ))}
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          compact
          title="Nothing logged on this day"
          description="Select another date on the calendar or add an entry for this day."
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
        <>
          <ul class="calendar-item-list">
            {visibleItems.map((item) => {
              const cat = resolveItemCategory(item);
              const fullTitle = formatItemTitle(item);
              const workTitle = resolveCalendarWorkTitle(item);
              const libraryHref = workTitle
                ? `#/library?q=${encodeURIComponent(workTitle)}`
                : "#/library";
              const timeLabel = resolveItemLocalTime(item);

              return (
                <li key={item.id} class="calendar-item-row">
                  <Cover
                    src={item.cover_url}
                    title={item.title ?? item.parent_title}
                    category={cat}
                    source={item.source}
                    mediaType={item.media_type}
                    size="md"
                    aspect="square"
                  />
                  <div class="calendar-item-body">
                    {item.parent_title && (
                      <div
                        class="calendar-item-parent"
                        title={item.parent_title}
                      >
                        {item.parent_title}
                      </div>
                    )}
                    <a
                      class="calendar-item-title-link"
                      href={libraryHref}
                      title={fullTitle}
                    >
                      {fullTitle}
                    </a>
                    <div class="calendar-item-meta">
                      <Badge
                        size="sm"
                        category={cat}
                        icon={<CategoryIcon category={cat} size={11} />}
                      >
                        {categoryLabel(cat)}
                      </Badge>

                      {timeLabel && (
                        <span
                          class={
                            item.time_uncertain
                              ? "calendar-item-time calendar-item-time--uncertain"
                              : "calendar-item-time"
                          }
                          title={
                            item.time_uncertain
                              ? "Played offline and synced later. The day is the sync day; the time of day is unknown."
                              : undefined
                          }
                        >
                          <ClockIcon size={12} />
                          {item.time_uncertain
                            ? `synced ${timeLabel} (offline)`
                            : timeLabel}
                        </span>
                      )}

                      {item.duration_seconds !== null &&
                        item.duration_seconds !== undefined &&
                        item.duration_seconds > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{formatDuration(item.duration_seconds)}</span>
                          </>
                        )}
                    </div>
                    {item.also_from && item.also_from.length > 0 && (
                      <div class="calendar-item-dedup">
                        Also logged via{" "}
                        {item.also_from
                          .map((src) => sourceLabel(src))
                          .join(", ")}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {hiddenCount > 0 && (
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              onClick={() => setShowAllItems(true)}
            >
              Show all {items.length} entries (+{hiddenCount} more)
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export function Calendar({
  date,
  initialMonth,
  initialCategory,
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

  const [categoryFilter, setCategoryFilter] = useState<Category | "">(
    initialCategory ?? ""
  );

  const [selectedDate, setSelectedDate] = useState<string | null>(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date;
    }
    return today;
  });

  // Never open the modal sheet on desktop (`>= 768px`) when arriving via `?date=`.
  const [mobileSheetOpen, setMobileSheetOpen] = useState<boolean>(false);

  const [data, setData] = useState<CalendarResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state when incoming deep-link date prop changes (`#/calendar?date=YYYY-MM-DD`).
  useEffect(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setMonth(date.slice(0, 7));
      setSelectedDate(date);
      // On desktop, select the day in the side panel without opening a modal over it.
      if (isMobileViewport()) {
        setMobileSheetOpen(true);
      } else {
        setMobileSheetOpen(false);
      }
    }
  }, [date]);

  useEffect(() => {
    if (initialCategory !== undefined) {
      setCategoryFilter(initialCategory);
    }
  }, [initialCategory]);

  // Fetch calendar data when month changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getCalendar(month)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [month]);

  // Filter days by selected category if active
  const filteredDays = useMemo<CalendarDay[]>(() => {
    const rawDays = data?.days ?? [];
    if (!categoryFilter) {
      return rawDays;
    }
    return rawDays.map((d) => {
      const matchingItems = (d.items ?? []).filter(
        (it) => resolveItemCategory(it) === categoryFilter
      );
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
  }, [data, categoryFilter]);

  const daysMap = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    for (const d of filteredDays) {
      map.set(d.date, d);
    }
    return map;
  }, [filteredDays]);

  // Unfiltered month summary for the category tabs/share bar
  const fullMonthSummary = useMemo(
    () => summarizeCalendarMonthV2(data?.days ?? [], month),
    [data, month]
  );

  // Filtered month summary for the active view
  const monthSummary = useMemo(
    () => summarizeCalendarMonthV2(filteredDays, month),
    [filteredDays, month]
  );

  const categoryTabs = useMemo<TabOption<Category | "">[]>(() => {
    const presentCats = new Set(
      fullMonthSummary.categories.map((c) => c.category)
    );
    const ordered = CATEGORIES.filter(
      (c) => presentCats.has(c) || c === categoryFilter
    );
    return [
      { value: "", label: "All Categories" },
      ...ordered.map((cat) => {
        const entry = fullMonthSummary.categories.find(
          (c) => c.category === cat
        );
        return {
          value: cat,
          label: categoryPluralLabel(cat),
          category: cat,
          count: entry ? entry.units : undefined,
        };
      }),
    ];
  }, [fullMonthSummary.categories, categoryFilter]);

  const weeks = useMemo(() => {
    try {
      return buildMonthGrid(month);
    } catch {
      return [];
    }
  }, [month]);

  // Ensure a sensible day is selected for the desktop side panel when switching months.
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

  return (
    <section class="page-container calendar-page" aria-label="Calendar">
      {/* Top Header & Navigation Controls */}
      <header class="calendar-toolbar">
        <div class="calendar-toolbar-top">
          <div class="calendar-title-block">
            <span class="page-eyebrow">Daily Log & Archive</span>
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
                        category: categoryFilter || undefined,
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

        {categoryTabs.length > 1 && (
          <div class="calendar-toolbar-filters">
            <Tabs
              ariaLabel="Filter calendar by category"
              options={categoryTabs}
              value={categoryFilter}
              onChange={(val) => setCategoryFilter(val)}
              variant="pills"
            />
          </div>
        )}
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

      {/* Compact Month Pulse Strip (Sparkline + Category Share Bar, No Cover Bloat) */}
      <Card padding="md" class="calendar-pulse-card">
        <div class="calendar-pulse-grid">
          <Stat
            label="Time This Month"
            value={formatMinutes(monthSummary.totalMinutes)}
            category={categoryFilter || undefined}
            sparkline={
              <Sparkline
                values={monthSummary.dailyMinutesSeries}
                category={categoryFilter || undefined}
                label={`Daily minutes in ${formatMonthTitle(month)}`}
              />
            }
            sublabel={
              monthSummary.busiestDay
                ? `Peak: ${formatMinutes(
                    monthSummary.busiestDay.minutes
                  )} on ${formatLocalDay(monthSummary.busiestDay.date)}`
                : "No timed sessions yet"
            }
          />

          <Stat
            label="Active Rhythm"
            value={`${monthSummary.activeDays} / ${monthSummary.daysInMonth}d`}
            sublabel={`${monthSummary.totalItems} ${
              monthSummary.totalItems === 1 ? "entry" : "entries"
            } logged`}
          />

          <div class="calendar-pulse-share">
            <span class="ui-stat-label">Category Breakdown</span>
            <CategoryShareChart
              categories={fullMonthSummary.categories}
              selectedCategory={categoryFilter}
              onSelectCategory={(cat) => setCategoryFilter(cat)}
              compact
              title={`Category share for ${formatMonthTitle(month)}`}
            />
          </div>
        </div>
      </Card>

      {/* Main Calendar Workspace: 7-col Cover-Free Month Grid + Desktop Side Panel */}
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
                    <Skeleton key={dIdx} height={84} />
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
                      2
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

                        {count > 0 && (
                          <div class="calendar-day-media" aria-hidden="true">
                            {/* Desktop/Tablet Title Previews (No cover thumbnails inside cells!) */}
                            {cellSummary.workTitles.length > 0 && (
                              <div class="calendar-day-titles">
                                {cellSummary.workTitles.map((w, idx) => (
                                  <div
                                    key={`${w.category}-${idx}`}
                                    class="calendar-day-title-row"
                                  >
                                    <span
                                      class={`ui-tab-dot ui-tab-dot--${w.category}`}
                                    />
                                    <span class="calendar-day-title-text">
                                      {w.title}
                                    </span>
                                  </div>
                                ))}
                                {cellSummary.overflowWorks > 0 && (
                                  <span class="calendar-day-more">
                                    +{cellSummary.overflowWorks} more
                                  </span>
                                )}
                              </div>
                            )}

                            {/* Proportional Category Time Bar at bottom of cell */}
                            {cellSummary.categorySegments.length > 0 && (
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
                            )}
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
                day={selectedDay}
                onOpenAdd={onOpenAdd}
                onClose={() => setSelectedDate(null)}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Inline Detail Card (< 1024px) so selected day is always visible below the calendar */}
      {selectedDate && (
        <section
          class="calendar-detail-inline"
          aria-label="Selected day details"
        >
          <div class="calendar-detail-card">
            <DayDetailContent
              dateStr={selectedDate}
              day={selectedDay}
              onOpenAdd={onOpenAdd}
              onClose={() => setSelectedDate(null)}
            />
          </div>
        </section>
      )}

      {/* Phone Bottom Sheet (< 768px, only opened on explicit tap) */}
      {selectedDate && (
        <Sheet
          open={mobileSheetOpen}
          onClose={() => setMobileSheetOpen(false)}
          title={formatDetailDate(selectedDate)}
          subtitle={
            selectedDay && selectedDay.count > 0
              ? `${formatLocalDay(selectedDate)} · ${selectedDay.count} ${
                  selectedDay.count === 1 ? "entry" : "entries"
                }${
                  selectedDay.minutes > 0
                    ? ` · ${formatDuration(selectedDay.minutes * 60)}`
                    : ""
                }`
              : `${formatLocalDay(selectedDate)} · No activity recorded`
          }
        >
          <DayDetailContent
            dateStr={selectedDate}
            day={selectedDay}
            onOpenAdd={onOpenAdd}
            showHeader={false}
          />
        </Sheet>
      )}
    </section>
  );
}
