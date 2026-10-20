import type { Database } from "bun:sqlite";
import type { TopBy, TopEntry, TopKind, TopResult } from "../core/contract.ts";
import { eventPrecision, formatLocalParts } from "./aggregate.ts";
import { cleanMusicArtist } from "./covers.ts";
import { buildAllLibraryWorks, type InternalLibraryWork } from "./library.ts";

export interface TopOptions {
  kind: TopKind;
  by?: TopBy;
  from?: string;
  to?: string;
  limit?: number;
  tz?: string;
}

/** Input is deduped, override-aware library works, never raw archive rows. */
export function aggregateTop(works: readonly Pick<InternalLibraryWork, "work" | "events">[], opts: TopOptions): TopResult {
  const tz = opts.tz ?? "Europe/Bratislava";
  const by = opts.by ?? "plays";
  const entries = new Map<string, TopEntry>();
  for (const { work, events } of works) {
    if (work.status === "planned" || work.category !== (opts.kind === "channels" ? "youtube" : "music")) continue;
    const creator = opts.kind === "channels" ? work.creator ?? work.channel : cleanMusicArtist(work.creator ?? work.channel) || null;
    if (opts.kind !== "songs" && !creator) continue;
    const key = opts.kind === "songs" ? work.key : creator!.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    for (const ev of events) {
      if (ev.source_kind === "shortform_day" || ev.media_type === "shortform") continue;
      if ((opts.from || opts.to) && eventPrecision(ev) === "unknown") continue;
      const date = formatLocalParts(ev.started_at, tz).date;
      if ((opts.from && date < opts.from) || (opts.to && date > opts.to)) continue;
      const entry = entries.get(key) ?? { key, title: opts.kind === "songs" ? work.title : creator!, creator: opts.kind === "songs" ? creator : null, plays: 0, total_minutes: 0 };
      entry.plays++;
      entry.total_minutes += Math.max(0, ev.duration_seconds ?? 0) / 60;
      entries.set(key, entry);
    }
  }
  return {
    kind: opts.kind, by, from: opts.from ?? null, to: opts.to ?? null,
    entries: [...entries.values()].sort((a, b) =>
      (by === "plays" ? b.plays - a.plays || b.total_minutes - a.total_minutes : b.total_minutes - a.total_minutes || b.plays - a.plays) ||
      a.title.localeCompare(b.title) || a.key.localeCompare(b.key)).slice(0, opts.limit ?? 10),
  };
}

export function getTop(db: Database, opts: TopOptions): TopResult {
  return aggregateTop(buildAllLibraryWorks(db, opts.tz), opts);
}
