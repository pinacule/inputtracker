import { useRef } from "preact/hooks";
import { categoryCssColor } from "../../lib/categories";
import {
  formatCleanDayHeading,
  stepCalendarDateByKey,
  type MonthCalendarCellModel,
} from "../../lib/home";
import { formatMinutes } from "../../lib/stats";

export interface MonthCalendarGridProps {
  readonly monthHeading: string;
  readonly weeks: ReadonlyArray<ReadonlyArray<MonthCalendarCellModel>>;
  readonly todayStr: string;
  readonly onSelectDate: (date: string, fromMonthGrid?: boolean) => void;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * 7-column visual Month Calendar Grid:
 * - Subtle heat-wash backgrounds (`--heat-0`..`--heat-4`)
 * - Proportional category time bar at the bottom of each active cell
 * - Calm, deduplicated work lines on desktop (YouTube & Music collapsed)
 * - Clean category dots on phone (zero cramped text inside narrow phone cells)
 * - Full roving keyboard navigation (`Arrow*`, `Home`, `End`, `PageUp`, `PageDown`)
 */
export function MonthCalendarGrid({
  monthHeading,
  weeks,
  todayStr,
  onSelectDate,
}: MonthCalendarGridProps) {
  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const handleCellKeyDown = (e: KeyboardEvent, dateStr: string) => {
    const nextDate = stepCalendarDateByKey(dateStr, e.key);
    if (!nextDate) return;
    e.preventDefault();
    onSelectDate(nextDate, false);
    // Focus the target cell if it is rendered in the current grid
    requestAnimationFrame(() => {
      const targetBtn = cellRefs.current.get(nextDate);
      targetBtn?.focus();
    });
  };

  return (
    <section
      class="home-card home-cal-card"
      aria-label={`${monthHeading} calendar`}
    >
      {/* Weekday Header Row */}
      <div class="home-cal-weekdays" aria-hidden="true">
        {WEEKDAYS.map((wd) => (
          <div key={wd} class="home-cal-weekday">
            {wd}
          </div>
        ))}
      </div>

      {/* 7-Column Month Grid */}
      <div
        class="home-cal-grid"
        role="grid"
        aria-label={`Days of ${monthHeading}`}
      >
        {weeks.map((week, wIdx) => (
          <div key={wIdx} class="home-cal-week-row" role="row">
            {week.map((cell) => {
              const plainDate = formatCleanDayHeading(cell.date, todayStr);
              const ariaSummary =
                cell.totalMinutes > 0
                  ? `${plainDate}: ${formatMinutes(cell.totalMinutes)}`
                  : cell.totalCount > 0
                    ? `${plainDate}: ${cell.totalCount} items`
                    : `${plainDate}: no activity`;

              const classes = [
                "home-cal-cell",
                `home-cal-cell--heat-${cell.intensity}`,
                !cell.inCurrentMonth ? "home-cal-cell--outside" : "",
                cell.isSelected ? "home-cal-cell--selected" : "",
                cell.isToday ? "home-cal-cell--today" : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  key={cell.date}
                  ref={(el) => {
                    if (el) {
                      cellRefs.current.set(cell.date, el);
                    } else {
                      cellRefs.current.delete(cell.date);
                    }
                  }}
                  type="button"
                  role="gridcell"
                  tabIndex={cell.isSelected ? 0 : -1}
                  aria-selected={cell.isSelected}
                  aria-current={cell.isToday ? "date" : undefined}
                  aria-label={ariaSummary}
                  class={classes}
                  onClick={() => onSelectDate(cell.date, true)}
                  onKeyDown={(e) => handleCellKeyDown(e, cell.date)}
                >
                  {/* Cell Top: Day number + compact duration */}
                  <span class="home-cal-cell-top" aria-hidden="true">
                    <span
                      class={
                        cell.isToday
                          ? "home-cal-day-num home-cal-day-num--today tabular-nums"
                          : "home-cal-day-num tabular-nums"
                      }
                    >
                      {cell.dayOfMonth}
                    </span>
                    {cell.durationLabel && (
                      <span class="home-cal-day-dur tabular-nums">
                        {cell.durationLabel}
                      </span>
                    )}
                  </span>

                  {/* Desktop Calm Lines (max 2, YouTube/Music collapsed) */}
                  {cell.calmLines.length > 0 && (
                    <span class="home-cal-lines" aria-hidden="true">
                      {cell.calmLines.map((line, lIdx) => {
                        const isLastShown =
                          lIdx === cell.calmLines.length - 1 &&
                          cell.overflowCount > 0;
                        return (
                          <span key={line.key} class="home-cal-line">
                            <span
                              class={`ui-tab-dot ui-tab-dot--${line.category}`}
                            />
                            <span class="home-cal-line-text">{line.label}</span>
                            {isLastShown && (
                              <span class="home-cal-line-more tabular-nums">
                                +{cell.overflowCount}
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </span>
                  )}

                  {/* Phone Category Dots (shown on < 768px instead of truncated text) */}
                  {cell.segments.length > 0 && (
                    <span class="home-cal-mobile-dots" aria-hidden="true">
                      {cell.segments.slice(0, 4).map((seg) => (
                        <span
                          key={seg.category}
                          class={`ui-tab-dot ui-tab-dot--${seg.category}`}
                        />
                      ))}
                    </span>
                  )}

                  {/* Bottom Proportional Category Time Bar */}
                  <span class="home-cal-bar-slot" aria-hidden="true">
                    {cell.barWidthRatio > 0 && (
                      <span
                        class="home-cal-bar"
                        style={{
                          width: `${Math.round(cell.barWidthRatio * 100)}%`,
                        }}
                      >
                        {cell.segments.map((seg) => (
                          <span
                            key={seg.category}
                            class="home-cal-bar-seg"
                            style={{
                              width: `${Math.max(4, seg.sharePct)}%`,
                              backgroundColor: categoryCssColor(seg.category),
                            }}
                          />
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
