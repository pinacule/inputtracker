/** Time-only daily records. Intervals retain no video IDs, titles or URLs. */
import { createHash } from "node:crypto";
import type { NewEvent } from "./events.ts";
import { localParts, localToUtcIso } from "./time.ts";

export type TimeInterval = [number, number];

export function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
}

export function unionIntervals(intervals: readonly TimeInterval[]): TimeInterval[] {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .map(([a, b]): TimeInterval => [a, b]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result: TimeInterval[] = [];
  for (const interval of sorted) {
    const last = result.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else result.push(interval);
  }
  return result;
}

export function shortformDay(date: string, seconds: number, source: string, prefix: string, tz: string): NewEvent {
  return {
    source, source_kind: "shortform_day", source_id: `${prefix}:${date}`,
    media_type: "shortform", title: "Short-form", parent_title: null,
    started_at: localToUtcIso(date, tz), ended_at: null,
    duration_seconds: seconds, progress: null, external_ids: null,
    raw: { date },
  };
}

export function intervalDayRecords(intervals: readonly TimeInterval[], prefix: "aw" | "takeout", tz: string): NewEvent[] {
  const days = new Map<string, TimeInterval[]>();
  for (const [start, end] of unionIntervals(intervals)) {
    let cursor = start;
    while (cursor < end) {
      const date = localParts(new Date(cursor).toISOString(), tz).date;
      const stop = Math.min(end, Date.parse(localToUtcIso(nextDate(date), tz)));
      const list = days.get(date) ?? [];
      list.push([cursor, stop]);
      days.set(date, list);
      cursor = stop;
    }
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, spans]) => {
    const merged = unionIntervals(spans);
    return {
      ...shortformDay(date, Math.round(merged.reduce((sum, [a, b]) => sum + b - a, 0) / 1000), "youtube", prefix, tz),
      // Raw is not hashed by events: include interval identity so equal-time corrections persist.
      external_ids: { shortform_intervals_hash: createHash("sha256").update(JSON.stringify(merged)).digest("hex") },
      raw: { date, intervals: merged, ...(prefix === "takeout" ? { estimated: "gap" } : {}) },
    };
  });
}

export function readIntervals(raw: unknown): TimeInterval[] {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || !Array.isArray(obj.intervals)) return [];
    return obj.intervals.filter((v: unknown): v is TimeInterval => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n)));
  } catch { return []; }
}
