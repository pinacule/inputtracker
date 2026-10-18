import { useId, useMemo, useState } from "preact/hooks";
import type { HeatmapDay } from "../../api";
import { formatLocalDay } from "../../lib/format-date";
import {
  WEEKDAYS_SHORT,
  buildYearGrid,
  describeDay,
  levelFor,
  monthLabels,
} from "../../lib/heatmap";
import { formatMinutes } from "../../lib/stats";

export interface HeatmapCalendarChartProps {
  year: number | string;
  days: readonly HeatmapDay[];
  onSelectDay?: (date: string) => void;
  class?: string;
}

const HEAT_FILLS = [
  "var(--heat-0)",
  "var(--heat-1)",
  "var(--heat-2)",
  "var(--heat-3)",
  "var(--heat-4)",
] as const;

const HEAT_STROKES = [
  "var(--border-subtle)",
  "var(--heat-border-1)",
  "var(--heat-border-2)",
  "var(--heat-border-3)",
  "var(--heat-border-4)",
] as const;

/**
 * Hand-crafted SVG 52-week × 7-day Streak & Activity Heatmap Calendar.
 * Lives inside Insights (replacing the standalone Heatmap page), with hover/tap
 * tooltips and click-to-open-day in Calendar.
 */
export function HeatmapCalendarChart({
  year,
  days,
  onSelectDay,
  class: className,
}: HeatmapCalendarChartProps) {
  const titleId = useId();
  const [hoveredDay, setHoveredDay] = useState<HeatmapDay | null>(null);

  const weeks = useMemo(() => {
    try {
      return buildYearGrid(year, days);
    } catch {
      return [];
    }
  }, [year, days]);

  const months = useMemo(() => monthLabels(weeks), [weeks]);

  const { maxMinutes, activeDays, totalMinutes } = useMemo(() => {
    let maxM = 0;
    let active = 0;
    let totalM = 0;
    for (const d of days) {
      const m = Math.max(0, d.minutes ?? 0);
      const c = Math.max(0, d.count ?? 0);
      if (m > 0 || c > 0) {
        active += 1;
        totalM += m;
        const effective = m > 0 ? m : c * 15;
        if (effective > maxM) {
          maxM = effective;
        }
      }
    }
    return {
      maxMinutes: maxM,
      activeDays: active,
      totalMinutes: Math.round(totalM),
    };
  }, [days]);

  const cellSize = 11;
  const cellGap = 3;
  const step = cellSize + cellGap;
  const padLeft = 32;
  const padTop = 20;
  const svgWidth = padLeft + Math.max(53, weeks.length) * step + 8;
  const svgHeight = padTop + 7 * step + 6;

  return (
    <div
      class={`ui-heatmap-chart ${className ?? ""}`.trim()}
      onMouseLeave={() => setHoveredDay(null)}
    >
      <div class="ui-chart-meta-bar">
        <span class="ui-chart-hint tabular-nums">
          <strong>{activeDays}</strong> active{" "}
          {activeDays === 1 ? "day" : "days"} in {year} ·{" "}
          <strong>{formatMinutes(totalMinutes)}</strong> logged
        </span>

        <div class="ui-chart-tooltip-inline" role="status" aria-live="polite">
          {hoveredDay ? (
            <span class="tabular-nums">
              <strong>{formatLocalDay(hoveredDay.date)}</strong>:{" "}
              {hoveredDay.minutes > 0
                ? formatMinutes(hoveredDay.minutes)
                : `${hoveredDay.count} ${
                    hoveredDay.count === 1 ? "item" : "items"
                  }`}{" "}
              ({hoveredDay.count} {hoveredDay.count === 1 ? "entry" : "entries"})
            </span>
          ) : (
            <span class="ui-chart-hint">
              Click any day cell to inspect it in Calendar
            </span>
          )}
        </div>
      </div>

      <div class="ui-heatmap-scroll">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          class="ui-heatmap-svg"
          role="img"
          aria-labelledby={titleId}
        >
          <title id={titleId}>
            Daily activity heatmap for {year} ({activeDays} active days)
          </title>

          {/* Month Labels */}
          {months.map((m) => (
            <text
              key={`${m.month}-${m.weekIndex}`}
              x={padLeft + m.weekIndex * step}
              y={13}
              class="ui-chart-axis-text"
            >
              {m.label}
            </text>
          ))}

          {/* Weekday Labels (Mon, Wed, Fri, Sun) */}
          {[0, 2, 4, 6].map((wd) => (
            <text
              key={wd}
              x={padLeft - 6}
              y={padTop + wd * step + 9}
              text-anchor="end"
              class="ui-chart-axis-text"
            >
              {WEEKDAYS_SHORT[wd]}
            </text>
          ))}

          {/* Week Columns × 7 Day Cells */}
          {weeks.map((week, wIdx) => (
            <g
              key={wIdx}
              transform={`translate(${padLeft + wIdx * step}, ${padTop})`}
            >
              {week.map((cell, dIdx) => {
                if (!cell) {
                  return null;
                }
                const effectiveVal =
                  cell.minutes > 0
                    ? cell.minutes
                    : cell.count > 0
                      ? Math.max(15, cell.count * 15)
                      : 0;
                const level = levelFor(effectiveVal, Math.max(maxMinutes, 60));
                const isHovered = hoveredDay?.date === cell.date;

                return (
                  <rect
                    key={cell.date}
                    x={0}
                    y={dIdx * step}
                    width={cellSize}
                    height={cellSize}
                    rx={2.5}
                    fill={HEAT_FILLS[level] ?? HEAT_FILLS[0]}
                    stroke={
                      isHovered
                        ? "var(--accent-primary)"
                        : HEAT_STROKES[level] ?? HEAT_STROKES[0]
                    }
                    stroke-width={isHovered ? "1.6" : "1"}
                    class="ui-heatmap-cell"
                    tabIndex={cell.count > 0 || cell.minutes > 0 ? 0 : undefined}
                    aria-label={describeDay(cell)}
                    onMouseEnter={() => setHoveredDay(cell)}
                    onFocus={() => setHoveredDay(cell)}
                    onClick={() => {
                      setHoveredDay(cell);
                      onSelectDay?.(cell.date);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectDay?.(cell.date);
                      }
                    }}
                  >
                    <title>{describeDay(cell)}</title>
                  </rect>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
