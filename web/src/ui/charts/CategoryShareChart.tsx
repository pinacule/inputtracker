import { useId, useMemo, useState } from "preact/hooks";
import type { Category, CategoryTotal } from "../../api";
import { buildCategoryShare } from "../../lib/charts";
import {
  categoryCssColor,
  categoryPluralLabel,
  formatCategoryUnits,
} from "../../lib/categories";
import { formatMinutes } from "../../lib/stats";

export interface CategoryShareChartProps {
  categories: readonly CategoryTotal[];
  selectedCategory?: Category | "";
  onSelectCategory?: (category: Category | "") => void;
  compact?: boolean;
  title?: string;
  class?: string;
}

/**
 * Hand-crafted SVG Category Share chart:
 * - In `compact` mode (e.g. Calendar month bar): renders an interactive multi-segment
 *   stacked proportion bar + clickable category pills with hours & share.
 * - In full mode (Insights / Review): renders an SVG donut ring alongside ranked
 *   horizontal share bars and unit counts, plus a `.sr-only` data table.
 */
export function CategoryShareChart({
  categories,
  selectedCategory = "",
  onSelectCategory,
  compact = false,
  title = "Share by category",
  class: className,
}: CategoryShareChartProps) {
  const titleId = useId();
  const [hoveredCat, setHoveredCat] = useState<Category | null>(null);

  const share = useMemo(() => buildCategoryShare(categories), [categories]);

  if (share.slices.length === 0) {
    return (
      <div class={`ui-cat-share-empty ${className ?? ""}`.trim()}>
        <span>No category activity recorded in this period.</span>
      </div>
    );
  }

  const activeSlice =
    share.slices.find((s) => s.category === (hoveredCat || selectedCategory)) ??
    null;

  if (compact) {
    return (
      <div class={`ui-cat-share-compact ${className ?? ""}`.trim()}>
        {/* Proportional Stacked SVG Bar */}
        <svg
          viewBox="0 0 400 12"
          preserveAspectRatio="none"
          class="ui-cat-share-bar-svg"
          role="img"
          aria-label={title}
        >
          <title>{title}</title>
          {share.slices.map((s) => {
            const x = s.startFraction * 400;
            const w = Math.max(2, s.fraction * 400);
            const isDimmed =
              Boolean(selectedCategory) && selectedCategory !== s.category;
            return (
              <rect
                key={s.category}
                x={x}
                y={0}
                width={w}
                height={12}
                fill={categoryCssColor(s.category)}
                opacity={isDimmed ? 0.32 : 1}
              >
                <title>
                  {`${categoryPluralLabel(s.category)}: ${formatMinutes(
                    s.totalMinutes
                  )} (${s.sharePct}%)`}
                </title>
              </rect>
            );
          })}
        </svg>

        <div class="ui-cat-share-pills">
          {share.slices.map((s) => {
            const isSelected = selectedCategory === s.category;
            const labelText =
              s.totalMinutes > 0
                ? formatMinutes(s.totalMinutes)
                : formatCategoryUnits(s.category, s.units);

            if (onSelectCategory) {
              return (
                <button
                  key={s.category}
                  type="button"
                  class={
                    isSelected
                      ? "ui-cat-pill ui-cat-pill--active"
                      : "ui-cat-pill"
                  }
                  aria-pressed={isSelected}
                  onClick={() =>
                    onSelectCategory(isSelected ? "" : s.category)
                  }
                >
                  <span
                    class={`ui-tab-dot ui-tab-dot--${s.category}`}
                    aria-hidden="true"
                  />
                  <span class="ui-cat-pill-name">
                    {categoryPluralLabel(s.category)}
                  </span>
                  <span class="ui-cat-pill-val tabular-nums">{labelText}</span>
                </button>
              );
            }

            return (
              <span key={s.category} class="ui-cat-pill">
                <span
                  class={`ui-tab-dot ui-tab-dot--${s.category}`}
                  aria-hidden="true"
                />
                <span class="ui-cat-pill-name">
                  {categoryPluralLabel(s.category)}
                </span>
                <span class="ui-cat-pill-val tabular-nums">{labelText}</span>
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  // Full Donut + Ranked Horizontal Bars
  const radius = 56;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      class={`ui-cat-share-full ${className ?? ""}`.trim()}
      onMouseLeave={() => setHoveredCat(null)}
    >
      {/* Left: SVG Donut Ring */}
      <div class="ui-cat-donut-wrap">
        <svg
          width="156"
          height="156"
          viewBox="0 0 156 156"
          class="ui-cat-donut-svg"
          role="img"
          aria-labelledby={titleId}
        >
          <title id={titleId}>{title}</title>
          <circle
            cx="78"
            cy="78"
            r={radius}
            fill="none"
            stroke="var(--bg-subtle)"
            stroke-width="20"
          />
          {share.slices.map((s) => {
            const dash = Math.max(0, s.fraction * circumference);
            const gap = Math.max(0, circumference - dash);
            const offset = -s.startFraction * circumference;
            const isHighlighted =
              hoveredCat === s.category || selectedCategory === s.category;
            return (
              <circle
                key={s.category}
                cx="78"
                cy="78"
                r={radius}
                fill="none"
                stroke={categoryCssColor(s.category)}
                stroke-width={isHighlighted ? "23" : "20"}
                stroke-dasharray={`${dash} ${gap}`}
                stroke-dashoffset={offset}
                transform="rotate(-90 78 78)"
                class="ui-cat-donut-segment"
                onMouseEnter={() => setHoveredCat(s.category)}
                onClick={() =>
                  onSelectCategory?.(
                    selectedCategory === s.category ? "" : s.category
                  )
                }
              >
                <title>
                  {`${categoryPluralLabel(s.category)}: ${formatMinutes(
                    s.totalMinutes
                  )} (${s.sharePct}%)`}
                </title>
              </circle>
            );
          })}
          <text
            x="78"
            y="74"
            text-anchor="middle"
            class="ui-cat-donut-center-val tabular-nums"
          >
            {activeSlice
              ? `${activeSlice.sharePct}%`
              : formatMinutes(share.totalMinutes)}
          </text>
          <text
            x="78"
            y="92"
            text-anchor="middle"
            class="ui-cat-donut-center-label"
          >
            {activeSlice
              ? categoryPluralLabel(activeSlice.category)
              : `${share.totalWorks} works`}
          </text>
        </svg>
      </div>

      {/* Right: Ranked Horizontal Share Rows */}
      <ul class="ui-cat-share-list">
        {share.slices.map((s) => {
          const isSelected = selectedCategory === s.category;
          const isHovered = hoveredCat === s.category;
          return (
            <li
              key={s.category}
              class={
                isSelected || isHovered
                  ? "ui-cat-share-row ui-cat-share-row--active"
                  : "ui-cat-share-row"
              }
              onMouseEnter={() => setHoveredCat(s.category)}
            >
              <div class="ui-cat-share-row-top">
                <div class="ui-cat-share-row-title">
                  <span
                    class={`ui-tab-dot ui-tab-dot--${s.category}`}
                    aria-hidden="true"
                  />
                  <span class="ui-cat-share-name">
                    {categoryPluralLabel(s.category)}
                  </span>
                  <span class="ui-cat-share-meta tabular-nums">
                    {s.works > 0 ? `${s.works} ${s.works === 1 ? "work" : "works"} · ` : ""}
                    {formatCategoryUnits(s.category, s.units)}
                  </span>
                </div>
                <div class="ui-cat-share-row-figures tabular-nums">
                  <strong>
                    {s.totalMinutes > 0
                      ? formatMinutes(s.totalMinutes)
                      : formatCategoryUnits(s.category, s.units)}
                  </strong>
                  <span class="ui-cat-share-pct">{s.sharePct}%</span>
                </div>
              </div>
              <div class="ui-cat-share-track" aria-hidden="true">
                <div
                  class="ui-cat-share-fill"
                  style={{
                    width: `${Math.max(2, s.sharePct)}%`,
                    backgroundColor: categoryCssColor(s.category),
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {/* Screen-reader data table */}
      <table class="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Time</th>
            <th scope="col">Share</th>
            <th scope="col">Works</th>
            <th scope="col">Units</th>
          </tr>
        </thead>
        <tbody>
          {share.slices.map((s) => (
            <tr key={s.category}>
              <th scope="row">{categoryPluralLabel(s.category)}</th>
              <td>{formatMinutes(s.totalMinutes)}</td>
              <td>{s.sharePct}%</td>
              <td>{s.works}</td>
              <td>{s.units}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
