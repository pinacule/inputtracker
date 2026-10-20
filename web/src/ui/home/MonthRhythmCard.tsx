import { useState } from "preact/hooks";
import type { Category } from "../../api";
import {
  categoryCssColor,
  categoryPluralLabel,
  formatCategoryUnits,
} from "../../lib/categories";
import {
  formatCleanDayHeading,
  type MonthRhythmModel,
  type MonthSkylineBar,
} from "../../lib/home";
import { formatMinutes } from "../../lib/stats";

export interface MonthRhythmCardProps {
  readonly model: MonthRhythmModel;
  readonly todayStr: string;
  readonly selectedCategories: readonly Category[];
  readonly onSelectDate: (date: string) => void;
  readonly onToggleCategory: (category: Category) => void;
}

/**
 * Month Rhythm & Skyline Graph Card:
 * Replaces numerical KPI boxes with two visual graphs for the month:
 * 1. Proportional Category Share Bar + clickable category breakdown pills.
 * 2. 31-day Daily Skyline Stacked Bar Chart (click any day bar to select that day).
 */
export function MonthRhythmCard({
  model,
  todayStr,
  selectedCategories,
  onSelectDate,
  onToggleCategory,
}: MonthRhythmCardProps) {
  const [hoveredDay, setHoveredDay] = useState<MonthSkylineBar | null>(null);

  const inspectedBar =
    hoveredDay ??
    model.skyline.find((b) => b.isSelected) ??
    null;

  return (
    <section
      class="home-card home-rhythm-card"
      aria-label={`${model.heading} overview graph`}
    >
      <h2 class="home-section-title">{model.heading}</h2>
      {/* Top summary row */}
      <div class="home-rhythm-header">
        <div class="home-rhythm-summary">
          <strong class="home-rhythm-total tabular-nums">
            {formatMinutes(model.totalMinutes)}
          </strong>
          <span class="home-rhythm-meta tabular-nums">
            {model.activeDays === 0
              ? `No activity in ${model.heading}`
              : `${model.activeDays} active ${
                  model.activeDays === 1 ? "day" : "days"
                }`}
            {model.deltaLabel ? ` · ${model.deltaLabel}` : ""}
          </span>
        </div>

        {inspectedBar && (inspectedBar.totalMinutes > 0 || inspectedBar.totalCount > 0) && (
          <div class="home-rhythm-readout tabular-nums" aria-live="polite">
            <span>{formatCleanDayHeading(inspectedBar.date, todayStr)}</span>
            <strong>
              {inspectedBar.totalMinutes > 0
                ? formatMinutes(inspectedBar.totalMinutes)
                : `${inspectedBar.totalCount} items`}
            </strong>
          </div>
        )}
      </div>

      {(model.undatedMinutes ?? 0) > 0 && (
        <p class="home-week-sub">Includes {formatMinutes(model.undatedMinutes!)} known only to this month, not shown in daily bars.</p>
      )}

      {model.categoryShares.length > 0 && (
        <>
          {/* 1. Proportional Category Share Bar */}
          <div
            class="home-share-bar home-share-bar--lg"
            role="img"
            aria-label={`Category share for ${model.heading}`}
          >
            {model.categoryShares.map((s) => (
              <span
                key={s.category}
                class="home-share-bar-seg"
                style={{
                  width: `${Math.max(2.5, s.sharePct)}%`,
                  backgroundColor: categoryCssColor(s.category),
                }}
                title={`${s.label}: ${
                  s.totalMinutes > 0
                    ? formatMinutes(s.totalMinutes)
                    : formatCategoryUnits(s.category, s.units)
                } (${Math.round(s.sharePct)}%)`}
              />
            ))}
          </div>

          {/* Inline Category Breakdown Legend Pills */}
          <div class="home-rhythm-cats" role="group" aria-label="Month categories">
            {model.categoryShares.map((s) => {
              const isSelected = selectedCategories.includes(s.category);
              const valLabel =
                s.totalMinutes > 0
                  ? formatMinutes(s.totalMinutes)
                  : formatCategoryUnits(s.category, s.units);
              return (
                <button
                  key={s.category}
                  type="button"
                  class={
                    isSelected
                      ? "home-rhythm-cat-pill home-rhythm-cat-pill--active"
                      : "home-rhythm-cat-pill"
                  }
                  aria-pressed={isSelected}
                  onClick={() => onToggleCategory(s.category)}
                >
                  <span
                    class={`ui-tab-dot ui-tab-dot--${s.category}`}
                    aria-hidden="true"
                  />
                  <span>{s.label}</span>
                  <strong class="tabular-nums">{valLabel}</strong>
                </button>
              );
            })}
          </div>

          {/* 2. 31-Day Daily Skyline Graph */}
          <div
            class="home-skyline"
            role="group"
            aria-label={`Daily activity bars for ${model.heading}`}
            onMouseLeave={() => setHoveredDay(null)}
          >
            {model.skyline.map((bar) => {
              const showTick =
                bar.dayOfMonth === 1 ||
                bar.dayOfMonth === 8 ||
                bar.dayOfMonth === 15 ||
                bar.dayOfMonth === 22 ||
                bar.dayOfMonth === model.daysInMonth ||
                bar.isSelected;

              const plainDay = formatCleanDayHeading(bar.date, todayStr);
              const barLabel =
                bar.totalMinutes > 0
                  ? `${plainDay}: ${formatMinutes(bar.totalMinutes)}`
                  : bar.totalCount > 0
                    ? `${plainDay}: ${bar.totalCount} items`
                    : `${plainDay}: 0m`;

              const classes = [
                "home-skyline-col",
                bar.isSelected ? "home-skyline-col--selected" : "",
                bar.isToday ? "home-skyline-col--today" : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  key={bar.date}
                  type="button"
                  class={classes}
                  aria-pressed={bar.isSelected}
                  aria-label={barLabel}
                  onMouseEnter={() => setHoveredDay(bar)}
                  onFocus={() => setHoveredDay(bar)}
                  onClick={() => onSelectDate(bar.date)}
                >
                  <span class="home-skyline-well" aria-hidden="true">
                    {bar.heightRatio > 0 ? (
                      <span
                        class="home-skyline-stack"
                        style={{
                          height: `${Math.round(bar.heightRatio * 100)}%`,
                        }}
                      >
                        {bar.segments.map((seg) => (
                          <span
                            key={seg.category}
                            class="home-skyline-seg"
                            style={{
                              flexGrow: Math.max(1, seg.sharePct),
                              backgroundColor: categoryCssColor(seg.category),
                            }}
                            title={`${categoryPluralLabel(
                              seg.category
                            )}: ${formatMinutes(seg.minutes)}`}
                          />
                        ))}
                      </span>
                    ) : (
                      <span class="home-skyline-dot" />
                    )}
                  </span>
                  <span
                    class={
                      bar.isSelected
                        ? "home-skyline-tick home-skyline-tick--selected tabular-nums"
                        : "home-skyline-tick tabular-nums"
                    }
                    aria-hidden="true"
                  >
                    {showTick ? bar.dayOfMonth : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
