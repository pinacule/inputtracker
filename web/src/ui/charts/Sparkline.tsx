import { useId } from "preact/hooks";
import { buildSparklineGeometry } from "../../lib/charts";
import { categoryCssColor, type Category } from "../../lib/categories";

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  category?: Category;
  label?: string;
  class?: string;
}

/**
 * Hand-crafted inline SVG sparkline with area gradient fill and end marker.
 */
export function Sparkline({
  values,
  width = 104,
  height = 30,
  category,
  label = "Activity trend",
  class: className,
}: SparklineProps) {
  const id = useId();
  const geom = buildSparklineGeometry(values, width, height, 3);
  const strokeColor = category
    ? categoryCssColor(category)
    : "var(--accent-primary)";
  const gradId = `spark-grad-${id}`;

  if (values.length === 0 || geom.max <= 0) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        class={`ui-sparkline ui-sparkline--empty ${className ?? ""}`.trim()}
        role="img"
        aria-label={`${label}: no activity`}
      >
        <title>{label}: no activity</title>
        <line
          x1={3}
          y1={height - 4}
          x2={width - 3}
          y2={height - 4}
          stroke="var(--border-default)"
          stroke-width="1.5"
          stroke-dasharray="3 3"
        />
      </svg>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      class={`ui-sparkline ${className ?? ""}`.trim()}
      role="img"
      aria-label={`${label} (peak ${Math.round(geom.max)} min)`}
    >
      <title>{label}</title>
      <desc>
        Trend across {values.length} points, ranging from {Math.round(geom.min)}{" "}
        to {Math.round(geom.max)} minutes.
      </desc>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color={strokeColor} stop-opacity="0.28" />
          <stop offset="100%" stop-color={strokeColor} stop-opacity="0.02" />
        </linearGradient>
      </defs>
      <path d={geom.areaPath} fill={`url(#${gradId})`} />
      <path
        d={geom.linePath}
        fill="none"
        stroke={strokeColor}
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      {geom.lastPoint && (
        <circle
          cx={geom.lastPoint.x}
          cy={geom.lastPoint.y}
          r="2.6"
          fill={strokeColor}
        />
      )}
    </svg>
  );
}
