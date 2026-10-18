/**
 * Ratings (1–10) and free-text notes on titles (F3).
 *
 * A title is the same group the Search page uses: `source` +
 * `getSeriesOrTitle(event)` (one book, one show, one movie, one YouTube video).
 * Like `events` and `goals`, `annotations` is append-only: every save is a new
 * row, and readers use the `annotations_latest` view (newest row per
 * `(source, title)`).
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AnnotationRow } from "../core/schema.ts";
import {
  MAX_RATING,
  MIN_RATING,
  RatingValidationError,
  ratingToTenths,
  tenthsToLegacyRating,
  tenthsToRating,
} from "./ratings.ts";

export { MAX_RATING, MIN_RATING };

/** UUID v4-ish format check (same shape as the goals module uses). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_ANNOTATION_SOURCE_LENGTH = 64;
export const MAX_ANNOTATION_TITLE_LENGTH = 500;
export const MAX_ANNOTATION_NOTE_LENGTH = 5000;

export class AnnotationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnotationValidationError";
  }
}

/** Identifies one annotated title: the Search grouping key. */
export interface AnnotationKey {
  source: string;
  title: string;
}

/** One row of `annotations_latest`: the current rating + note of a title. */
export interface Annotation {
  id: number;
  record_hash: string;
  source: string;
  title: string;
  rev_id: string;
  rating: number | null;
  note: string | null;
  created_at: string;
}

/** What readers get for a title nobody annotated yet. */
export interface EmptyAnnotation {
  rating: null;
  note: null;
}

export interface SaveAnnotationInput {
  source?: unknown;
  title?: unknown;
  rating?: unknown;
  note?: unknown;
  rev_id?: unknown;
}

export interface SaveAnnotationResult {
  rev_id: string;
  inserted: boolean;
  annotation: Annotation;
}

/** Map key for `getAnnotationsFor` results: `${source}\u0000${title}`. */
export function annotationMapKey(source: string, title: string): string {
  return `${source}\u0000${title}`;
}

/** Validate the title identity; returns the trimmed values. */
export function parseAnnotationKey(
  source: unknown,
  title: unknown
): AnnotationKey {
  if (typeof source !== "string") {
    throw new AnnotationValidationError("Field 'source' must be a string");
  }
  const trimmedSource = source.trim();
  if (trimmedSource.length === 0) {
    throw new AnnotationValidationError(
      "Field 'source' is required and cannot be empty"
    );
  }
  if (trimmedSource.length > MAX_ANNOTATION_SOURCE_LENGTH) {
    throw new AnnotationValidationError(
      `Field 'source' is too long (${trimmedSource.length} characters, max ${MAX_ANNOTATION_SOURCE_LENGTH})`
    );
  }

  if (typeof title !== "string") {
    throw new AnnotationValidationError("Field 'title' must be a string");
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    throw new AnnotationValidationError(
      "Field 'title' is required and cannot be empty"
    );
  }
  if (trimmedTitle.length > MAX_ANNOTATION_TITLE_LENGTH) {
    throw new AnnotationValidationError(
      `Field 'title' is too long (${trimmedTitle.length} characters, max ${MAX_ANNOTATION_TITLE_LENGTH})`
    );
  }

  return { source: trimmedSource, title: trimmedTitle };
}

/** Validate the rating: 0..10 with at most one decimal place, or null when absent. */
export function parseRating(value: unknown): number | null {
  try {
    const tenths = ratingToTenths(value);
    return tenths === null ? null : tenths / 10;
  } catch (err) {
    if (err instanceof RatingValidationError) {
      throw new AnnotationValidationError(err.message);
    }
    throw err;
  }
}

/**
 * Validate the note. Stored exactly as typed except trailing whitespace is
 * trimmed; an empty note becomes null (same as clearing it).
 */
export function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new AnnotationValidationError("Field 'note' must be a string");
  }
  const trimmed = value.trimEnd();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_ANNOTATION_NOTE_LENGTH) {
    throw new AnnotationValidationError(
      `Field 'note' is too long (${trimmed.length} characters, max ${MAX_ANNOTATION_NOTE_LENGTH})`
    );
  }
  return trimmed;
}

/** Validate `rev_id`, or generate one when missing. */
export function parseRevId(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return crypto.randomUUID();
  }
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new AnnotationValidationError(`Invalid rev_id format: '${value}'`);
  }
  return value;
}

/** sha256 of the canonical JSON of `source, title, rev_id, rating, note`. */
export function annotationRecordHash(norm: {
  source: string;
  title: string;
  rev_id: string;
  rating: number | null;
  note: string | null;
}): string {
  const hashObj = {
    source: norm.source,
    title: norm.title,
    rev_id: norm.rev_id,
    rating: norm.rating,
    note: norm.note,
  };
  return createHash("sha256").update(JSON.stringify(hashObj)).digest("hex");
}

function rowToAnnotation(row: AnnotationRow): Annotation {
  return {
    id: row.id,
    record_hash: row.record_hash,
    source: row.source,
    title: row.title,
    rev_id: row.rev_id,
    rating: tenthsToRating(row.rating_tenths, row.rating),
    note: row.note,
    created_at: row.created_at,
  };
}

function getLatestAnnotation(
  db: Database,
  source: string,
  title: string
): Annotation | null {
  const row = db
    .query<AnnotationRow, [string, string, string]>(
      `SELECT id, record_hash, source, title, rev_id, rating, rating_tenths, note, created_at
       FROM annotations_latest
       WHERE (source = ? AND title = ?) OR lower(title) = lower(?)
       ORDER BY id DESC
       LIMIT 1;`
    )
    .get(source, title, title);
  return row === null ? null : rowToAnnotation(row);
}

/**
 * Validates and saves one annotation revision. Every save is a new row;
 * clearing the rating or the note is a new row with `NULL`s. A retried save
 * with the same `rev_id` inserts nothing (`INSERT OR IGNORE` on
 * `record_hash`).
 */
export function saveAnnotation(
  db: Database,
  input: SaveAnnotationInput,
  now?: string
): SaveAnnotationResult {
  if (!input || typeof input !== "object") {
    throw new AnnotationValidationError("Input must be an object");
  }

  const key = parseAnnotationKey(input.source, input.title);
  const rating = parseRating(input.rating);
  const ratingTenths = rating === null ? null : Math.round(rating * 10);
  const legacyRating = tenthsToLegacyRating(ratingTenths);
  const note = parseNote(input.note);
  const revId = parseRevId(input.rev_id);
  const createdAt = now ?? new Date().toISOString();

  const recordHash = annotationRecordHash({
    source: key.source,
    title: key.title,
    rev_id: revId,
    rating,
    note,
  });

  const res = db.run(
    `INSERT OR IGNORE INTO annotations (
      record_hash,
      source,
      title,
      rev_id,
      rating,
      rating_tenths,
      note,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      recordHash,
      key.source,
      key.title,
      revId,
      legacyRating,
      ratingTenths,
      note,
      createdAt,
    ]
  );

  const annotation = getLatestAnnotation(db, key.source, key.title);
  if (annotation === null) {
    throw new Error("Failed to read back the saved annotation");
  }

  return {
    rev_id: revId,
    inserted: res.changes > 0,
    annotation,
  };
}

/**
 * The latest annotation for one title, or `{ rating: null, note: null }`
 * when the title has none yet.
 */
export function getAnnotation(
  db: Database,
  source: unknown,
  title: unknown
): Annotation | EmptyAnnotation {
  const key = parseAnnotationKey(source, title);
  return getLatestAnnotation(db, key.source, key.title) ?? { rating: null, note: null };
}

/**
 * Batch lookup for lists: one query for all keys, returning a map from
 * `annotationMapKey(source, title)` to the latest annotation. Titles without
 * an annotation are absent from the map.
 */
export function getAnnotationsFor(
  db: Database,
  keys: readonly AnnotationKey[]
): Map<string, Annotation> {
  const result = new Map<string, Annotation>();
  if (keys.length === 0) {
    return result;
  }

  const uniqueTitles = Array.from(new Set(keys.map((k) => k.title.toLowerCase())));
  const placeholders = uniqueTitles.map(() => "?").join(", ");

  const rows = db
    .query<AnnotationRow, string[]>(
      `SELECT id, record_hash, source, title, rev_id, rating, rating_tenths, note, created_at
       FROM annotations_latest
       WHERE lower(title) IN (${placeholders})
       ORDER BY id ASC;`
    )
    .all(...uniqueTitles);

  const byLowerTitle = new Map<string, Annotation>();
  for (const row of rows) {
    const ann = rowToAnnotation(row);
    byLowerTitle.set(row.title.toLowerCase(), ann);
    result.set(annotationMapKey(row.source, row.title), ann);
  }

  for (const key of keys) {
    const mapKey = annotationMapKey(key.source, key.title);
    const byTitle = byLowerTitle.get(key.title.toLowerCase());
    if (byTitle !== undefined) {
      result.set(mapKey, byTitle);
    }
  }
  return result;
}
