/**
 * Optional weekly summary text (off by default: `[notify] weekly_summary`).
 *
 * The text is built strictly from the reuse helpers that read `events_latest`:
 * `getLatestConsumptionEvents` + `aggregateStats` for the 7-day window and
 * `computeStreaks` for the current streak — nothing is re-implemented here.
 * The window is the last seven *local* days (config timezone), computed from
 * an injectable clock so tests are deterministic.
 *
 * The body is plain text and gets truncated to ntfy's size limits further
 * downstream in the channel; a weekly summary is normally well under it.
 */

import type { Database } from "bun:sqlite";
import {
  formatLocalParts,
  getLatestConsumptionEvents,
  aggregateStats,
  type ConsumptionEvent,
} from "../server/aggregate.ts";
import { computeStreaks } from "../server/insights.ts";

/** Adds `delta` days to a local "YYYY-MM-DD" string (pure UTC math). */
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-");
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + delta));
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** "135.25" hours from minutes, one decimal (0 -> "0.0"). */
function fmtHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} h`;
}

/** "22 min" below an hour, else "1h 5m" style, from minutes. */
function fmtDuration(minutes: number): string {
  const mins = Math.max(0, Math.round(minutes));
  if (mins < 60) {
    return `${mins} min`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export interface WeeklySummaryOptions {
  /** IANA timezone for local-day bucketing (the config timezone). */
  tz: string;
  /** Clock; defaults to the current time. */
  now?: Date;
}

export interface WeeklySummary {
  title: string;
  body: string;
}

/**
 * Build the summary text from already-loaded events. Pure: no database access.
 */
export function buildWeeklySummaryText(
  events: readonly ConsumptionEvent[],
  opts: WeeklySummaryOptions
): WeeklySummary {
  const tz = opts.tz;
  const now = opts.now ?? new Date();
  const today = formatLocalParts(new Date(now.getTime()).toISOString(), tz).date;
  const from = addDays(today, -6);

  const stats = aggregateStats(events, { from, to: today, tz });
  const streaks = computeStreaks(events, tz, today);
  const streak = streaks.overall.current;

  const lines: string[] = [
    `Last 7 days (${from} to ${today})`,
  ];

  if (stats.total_items === 0) {
    lines.push("No activity in this window.");
  } else {
    lines.push(
      `${fmtHours(stats.total_minutes)} across ${stats.total_items} items`
    );
    const sources = Object.entries(stats.by_source).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [source, bucket] of sources) {
      lines.push(`  ${source}: ${fmtHours(bucket.minutes)}, ${bucket.items} items`);
    }
    const top = stats.top_items.slice(0, 3);
    if (top.length > 0) {
      lines.push(
        `Top: ${top.map((t) => `${t.title} (${fmtDuration(t.minutes)})`).join(", ")}`
      );
    }
  }
  lines.push(`Streak: ${streak} ${streak === 1 ? "day" : "days"}`);

  return { title: "InputTracker weekly summary", body: lines.join("\n") };
}

/** Read `events_latest` once and build the summary text from it. */
export function buildWeeklySummary(
  db: Database,
  opts: WeeklySummaryOptions
): WeeklySummary {
  const events = getLatestConsumptionEvents(db);
  return buildWeeklySummaryText(events, opts);
}
