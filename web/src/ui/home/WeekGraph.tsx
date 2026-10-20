import {
  categoryCssColor,
  categoryPluralLabel,
} from "../../lib/categories";
import { formatCleanDayHeading } from "../../lib/home";
import type { RollingGraphModel } from "../../lib/home-norm";
import { formatMinutes } from "../../lib/stats";
import { IconButton } from "../IconButton";
import { ChevronLeftIcon, ChevronRightIcon } from "../icons";

export interface WeekGraphProps {
  readonly model: RollingGraphModel;
  readonly todayStr: string;
  readonly onSelectDate: (date: string) => void;
  readonly onStepWindow: (delta: number) => void;
}

/**
 * Rolling seven-day pills, with weekday median markers on the same minute scale.
 * Answers "What did I do today and this week?" at a glance on phone and desktop,
 * and acts as a fast 7-day thumb switcher.
 */
export function WeekGraph({
  model,
  todayStr,
  onSelectDate,
  onStepWindow,
}: WeekGraphProps) {
  return (
    <section
      class="home-card home-week-card"
      aria-label={`${model.heading} activity graph`}
    >
      <div class="home-week-header">
        <div class="home-week-titles">
          <h2 class="home-section-title">{model.heading}</h2>
        </div>

        <div class="home-week-totals">
          <IconButton label="Previous 7 days" variant="ghost" size="sm" onClick={() => onStepWindow(-1)}>
            <ChevronLeftIcon size={17} />
          </IconButton>
          <IconButton label="Next 7 days" variant="ghost" size="sm" disabled={model.endDate >= todayStr} onClick={() => onStepWindow(1)}>
            <ChevronRightIcon size={17} />
          </IconButton>
        </div>
      </div>

      {/* 7-Day Interactive Stacked Bar Columns */}
      <div
        class="home-week-bars"
        role="group"
        aria-label="Seven days, oldest to newest"
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
              aria-label={`${ariaSummary}; usual ${formatMinutes(model.norms.get(day.date) ?? 0)}`}
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
                          flexGrow: seg.sharePct,
                          flexBasis: 0,
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
                <span class="home-week-norm-marker" style={{ bottom: `${(model.normRatios.get(day.date) ?? 0) * 100}%` }} />
              </span>

              <span class="home-week-day-footer" aria-hidden="true">
                <span class="home-week-day-name">{day.weekdayShort}</span>
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
      <div class="home-week-comparisons tabular-nums" aria-live="polite">
        <p>{model.daySentence}</p>
        <p>{model.windowSentence}</p>
        <span class="home-week-sub">Faint line: your usual amount · weekday median over 8 weeks, or 30-day median with little history</span>
      </div>
    </section>
  );
}
