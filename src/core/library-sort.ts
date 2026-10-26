/**
 * Shared ordering for the Library "rating" and "progress" sorts, used by the
 * server (`GET /api/library?sort=`) and the web shelf so both agree. Pure.
 */

export interface SortableLibraryWork {
  readonly status: string;
  readonly rating: number | null;
  readonly title: string;
  readonly progress?: {
    readonly seasons_watched: number;
    readonly seasons_total: number | null;
    readonly episodes_watched: number;
    readonly episodes_total: number | null;
  } | null;
  readonly consumption_progress?: number | null;
}

/**
 * How far through a work the user is, 0..1, or null when unknown.
 * Finished works count as 1; planned works have no progress yet.
 */
export function libraryWorkProgress(work: SortableLibraryWork): number | null {
  if (work.status === "finished") return 1;
  if (work.status === "planned") return null;
  let fraction: number | null = null;
  if (work.consumption_progress != null) {
    fraction = work.consumption_progress;
  } else if (work.progress) {
    const p = work.progress;
    if (p.episodes_total != null && p.episodes_total > 0) {
      fraction = p.episodes_watched / p.episodes_total;
    } else if (p.seasons_total != null && p.seasons_total > 0) {
      fraction = p.seasons_watched / p.seasons_total;
    }
  }
  if (fraction == null || !Number.isFinite(fraction)) return null;
  return Math.min(1, Math.max(0, fraction));
}

/** Highest rating first; unrated works last. `reversed` flips only the rated part. */
export function compareByRating(
  a: SortableLibraryWork,
  b: SortableLibraryWork,
  reversed = false
): number {
  if (a.rating == null || b.rating == null) {
    if (a.rating != null) return -1;
    if (b.rating != null) return 1;
    return a.title.localeCompare(b.title);
  }
  const diff = reversed ? a.rating - b.rating : b.rating - a.rating;
  return diff || a.title.localeCompare(b.title);
}

/**
 * Closest to done first, but not done: partial works (below 100%), then
 * finished works, then works without known progress. `reversed` puts the
 * least-progressed partial works first; finished/unknown stay at the end.
 */
export function compareByProgress(
  a: SortableLibraryWork,
  b: SortableLibraryWork,
  reversed = false
): number {
  const pa = libraryWorkProgress(a);
  const pb = libraryWorkProgress(b);
  const tier = (p: number | null): number => (p == null ? 2 : p >= 1 ? 1 : 0);
  const ta = tier(pa);
  const tb = tier(pb);
  if (ta !== tb) return ta - tb;
  if (ta === 0 && pa !== pb) {
    return reversed ? pa! - pb! : pb! - pa!;
  }
  return a.title.localeCompare(b.title);
}
