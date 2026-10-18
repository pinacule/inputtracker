import type { LibraryWork } from "../api";
import type { Category } from "../../../src/core/contract";

/** Props the app shell passes to the home page (`#/calendar`). Keep or extend as needed. */
export interface CalendarProps {
  /** `?date=YYYY-MM-DD`: the day to select. */
  date?: string;
  /** `?month=YYYY-MM`: the month to show. */
  initialMonth?: string;
  initialCategory?: Category;
  initialCategories?: readonly Category[];
  includeYoutubeInAll?: boolean;
  onOpenAdd?: (prefill?: { date?: string; category?: Category }) => void;
  onOpenEditWork?: (work: LibraryWork) => void;
}

/** Home page: to be designed from scratch (task W10). */
export function Calendar(_props: CalendarProps) {
  return <section class="page"><h1>Home</h1></section>;
}
