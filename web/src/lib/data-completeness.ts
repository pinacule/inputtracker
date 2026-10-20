/**
 * The archive is still being filled: older history from several sources
 * (Simkl, Audiobookshelf, YouTube, phone short-form) is missing or partial, so
 * averages and "usual" comparisons would describe the gaps, not the habits.
 *
 * COMPLETE_FROM is the first local date (YYYY-MM-DD) from which every source's
 * history is in the archive. While it is null the app shows plain totals and
 * counts only; once set, averages and norms use days from that date on.
 */
export const COMPLETE_FROM: string | null = null;

/** History start for averages: never earlier than COMPLETE_FROM; null while incomplete. */
export function completeHistoryStart(
  historyStart: string | null,
  completeFrom: string | null = COMPLETE_FROM,
): string | null {
  if (!completeFrom) return null;
  if (!historyStart) return completeFrom;
  return historyStart > completeFrom ? historyStart : completeFrom;
}

/** Whether a date range lies entirely within complete history (averages allowed). */
export function rangeIsComplete(from: string, completeFrom: string | null = COMPLETE_FROM): boolean {
  return completeFrom !== null && from >= completeFrom;
}
