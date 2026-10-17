/**
 * Pure form logic for the Add and Import/Export pages.
 *
 * No DOM, no `fetch`: these helpers only turn raw form state into a validated
 * `ManualEventInput` payload and format API results, so they can be unit-tested
 * under Bun without a browser.
 */

import type { ManualEventInput } from "../api";

/** Allowed `media_type` values; mirrors `VALID_MEDIA_TYPES` in `src/core/events.ts`. */
export const MEDIA_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "movie", label: "Movie" },
  { value: "episode", label: "Episode" },
  { value: "book", label: "Book" },
  { value: "audiobook", label: "Audiobook" },
  { value: "podcast_episode", label: "Podcast episode" },
  { value: "video", label: "Video" },
  { value: "other", label: "Other" },
];

const MEDIA_TYPE_VALUES: ReadonlySet<string> = new Set(
  MEDIA_TYPE_OPTIONS.map((option) => option.value)
);

/**
 * Raw values read out of the Add form. `datetime-local` inputs produce a
 * `YYYY-MM-DDTHH:mm` wall-clock string, which `localToUtcIso` already accepts.
 */
export interface AddFormState {
  media_type: string;
  title: string;
  parent_title: string;
  season: string;
  episode: string;
  started_at: string;
  duration_min: string;
  ended_at: string;
}

export interface BuildEventResult {
  /** Human-readable validation problems; empty when `input` is set. */
  errors: string[];
  /** Valid payload, or `null` when there was at least one problem. */
  input: ManualEventInput | null;
}

function trim(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parse an optional integer form field. Empty → null; invalid/negative → error. */
function parseOptionalInteger(
  raw: string | undefined,
  field: string,
  errors: string[]
): number | null {
  const value = trim(raw);
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    errors.push(`${field} must be an integer >= 0`);
    return null;
  }
  return parsed;
}

/**
 * Validate raw Add-form state and build the `ManualEventInput` to POST.
 *
 * - `media_type`, `title` and `started_at` are required.
 * - `duration_min` (minutes) is converted to `duration_seconds`.
 * - Empty optional strings become `null`; invalid numbers add an error.
 */
export function buildEventInput(state: AddFormState): BuildEventResult {
  const errors: string[] = [];

  const mediaType = trim(state.media_type);
  if (mediaType === "") {
    errors.push("media_type is required");
  } else if (!MEDIA_TYPE_VALUES.has(mediaType)) {
    errors.push(`Invalid media_type: '${mediaType}'`);
  }

  const title = trim(state.title);
  if (title === "") {
    errors.push("title is required");
  }

  const startedAt = trim(state.started_at);
  if (startedAt === "") {
    errors.push("started_at is required");
  }

  const parentTitle = trim(state.parent_title);
  const endedAt = trim(state.ended_at);

  const season = parseOptionalInteger(state.season, "season", errors);
  const episode = parseOptionalInteger(state.episode, "episode", errors);

  let durationSeconds: number | null = null;
  const durationRaw = trim(state.duration_min);
  if (durationRaw !== "") {
    const minutes = Number(durationRaw);
    if (!Number.isFinite(minutes)) {
      errors.push("duration must be a number");
    } else if (minutes < 0) {
      errors.push("duration must be >= 0");
    } else {
      durationSeconds = minutes * 60;
    }
  }

  if (errors.length > 0) {
    return { errors, input: null };
  }

  return {
    errors: [],
    input: {
      media_type: mediaType,
      title,
      parent_title: parentTitle === "" ? null : parentTitle,
      season,
      episode,
      started_at: startedAt,
      ended_at: endedAt === "" ? null : endedAt,
      duration_seconds: durationSeconds,
    },
  };
}

/** Format an import/sync result as `"3 new of 5 seen"` (or `"0 new of 5 seen"`). */
export function describeImport(result: { seen: number; inserted: number }): string {
  return `${result.inserted} new of ${result.seen} seen`;
}
