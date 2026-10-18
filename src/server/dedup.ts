/**
 * Cross-source deduplication for display reads (F13).
 *
 * The same watch can arrive from two sources — typically a movie or episode
 * logged by hand (`manual`) and also synced from Simkl (`simkl`). Every display
 * should show it once. This is display-only linking: stored rows, the events
 * table, exports and backups are never changed (the archive is append-only).
 *
 * Matching rules (all must hold):
 * 1. Different sources, and one of them is manual (never merge two non-manual
 *    sources with each other, never merge two manual rows).
 * 2. Same media_type, which is movie or episode.
 * 3. Same normalizeForSearch(getSeriesOrTitle(event)). For episodes also equal
 *    season and episode (both non-null).
 * 4. Same local date in the configured timezone (formatLocalParts(started_at, tz).date).
 *
 * Merging:
 * - Each manual event merges with at most one non-manual event (closest started_at;
 *   tie -> lower id).
 * - Each non-manual event absorbs at most one manual event per source pairing.
 * - Result of a merge: keep the non-manual event, set duration_seconds to its
 *   own value or the manual one's when its own is null; set also_from: ["manual"].
 * - Order and everything else of the output stay as in the input (with the
 *   absorbed manual events removed).
 * - Idempotent, runs in O(n log n) or better.
 */

import {
  formatLocalParts,
  getSeriesOrTitle,
  type ConsumptionEvent,
} from "./aggregate.ts";
import { normalizeForSearch } from "./search.ts";
import { dropTakeoutCoveredByMeasuredPlays } from "./youtube-filter.ts";

export type DedupedEvent = ConsumptionEvent & {
  also_from?: string[];
};

interface CandidatePair {
  mIndex: number;
  nIndex: number;
  distance: number;
  nonManualId: number;
  manualId: number;
}

function getDedupKey(event: ConsumptionEvent, tz: string): string | null {
  if (event.media_type !== "movie" && event.media_type !== "episode") {
    return null;
  }
  if (event.media_type === "episode") {
    if (
      event.season === null ||
      event.season === undefined ||
      event.episode === null ||
      event.episode === undefined
    ) {
      return null;
    }
  }

  const localDate = formatLocalParts(event.started_at, tz).date;
  const normTitle = normalizeForSearch(getSeriesOrTitle(event));
  if (!normTitle) {
    return null;
  }

  if (event.media_type === "movie") {
    return `movie\0${localDate}\0${normTitle}`;
  }
  return `episode\0${localDate}\0${normTitle}\0${event.season}\0${event.episode}`;
}

export function dedupeConsumption(
   rawEvents: readonly ConsumptionEvent[],
  tz: string
): DedupedEvent[] {
  if (rawEvents.length === 0) {
    return [];
  }

  const events = dropTakeoutCoveredByMeasuredPlays(rawEvents, tz);
  if (events.length === 0) {
    return [];
  }

  // Group indices by bucket key
  const bucketMap = new Map<
    string,
    { manual: number[]; nonManual: number[] }
  >();

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const key = getDedupKey(event, tz);
    if (key === null) {
      continue;
    }

    let bucket = bucketMap.get(key);
    if (!bucket) {
      bucket = { manual: [], nonManual: [] };
      bucketMap.set(key, bucket);
    }

    if (event.source === "manual") {
      bucket.manual.push(i);
    } else {
      bucket.nonManual.push(i);
    }
  }

  const matchedManualIndices = new Set<number>();
  const matchedNonManualMap = new Map<number, number>(); // nonManual index -> manual index

  for (const bucket of bucketMap.values()) {
    if (bucket.manual.length === 0 || bucket.nonManual.length === 0) {
      continue;
    }

    const pairs: CandidatePair[] = [];
    for (const mIdx of bucket.manual) {
      const mEvent = events[mIdx]!;
      const mTime = Date.parse(mEvent.started_at);

      for (const nIdx of bucket.nonManual) {
        const nEvent = events[nIdx]!;
        const nTime = Date.parse(nEvent.started_at);
        const distance = Math.abs(mTime - nTime);

        pairs.push({
          mIndex: mIdx,
          nIndex: nIdx,
          distance,
          nonManualId: nEvent.id,
          manualId: mEvent.id,
        });
      }
    }

    // Sort candidate pairs:
    // 1. Closest started_at first
    // 2. Tie in non-manual: lower non-manual id
    // 3. Tie in manual: lower manual id
    pairs.sort(
      (a, b) =>
        a.distance - b.distance ||
        a.nonManualId - b.nonManualId ||
        a.manualId - b.manualId
    );

    for (const pair of pairs) {
      if (matchedManualIndices.has(pair.mIndex)) {
        continue;
      }
      if (matchedNonManualMap.has(pair.nIndex)) {
        continue;
      }

      matchedManualIndices.add(pair.mIndex);
      matchedNonManualMap.set(pair.nIndex, pair.mIndex);
    }
  }

  const result: DedupedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    if (matchedManualIndices.has(i)) {
      // Absorbed manual event: removed from output
      continue;
    }

    const mergedManualIdx = matchedNonManualMap.get(i);
    if (mergedManualIdx !== undefined) {
      const nonManual = events[i]!;
      const manual = events[mergedManualIdx]!;

      const duration_seconds =
        nonManual.duration_seconds !== null &&
        nonManual.duration_seconds !== undefined
          ? nonManual.duration_seconds
          : (manual.duration_seconds ?? null);

      const existingAlso = (nonManual as DedupedEvent).also_from ?? [];
      const also_from = Array.from(new Set([...existingAlso, "manual"]));

      result.push({
        ...nonManual,
        duration_seconds,
        also_from,
      });
    } else {
      result.push(events[i]!);
    }
  }

  return result;
}
