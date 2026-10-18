import {
  categoryCssColor,
  categoryPluralLabel,
} from "../../lib/categories";
import { formatCleanDayHeading, type WeekGraphModel } from "../../lib/home";
import { formatMinutes } from "../../lib/stats";

export interface WeekGraphProps {
  readonly model: WeekGraphModel;
  readonly todayStr: string;
  readonly onSelectDate: (date: string) => void;
}

/**
 * 7-day interactive stacked category bar graph for the selected week (Mon–Sun).
 * Answers "What did I do today and this week?" at a glance on phone and desktop,
 * and acts as a fast 7-day thumb switcher.
 */
export function WeekGraph({
  model,
  todayStr,
  onSelectDate,
}: WeekGraphProps) {
  return (
    <section
      class="home-card home-week-card"
      aria-label={`${model.heading} activity graph`}
    >
      <div class="home-week-header">
        <div class="home-week-titles">
          <h2 class="home-section-title">{model.heading}</h2>
          <span class="home-week-sub tabular-nums">
            {model.activeDays === 0
              ? "No activity yet"
              : `${model.activeDays} ${
                  model.activeDays === 1 ? "day" : "days"
                } active`}
          </span>
        </div>

        <div class="home-week-totals tabular-nums">
          {model.isCurrentWeek && (
            <span class="home-week-pill home-week-pill--today">
              <span class="home-week-pill-label">Today</span>
              <strong>{formatMinutes(model.todayMinutes)}</strong>
            </span>
          )}
          <span class="home-week-pill">
            <span class="home-week-pill-label">
              {model.isCurrentWeek ? "Week" : "Total"}
            </span>
            <strong>{formatMinutes(model.weekMinutes)}</strong>
          </span>
        </div>
      </div>

      {/* 7-Day Interactive Stacked Bar Columns */}
      <div
        class="home-week-bars"
        role="group"
        aria-label="Days of the week"
      >
        {model.days.map((day) => {
          const plainDate = formatCleanDayHeading(day.date, todayStr);
          const ariaSummary =
            day.totalMinutes > 0
              ? `${plainDate}: ${formatMinutes(day.totalMinutes)}`
              : day.totalCount > 0
                ? `${plainDate}: ${day.totalCount} items`
                : `${plainDate}: no activity`;

          const classes = [
            "home-week-day",
            day.isSelected ? "home-week-day--selected" : "",
            day.isToday ? "home-week-day--today" : "",
            !day.isCurrentMonth ? "home-week-day--outside" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              key={day.date}
              type="button"
              class={classes}
              aria-pressed={day.isSelected}
              aria-current={day.isToday ? "date" : undefined}
              aria-label={ariaSummary}
              onClick={() => onSelectDate(day.date)}
            >
              <span
                class="home-week-day-value tabular-nums"
                aria-hidden="true"
              >
                {day.durationLabel}
              </span>

              <span class="home-week-bar-well" aria-hidden="true">
                {day.heightRatio > 0 ? (
                  <span
                    class="home-week-bar-stack"
                    style={{
                      height: `${Math.round(day.heightRatio * 100)}%`,
                    }}
                  >
                    {day.segments.map((seg) => (
                      <span
                        key={seg.category}
                        class="home-week-bar-seg"
                        style={{
                          flexGrow: Math.max(1, seg.sharePct),
                          backgroundColor: categoryCssColor(seg.category),
                        }}
                        title={`${categoryPluralLabel(seg.category)}: ${formatMinutes(
                          seg.minutes
                        )}`}
                      />
                    ))}
                  </span>
                ) : (
                  <span class="home-week-bar-Baseline" />
                )}
              </span>

              <span class="home-week-day-footer" aria-hidden="true">
                <span class="home-week-day-name">{day.weekdayShort}</span>
                <span class="home-week-day-letter">{day.weekdayLetter}</span>
                <span
                  class={
                    day.isToday
                      ? "home-week-day-num home-week-day-num--today tabular-nums"
                      : "home-week-day-num tabular-nums"
                  }
                >
                  {day.dayOfMonth}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
