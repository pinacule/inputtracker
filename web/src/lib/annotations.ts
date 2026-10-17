/**
 * Pure, unit-tested helpers for ratings + notes (F3).
 *
 * No DOM, no `fetch`: rating <-> stars conversion, formatting labels, the
 * note length counter, and building/validating the save payload (the server
 * re-validates everything).
 */

export const MIN_RATING = 1;
export const MAX_RATING = 10;
export const MAX_NOTE_LENGTH = 5000;
export const MAX_TITLE_LENGTH = 500;
export const MAX_SOURCE_LENGTH = 64;

/** Rating 1–10 → stars 0.5–5 (`7` → `3.5`); null/undefined stays null. */
export function ratingToStars(
  rating: number | null | undefined
): number | null {
  if (rating === null || rating === undefined) {
    return null;
  }
  return rating / 2;
}

/** Stars 0.5–5 → rating 1–10, rounded to a whole number and clamped. */
export function starsToRating(stars: number): number {
  if (!Number.isFinite(stars)) {
    return MIN_RATING;
  }
  return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(stars * 2)));
}

/**
 * Compact star value with a vulgar fraction for halves: `3.5` → `"3½"`,
 * `4` → `"4"`, `0.5` → `"½"`.
 */
export function formatStarValue(stars: number): string {
  const whole = Math.floor(stars);
  const half = stars - whole >= 0.5;
  if (whole === 0) {
    return half ? "½" : "0";
  }
  return half ? `${whole}½` : `${whole}`;
}

/** `7` → `"3.5 of 5 stars"`, `8` → `"4 of 5 stars"`, null → `"Not rated"`. */
export function formatRating(rating: number | null | undefined): string {
  const stars = ratingToStars(rating);
  if (stars === null) {
    return "Not rated";
  }
  const text = Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
  return `${text} of 5 stars`;
}

/** Note length counter text: `"123 / 5000"`. */
export function formatNoteCounter(note: string): string {
  return `${note.length} / ${MAX_NOTE_LENGTH}`;
}

/** True when the note fits in the limit (after trailing trim, like storage). */
export function isNoteTooLong(note: string): boolean {
  return note.trimEnd().length > MAX_NOTE_LENGTH;
}

export interface AnnotationBody {
  source: string;
  title: string;
  rating: number | null;
  note: string | null;
}

export type BuildAnnotationBodyResult =
  | { ok: true; body: AnnotationBody }
  | { ok: false; errors: string[] };

/**
 * Validate raw editor input and build the save payload (`rev_id` is not
 * part of the body: the editor generates one per save attempt and reuses it
 * across retries). Collects every problem so the UI can show them at once.
 * Mirrors the server validation in `src/server/annotations.ts`.
 */
export function buildAnnotationBody(input: {
  source: string;
  title: string;
  rating: number | null | undefined;
  note: string | null | undefined;
}): BuildAnnotationBodyResult {
  const errors: string[] = [];

  const source = input.source?.trim() ?? "";
  if (source.length === 0) {
    errors.push("Source is required.");
  } else if (source.length > MAX_SOURCE_LENGTH) {
    errors.push(
      `Source is too long (${source.length} characters, max ${MAX_SOURCE_LENGTH}).`
    );
  }

  const title = input.title?.trim() ?? "";
  if (title.length === 0) {
    errors.push("Title is required.");
  } else if (title.length > MAX_TITLE_LENGTH) {
    errors.push(
      `Title is too long (${title.length} characters, max ${MAX_TITLE_LENGTH}).`
    );
  }

  let rating: number | null = null;
  if (input.rating !== null && input.rating !== undefined) {
    if (
      !Number.isInteger(input.rating) ||
      input.rating < MIN_RATING ||
      input.rating > MAX_RATING
    ) {
      errors.push(
        `Rating must be a whole number between ${MIN_RATING} and ${MAX_RATING}.`
      );
    } else {
      rating = input.rating;
    }
  }

  let note: string | null = null;
  if (input.note !== null && input.note !== undefined) {
    const trimmed = input.note.trimEnd();
    if (trimmed.length > MAX_NOTE_LENGTH) {
      errors.push(
        `Note is too long (${trimmed.length} characters, max ${MAX_NOTE_LENGTH}).`
      );
    } else if (trimmed.length > 0) {
      note = trimmed;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, body: { source, title, rating, note } };
}
