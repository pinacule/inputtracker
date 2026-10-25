/**
 * Pure display helpers for the "Year in review" page. No DOM dependencies;
 * safe to run under Bun or in the browser.
 */

import type { Category, YearReview } from "../api";

const MONTH_LABELS = [
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

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Hours as "0 h", "1.5 h", "123 h": one decimal below 10 h (trailing ".0"
 * dropped), whole hours above.
 */
export function formatHours(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "0 h";
  }
  const hours = minutes / 60;
  if (hours < 10) {
    const rounded = Math.round(hours * 10) / 10;
    return rounded % 1 === 0 ? `${rounded} h` : `${rounded.toFixed(1)} h`;
  }
  return `${Math.round(hours)} h`;
}

/**
 * Change vs the previous year as "+12 %" / "−8 %" / "±0 %"; "new" when the
 * previous value is 0 or missing. Minus is a real minus sign (U+2212).
 */
export function formatChange(
  current: number,
  previous: number | null | undefined
): string {
  if (previous === null || previous === undefined || previous === 0) {
    return "new";
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) {
    return "±0 %";
  }
  return pct > 0 ? `+${pct} %` : `−${Math.abs(pct)} %`;
}

/** "2026-03" -> "Mar"; anything else passes through unchanged. */
export function monthLabel(month: string): string {
  const match = /^\d{4}-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) {
    return month;
  }
  return MONTH_LABELS[Number.parseInt(match[1]!, 10) - 1]!;
}

/** ISO weekday 1 = Monday .. 7 = Sunday -> "Mon" .. "Sun". */
export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday - 1] ?? "";
}

/**
 * True when the review contains YouTube events only (the totals then count
 * views, because YouTube has no durations). Data-driven so the share image
 * agrees with the page without passing the filter around.
 */
export function isYoutubeOnly(review: YearReview): boolean {
  const sources = Object.keys(review.by_source);
  return sources.length === 1 && sources[0] === "youtube";
}

const MILESTONE_CATEGORIES: ReadonlySet<Category> = new Set(["book", "film", "series", "anime", "audiobook"]);

/**
 * Finished/Started lists show only works with a real start and end: books, films,
 * series, anime and audiobooks. A first play of a song or video would flood them.
 */
export function isMilestoneCategory(category: Category): boolean {
  return MILESTONE_CATEGORIES.has(category);
}

/**
 * The plain text lines drawn on the share image: year, hours (or views for a
 * YouTube-only review), items, active days, longest streak, top 3 titles and
 * the busiest month. Empty sections are skipped.
 */
export function buildShareLines(
  review: YearReview,
  sourceLabel: string | null | undefined
): string[] {
  const views = isYoutubeOnly(review);
  const scope = sourceLabel ? ` · ${sourceLabel}` : "";

  const lines: string[] = [
    "InputTracker — Year in review",
    `${review.year}${scope}${review.partial ? " · so far" : ""}`,
  ];

  if (views) {
    lines.push(`${review.totals.items} views`);
  } else {
    lines.push(formatHours(review.totals.minutes));
    lines.push(
      `${review.totals.items} ${review.totals.items === 1 ? "item" : "items"}`
    );
  }
  lines.push(`${review.totals.active_days} active days`);
  lines.push(
    review.longest_streak.days > 0
      ? `Longest streak: ${review.longest_streak.days} days`
      : "Longest streak: none"
  );

  for (const [index, title] of review.top_titles.slice(0, 3).entries()) {
    const value = views
      ? `${title.count} views`
      : formatHours(title.minutes);
    lines.push(`${index + 1}. ${title.title} — ${value}`);
  }

  if (review.busiest_month !== null) {
    const value = views
      ? `${review.busiest_month.count} views`
      : formatHours(review.busiest_month.minutes);
    lines.push(
      `Busiest month: ${monthLabel(review.busiest_month.month)} — ${value}`
    );
  }

  return lines;
}
