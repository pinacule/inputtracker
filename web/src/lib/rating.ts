/**
 * Pure, DOM-free helpers for v2.2 in-place ratings (0..10 with at most one decimal).
 *
 * Uses integer tenths (0..100) internally to prevent floating-point drift
 * (e.g. `7.4 + 0.1 === 7.5`).
 *
 * Section 16 rules:
 * - Click the ★ badge and it turns in place into a small text field showing the current value
 * - Type `8.5`, Enter saves, Esc cancels, blur saves if valid
 * - ↑/↓ and the mouse wheel nudge by 0.1 (Shift: 1.0)
 * - Invalid input shows a short inline hint and does not save
 * - Hidden for music (`canRateCategory("music") === false`)
 */

export const MIN_RATING_10 = 0;
export const MAX_RATING_10 = 10;
export const MIN_TENTHS = 0;
export const MAX_TENTHS = 100;
export const DEFAULT_NUDGE_START_TENTHS = 80; // 8.0 when nudging from unrated

/**
 * Returns whether a category supports ratings.
 * Music tracks have no rating control (`category === "music"` returns `false`).
 */
export function canRateCategory(
  category: string | null | undefined
): boolean {
  if (!category) {
    return true;
  }
  return !["music", "shortform"].includes(category.trim().toLowerCase());
}

/** Convert a 0..10 rating to integer tenths (0..100). */
export function ratingToTenths(rating: number): number {
  return Math.round(rating * 10);
}

/** Convert integer tenths (0..100) back to a 0..10 rating with at most one decimal. */
export function tenthsToRating(tenths: number): number {
  const clamped = Math.max(MIN_TENTHS, Math.min(MAX_TENTHS, Math.round(tenths)));
  return clamped / 10;
}

export type ValidateRating10Result =
  | { ok: true; rating: number | null }
  | { ok: false; error: string };

/**
 * Validates a rating value (number, string, or null/undefined).
 * Accepts `null`/`undefined`/`""` as `null` (unrated), or a number in `0..10`
 * with at most one decimal place (`0`, `7.5`, `10`).
 * Rejects `< 0`, `> 10`, `NaN`, or more than one decimal (`7.25`).
 */
export function validateRating10(input: unknown): ValidateRating10Result {
  if (input === null || input === undefined) {
    return { ok: true, rating: null };
  }

  if (typeof input === "string") {
    const trimmed = input.trim().replace(",", ".");
    if (trimmed === "") {
      return { ok: true, rating: null };
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return {
        ok: false,
        error: "0–10, one decimal (e.g. 8.5)",
      };
    }
    const dotIdx = trimmed.indexOf(".");
    if (dotIdx !== -1 && trimmed.length - dotIdx - 1 > 1) {
      return {
        ok: false,
        error: "At most one decimal (e.g. 8.5)",
      };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < MIN_RATING_10 || parsed > MAX_RATING_10) {
      return {
        ok: false,
        error: "Must be between 0 and 10",
      };
    }
    return { ok: true, rating: tenthsToRating(ratingToTenths(parsed)) };
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      return {
        ok: false,
        error: "0–10, one decimal (e.g. 8.5)",
      };
    }
    if (input < MIN_RATING_10 || input > MAX_RATING_10) {
      return {
        ok: false,
        error: "Must be between 0 and 10",
      };
    }
    const tenths = input * 10;
    if (Math.abs(tenths - Math.round(tenths)) > 1e-6) {
      return {
        ok: false,
        error: "At most one decimal (e.g. 8.5)",
      };
    }
    return { ok: true, rating: tenthsToRating(Math.round(tenths)) };
  }

  return {
    ok: false,
    error: "0–10, one decimal (e.g. 8.5)",
  };
}

export const parseRating10Input = validateRating10;

export interface FormatRating10Options {
  /** Always show one decimal for 0..9 (e.g. `8` -> `"8.0"`, `10` stays `"10"`). */
  fixed?: boolean;
  /** Fallback text when unrated (default `"—"`). */
  fallback?: string;
}

/**
 * Formats a 0..10 rating for display (e.g. `8.5` -> `"8.5"`, `10` -> `"10"`, `0` -> `"0"`).
 */
export function formatRating10(
  rating: number | null | undefined,
  options: FormatRating10Options = {}
): string {
  const fallback = options.fallback ?? "—";
  if (rating === null || rating === undefined || !Number.isFinite(rating)) {
    return fallback;
  }
  const normalized = tenthsToRating(ratingToTenths(rating));
  if (options.fixed && normalized < 10) {
    return normalized.toFixed(1);
  }
  return Number.isInteger(normalized)
    ? String(normalized)
    : normalized.toFixed(1);
}

/**
 * Steps a rating by `delta` (e.g. `+0.1`, `-0.1`, `+1.0`, `-1.0`) using
 * integer tenths arithmetic and clamping to `0..10`.
 */
export function stepRating10(
  current: number | null | undefined,
  delta: number
): number {
  const baseTenths =
    current === null || current === undefined || !Number.isFinite(current)
      ? DEFAULT_NUDGE_START_TENTHS
      : ratingToTenths(current);
  const deltaTenths = Math.round(delta * 10);
  return tenthsToRating(baseTenths + deltaTenths);
}

/**
 * Nudges an in-place text input value by `delta` (`±0.1` or `±1.0`),
 * using the current typed text if it parses to a valid rating, else
 * `fallbackRating`, else `8.0`.
 */
export function nudgeRatingText(
  rawText: string,
  fallbackRating: number | null | undefined,
  delta: number
): { rating: number; text: string } {
  const check = validateRating10(rawText);
  const base =
    check.ok && check.rating !== null
      ? check.rating
      : fallbackRating !== null &&
          fallbackRating !== undefined &&
          Number.isFinite(fallbackRating)
        ? fallbackRating
        : null;
  const next = stepRating10(base, delta);
  return {
    rating: next,
    text: formatRating10(next),
  };
}

/**
 * Computes the rating nudge delta for a mouse wheel event:
 * - Scroll up (`deltaY < 0`): `+0.1` (`+1.0` with Shift)
 * - Scroll down (`deltaY > 0`): `-0.1` (`-1.0` with Shift)
 * - `0` when `deltaY === 0`
 */
export function resolveRatingWheelDelta(
  deltaY: number,
  shiftKey = false
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return 0;
  }
  const step = shiftKey ? 1.0 : 0.1;
  return deltaY < 0 ? step : -step;
}

export type RatingKeyAction =
  | { type: "step"; delta: number }
  | { type: "set"; value: number }
  | { type: "clear" }
  | { type: "commit" }
  | { type: "cancel" };

/**
 * Maps keyboard keys in the rating input to rating actions:
 * - ArrowUp / ArrowDown: `±0.1` (`±1.0` with Shift)
 * - PageUp / PageDown: `±1.0`
 * - Enter: `commit`
 * - Escape: `cancel`
 */
export function resolveRatingKeyAction(
  key: string,
  shiftKey = false
): RatingKeyAction | null {
  switch (key) {
    case "ArrowUp":
      return { type: "step", delta: shiftKey ? 1.0 : 0.1 };
    case "ArrowDown":
      return { type: "step", delta: shiftKey ? -1.0 : -0.1 };
    case "PageUp":
      return { type: "step", delta: 1.0 };
    case "PageDown":
      return { type: "step", delta: -1.0 };
    case "Enter":
      return { type: "commit" };
    case "Escape":
      return { type: "cancel" };
    default:
      return null;
  }
}

export type InlineRatingCommitResult =
  | { action: "save"; rating: number | null }
  | { action: "noop" }
  | { action: "invalid"; error: string };

/**
 * Evaluates what should happen on Enter or blur for an in-place rating input:
 * - Empty text when previously unrated -> `noop` (close without saving)
 * - Empty text when previously rated -> `save` with `null` (clears rating)
 * - Valid rating equal to `previousRating` -> `noop` (close without saving)
 * - Valid rating different from `previousRating` -> `save` with `rating`
 * - Invalid text -> `invalid` with short inline `error` (do not save)
 */
export function commitInlineRatingInput(
  rawText: string,
  previousRating: number | null | undefined
): InlineRatingCommitResult {
  const prev =
    previousRating !== null &&
    previousRating !== undefined &&
    Number.isFinite(previousRating)
      ? tenthsToRating(ratingToTenths(previousRating))
      : null;

  if (rawText.trim() === "") {
    if (prev !== null) {
      return { action: "save", rating: null };
    }
    return { action: "noop" };
  }

  const parsed = validateRating10(rawText);
  if (!parsed.ok) {
    return { action: "invalid", error: parsed.error };
  }

  if (parsed.rating === prev) {
    return { action: "noop" };
  }

  return { action: "save", rating: parsed.rating };
}
