/** Pure rolling-window and norm helpers. UTC is used as a calendar, not a display timezone. */
import type { CalendarDay, SeriesPoint } from "../api";
import { CATEGORIES } from "./categories";
import {
  computeCategorySegmentsFromItems, formatWeekRangeHeading, isValidDateStr,
  shiftDateStr, type WeekGraphModel,
} from "./home";
import { formatMinutes, formatMinutesShort } from "./stats";

export function rollingWindowDates(endDate: string): string[] {
  return isValidDateStr(endDate)
    ? Array.from({ length: 7 }, (_, i) => shiftDateStr(endDate, i - 6))
    : [];
}

export function clampWindowEnd(date: string | undefined, today: string): string {
  return isValidDateStr(date) && date <= today ? date : today;
}

export function shiftWindowEnd(endDate: string, delta: number, today: string): string {
  return clampWindowEnd(shiftDateStr(endDate, delta * 7), today);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function weekdayName(date: string): string {
  return new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`));
}

export function seriesDayTotals(points: readonly SeriesPoint[]): Map<string, number> {
  return new Map(points.map((p) => [p.bucket, CATEGORIES.reduce((sum, cat) => {
    const minutes = p.minutes_by_category[cat] ?? 0;
    return sum + (Number.isFinite(minutes) ? Math.max(0, minutes) : 0);
  }, 0)]));
}

/**
 * Eight preceding occurrences of this weekday. Missing days after historyStart
 * are real zero days; dates before it are not observations. With <4 occurrences,
 * use all available preceding days (up to 30). The target never trains itself.
 */
export function usualMinutes(date: string, totals: ReadonlyMap<string, number>, historyStart: string | null): number {
  if (!historyStart || historyStart >= date) return 0;
  const value = (day: string) => Math.max(0, totals.get(day) ?? 0);
  const sameWeekday = Array.from({ length: 8 }, (_, i) => shiftDateStr(date, -7 * (i + 1)))
    .filter((d) => d >= historyStart);
  if (sameWeekday.length >= 4) return median(sameWeekday.map(value));
  return median(Array.from({ length: 30 }, (_, i) => shiftDateStr(date, -i - 1))
    .filter((d) => d >= historyStart).map(value));
}

export function normComparison(actual: number, norm: number, usual = "usual"): string {
  const diff = actual - norm;
  // Inclusive ±10%, with tolerance for floating-point series totals.
  if (Math.abs(diff) <= norm * 0.1 + 1e-9) return "about usual";
  const minutes = Math.round(Math.abs(diff));
  const amount = minutes === 0 ? "<1 min" : minutes < 60 ? `${minutes} min` : formatMinutes(minutes);
  return `${amount} ${diff > 0 ? "more" : "less"} than ${usual}`;
}

export function dayNormSentence(date: string, today: string, actual: number, norm: number): string {
  const label = date === today ? "Today" : weekdayName(date);
  return `${label} ${formatMinutes(actual)} · ${normComparison(actual, norm, `a usual ${weekdayName(date)}`)}`;
}

export function windowNormSentence(actual: number, norm: number, isCurrent: boolean): string {
  return `${isCurrent ? "Last 7 days" : "These 7 days"} ${formatMinutes(actual)} · ${normComparison(actual, norm)}`;
}

export interface RollingGraphModel extends WeekGraphModel {
  readonly daySentence: string;
  readonly windowSentence: string;
  readonly norms: ReadonlyMap<string, number>;
  readonly normRatios: ReadonlyMap<string, number>;
  /** False while there is no complete history to compare against: hide every "usual". */
  readonly hasNorms: boolean;
}

export function buildRollingGraphModel(
  allDays: readonly CalendarDay[], selectedDate: string, windowEnd: string, today: string,
  points: readonly SeriesPoint[], historyStart: string | null,
): RollingGraphModel {
  const dates = rollingWindowDates(windowEnd);
  const dayMap = new Map(allDays.map((d) => [d.date, d]));
  const totals = seriesDayTotals(points);
  const norms = new Map(dates.map((date) => [date, usualMinutes(date, totals, historyStart)]));
  const maxDayMinutes = Math.max(0, ...dates.map((d) => dayMap.get(d)?.minutes ?? 0));
  // Both the observed bars and markers share one scale; a quiet week never clips its norm.
  const ceiling = Math.max(60, maxDayMinutes, ...norms.values());
  const days = dates.map((date) => {
    const d = dayMap.get(date);
    const minutes = Math.max(0, d?.minutes ?? 0);
    const weekday = weekdayName(date);
    return {
      date, dayOfMonth: Number(date.slice(8)), weekdayShort: weekday.slice(0, 3), weekdayLetter: weekday[0]!,
      isToday: date === today, isSelected: date === selectedDate, isCurrentMonth: true,
      totalMinutes: minutes, totalCount: d?.count ?? 0, heightRatio: minutes / ceiling,
      durationLabel: minutes > 0 ? formatMinutesShort(minutes) : "0m",
      segments: computeCategorySegmentsFromItems(d?.items ?? []).filter((s) => s.minutes > 0 || s.sharePct > 0),
    };
  });
  const weekMinutes = days.reduce((sum, d) => sum + d.totalMinutes, 0);
  const isCurrent = windowEnd === today;
  const comparisonDay = isCurrent ? today : selectedDate;
  return {
    startDate: dates[0] ?? windowEnd, endDate: windowEnd,
    heading: isCurrent ? "Last 7 days" : formatWeekRangeHeading(dates, today).heading,
    isCurrentWeek: isCurrent, todayMinutes: dayMap.get(today)?.minutes ?? 0, weekMinutes,
    activeDays: days.filter((d) => d.totalMinutes > 0 || d.totalCount > 0).length,
    maxDayMinutes, days, norms, hasNorms: historyStart !== null,
    normRatios: new Map([...norms].map(([date, norm]) => [date, norm / ceiling])),
    daySentence: dayNormSentence(comparisonDay, today, dayMap.get(comparisonDay)?.minutes ?? 0,
      usualMinutes(comparisonDay, totals, historyStart)),
    windowSentence: windowNormSentence(weekMinutes, [...norms.values()].reduce((a, b) => a + b, 0), isCurrent),
  };
}
