/**
 * Rating validation and tenths conversion (v2.1 section 7).
 *
 * - Ratings are 0..10 with at most one decimal place (e.g. 0, 7.5, 10).
 * - Stored in SQLite as integer tenths (0..100) to avoid floating-point drift.
 * - Legacy integer ratings (1..10 in `annotations.rating` where `rating_tenths`
 *   is NULL) continue to read as the same value.
 */

export const MIN_RATING = 0;
export const MAX_RATING = 10;
export const MIN_RATING_TENTHS = 0;
export const MAX_RATING_TENTHS = 100;

export class RatingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatingValidationError";
  }
}

/**
 * Validate a rating (`0..10` with at most one decimal place, or `null`/`undefined`)
 * and return integer tenths (`0..100`) or `null`.
 */
export function ratingToTenths(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RatingValidationError(
      `Field 'rating' must be a number between ${MIN_RATING} and ${MAX_RATING}`
    );
  }
  if (value < MIN_RATING || value > MAX_RATING) {
    throw new RatingValidationError(
      `Field 'rating' must be between ${MIN_RATING} and ${MAX_RATING}, got ${value}`
    );
  }
  const tenths = Math.round(value * 10);
  if (
    tenths < MIN_RATING_TENTHS ||
    tenths > MAX_RATING_TENTHS ||
    Math.abs(value * 10 - tenths) > 1e-6 ||
    /\.\d{2,}/.test(String(value))
  ) {
    throw new RatingValidationError(
      `Field 'rating' must have at most one decimal place between ${MIN_RATING} and ${MAX_RATING}, got ${value}`
    );
  }
  return tenths;
}

/**
 * Convert stored `rating_tenths` (or legacy integer `rating` 1..10 when
 * `rating_tenths` is NULL) back to a `0..10` number with at most one decimal.
 */
export function tenthsToRating(
  tenths: number | null | undefined,
  legacyRating?: number | null
): number | null {
  if (typeof tenths === "number" && Number.isFinite(tenths)) {
    return tenths / 10;
  }
  if (typeof legacyRating === "number" && Number.isFinite(legacyRating)) {
    return legacyRating;
  }
  return null;
}

/**
 * Value for the legacy `annotations.rating` column (`CHECK (rating BETWEEN 1 AND 10)`):
 * populated when the rating is a whole integer 1..10, otherwise `null`.
 */
export function tenthsToLegacyRating(tenths: number | null): number | null {
  if (tenths === null) {
    return null;
  }
  if (tenths >= 10 && tenths <= 100 && tenths % 10 === 0) {
    return tenths / 10;
  }
  return null;
}
