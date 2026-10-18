import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getCalendar,
  type CalendarDay,
  type CalendarItem,
  type CalendarResult,
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
import { SOURCES, sourceLabel } from "../lib/sources";
import { formatMinutes } from "../lib/stats";
import {
  MEDIA_KINDS,
  computeDayIntensity,
  pickDayPreviewItems,
  resolveMediaKind,
  summarizeCalendarMonth,
  type MediaKind,
} from "../lib/ui-helpers";
import {
  Badge,
  Button,
  Card,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  Cover,
  EmptyState,
  IconButton,
  MediaKindIcon,
  SearchIcon,
  Sheet,
  Skeleton,
  Stat,
  Tabs,
  type TabOption,
} from "../ui";

export interface CalendarProps {
  /** Optional date in `YYYY-MM-DD` format to open on mount (`#/calendar?date=...`). */
  date?: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const SOURCE_TABS: readonly TabOption<string>[] = [
  { value: "", label: "All Media" },
  ...SOURCES.map((s) => ({
    value: s.value,
    label: s.label,
    kind: resolveMediaKind(s.value),
  })),
];

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
  showHeader?: boolean;
}

function DayDetailContent({
  dateStr,
  day,
  onClose,
  showHeader = true,
}: DayDetailContentProps) {
  const items = day?.items ?? [];
  const count = day?.count ?? 0;
  const minutes = day?.minutes ?? 0;

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
      )}

      {items.length === 0 ? (
        <EmptyState
          compact
          title="Nothing logged on this day"
          description="Select another date on the calendar or add a manual entry for this day."
          actions={
            <Button variant="secondary" size="sm" href="#/add">
              Log an entry
            </Button>
          }
        />
      ) : (
        <ul class="calendar-item-list">
          {items.map((item) => {
            const fullTitle = formatItemTitle(item);
            const searchTarget = item.parent_title ?? item.title ?? "";
            const searchHref = searchTarget
              ? `#/search?q=${encodeURIComponent(searchTarget)}`
              : "#/search";
            const timeLabel = resolveItemLocalTime(item);

            return (
              <li key={item.id} class="calendar-item-row">
                <Cover
                  src={item.cover_url}
                  title={item.title ?? item.parent_title}
                  source={item.source}
                  mediaType={item.media_type}
                  size="md"
                  aspect="square"
                />
                <div class="calendar-item-body">
                  {item.parent_title && (
                    <div class="calendar-item-parent">{item.parent_title}</div>
                  )}
                  <a class="calendar-item-title-link" href={searchHref}>
                    {fullTitle}
                  </a>
                  <div class="calendar-item-meta">
                    <Badge
                      size="sm"
                      source={item.source}
                      mediaType={item.media_type}
                      icon={
                        <MediaKindIcon
                          source={item.source}
                          mediaType={item.media_type}
                          size={11}
                        />
                      }
                    >
                      {sourceLabel(item.source)}
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
                      {item.also_from.map((src) => sourceLabel(src)).join(", ")}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Calendar({ date }: CalendarProps = {}) {
  const currentMonth = getCurrentMonth();
  const today = getTodayDate();

  const [month, setMonth] = useState<string>(() => {
    if (date && /^\d{4}-\d{2}/.test(date)) {
      return date.slice(0, 7);
    }
    return currentMonth;
  });

  const [sourceFilter, setSourceFilter] = useState<string>("");

  const [selectedDate, setSelectedDate] = useState<string | null>(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date;
    }
    return today;
  });

  const [mobileSheetOpen, setMobileSheetOpen] = useState<boolean>(() =>
    Boolean(date && /^\d{4}-\d{2}-\d{2}$/.test(date))
  );

  const [data, setData] = useState<CalendarResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state when incoming deep-link date prop changes (`#/calendar?date=YYYY-MM-DD`).
  useEffect(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setMonth(date.slice(0, 7));
      setSelectedDate(date);
      setMobileSheetOpen(true);
    }
  }, [date]);

  // Fetch calendar data when month or source filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getCalendar(month, sourceFilter || undefined)
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
  }, [month, sourceFilter]);

  const daysMap = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    if (data?.days) {
      for (const d of data.days) {
        map.set(d.date, d);
      }
    }
    return map;
  }, [data]);

  const monthSummary = useMemo(
    () => summarizeCalendarMonth(data?.days ?? [], month),
    [data, month]
  );

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
      } else if (data?.days && data.days.length > 0) {
        const lastActive = [...data.days]
          .filter((d) => d.date.startsWith(month) && (d.count > 0 || d.minutes > 0))
          .sort((a, b) => b.date.localeCompare(a.date))[0];
        setSelectedDate(lastActive ? lastActive.date : `${month}-01`);
      } else {
        setSelectedDate(`${month}-01`);
      }
    }
  }, [month, data, today, selectedDate]);

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
    setMobileSheetOpen(true);
  };

  const selectedDay = selectedDate ? daysMap.get(selectedDate) : undefined;

  const activeKinds = (["audiobook", "film", "youtube", "manual"] as const).filter(
    (k) => monthSummary.byKind[k].count > 0
  );

  return (
    <section class="page-container calendar-page" aria-label="Calendar">
      {/* Top Header & Navigation Controls */}
      <header class="calendar-toolbar">
        <div class="calendar-toolbar-top">
          <div class="calendar-title-block">
            <h1 class="calendar-month-heading">{formatMonthTitle(month)}</h1>
            {loading && (
              <span class="calendar-loading-pill" role="status">
                Updating…
              </span>
            )}
          </div>

          <div
            class="calendar-nav-controls"
            role="toolbar"
            aria-label="Month navigation"
          >
            <Button
              variant="ghost"
              size="sm"
              href="#/search"
              leadingIcon={<SearchIcon size={15} />}
            >
              Search
            </Button>

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
          </div>
        </div>

        <div class="calendar-toolbar-filters">
          <Tabs
            ariaLabel="Filter calendar by media source"
            options={SOURCE_TABS}
            value={sourceFilter}
            onChange={(val) => setSourceFilter(val)}
            variant="pills"
          />
        </div>
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

      {/* Monthly Summary Strip */}
      <div class="calendar-summary-grid">
        <Card padding="sm">
          <Stat
            label="Time Logged"
            value={formatMinutes(monthSummary.totalMinutes)}
            sublabel={
              monthSummary.busiestDay
                ? `Peak: ${formatMinutes(monthSummary.busiestDay.minutes)} on ${formatLocalDay(
                    monthSummary.busiestDay.date
                  )}`
                : "No timed sessions yet"
            }
          />
        </Card>
        <Card padding="sm">
          <Stat
            label="Entries"
            value={monthSummary.totalItems}
            sublabel={
              monthSummary.featuredItems.length > 0
                ? `${monthSummary.featuredItems.length} distinct ${
                    monthSummary.featuredItems.length === 1 ? "work" : "works"
                  }`
                : "Across all sources"
            }
          />
        </Card>
        <Card padding="sm">
          <Stat
            label="Active Days"
            value={monthSummary.activeDays}
            sublabel={`In ${formatMonthTitle(month)}`}
          />
        </Card>
        <Card padding="sm">
          <div class="ui-stat">
            <span class="ui-stat-label">By Media Kind</span>
            {activeKinds.length === 0 ? (
              <div class="ui-stat-sublabel">No activity recorded this month</div>
            ) : (
              <div class="calendar-kind-pills">
                {activeKinds.map((kind) => {
                  const info = monthSummary.byKind[kind];
                  return (
                    <Badge
                      key={kind}
                      variant={kind}
                      size="sm"
                      icon={<MediaKindIcon kind={kind} size={11} />}
                    >
                      {MEDIA_KINDS[kind].shortLabel}: {info.count}
                    </Badge>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Cover-First Showcase Shelf: Works Consumed This Month */}
      {monthSummary.featuredItems.length > 0 && (
        <Card padding="md" class="calendar-shelf-card">
          <div class="calendar-shelf-header">
            <h2 class="calendar-shelf-title">On Your Shelf This Month</h2>
            <span class="calendar-shelf-subtitle">
              Select a cover to inspect that day
            </span>
          </div>
          <div class="calendar-shelf-scroll">
            {monthSummary.featuredItems.map((work) => (
              <button
                key={`${work.source}:${work.title}`}
                type="button"
                class="calendar-shelf-item"
                onClick={() => handleDaySelect(work.date)}
                title={`${work.title} (${formatLocalDay(work.date)})`}
              >
                <Cover
                  src={work.coverUrl}
                  title={work.title}
                  source={work.source}
                  mediaType={work.mediaType}
                  kind={work.kind}
                  size="lg"
                  aspect="square"
                />
                <span class="calendar-shelf-item-title">{work.title}</span>
                <span class="calendar-shelf-item-meta">
                  {work.totalMinutes >= 1
                    ? formatMinutes(work.totalMinutes)
                    : `${work.sessionCount}×`}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Main Calendar Workspace: 7-col Month Grid + Desktop Side Panel */}
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
                    <Skeleton key={dIdx} height={88} />
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
                    const count = dayData?.count ?? 0;
                    const minutes = dayData?.minutes ?? 0;
                    const dayNum = Number(cellDate.slice(8, 10));

                    const intensity = isCurrentMonth
                      ? computeDayIntensity(
                          minutes,
                          count,
                          monthSummary.maxDayMinutes
                        )
                      : 0;

                    const previewItems = dayData
                      ? pickDayPreviewItems(dayData.items, 3)
                      : [];
                    const overflowCount = Math.max(
                      0,
                      count - previewItems.length
                    );

                    // Unique kinds present on this day for the bottom accent bar
                    const dayKinds: MediaKind[] = dayData
                      ? Array.from(
                          new Set(
                            dayData.items.map((it) =>
                              resolveMediaKind(it.source, it.media_type)
                            )
                          )
                        )
                      : [];

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
                          }, ${Math.round(minutes)} minutes`
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
                            <div class="calendar-day-covers">
                              {previewItems.map((it) => (
                                <Cover
                                  key={it.id}
                                  src={it.cover_url}
                                  title={it.title ?? it.parent_title}
                                  source={it.source}
                                  mediaType={it.media_type}
                                  size="xs"
                                  aspect="square"
                                />
                              ))}
                              {overflowCount > 0 && (
                                <span class="calendar-day-more">
                                  +{overflowCount}
                                </span>
                              )}
                            </div>

                            {dayKinds.length > 0 && (
                              <div class="calendar-day-dots">
                                {dayKinds.map((k) => (
                                  <span
                                    key={k}
                                    class={`calendar-day-dot calendar-day-dot--${k}`}
                                  />
                                ))}
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

          {/* Intensity & Kind Legend */}
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
                onClose={() => setSelectedDate(null)}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Tablet Inline Detail Card (768px .. 1023px) */}
      {selectedDate && (
        <section
          class="calendar-detail-tablet"
          aria-label="Selected day details"
        >
          <div class="calendar-detail-card">
            <DayDetailContent
              dateStr={selectedDate}
              day={selectedDay}
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
            showHeader={false}
          />
        </Sheet>
      )}
    </section>
  );
}
