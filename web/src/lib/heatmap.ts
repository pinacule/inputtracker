/**
 * Pure heat map and formatting utilities for InputTracker.
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import type { HeatmapDay, HeatmapHourCell } from "../api";
import { SOURCES } from "./sources";

export interface HeatmapSourceOption {
  readonly id: string;
  readonly value: string;
  readonly label: string;
}

/**
 * Fixed list of supported sources for filtering in the heat map view.
 * Derived from the shared `SOURCES` list so it never drifts.
 */
export const HEATMAP_SOURCES: readonly HeatmapSourceOption[] = SOURCES.map(
  (source) => ({
    id: source.value,
    value: source.value,
    label: source.label,
  })
);

export interface MonthLabel {
  readonly label: string;
  readonly weekIndex: number;
  readonly col: number;
  readonly month: number;
  readonly monthIndex: number;
}

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

export const WEEKDAYS_SHORT = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

/**
 * Builds a GitHub-style year grid as an array of weeks (columns, Monday-first).
 * Each week is an array of 7 items (rows: Mon=0 .. Sun=6).
 * Days outside the specified year are padded with `null`.
 *
 * @param year The year as a 4-digit number or numeric string (e.g. 2026 or "2026").
 * @param days Aggregated daily stats from `getHeatmapDays`.
 */
export function buildYearGrid(
  year: number | string,
  days: readonly HeatmapDay[]
): (HeatmapDay | null)[][] {
  const y = typeof year === "string" ? parseInt(year, 10) : year;
  if (!Number.isInteger(y) || y < 1000 || y > 9999) {
    throw new Error(`Invalid year: "${year}" (expected 4-digit year)`);
  }

  const daysMap = new Map<string, HeatmapDay>();
  for (const day of days) {
    daysMap.set(day.date, day);
  }

  // Jan 1 in UTC
  const firstDay = new Date(Date.UTC(y, 0, 1));
  // 0 = Sun, 1 = Mon ... 6 = Sat -> Mon=0, Tue=1, ..., Sun=6
  const leadingDays = (firstDay.getUTCDay() + 6) % 7;

  // Leap year calculation: leap if divisible by 4, except if divisible by 100 unless also divisible by 400
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;

  const trailingDays = (7 - ((leadingDays + daysInYear) % 7)) % 7;
  const totalCells = leadingDays + daysInYear + trailingDays;

  const weeks: (HeatmapDay | null)[][] = [];
  let currentWeek: (HeatmapDay | null)[] = [];

  for (let cellIdx = 0; cellIdx < totalCells; cellIdx++) {
    if (cellIdx < leadingDays || cellIdx >= leadingDays + daysInYear) {
      currentWeek.push(null);
    } else {
      const dayOffset = cellIdx - leadingDays;
      const d = new Date(Date.UTC(y, 0, 1 + dayOffset));
      const mStr = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dStr = String(d.getUTCDate()).padStart(2, "0");
      const dateStr = `${y}-${mStr}-${dStr}`;

      const existing = daysMap.get(dateStr);
      currentWeek.push({
        date: dateStr,
        count: existing?.count ?? 0,
        minutes: existing?.minutes ?? 0,
      });
    }

    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  return weeks;
}

/**
 * Calculates a 5-level color intensity (0 = empty, 1..4 = active)
 * based on linear quartiles of `max`.
 *
 * Rules:
 * - value <= 0 -> 0
 * - max <= 0 -> 0
 * - value >= max -> 4
 * - otherwise 1..4 based on quartile of max
 */
export function levelFor(value: number, max: number): number {
  if (value <= 0 || max <= 0 || Number.isNaN(value) || Number.isNaN(max)) {
    return 0;
  }
  if (value >= max) {
    return 4;
  }
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

/**
 * Builds a 7x24 matrix for weekday x hour.
 * Rows are weekdays (0=Mon .. 6=Sun), columns are hours (0..23).
 */
export function buildHourGrid(
  cells: readonly HeatmapHourCell[]
): HeatmapHourCell[][] {
  const grid: HeatmapHourCell[][] = [];

  for (let weekday = 0; weekday < 7; weekday++) {
    const row: HeatmapHourCell[] = [];
    for (let hour = 0; hour < 24; hour++) {
      row.push({
        weekday,
        hour,
        count: 0,
        minutes: 0,
      });
    }
    grid.push(row);
  }

  for (const cell of cells) {
    if (
      Number.isInteger(cell.weekday) &&
      cell.weekday >= 0 &&
      cell.weekday < 7 &&
      Number.isInteger(cell.hour) &&
      cell.hour >= 0 &&
      cell.hour < 24
    ) {
      const target = grid[cell.weekday]?.[cell.hour];
      if (target) {
        target.count += cell.count ?? 0;
        target.minutes += cell.minutes ?? 0;
      }
    }
  }

  return grid;
}

/**
 * Extracts month labels and their week column indices from a year grid.
 */
export function monthLabels(
  weeks: readonly (readonly (HeatmapDay | null)[])[]
): MonthLabel[] {
  const seenMonths = new Set<number>();
  const labels: MonthLabel[] = [];

  for (let w = 0; w < weeks.length; w++) {
    const week = weeks[w];
    if (!week) continue;
    for (const cell of week) {
      if (!cell) continue;
      const monthNum = parseInt(cell.date.slice(5, 7), 10);
      if (!seenMonths.has(monthNum)) {
        seenMonths.add(monthNum);
        const name = MONTH_NAMES[monthNum - 1] ?? "";
        labels.push({
          label: name,
          weekIndex: w,
          col: w,
          month: monthNum,
          monthIndex: monthNum - 1,
        });
      }
    }
  }

  return labels;
}

/**
 * Formats an accessible description for a day cell:
 * e.g. "2026-10-17: 85 min, 3 items"
 */
export function describeDay(day: {
  date: string;
  minutes: number;
  count: number;
}): string;
export function describeDay(
  date: string,
  minutes: number,
  count: number
): string;
export function describeDay(
  dayOrDate:
    | string
    | { date?: string | null; minutes?: number | null; count?: number | null },
  maybeMinutes?: number,
  maybeCount?: number
): string {
  let date: string;
  let minutes: number;
  let count: number;

  if (typeof dayOrDate === "object" && dayOrDate !== null) {
    date = dayOrDate.date ?? "";
    minutes = dayOrDate.minutes ?? 0;
    count = dayOrDate.count ?? 0;
  } else {
    date = String(dayOrDate ?? "");
    minutes = maybeMinutes ?? 0;
    count = maybeCount ?? 0;
  }

  const safeMin = Number.isNaN(minutes) || minutes < 0 ? 0 : minutes;
  const safeCount = Number.isNaN(count) || count < 0 ? 0 : count;
  const roundedMin = Math.round(safeMin);
  const itemWord = safeCount === 1 ? "item" : "items";
  return `${date}: ${roundedMin} min, ${safeCount} ${itemWord}`;
}
