import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { NewEvent } from "../../core/events.ts";
import { intervalDayRecords, readIntervals, shortformDay, unionIntervals, type TimeInterval } from "../../core/shortform.ts";
import { localParts } from "../../core/time.ts";

/** Preserve observations from other buckets and overlapping/partial sync windows. */
export function mergeStoredShortformDays(db: Database, events: readonly NewEvent[], tz: string, window?: { bucket: string; from: string; to: string }): NewEvent[] {
  const ordinary = events.filter((e) => e.source_kind !== "shortform_day");
  const days = events.filter((e) => e.source_kind === "shortform_day");
  if (window) {
    const from = Date.parse(window.from), to = Date.parse(window.to);
    const incoming = intervalDayRecords(days.flatMap((e) => readIntervals(e.raw)).map(([a, b]): TimeInterval => [Math.max(a, from), Math.min(b, to)]), "aw", tz);
    const byId = new Map(incoming.map((e) => [e.source_id, e]));
    const stored = db.query<{ source_id: string; raw: string | null }, []>(
      "SELECT source_id, raw FROM events_latest WHERE source = 'youtube' AND source_kind = 'shortform_day' AND source_id LIKE 'aw:%'"
    ).all().filter((e) => e.source_id.slice(3) >= localParts(window.from, tz).date && e.source_id.slice(3) <= localParts(window.to, tz).date);
    const oldById = new Map(stored.map((e) => [e.source_id, e]));
    const output: NewEvent[] = [];
    for (const id of new Set([...byId.keys(), ...oldById.keys()])) {
      const old = oldById.get(id);
      const raw = old?.raw ? JSON.parse(old.raw) : {};
      const buckets: Record<string, TimeInterval[]> = { ...(raw.buckets ?? {}) };
      // Legacy interval-only rows remain known observations, not guessed bucket ownership.
      if (old && !raw.buckets) buckets.legacy = readIntervals(raw);
      const retained: TimeInterval[] = [];
      for (const [a, b] of buckets[window.bucket] ?? []) {
        if (a < from) retained.push([a, Math.min(b, from)]);
        if (b > to) retained.push([Math.max(a, to), b]);
      }
      buckets[window.bucket] = unionIntervals([...retained, ...readIntervals(byId.get(id)?.raw)]);
      const stableBuckets = Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)));
      const spans = unionIntervals(Object.values(stableBuckets).flat());
      const date = id.slice(3);
      output.push({
        ...shortformDay(date, Math.round(spans.reduce((sum, [a, b]) => sum + b - a, 0) / 1000), "youtube", "aw", tz),
        external_ids: { shortform_intervals_hash: createHash("sha256").update(JSON.stringify(stableBuckets)).digest("hex") },
        raw: { date, intervals: spans, buckets: stableBuckets },
      });
    }
    return [...ordinary, ...output];
  }
  if (days.length === 0) return [...events];
  const intervals: TimeInterval[] = days.flatMap((e) => readIntervals(e.raw));
  const get = db.query<{ raw: string | null }, [string]>(
    "SELECT raw FROM events_latest WHERE source = 'youtube' AND source_kind = 'shortform_day' AND source_id = ?"
  );
  for (const id of new Set(days.map((e) => e.source_id))) intervals.push(...readIntervals(get.get(id)?.raw));
  return [...ordinary, ...intervalDayRecords(intervals, "aw", tz)];
}
