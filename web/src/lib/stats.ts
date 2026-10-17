/**
 * Pure stats and formatting utilities for InputTracker.
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

export interface SourceOption {
  readonly value: string;
  readonly label: string;
}

export const STATS_SOURCES: readonly SourceOption[] = [
  { value: "", label: "All sources" },
  { value: "audiobookshelf", label: "Audiobookshelf" },
  { value: "manual", label: "Manual" },
  { value: "simkl", label: "Simkl" },
];

const MONTH_NAMES = [
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
 * Formats minutes into human-readable hours and minutes (e.g. "2h 15m", "45m", "0m").
 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (
    minutes === null ||
    minutes === undefined ||
    Number.isNaN(minutes) ||
    minutes < 0
  ) {
    return "0m";
  }
  const rounded = Math.round(minutes);
  if (rounded === 0) {
    return "0m";
  }
  if (rounded < 60) {
    return `${rounded}m`;
  }
  const hours = Math.floor(rounded / 60);
  const remainingMinutes = rounded % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
}

/** Alias for formatMinutes for descriptive callers. */
export const formatHoursMinutes = formatMinutes;

/**
 * Calculates the maximum minutes across a list of buckets.
 */
export function computeMaxMinutes(
  buckets: ReadonlyArray<{ minutes: number }>
): number {
  let max = 0;
  for (const b of buckets) {
    if (b.minutes > max) {
      max = b.minutes;
    }
  }
  return max;
}

/**
 * Computes the scaled bar height percentage (0..100) relative to maxMinutes.
 */
export function computeBarHeight(
  minutes: number,
  maxMinutes: number,
  minPercent = 0
): number {
  if (maxMinutes <= 0 || minutes <= 0) {
    return 0;
  }
  const pct = (minutes / maxMinutes) * 100;
  return Math.max(minPercent, Math.min(100, Math.round(pct * 10) / 10));
}

export interface StackedSegment {
  source: string;
  minutes: number;
  percentage: number;
}

/**
 * Computes stacked segments for each source within a bar, relative to totalBarMinutes.
 * The percentages sum to 100% (or 0% if totalBarMinutes is 0).
 */
export function computeStackedSegments(
  bySource: Record<string, number>,
  totalBarMinutes: number
): StackedSegment[] {
  if (totalBarMinutes <= 0) {
    return [];
  }
  const entries = Object.entries(bySource).filter(([, m]) => m > 0);
  return entries.map(([source, minutes]) => ({
    source,
    minutes,
    percentage: Math.round((minutes / totalBarMinutes) * 1000) / 10,
  }));
}

/**
 * Formats a week ("2026-W42") or month ("2026-10") period into a readable label.
 */
export function formatPeriodLabel(
  period: string,
  type: "week" | "month"
): string {
  if (type === "week") {
    // e.g. "2026-W42" -> "W42"
    const match = /^(\d{4})-W(\d{2})$/.exec(period);
    if (match) {
      return `W${match[2]}`;
    }
    return period;
  }

  // e.g. "2026-10" -> "Oct 2026"
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (match) {
    const year = match[1];
    const monthIndex = Number.parseInt(match[2]!, 10) - 1;
    return `${MONTH_NAMES[monthIndex]} ${year}`;
  }
  return period;
}

/**
 * Returns a consistent hex color for each source in the charts.
 */
export function sourceColor(source: string): string {
  switch (source.toLowerCase().trim()) {
    case "audiobookshelf":
    case "abs":
      return "#8b5cf6"; // Violet
    case "manual":
      return "#10b981"; // Emerald
    case "simkl":
      return "#f59e0b"; // Amber
    default:
      return "#3b82f6"; // Blue
  }
}
