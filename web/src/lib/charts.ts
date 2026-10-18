/**
 * Pure chart scales, geometry, sparkline paths, punch-card normalization,
 * and time-range presets for InputTracker v2 SVG charts.
 *
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import type {
  Category,
  CategoryTotal,
  HeatmapHourCell,
  SeriesPoint,
} from "../api";
import { CATEGORIES, isCategory } from "./categories";
import { WEEKDAYS_SHORT } from "./heatmap";

// --- Axis Ticks & Scales ---------------------------------------------------

/**
 * Computes human-friendly axis tick values (in minutes) from `0` up to a clean
 * ceiling >= `maxMinutes`.
 */
export function computeChartTicks(
  maxMinutes: number,
  targetTicks = 4
): number[] {
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
    return [0, 30, 60];
  }

  // Nice step intervals in minutes (15m, 30m, 1h, 2h, 3h, 4h, 6h, 12h, 24h, 50h, 100h, ...)
  const niceSteps = [
    5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 600, 900, 1200, 1800, 2400,
    3000, 6000, 12000,
  ];
  const rawStep = maxMinutes / Math.max(2, targetTicks);
  let step = niceSteps.find((s) => s >= rawStep);
  if (!step) {
    const hoursStep = Math.ceil(rawStep / 600) * 600;
    step = Math.max(600, hoursStep);
  }

  const ceiling = Math.ceil(maxMinutes / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= ceiling; v += step) {
    ticks.push(v);
  }
  return ticks;
}

// --- Stacked Series Chart Geometry -----------------------------------------

export interface StackedBarSegment {
  readonly category: Category;
  readonly minutes: number;
  /** Fraction 0..1 of the chart ceiling. */
  readonly heightRatio: number;
  /** Bottom offset fraction 0..1 from the chart baseline. */
  readonly offsetRatio: number;
}

export interface StackedBarDatum {
  readonly bucket: string;
  readonly label: string;
  readonly totalMinutes: number;
  readonly heightRatio: number;
  readonly segments: readonly StackedBarSegment[];
}

export interface StackedSeriesLayout {
  readonly bars: readonly StackedBarDatum[];
  readonly activeCategories: readonly Category[];
  readonly maxMinutes: number;
  readonly ceilingMinutes: number;
  readonly ticks: readonly number[];
  readonly totalMinutes: number;
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Formats a `SeriesPoint.bucket` ("YYYY-MM-DD", "YYYY-Www", "YYYY-MM") into a
 * concise axis label.
 */
export function formatSeriesBucketLabel(
  bucket: string,
  bucketType?: "day" | "week" | "month"
): string {
  if (bucketType === "day" || /^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
    const dayNum = Number.parseInt(bucket.slice(8, 10), 10);
    const monthNum = Number.parseInt(bucket.slice(5, 7), 10);
    if (dayNum === 1 && monthNum >= 1 && monthNum <= 12) {
      return `${SHORT_MONTHS[monthNum - 1]} 1`;
    }
    return Number.isNaN(dayNum) ? bucket : String(dayNum);
  }
  if (bucketType === "week" || /^\d{4}-W\d{2}$/.test(bucket)) {
    const m = /^(\d{4})-W(\d{2})$/.exec(bucket);
    return m ? `W${m[2]}` : bucket;
  }
  if (bucketType === "month" || /^\d{4}-\d{2}$/.test(bucket)) {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(bucket);
    if (m) {
      const idx = Number.parseInt(m[2]!, 10) - 1;
      return SHORT_MONTHS[idx] ?? bucket;
    }
  }
  return bucket;
}

/**
 * Computes stacked bar geometry and active categories from `SeriesPoint[]`.
 */
export function buildStackedSeriesLayout(
  points: readonly SeriesPoint[],
  bucketType?: "day" | "week" | "month"
): StackedSeriesLayout {
  const categorySeen = new Set<Category>();
  let maxMinutes = 0;
  let totalMinutes = 0;

  const pointTotals = points.map((pt) => {
    let sum = 0;
    const byCat = pt.minutes_by_category ?? {};
    for (const cat of CATEGORIES) {
      const val = byCat[cat];
      if (typeof val === "number" && Number.isFinite(val) && val > 0) {
        sum += val;
        categorySeen.add(cat);
      }
    }
    // Also check any unexpected keys that match Category
    for (const [key, val] of Object.entries(byCat)) {
      if (
        isCategory(key) &&
        !categorySeen.has(key) &&
        typeof val === "number" &&
        val > 0
      ) {
        categorySeen.add(key);
      }
    }
    if (sum > maxMinutes) {
      maxMinutes = sum;
    }
    totalMinutes += sum;
    return sum;
  });

  const ticks = computeChartTicks(maxMinutes, 4);
  const ceilingMinutes = Math.max(ticks[ticks.length - 1] ?? 60, maxMinutes, 1);
  const activeCategories = CATEGORIES.filter((c) => categorySeen.has(c));

  const bars: StackedBarDatum[] = points.map((pt, idx) => {
    const barTotal = pointTotals[idx] ?? 0;
    const byCat = pt.minutes_by_category ?? {};
    let currentOffset = 0;
    const segments: StackedBarSegment[] = [];

    for (const cat of activeCategories) {
      const val = byCat[cat] ?? 0;
      if (val > 0) {
        const hRatio = Math.min(1, val / ceilingMinutes);
        segments.push({
          category: cat,
          minutes: Math.round(val),
          heightRatio: hRatio,
          offsetRatio: currentOffset,
        });
        currentOffset += hRatio;
      }
    }

    return {
      bucket: pt.bucket,
      label: formatSeriesBucketLabel(pt.bucket, bucketType),
      totalMinutes: Math.round(barTotal),
      heightRatio: Math.min(1, barTotal / ceilingMinutes),
      segments,
    };
  });

  return {
    bars,
    activeCategories,
    maxMinutes: Math.round(maxMinutes),
    ceilingMinutes,
    ticks,
    totalMinutes: Math.round(totalMinutes),
  };
}

// --- Category Share Breakdown ----------------------------------------------

export interface CategoryShareSlice {
  readonly category: Category;
  readonly totalMinutes: number;
  readonly works: number;
  readonly units: number;
  /** Percentage 0..100 (rounded to 1 decimal). */
  readonly sharePct: number;
  /** Exact fraction 0..1 for SVG arc/bar math. */
  readonly fraction: number;
  /** Cumulative start fraction 0..1. */
  readonly startFraction: number;
}

/**
 * Sorts categories by time (or units when all times are 0) and computes share
 * percentages and cumulative fractions for stacked bars and donut rings.
 */
export function buildCategoryShare(
  categories: readonly CategoryTotal[]
): {
  slices: CategoryShareSlice[];
  totalMinutes: number;
  totalWorks: number;
  totalUnits: number;
} {
  const valid = categories.filter(
    (c) =>
      isCategory(c.category) &&
      ((c.total_minutes ?? 0) > 0 || (c.units ?? 0) > 0 || (c.works ?? 0) > 0)
  );

  const totalMinutes = valid.reduce(
    (acc, c) => acc + Math.max(0, c.total_minutes ?? 0),
    0
  );
  const totalWorks = valid.reduce(
    (acc, c) => acc + Math.max(0, c.works ?? 0),
    0
  );
  const totalUnits = valid.reduce(
    (acc, c) => acc + Math.max(0, c.units ?? 0),
    0
  );

  const sorted = [...valid].sort((a, b) => {
    if (b.total_minutes !== a.total_minutes) {
      return b.total_minutes - a.total_minutes;
    }
    if (b.units !== a.units) {
      return b.units - a.units;
    }
    return b.works - a.works;
  });

  const denominator = totalMinutes > 0 ? totalMinutes : Math.max(1, totalUnits);
  let cursor = 0;

  const slices: CategoryShareSlice[] = sorted.map((c) => {
    const metric =
      totalMinutes > 0
        ? Math.max(0, c.total_minutes ?? 0)
        : Math.max(0, c.units ?? 0);
    const fraction = denominator > 0 ? metric / denominator : 0;
    const slice: CategoryShareSlice = {
      category: c.category,
      totalMinutes: Math.round(Math.max(0, c.total_minutes ?? 0)),
      works: Math.max(0, c.works ?? 0),
      units: Math.max(0, c.units ?? 0),
      sharePct: Math.round(fraction * 1000) / 10,
      fraction,
      startFraction: cursor,
    };
    cursor += fraction;
    return slice;
  });

  return {
    slices,
    totalMinutes: Math.round(totalMinutes),
    totalWorks,
    totalUnits,
  };
}

// --- Punch-Card (Hour × Weekday) Matrix ------------------------------------

export interface PunchCardSummary {
  /** 7 rows (0=Mon..6=Sun) × 24 columns (0..23 hours) of minutes. */
  readonly matrix: readonly (readonly number[])[];
  readonly maxCellMinutes: number;
  readonly totalMinutes: number;
  readonly peakWeekday: { index: number; label: string; minutes: number } | null;
  readonly peakHour: { hour: number; label: string; minutes: number } | null;
}

/**
 * Normalizes either a `MonthReview["hour_weekday"]` 2D array (handling both
 * `24×7` `[hour][weekday]` and `7×24` `[weekday][hour]` shapes) or a
 * `HeatmapHourCell[]` array into a canonical `7 (Mon..Sun) × 24 (0..23)` matrix.
 */
export function buildPunchCardSummary(
  hourWeekday?: readonly (readonly number[])[] | null,
  cells?: readonly HeatmapHourCell[] | null
): PunchCardSummary {
  const matrix: number[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0)
  );

  if (hourWeekday && hourWeekday.length > 0) {
    if (hourWeekday.length === 24 && (hourWeekday[0]?.length ?? 0) === 7) {
      // [hour 0..23][weekday 0..6]
      for (let h = 0; h < 24; h++) {
        for (let wd = 0; wd < 7; wd++) {
          const val = hourWeekday[h]?.[wd] ?? 0;
          if (Number.isFinite(val) && val > 0) {
            matrix[wd]![h]! += val;
          }
        }
      }
    } else {
      // [weekday 0..6][hour 0..23]
      for (let wd = 0; wd < Math.min(7, hourWeekday.length); wd++) {
        const row = hourWeekday[wd] ?? [];
        for (let h = 0; h < Math.min(24, row.length); h++) {
          const val = row[h] ?? 0;
          if (Number.isFinite(val) && val > 0) {
            matrix[wd]![h]! += val;
          }
        }
      }
    }
  } else if (cells && cells.length > 0) {
    for (const c of cells) {
      if (
        Number.isInteger(c.weekday) &&
        c.weekday >= 0 &&
        c.weekday < 7 &&
        Number.isInteger(c.hour) &&
        c.hour >= 0 &&
        c.hour < 24
      ) {
        const val = c.minutes > 0 ? c.minutes : c.count;
        if (val > 0) {
          matrix[c.weekday]![c.hour]! += val;
        }
      }
    }
  }

  let maxCellMinutes = 0;
  let totalMinutes = 0;
  const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
  const hourTotals = Array.from({ length: 24 }, () => 0);

  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const v = Math.round(matrix[wd]![h]!);
      matrix[wd]![h] = v;
      if (v > maxCellMinutes) {
        maxCellMinutes = v;
      }
      totalMinutes += v;
      weekdayTotals[wd]! += v;
      hourTotals[h]! += v;
    }
  }

  let peakWeekday: { index: number; label: string; minutes: number } | null =
    null;
  let peakHour: { hour: number; label: string; minutes: number } | null = null;

  if (totalMinutes > 0) {
    let bestWd = 0;
    for (let wd = 1; wd < 7; wd++) {
      if (weekdayTotals[wd]! > weekdayTotals[bestWd]!) {
        bestWd = wd;
      }
    }
    peakWeekday = {
      index: bestWd,
      label: WEEKDAYS_SHORT[bestWd] ?? "Mon",
      minutes: weekdayTotals[bestWd]!,
    };

    let bestH = 0;
    for (let h = 1; h < 24; h++) {
      if (hourTotals[h]! > hourTotals[bestH]!) {
        bestH = h;
      }
    }
    const hPad = String(bestH).padStart(2, "0");
    const hNextPad = String((bestH + 1) % 24).padStart(2, "0");
    peakHour = {
      hour: bestH,
      label: `${hPad}:00–${hNextPad}:00`,
      minutes: hourTotals[bestH]!,
    };
  }

  return {
    matrix,
    maxCellMinutes,
    totalMinutes,
    peakWeekday,
    peakHour,
  };
}

// --- Sparkline SVG Path Builder --------------------------------------------

export interface SparklineGeometry {
  readonly linePath: string;
  readonly areaPath: string;
  readonly min: number;
  readonly max: number;
  readonly lastPoint: { x: number; y: number } | null;
}

/**
 * Builds an SVG `d` path string for a sparkline line and its filled area.
 */
export function buildSparklineGeometry(
  values: readonly number[],
  width = 120,
  height = 32,
  pad = 3
): SparklineGeometry {
  const safeValues = values.map((v) =>
    Number.isFinite(v) && v >= 0 ? v : 0
  );
  if (safeValues.length === 0) {
    return { linePath: "", areaPath: "", min: 0, max: 0, lastPoint: null };
  }

  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const baselineY = height - pad;

  const coords = safeValues.map((val, idx) => {
    const x =
      safeValues.length === 1
        ? width / 2
        : pad + (idx / (safeValues.length - 1)) * innerW;
    const ratio = max > 0 ? val / max : 0;
    const y = baselineY - ratio * innerH;
    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
    };
  });

  const lineParts = coords.map(
    (pt, idx) => `${idx === 0 ? "M" : "L"}${pt.x},${pt.y}`
  );
  const linePath = lineParts.join(" ");
  const firstPt = coords[0]!;
  const lastPt = coords[coords.length - 1]!;
  const areaPath = `${linePath} L${lastPt.x},${baselineY} L${firstPt.x},${baselineY} Z`;

  return {
    linePath,
    areaPath,
    min,
    max,
    lastPoint: lastPt,
  };
}

// --- Insights Time Range Presets -------------------------------------------

export type InsightsRangePreset = "30d" | "12w" | "12m" | "all";

export interface InsightsDateRange {
  readonly preset: InsightsRangePreset;
  readonly bucket: "day" | "week" | "month";
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

function shiftIsoDate(dateStr: string, deltaDays: number): string {
  const [yStr, mStr, dStr] = dateStr.split("-");
  const y = Number.parseInt(yStr ?? "2026", 10);
  const m = Number.parseInt(mStr ?? "1", 10);
  const d = Number.parseInt(dStr ?? "1", 10);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Resolves the `bucket`, `from`, and `to` parameters for `GET /api/series`
 * given a range preset (`30d`, `12w`, `12m`, `all`) and today's date (`YYYY-MM-DD`).
 */
export function resolveInsightsRange(
  preset: InsightsRangePreset,
  todayStr: string
): InsightsDateRange {
  switch (preset) {
    case "30d":
      return {
        preset: "30d",
        bucket: "day",
        from: shiftIsoDate(todayStr, -29),
        to: todayStr,
        label: "Last 30 days",
      };
    case "12w":
      return {
        preset: "12w",
        bucket: "week",
        from: shiftIsoDate(todayStr, -83),
        to: todayStr,
        label: "Last 12 weeks",
      };
    case "12m":
      return {
        preset: "12m",
        bucket: "month",
        from: shiftIsoDate(todayStr, -364),
        to: todayStr,
        label: "Last 12 months",
      };
    case "all":
      return {
        preset: "all",
        bucket: "month",
        from: "2015-01-01",
        to: todayStr,
        label: "All time",
      };
  }
}
