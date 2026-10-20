import { localParts } from "../core/time.ts";
import type { ConsumptionEvent } from "./aggregate.ts";

export function isShortform(event: { source_kind?: string; media_type?: string }): boolean {
  return event.source_kind === "shortform_day" || event.media_type === "shortform";
}

/** The phone sends the YouTube app's whole daily screen time as app "youtube". */
function isPhoneYoutubeTotal(e: ConsumptionEvent): boolean {
  return isShortform(e) && e.source === "phone" && e.source_id?.startsWith("phone:youtube:") === true;
}

/**
 * Display-only short-form rules (stored rows never change):
 * - Only PC measured Shorts supersede Takeout estimates of the same day.
 * - A phone YouTube app total minus that day's recorded phone video plays is what is left for
 *   Shorts and browsing; when the plays cover it all, the day's phone YouTube short-form is gone.
 */
export function dedupeShortform<T extends ConsumptionEvent>(events: readonly T[], tz: string): T[] {
  const dayOf = (e: ConsumptionEvent) => localParts(e.started_at, tz).date;
  const measuredDays = new Set(events.filter((e) => isShortform(e) && e.source === "youtube" && e.source_id?.startsWith("aw:"))
    .map(dayOf));
  const phoneVideoSeconds = new Map<string, number>();
  for (const e of events) {
    if (e.source === "youtube" && e.source_kind === "phone_play" && e.media_type === "video") {
      const day = dayOf(e);
      phoneVideoSeconds.set(day, (phoneVideoSeconds.get(day) ?? 0) + Math.max(0, e.duration_seconds ?? 0));
    }
  }
  const out: T[] = [];
  for (const e of events) {
    if (isShortform(e) && e.source === "youtube" && e.source_id?.startsWith("takeout:") && measuredDays.has(dayOf(e))) continue;
    if (isPhoneYoutubeTotal(e)) {
      const left = Math.max(0, (e.duration_seconds ?? 0) - (phoneVideoSeconds.get(dayOf(e)) ?? 0));
      if (left <= 0) continue;
      if (left !== e.duration_seconds) {
        out.push({ ...e, duration_seconds: left });
        continue;
      }
    }
    out.push(e);
  }
  return out;
}
