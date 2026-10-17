/**
 * Pure display helpers for the Streaks and "On this day" cards on the Stats
 * page. No DOM dependencies; safe to run under Bun or in the browser.
 */

import { formatLocalDay } from "./format-date";

/** Day count as a phrase: "1 day", "3 days". Zero and negatives use plural. */
export function formatDayCount(days: number): string {
  const n = Number.isNaN(days) ? 0 : Math.max(0, Math.floor(days));
  return `${n} ${n === 1 ? "day" : "days"}`;
}

/** Age of an earlier year as a phrase: "1 year ago", "4 years ago". */
export function formatYearsAgo(years: number): string {
  const n = Math.max(0, Math.floor(years));
  return `${n} ${n === 1 ? "year" : "years"} ago`;
}

/**
 * Longest-streak date range for display, e.g. "05.01.2026 – 09.01.2026".
 * A single-day streak shows just the day; null bounds (no events) yield null
 * so the caller can show a placeholder.
 */
export function formatStreakRange(
  start: string | null,
  end: string | null
): string | null {
  if (start === null || end === null) {
    return null;
  }
  const from = formatLocalDay(start);
  const to = formatLocalDay(end);
  return from === to ? from : `${from} – ${to}`;
}

/** Group heading for one "on this day" year: "2 years ago · 2024". */
export function formatOnThisDayHeading(
  year: number,
  yearsAgo: number
): string {
  return `${formatYearsAgo(yearsAgo)} · ${year}`;
}

/**
 * Caption under the current-streak figure: "Active today", "Active yesterday"
 * (a streak alive only through yesterday), or "No active streak".
 */
export function describeCurrentStreak(
  current: number,
  lastActive: string | null,
  today: string
): string {
  if (current <= 0) {
    return "No active streak";
  }
  if (lastActive === today) {
    return "Active today";
  }
  return "Active yesterday";
}
