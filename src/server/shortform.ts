import { localParts } from "../core/time.ts";
import type { ConsumptionEvent } from "./aggregate.ts";

export function isShortform(event: { source_kind?: string; media_type?: string }): boolean {
  return event.source_kind === "shortform_day" || event.media_type === "shortform";
}

/** Only PC measured Shorts supersede Takeout; phone app totals are a separate device. */
export function dedupeShortform<T extends ConsumptionEvent>(events: readonly T[], tz: string): T[] {
  const measuredDays = new Set(events.filter((e) => isShortform(e) && e.source === "youtube" && e.source_id?.startsWith("aw:"))
    .map((e) => localParts(e.started_at, tz).date));
  return events.filter((e) => !(isShortform(e) && e.source === "youtube" && e.source_id?.startsWith("takeout:") && measuredDays.has(localParts(e.started_at, tz).date)));
}
