/**
 * Pure calendar and formatting utilities for InputTracker.
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import { sourceEntry } from "./sources";

/**
 * Builds a month grid as an array of weeks (Monday-first).
 * Each week is an array of 7 ISO date strings (`YYYY-MM-DD`).
 * Includes leading days from the previous month and trailing days from the next month
 * to ensure every week has exactly 7 days.
 *
 * @param month ISO month string in `YYYY-MM` format (e.g. "2026-10").
 */
export function buildMonthGrid(month: string): string[][] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) {
    throw new Error(`Invalid month format: "${month}" (expected YYYY-MM)`);
  }
  const year = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  if (m < 1 || m > 12) {
    throw new Error(`Invalid month value: ${m} in "${month}"`);
  }

  // 1st of the month
  const firstDay = new Date(Date.UTC(year, m - 1, 1));
  // getUTCDay(): 0 = Sun, 1 = Mon, ..., 6 = Sat
  // For Monday-first: Mon=0, Tue=1, ..., Sun=6 leading days
  const dayOfWeek = firstDay.getUTCDay();
  const leadingDays = (dayOfWeek + 6) % 7;

  // Number of days in this month
  const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();

  // Last day of this month
  const lastDay = new Date(Date.UTC(year, m - 1, daysInMonth));
  const lastDayOfWeek = lastDay.getUTCDay();
  // Trailing days needed to complete the week through Sunday
  const trailingDays = (7 - ((lastDayOfWeek + 6) % 7 + 1)) % 7;

  const totalDays = leadingDays + daysInMonth + trailingDays;
  const startDate = new Date(Date.UTC(year, m - 1, 1 - leadingDays));

  const weeks: string[][] = [];
  let currentWeek: string[] = [];

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate() + i
      )
    );
    const yStr = String(d.getUTCFullYear()).padStart(4, "0");
    const mStr = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dStr = String(d.getUTCDate()).padStart(2, "0");
    currentWeek.push(`${yStr}-${mStr}-${dStr}`);

    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  return weeks;
}

/**
 * Shifts a `YYYY-MM` month by `delta` months (positive or negative).
 */
export function shiftMonth(month: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) {
    throw new Error(`Invalid month format: "${month}" (expected YYYY-MM)`);
  }
  const year = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  if (m < 1 || m > 12) {
    throw new Error(`Invalid month value: ${m} in "${month}"`);
  }

  const totalMonths = year * 12 + (m - 1) + delta;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = ((totalMonths % 12) + 12) % 12 + 1;

  const yStr = String(newYear).padStart(4, "0");
  const mStr = String(newMonth).padStart(2, "0");
  return `${yStr}-${mStr}`;
}

/**
 * Formats duration in seconds into a friendly string:
 * - null/undefined/<0 -> "—"
 * - < 60s -> "<1 min"
 * - minutes (< 1h) -> "42 min"
 * - hours (>= 1h) -> "1h" or "1h 30m"
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (
    seconds === null ||
    seconds === undefined ||
    Number.isNaN(seconds) ||
    seconds < 0
  ) {
    return "—";
  }
  if (seconds < 60) {
    return "<1 min";
  }
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Extracts and formats local time (HH:MM) from a string.
 */
export function formatLocalTime(localTime: string): string {
  if (!localTime) {
    return "";
  }
  if (/^\d{2}:\d{2}$/.test(localTime)) {
    return localTime;
  }
  const match = /(\d{2}:\d{2})(?::\d{2})?/.exec(localTime);
  if (match) {
    return match[1]!;
  }
  return localTime;
}

/**
 * Returns an icon/emoji badge for the given source and optional media type.
 *
 * Media-type icons take precedence (an episode of a Simkl show is still a 📺),
 * otherwise the source icon comes from the shared `SOURCES` list.
 */
export function sourceIcon(
  source: string,
  mediaType?: string | null
): string {
  const s = (source || "").toLowerCase().trim();
  const m = (mediaType || "").toLowerCase().trim();

  // abs = 🎧
  if (s === "audiobookshelf" || s === "abs") {
    return "🎧";
  }
  if (m === "audiobook") {
    return "🎧";
  }
  if (m === "podcast_episode" || m === "podcast") {
    return "🎙️";
  }
  if (m === "movie") {
    return "🎬";
  }
  if (m === "episode" || m === "tv") {
    return "📺";
  }
  if (m === "video") {
    return "📹";
  }
  if (m === "book") {
    return "📖";
  }
  // YouTube is not in `SOURCES` yet (task Y03); keep its icon here until then.
  if (s === "youtube") {
    return "▶️";
  }
  return sourceEntry(s)?.icon ?? "📌";
}

/** Zero-pad an S/E number to two digits (`3` → `03`, `100` stays `100`). */
function padSeasonEpisode(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Formats season and episode indicators (e.g. "S01E03").
 */
export function formatSeasonEpisode(
  season: number | null | undefined,
  episode: number | null | undefined
): string {
  const hasSeason = season !== null && season !== undefined;
  const hasEpisode = episode !== null && episode !== undefined;
  if (hasSeason && hasEpisode) {
    return `S${padSeasonEpisode(season)}E${padSeasonEpisode(episode)}`;
  }
  if (hasSeason) {
    return `S${padSeasonEpisode(season)}`;
  }
  if (hasEpisode) {
    return `E${padSeasonEpisode(episode)}`;
  }
  return "";
}

/**
 * Formats an item title combining season/episode with the title.
 */
export function formatItemTitle(item: {
  title: string | null;
  season?: number | null;
  episode?: number | null;
}): string {
  const se = formatSeasonEpisode(item.season, item.episode);
  const title = item.title ?? "Untitled";
  return se ? `${se} · ${title}` : title;
}
