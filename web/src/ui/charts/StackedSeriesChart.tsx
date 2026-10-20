import { useId, useMemo, useState } from "preact/hooks";
import type { Category, SeriesPoint } from "../../api";
import {
  buildStackedSeriesLayout,
  type StackedBarDatum,
} from "../../lib/charts";
import {
  categoryCssColor,
  categoryPluralLabel,
} from "../../lib/categories";
import { formatLocalDay } from "../../lib/format-date";
import { formatMinutes, formatMinutesShort } from "../../lib/stats";

export interface StackedSeriesChartProps {
  points: readonly SeriesPoint[];
  bucketType?: "day" | "week" | "month";
  title?: string;
  description?: string;
  height?: number;
  onSelectBucket?: (bucket: string) => void;
  class?: string;
}

function formatFullBucketHeading(
  bucket: string,
  bucketType?: "day" | "week" | "month"
): string {
  if (bucketType === "day" || /^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    return formatLocalDay(bucket);
  }
  return bucket;
}

/**
 * Hand-made accessible SVG stacked bar chart showing minutes per category over time.
 * Includes interactive hover/tap/focus tooltips and a visually hidden data table.
 */
export function StackedSeriesChart({
  points,
  bucketType = "day",
  title = "Minutes by category over time",
  description,
  height = 220,
  onSelectBucket,
  class: className,
}: StackedSeriesChartProps) {
  const titleId = useId();
  const descId = useId();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const layout = useMemo(
    () => buildStackedSeriesLayout(points, bucketType),
    [points, bucketType]
  );

  const activeBar: StackedBarDatum | null =
    activeIndex !== null && layout.bars[activeIndex]
      ? layout.bars[activeIndex]!
      : null;

  // SVG coordinate system
  const svgWidth = 760;
  const svgHeight = height;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 28;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = svgHeight - padTop - padBottom;
  const baselineY = padTop + plotH;

  const barCount = Math.max(1, layout.bars.length);
  const slotW = plotW / barCount;
  const barW = Math.max(3, Math.min(34, slotW * 0.72));

  // Decide which x-axis labels to show so 30+ daily bars don't collide
  const labelStride =
    barCount > 24 ? 5 : barCount > 14 ? 2 : 1;

  if (layout.bars.length === 0) {
    return (
      <div class={`ui-chart-empty ${className ?? ""}`.trim()}>
        <p>No time series data for this period.</p>
      </div>
    );
  }

  return (
    <div
      class={`ui-chart-container ${className ?? ""}`.trim()}
      onMouseLeave={() => setActiveIndex(null)}
    >
      {/* Category Legend + Active Tooltip Header */}
      <div class="ui-chart-meta-bar">
        <div class="ui-chart-legend" aria-label="Categories in chart">
          {layout.activeCategories.length === 0 ? (
            <span class="ui-chart-legend-empty">No timed activity in range</span>
          ) : (
            layout.activeCategories.map((cat: Category) => (
              <span key={cat} class="ui-chart-legend-item">
                <span
                  class={`ui-tab-dot ui-tab-dot--${cat}`}
                  aria-hidden="true"
                />
                <span>{categoryPluralLabel(cat)}</span>
              </span>
            ))
          )}
        </div>

        <div class="ui-chart-tooltip-inline" role="status" aria-live="polite">
          {activeBar ? (
            <div class="ui-chart-tooltip-content">
              <strong class="tabular-nums">
                {formatFullBucketHeading(activeBar.bucket, bucketType)}
              </strong>
              <span class="ui-chart-tooltip-total tabular-nums">
                {formatMinutes(activeBar.totalMinutes)}
              </span>
              {activeBar.segments.map((seg) => (
                <span
                  key={seg.category}
                  class="ui-chart-tooltip-seg tabular-nums"
                >
                  <span
                    class={`ui-tab-dot ui-tab-dot--${seg.category}`}
                    aria-hidden="true"
                  />
                  {categoryPluralLabel(seg.category)}:{" "}
                  {formatMinutes(seg.minutes)}
                </span>
              ))}
            </div>
          ) : (
            <span class="ui-chart-hint">
              Hover or tap a bar to inspect category breakdown
            </span>
          )}
        </div>
      </div>

      {/* Responsive SVG Canvas */}
      <div class="ui-chart-svg-wrap">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          class="ui-chart-svg"
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
        >
          <title id={titleId}>{title}</title>
          <desc id={descId}>
            {description ??
              `Stacked bar chart across ${layout.bars.length} ${bucketType}s, totalling ${formatMinutes(
                layout.totalMinutes
              )}.`}
          </desc>

          {/* Horizontal Gridlines & Y-Axis Labels */}
          {layout.ticks.map((tick) => {
            const ratio =
              layout.ceilingMinutes > 0 ? tick / layout.ceilingMinutes : 0;
            const y = Math.round((baselineY - ratio * plotH) * 10) / 10;
            return (
              <g key={tick} class="ui-chart-grid-group">
                <line
                  x1={padLeft}
                  y1={y}
                  x2={svgWidth - padRight}
                  y2={y}
                  stroke="var(--border-subtle)"
                  stroke-dasharray={tick === 0 ? undefined : "3 3"}
                  stroke-width="1"
                />
                <text
                  x={padLeft - 8}
                  y={y + 4}
                  text-anchor="end"
                  class="ui-chart-axis-text tabular-nums"
                >
                  {tick === 0 ? "0" : formatMinutesShort(tick)}
                </text>
              </g>
            );
          })}

          {/* Bars */}
          {layout.bars.map((bar, idx) => {
            const centerX = padLeft + (idx + 0.5) * slotW;
            const barX = centerX - barW / 2;
            const isHovered = activeIndex === idx;
            const showLabel =
              idx % labelStride === 0 || idx === layout.bars.length - 1;

            return (
              <g
                key={bar.bucket}
                class={
                  isHovered
                    ? "ui-chart-bar-group ui-chart-bar-group--active"
                    : "ui-chart-bar-group"
                }
                tabIndex={0}
                role={onSelectBucket ? "button" : undefined}
                aria-label={`${formatFullBucketHeading(
                  bar.bucket,
                  bucketType
                )}: ${formatMinutes(bar.totalMinutes)}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onFocus={() => setActiveIndex(idx)}
                onClick={() => {
                  setActiveIndex(idx);
                  onSelectBucket?.(bar.bucket);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveIndex(idx);
                    onSelectBucket?.(bar.bucket);
                  }
                }}
              >
                {/* Invisible full-height hit target for easy touch/hover */}
                <rect
                  x={padLeft + idx * slotW}
                  y={padTop}
                  width={slotW}
                  height={plotH + padBottom}
                  fill={isHovered ? "var(--bg-subtle)" : "transparent"}
                  opacity={isHovered ? 0.55 : 0}
                  rx="4"
                />

                {/* Stacked Category Segments */}
                {bar.segments.map((seg, sIdx) => {
                  const segH = Math.max(2, seg.heightRatio * plotH);
                  const segY =
                    baselineY - (seg.offsetRatio + seg.heightRatio) * plotH;
                  const isTopSegment = sIdx === bar.segments.length - 1;
                  return (
                    <rect
                      key={seg.category}
                      class={isTopSegment ? "ui-chart-segment ui-chart-segment--top" : "ui-chart-segment"}
                      x={barX}
                      y={Math.max(padTop, segY)}
                      width={barW}
                      height={segH}
                      rx={isTopSegment ? 3 : 1}
                      fill={categoryCssColor(seg.category)}
                    >
                      <title>
                        {`${formatFullBucketHeading(
                          bar.bucket,
                          bucketType
                        )} · ${categoryPluralLabel(
                          seg.category
                        )}: ${formatMinutes(seg.minutes)}`}
                      </title>
                    </rect>
                  );
                })}

                {/* X-Axis Label */}
                {showLabel && (
                  <text
                    x={centerX}
                    y={svgHeight - 7}
                    text-anchor="middle"
                    class={
                      isHovered
                        ? "ui-chart-axis-text ui-chart-axis-text--active tabular-nums"
                        : "ui-chart-axis-text tabular-nums"
                    }
                  >
                    {bar.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Visually Hidden Data Table for Screen Readers */}
      <table class="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Total Time</th>
            {layout.activeCategories.map((cat) => (
              <th key={cat} scope="col">
                {categoryPluralLabel(cat)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {layout.bars.map((bar) => (
            <tr key={bar.bucket}>
              <th scope="row">{bar.bucket}</th>
              <td>{formatMinutes(bar.totalMinutes)}</td>
              {layout.activeCategories.map((cat) => {
                const found = bar.segments.find((s) => s.category === cat);
                return (
                  <td key={cat}>{formatMinutes(found?.minutes ?? 0)}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
