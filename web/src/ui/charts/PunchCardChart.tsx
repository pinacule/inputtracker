import { useId, useMemo, useState } from "preact/hooks";
import type { HeatmapHourCell } from "../../api";
import { buildPunchCardSummary } from "../../lib/charts";
import { WEEKDAYS_SHORT } from "../../lib/heatmap";
import { formatMinutes } from "../../lib/stats";

export interface PunchCardChartProps {
  /** 2D matrix from `MonthReview.hour_weekday`. */
  hourWeekday?: readonly (readonly number[])[] | null;
  /** Or flat cell list from `GET /api/heatmap/hours`. */
  cells?: readonly HeatmapHourCell[] | null;
  unplacedCount?: number;
  unplacedMinutes?: number;
  title?: string;
  class?: string;
}

const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21] as const;

/**
 * Hand-crafted SVG 7×24 Hour × Weekday Punch Card chart.
 * Shows when across the week and day media is consumed, with interactive
 * cell tooltips and peak rhythm badges.
 */
export function PunchCardChart({
  hourWeekday,
  cells,
  unplacedCount = 0,
  unplacedMinutes = 0,
  title = "Hour × Weekday Rhythm",
  class: className,
}: PunchCardChartProps) {
  const titleId = useId();
  const descId = useId();
  const [activeCell, setActiveCell] = useState<{
    weekday: number;
    hour: number;
    value: number;
  } | null>(null);

  const summary = useMemo(
    () => buildPunchCardSummary(hourWeekday, cells),
    [hourWeekday, cells]
  );

  const svgWidth = 680;
  const svgHeight = 230;
  const padLeft = 44;
  const padRight = 14;
  const padTop = 26;
  const padBottom = 16;
  const gridW = svgWidth - padLeft - padRight;
  const gridH = svgHeight - padTop - padBottom;
  const colW = gridW / 24;
  const rowH = gridH / 7;
  const maxRadius = Math.min(colW, rowH) * 0.44;

  return (
    <div
      class={`ui-punchcard ${className ?? ""}`.trim()}
      onMouseLeave={() => setActiveCell(null)}
    >
      {/* Top Rhythm Summary & Tooltip Bar */}
      <div class="ui-chart-meta-bar">
        <div class="ui-punchcard-peaks">
          {summary.peakWeekday && summary.peakHour ? (
            <>
              <span class="ui-punchcard-peak-chip">
                Peak day: <strong>{summary.peakWeekday.label}</strong> (
                {formatMinutes(summary.peakWeekday.minutes)})
              </span>
              <span class="ui-punchcard-peak-chip">
                Peak hour: <strong>{summary.peakHour.label}</strong> (
                {formatMinutes(summary.peakHour.minutes)})
              </span>
            </>
          ) : (
            <span class="ui-chart-hint">
              Day-precision sessions appear in this 24-hour rhythm grid
            </span>
          )}
        </div>

        <div class="ui-chart-tooltip-inline" role="status" aria-live="polite">
          {activeCell ? (
            <span class="tabular-nums">
              <strong>
                {WEEKDAYS_SHORT[activeCell.weekday]}{" "}
                {String(activeCell.hour).padStart(2, "0")}:00
              </strong>{" "}
              —{" "}
              {activeCell.value > 0
                ? formatMinutes(activeCell.value)
                : "No activity"}
            </span>
          ) : unplacedCount > 0 ? (
            <span class="ui-chart-hint">
              {unplacedCount} offline-synced{" "}
              {unplacedCount === 1 ? "session" : "sessions"} without time of day
            </span>
           ) : unplacedMinutes > 0 ? (
             <span class="ui-chart-hint">{formatMinutes(unplacedMinutes)} of daily time without time of day</span>
           ) : null}
        </div>
      </div>

      {/* SVG 7x24 Punch Card */}
      <div class="ui-chart-svg-wrap">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          class="ui-chart-svg"
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
        >
          <title id={titleId}>{title}</title>
          <desc id={descId}>
            {summary.peakWeekday && summary.peakHour
              ? `Most active on ${summary.peakWeekday.label} and around ${summary.peakHour.label}.`
              : "No timed hourly activity recorded."}
          </desc>

          {/* Hour column headers */}
          {HOUR_TICKS.map((h) => {
            const cx = padLeft + (h + 0.5) * colW;
            return (
              <text
                key={h}
                x={cx}
                y={16}
                text-anchor="middle"
                class="ui-chart-axis-text tabular-nums"
              >
                {`${String(h).padStart(2, "0")}h`}
              </text>
            );
          })}

          {/* Weekday rows */}
          {summary.matrix.map((row, wd) => {
            const cy = padTop + (wd + 0.5) * rowH;
            return (
              <g key={wd}>
                <text
                  x={padLeft - 8}
                  y={cy + 4}
                  text-anchor="end"
                  class="ui-chart-axis-text"
                >
                  {WEEKDAYS_SHORT[wd]}
                </text>

                <line
                  x1={padLeft}
                  y1={cy}
                  x2={svgWidth - padRight}
                  y2={cy}
                  stroke="var(--border-subtle)"
                  stroke-width="0.75"
                />

                {row.map((val, h) => {
                  const cx = padLeft + (h + 0.5) * colW;
                  const ratio =
                    summary.maxCellMinutes > 0 && val > 0
                      ? Math.sqrt(val / summary.maxCellMinutes)
                      : 0;
                  const r =
                    val > 0 ? Math.max(2.6, ratio * maxRadius) : 1.5;
                  const isHovered =
                    activeCell?.weekday === wd && activeCell?.hour === h;

                  return (
                    <g
                      key={h}
                      tabIndex={val > 0 ? 0 : undefined}
                      onMouseEnter={() =>
                        setActiveCell({ weekday: wd, hour: h, value: val })
                      }
                      onFocus={() =>
                        setActiveCell({ weekday: wd, hour: h, value: val })
                      }
                      onClick={() =>
                        setActiveCell({ weekday: wd, hour: h, value: val })
                      }
                    >
                      <rect
                        x={padLeft + h * colW}
                        y={padTop + wd * rowH}
                        width={colW}
                        height={rowH}
                        fill="transparent"
                      />
                      <circle
                        cx={cx}
                        cy={cy}
                        r={isHovered ? r + 1.5 : r}
                        fill={
                          val > 0
                            ? "var(--accent-primary)"
                            : "var(--border-default)"
                        }
                        fill-opacity={
                          val > 0
                            ? Math.min(1, 0.28 + ratio * 0.72)
                            : 0.45
                        }
                        stroke={isHovered ? "var(--text-primary)" : "none"}
                        stroke-width={isHovered ? "1.5" : "0"}
                      >
                        <title>
                          {`${WEEKDAYS_SHORT[wd]} ${String(h).padStart(
                            2,
                            "0"
                          )}:00 — ${val > 0 ? formatMinutes(val) : "0m"}`}
                        </title>
                      </circle>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Visually Hidden Summary Table */}
      <table class="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Weekday</th>
            <th scope="col">Total Time</th>
          </tr>
        </thead>
        <tbody>
          {summary.matrix.map((row, wd) => {
            const rowSum = row.reduce((a, b) => a + b, 0);
            return (
              <tr key={wd}>
                <th scope="row">{WEEKDAYS_SHORT[wd]}</th>
                <td>{formatMinutes(rowSum)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
