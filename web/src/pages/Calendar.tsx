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
  sourceIcon,
} from "../lib/calendar";
import { sourceLabel } from "../lib/sources";

export interface CalendarProps {
  /** Optional date in `YYYY-MM-DD` format to open on mount. */
  date?: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Small square cover thumbnail for a calendar item. Falls back to the existing
 * source icon when the item has no cover or the image fails to load.
 */
function ItemThumbnail({ item }: { item: CalendarItem }) {
  const [failed, setFailed] = useState(false);

  if (item.cover_url && !failed) {
    return (
      <img
        class="calendar-item-cover"
        src={item.cover_url}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span class="calendar-item-icon-badge" aria-hidden="true">
      {sourceIcon(item.source, item.media_type)}
    </span>
  );
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
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
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

  const [selectedDate, setSelectedDate] = useState<string | null>(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date;
    }
    return null;
  });

  const [data, setData] = useState<CalendarResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state if incoming date prop changes
  useEffect(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setMonth(date.slice(0, 7));
      setSelectedDate(date);
    }
  }, [date]);

  // Fetch calendar data when month changes
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

  const daysMap = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    if (data?.days) {
      for (const d of data.days) {
        map.set(d.date, d);
      }
    }
    return map;
  }, [data]);

  const weeks = useMemo(() => {
    try {
      return buildMonthGrid(month);
    } catch {
      return [];
    }
  }, [month]);

  const handlePrevMonth = () => {
    setMonth((m) => shiftMonth(m, -1));
  };

  const handleNextMonth = () => {
    setMonth((m) => shiftMonth(m, 1));
  };

  const handleToday = () => {
    setMonth(getCurrentMonth());
  };

  const handleDayClick = (cellDate: string) => {
    setSelectedDate((prev) => (prev === cellDate ? null : cellDate));
  };

  const selectedDay = selectedDate ? daysMap.get(selectedDate) : null;
  const selectedItems = selectedDay?.items ?? [];

  return (
    <section class="page calendar-page">
      <header class="calendar-header">
        <div class="calendar-title-group">
          <h1 class="calendar-title">{formatMonthTitle(month)}</h1>
          <a class="search-header-link" href="#/search">
            🔍 Search
          </a>
          {loading && (
            <span class="calendar-loading-badge" role="status">
              Loading…
            </span>
          )}
        </div>
        <div class="calendar-nav" role="toolbar" aria-label="Month navigation">
          <button
            type="button"
            class="calendar-nav-btn"
            onClick={handlePrevMonth}
            aria-label="Previous month"
          >
            ‹ Prev
          </button>
          <button
            type="button"
            class="calendar-nav-btn calendar-nav-today"
            onClick={handleToday}
          >
            Today
          </button>
          <button
            type="button"
            class="calendar-nav-btn"
            onClick={handleNextMonth}
            aria-label="Next month"
          >
            Next ›
          </button>
        </div>
      </header>

      {error && (
        <div class="calendar-error" role="alert">
          <strong>Error loading calendar:</strong> {error}
        </div>
      )}

      <div class="calendar-grid-wrapper">
        <div class="calendar-weekday-header">
          {WEEKDAYS.map((wd) => (
            <div key={wd} class="calendar-weekday">
              {wd}
            </div>
          ))}
        </div>

        <div class="calendar-grid" role="grid" aria-label="Monthly activity grid">
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

                const icons = dayData
                  ? Array.from(
                      new Set(
                        dayData.items.map((it) =>
                          sourceIcon(it.source, it.media_type)
                        )
                      )
                    )
                  : [];

                const classNames = [
                  "calendar-day",
                  isCurrentMonth ? "" : "calendar-day-outside",
                  isToday ? "calendar-day-today" : "",
                  isSelected ? "calendar-day-selected" : "",
                  count > 0 ? "calendar-day-has-events" : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                const label = `${cellDate}${
                  count > 0
                    ? `, ${count} ${count === 1 ? "item" : "items"}, ${Math.round(minutes)} minutes`
                    : ""
                }`;

                return (
                  <button
                    key={cellDate}
                    type="button"
                    class={classNames}
                    onClick={() => handleDayClick(cellDate)}
                    aria-label={label}
                    aria-pressed={isSelected}
                  >
                    <div class="calendar-day-top">
                      <span class="calendar-day-num">{dayNum}</span>
                      {count > 0 && (
                        <span class="calendar-day-count-badge">{count}</span>
                      )}
                    </div>
                    {count > 0 && (
                      <div class="calendar-day-bottom">
                        <div class="calendar-day-icons" aria-hidden="true">
                          {icons.map((ic, iIdx) => (
                            <span key={iIdx} class="calendar-day-icon">
                              {ic}
                            </span>
                          ))}
                        </div>
                        {minutes > 0 && (
                          <span class="calendar-day-time">
                            {formatDuration(minutes * 60)}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {selectedDate && (
        <section
          class="calendar-detail"
          aria-labelledby="calendar-detail-heading"
        >
          <div class="calendar-detail-header">
            <div class="calendar-detail-heading-group">
              <h2 id="calendar-detail-heading" class="calendar-detail-title">
                {formatDetailDate(selectedDate)}
              </h2>
              {selectedDay && selectedDay.count > 0 && (
                <span class="calendar-detail-stats">
                  {selectedDay.count}{" "}
                  {selectedDay.count === 1 ? "item" : "items"} ·{" "}
                  {formatDuration(selectedDay.minutes * 60)}
                </span>
              )}
            </div>
            <button
              type="button"
              class="calendar-detail-close"
              onClick={() => setSelectedDate(null)}
              aria-label="Close detail panel"
            >
              ✕
            </button>
          </div>

          {selectedItems.length === 0 ? (
            <p class="muted calendar-detail-empty">
              No activity recorded for this date.
            </p>
          ) : (
            <ul class="calendar-detail-list">
              {selectedItems.map((item) => (
                <li key={item.id} class="calendar-detail-item">
                  <ItemThumbnail item={item} />
                  <div class="calendar-item-body">
                    {item.parent_title && (
                      <div class="calendar-item-parent">
                        {item.parent_title}
                      </div>
                    )}
                    <div class="calendar-item-title">
                      {formatItemTitle(item)}
                    </div>
                    <div class="calendar-item-meta">
                      {item.time_uncertain ? (
                        <span
                          class="calendar-item-time calendar-item-time-uncertain"
                          title="Played offline and synced later. The day is the sync day; the time of day is unknown."
                        >
                          synced {formatLocalTime(item.local_time)} (offline)
                        </span>
                      ) : (
                        <span class="calendar-item-time">
                          {formatLocalTime(item.local_time)}
                        </span>
                      )}
                      <span class="calendar-item-bullet">·</span>
                      {item.duration_seconds !== null &&
                        item.duration_seconds !== undefined && (
                          <>
                            <span class="calendar-item-duration">
                              {formatDuration(item.duration_seconds)}
                            </span>
                            <span class="calendar-item-bullet">·</span>
                          </>
                        )}
                      <span class="calendar-item-source">
                        {sourceLabel(item.source)}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
