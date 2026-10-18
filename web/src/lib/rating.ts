/**
 * Pure, DOM-free helpers for v2.1 ratings (0..10 with at most one decimal).
 *
 * Uses integer tenths (0..100) internally to prevent floating-point drift
 * (e.g. `7.4 + 0.1 === 7.5`).
 */

export const MIN_RATING_10 = 0;
export const MAX_RATING_10 = 10;
export const MIN_TENTHS = 0;
export const MAX_TENTHS = 100;

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
    const trimmed = input.trim();
    if (trimmed === "") {
      return { ok: true, rating: null };
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return {
        ok: false,
        error: "Rating must be a number between 0 and 10 (e.g. 8.5).",
      };
    }
    const dotIdx = trimmed.indexOf(".");
    if (dotIdx !== -1 && trimmed.length - dotIdx - 1 > 1) {
      return {
        ok: false,
        error: "Rating can have at most one decimal place (e.g. 8.5).",
      };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < MIN_RATING_10 || parsed > MAX_RATING_10) {
      return {
        ok: false,
        error: "Rating must be between 0 and 10.",
      };
    }
    return { ok: true, rating: tenthsToRating(ratingToTenths(parsed)) };
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      return {
        ok: false,
        error: "Rating must be a valid number between 0 and 10.",
      };
    }
    if (input < MIN_RATING_10 || input > MAX_RATING_10) {
      return {
        ok: false,
        error: "Rating must be between 0 and 10.",
      };
    }
    const tenths = input * 10;
    if (Math.abs(tenths - Math.round(tenths)) > 1e-6) {
      return {
        ok: false,
        error: "Rating can have at most one decimal place (e.g. 8.5).",
      };
    }
    return { ok: true, rating: tenthsToRating(Math.round(tenths)) };
  }

  return {
    ok: false,
    error: "Rating must be a number between 0 and 10.",
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
 * Steps a rating by `delta` (e.g. `+0.1`, `-0.1`, `+0.5`, `-0.5`) using
 * integer tenths arithmetic and clamping to `0..10`.
 */
export function stepRating10(
  current: number | null | undefined,
  delta: number
): number {
  const baseTenths =
    current === null || current === undefined || !Number.isFinite(current)
      ? 50 // Default starting point 5.0 when stepping from unrated
      : ratingToTenths(current);
  const deltaTenths = Math.round(delta * 10);
  return tenthsToRating(baseTenths + deltaTenths);
}

export type RatingKeyAction =
  | { type: "step"; delta: number }
  | { type: "set"; value: number }
  | { type: "clear" };

/**
 * Maps keyboard keys (`ArrowLeft`/`Right`/`Up`/`Down` with optional `Shift`,
 * `PageUp`/`PageDown`, `Home`, `End`, `Backspace`/`Delete`) to rating actions:
 * - Arrow keys: `±0.1` (or `±0.5` with Shift)
 * - PageUp / PageDown: `±0.5`
 * - Home / End: `0` / `10`
 * - Delete / Backspace: clear (`null`)
 */
export function resolveRatingKeyAction(
  key: string,
  shiftKey = false
): RatingKeyAction | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return { type: "step", delta: shiftKey ? 0.5 : 0.1 };
    case "ArrowLeft":
    case "ArrowDown":
      return { type: "step", delta: shiftKey ? -0.5 : -0.1 };
    case "PageUp":
      return { type: "step", delta: 0.5 };
    case "PageDown":
      return { type: "step", delta: -0.5 };
    case "Home":
      return { type: "set", value: MIN_RATING_10 };
    case "End":
      return { type: "set", value: MAX_RATING_10 };
    case "Delete":
    case "Backspace":
      return { type: "clear" };
    default:
      return null;
  }
}
