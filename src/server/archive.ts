/**
 * Archive entries (v2 section 2): add, edit, list and tombstone-delete past
 * media consumption entries (`POST /api/archive`, `POST /api/archive/:entry_id/delete`,
 * `GET /api/archive`).
 *
 * Rules:
 * - Append-only: never UPDATE or DELETE `events` or `annotations`.
 * - Each archive entry is stored as units (`source = "manual"`, `source_kind = "archive"`,
 *   `source_id = "archive:<entry_id>:<unit>"`).
 * - Editing writes new unit versions and tombstones (`raw.deleted = true`,
 *   `duration_seconds = 0`) for removed units.
 * - Re-sending an identical request inserts nothing.
 */

import type { Database } from "bun:sqlite";
import { categoryOf, isCategory, type Category } from "../core/category.ts";
import type {
  ArchiveConsumed,
  ArchiveEntrySummary,
  ArchiveRequest,
  ArchiveResult,
  ArchiveWhen,
  DatePrecision,
  ManualWork,
  MetaProvider,
  SeasonInfo,
  WorkDetails,
} from "../core/contract.ts";
import {
  finishRun,
  insertEvents,
  recordHash,
  startRun,
  type MediaType,
  type NewEvent,
} from "../core/events.ts";
import type { EventRow } from "../core/schema.ts";
import { localToUtcIso } from "../core/time.ts";
import {
  coverUrlFor,
  META_ID_RE,
  parseExternalIds,
  parseJsonObject,
  VALID_META_PROVIDERS,
} from "./aggregate.ts";
import {
  AnnotationValidationError,
  getAnnotation,
  parseNote,
  parseRating,
  saveAnnotation,
} from "./annotations.ts";

export const ARCHIVE_SOURCE = "manual";
export const ARCHIVE_SOURCE_KIND = "archive";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveValidationError";
  }
}

export class ArchiveNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Archive entry not found: ${entryId}`);
    this.name = "ArchiveNotFoundError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidCalendarDate(str: string): boolean {
  if (!DATE_RE.test(str)) {
    return false;
  }
  const [yStr, mStr, dStr] = str.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Add `delta` days to a `"YYYY-MM-DD"` date string. */
function addDaysToDate(dateStr: string, delta: number): string {
  const [yStr, mStr, dStr] = dateStr.split("-");
  const dt = new Date(
    Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr) + delta)
  );
  const y = String(dt.getUTCFullYear()).padStart(4, "0");
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Difference in days (`endDate - startDate`) between two `"YYYY-MM-DD"` strings. */
function daysBetween(startDate: string, endDate: string): number {
  const [y1, m1, d1] = startDate.split("-").map(Number);
  const [y2, m2, d2] = endDate.split("-").map(Number);
  const ms1 = Date.UTC(y1!, m1! - 1, d1!);
  const ms2 = Date.UTC(y2!, m2! - 1, d2!);
  return Math.round((ms2 - ms1) / 86_400_000);
}

/** First local calendar day `"YYYY-MM-DD"` for a date string at the given precision. */
function periodFirstLocalDay(
  precision: Exclude<DatePrecision, "unknown">,
  dateStr: string
): string {
  if (precision === "day") {
    return dateStr;
  }
  if (precision === "month") {
    return `${dateStr}-01`;
  }
  return `${dateStr}-01-01`;
}

function validateSeasonInfo(raw: unknown, index: number): SeasonInfo {
  if (!isObject(raw)) {
    throw new ArchiveValidationError(`work.seasons[${index}] must be an object`);
  }
  const num = raw.number;
  if (typeof num !== "number" || !Number.isInteger(num) || num < 1) {
    throw new ArchiveValidationError(
      `work.seasons[${index}].number must be a positive integer`
    );
  }
  const episodes = raw.episodes;
  if (typeof episodes !== "number" || !Number.isInteger(episodes) || episodes < 0) {
    throw new ArchiveValidationError(
      `work.seasons[${index}].episodes must be a non-negative integer`
    );
  }
  const title =
    typeof raw.title === "string" && raw.title.trim() !== ""
      ? raw.title.trim()
      : null;
  const year =
    typeof raw.year === "number" && Number.isInteger(raw.year) ? raw.year : null;
  const episodeMinutes =
    typeof raw.episode_minutes === "number" &&
    Number.isFinite(raw.episode_minutes) &&
    raw.episode_minutes >= 0
      ? raw.episode_minutes
      : null;
  const totalMinutes =
    typeof raw.total_minutes === "number" &&
    Number.isFinite(raw.total_minutes) &&
    raw.total_minutes >= 0
      ? raw.total_minutes
      : null;
  const providerId =
    typeof raw.provider_id === "string" && raw.provider_id.trim() !== ""
      ? raw.provider_id.trim()
      : null;

  return {
    number: num,
    title,
    year,
    episodes,
    episode_minutes: episodeMinutes,
    total_minutes: totalMinutes,
    provider_id: providerId,
  };
}

function validateWork(raw: unknown): WorkDetails | ManualWork {
  if (!isObject(raw)) {
    throw new ArchiveValidationError("Field 'work' must be an object");
  }
  const provider = raw.provider;
  if (
    provider !== "manual" &&
    (typeof provider !== "string" || !VALID_META_PROVIDERS.has(provider))
  ) {
    throw new ArchiveValidationError(
      `Invalid work.provider: '${String(provider)}'`
    );
  }

  if (!isCategory(raw.category)) {
    throw new ArchiveValidationError(
      `Invalid work.category: '${String(raw.category)}'`
    );
  }
  const category = raw.category;

  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new ArchiveValidationError("Field 'work.title' is required");
  }
  const title = raw.title.trim();
  if (title.length > 500) {
    throw new ArchiveValidationError(
      `Field 'work.title' is too long (${title.length} characters, max 500)`
    );
  }

  const year =
    raw.year === null || raw.year === undefined
      ? null
      : typeof raw.year === "number" && Number.isInteger(raw.year)
        ? raw.year
        : (() => {
            throw new ArchiveValidationError(
              "Field 'work.year' must be an integer or null"
            );
          })();

  const creators: string[] = [];
  if (raw.creators !== undefined && raw.creators !== null) {
    if (!Array.isArray(raw.creators)) {
      throw new ArchiveValidationError("Field 'work.creators' must be an array");
    }
    for (const c of raw.creators) {
      if (typeof c === "string" && c.trim() !== "") {
        creators.push(c.trim());
      }
    }
  }

  const seasons: SeasonInfo[] = [];
  if (raw.seasons !== undefined && raw.seasons !== null) {
    if (!Array.isArray(raw.seasons)) {
      throw new ArchiveValidationError("Field 'work.seasons' must be an array");
    }
    for (let i = 0; i < raw.seasons.length; i++) {
      seasons.push(validateSeasonInfo(raw.seasons[i], i));
    }
  }

  let runtimeMinutes: number | null = null;
  if (raw.runtime_minutes !== undefined && raw.runtime_minutes !== null) {
    if (
      typeof raw.runtime_minutes !== "number" ||
      !Number.isFinite(raw.runtime_minutes) ||
      raw.runtime_minutes < 0
    ) {
      throw new ArchiveValidationError(
        "Field 'work.runtime_minutes' must be a non-negative number or null"
      );
    }
    runtimeMinutes = raw.runtime_minutes;
  }

  let pages: number | null = null;
  if (raw.pages !== undefined && raw.pages !== null) {
    if (
      typeof raw.pages !== "number" ||
      !Number.isFinite(raw.pages) ||
      raw.pages < 0
    ) {
      throw new ArchiveValidationError(
        "Field 'work.pages' must be a non-negative number or null"
      );
    }
    pages = raw.pages;
  }

  if (provider === "manual") {
    return {
      provider: "manual",
      category,
      title,
      year,
      creators,
      seasons,
      runtime_minutes: runtimeMinutes,
      pages,
    };
  }

  const providerId = raw.provider_id;
  if (typeof providerId !== "string" || !META_ID_RE.test(providerId)) {
    throw new ArchiveValidationError(
      "Field 'work.provider_id' must match [A-Za-z0-9_-]{1,64}"
    );
  }

  const originalTitle =
    typeof raw.original_title === "string" && raw.original_title.trim() !== ""
      ? raw.original_title.trim()
      : null;

  const coverUrl =
    typeof raw.cover_url === "string" && raw.cover_url.trim() !== ""
      ? raw.cover_url.trim()
      : null;

  const genres: string[] = [];
  if (Array.isArray(raw.genres)) {
    for (const g of raw.genres) {
      if (typeof g === "string" && g.trim() !== "") {
        genres.push(g.trim());
      }
    }
  }

  const description =
    typeof raw.description === "string" && raw.description.trim() !== ""
      ? raw.description.trim().slice(0, 600)
      : null;

  const externalIds: Record<string, string> = {};
  if (isObject(raw.external_ids)) {
    for (const [k, v] of Object.entries(raw.external_ids)) {
      if (typeof v === "string" && v.trim() !== "") {
        externalIds[k] = v.trim();
      } else if (typeof v === "number" && Number.isFinite(v)) {
        externalIds[k] = String(v);
      }
    }
  }

  return {
    provider: provider as MetaProvider,
    provider_id: providerId,
    category,
    title,
    original_title: originalTitle,
    year,
    cover_url: coverUrl,
    creators,
    genres,
    description,
    seasons,
    runtime_minutes: runtimeMinutes,
    pages,
    external_ids: externalIds,
  };
}

function validateWhen(raw: unknown): ArchiveWhen {
  if (!isObject(raw)) {
    throw new ArchiveValidationError("Field 'when' must be an object");
  }
  const precision = raw.precision;
  if (
    precision !== "day" &&
    precision !== "month" &&
    precision !== "year" &&
    precision !== "unknown"
  ) {
    throw new ArchiveValidationError(
      `Invalid when.precision: '${String(precision)}'`
    );
  }

  if (precision === "unknown") {
    if (
      (raw.date !== undefined && raw.date !== null && raw.date !== "") ||
      (raw.end_date !== undefined && raw.end_date !== null && raw.end_date !== "")
    ) {
      throw new ArchiveValidationError(
        "when.date and when.end_date must be omitted when precision is 'unknown'"
      );
    }
    return { precision: "unknown" };
  }

  const date = raw.date;
  if (typeof date !== "string" || date.trim() === "") {
    throw new ArchiveValidationError(
      `Field 'when.date' is required for precision '${precision}'`
    );
  }
  const trimmedDate = date.trim();

  const validateForPrecision = (val: string, fieldName: string): void => {
    if (precision === "day" && !isValidCalendarDate(val)) {
      throw new ArchiveValidationError(
        `Invalid ${fieldName}: '${val}' (expected valid YYYY-MM-DD)`
      );
    }
    if (precision === "month" && !MONTH_RE.test(val)) {
      throw new ArchiveValidationError(
        `Invalid ${fieldName}: '${val}' (expected YYYY-MM)`
      );
    }
    if (precision === "year" && !YEAR_RE.test(val)) {
      throw new ArchiveValidationError(
        `Invalid ${fieldName}: '${val}' (expected YYYY)`
      );
    }
  };

  validateForPrecision(trimmedDate, "when.date");

  const result: ArchiveWhen = {
    precision,
    date: trimmedDate,
  };

  if (raw.end_date !== undefined && raw.end_date !== null && raw.end_date !== "") {
    if (typeof raw.end_date !== "string") {
      throw new ArchiveValidationError("Field 'when.end_date' must be a string");
    }
    const trimmedEnd = raw.end_date.trim();
    validateForPrecision(trimmedEnd, "when.end_date");
    if (trimmedEnd < trimmedDate) {
      throw new ArchiveValidationError(
        "Field 'when.end_date' must not be before 'when.date'"
      );
    }
    result.end_date = trimmedEnd;
  }

  return result;
}

function validateConsumed(
  raw: unknown,
  work: WorkDetails | ManualWork
): ArchiveConsumed {
  if (!isObject(raw)) {
    throw new ArchiveValidationError("Field 'consumed' must be an object");
  }

  const result: ArchiveConsumed = {};

  if (raw.seasons !== undefined && raw.seasons !== null) {
    if (!Array.isArray(raw.seasons) || raw.seasons.length === 0) {
      throw new ArchiveValidationError(
        "Field 'consumed.seasons' must be a non-empty array"
      );
    }
    const seenSeasons = new Set<number>();
    const seasons: Array<{ number: number; episodes?: number }> = [];
    for (let i = 0; i < raw.seasons.length; i++) {
      const item = raw.seasons[i];
      if (!isObject(item)) {
        throw new ArchiveValidationError(
          `consumed.seasons[${i}] must be an object`
        );
      }
      const num = item.number;
      if (typeof num !== "number" || !Number.isInteger(num) || num < 1) {
        throw new ArchiveValidationError(
          `consumed.seasons[${i}].number must be a positive integer`
        );
      }
      if (seenSeasons.has(num)) {
        throw new ArchiveValidationError(
          `Duplicate season number ${num} in consumed.seasons`
        );
      }
      seenSeasons.add(num);

      if (item.episodes !== undefined && item.episodes !== null) {
        if (
          typeof item.episodes !== "number" ||
          !Number.isInteger(item.episodes) ||
          item.episodes < 1
        ) {
          throw new ArchiveValidationError(
            `consumed.seasons[${i}].episodes must be a positive integer`
          );
        }
        seasons.push({ number: num, episodes: item.episodes });
      } else {
        seasons.push({ number: num });
      }
    }
    seasons.sort((a, b) => a.number - b.number);
    result.seasons = seasons;
  } else if (
    work.category === "series" ||
    (work.category === "anime" && work.seasons.length > 0)
  ) {
    throw new ArchiveValidationError(
      "Field 'consumed.seasons' is required for series/seasonal anime"
    );
  }

  if (raw.times !== undefined && raw.times !== null) {
    if (
      typeof raw.times !== "number" ||
      !Number.isInteger(raw.times) ||
      raw.times < 1 ||
      raw.times > 1000
    ) {
      throw new ArchiveValidationError(
        "Field 'consumed.times' must be an integer between 1 and 1000"
      );
    }
    result.times = raw.times;
  }

  if (raw.progress !== undefined && raw.progress !== null) {
    if (
      typeof raw.progress !== "number" ||
      !Number.isFinite(raw.progress) ||
      raw.progress < 0 ||
      raw.progress > 1
    ) {
      throw new ArchiveValidationError(
        "Field 'consumed.progress' must be a number between 0 and 1"
      );
    }
    result.progress = raw.progress;
  }

  if (raw.minutes_override !== undefined && raw.minutes_override !== null) {
    if (
      typeof raw.minutes_override !== "number" ||
      !Number.isFinite(raw.minutes_override) ||
      raw.minutes_override < 0 ||
      raw.minutes_override > 1_000_000
    ) {
      throw new ArchiveValidationError(
        "Field 'consumed.minutes_override' must be a non-negative finite number"
      );
    }
    result.minutes_override = raw.minutes_override;
  }

  return result;
}

interface BuiltUnit {
  unit: string;
  source_id: string;
  media_type: MediaType;
  title: string;
  parent_title: string | null;
  season: number | null;
  episode: number | null;
  progress: number | null;
  naturalMinutes: number | null;
}

function buildExternalIdsForWork(
  work: WorkDetails | ManualWork
): Record<string, string> | null {
  if (work.provider === "manual") {
    return null;
  }
  const ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(work.external_ids)) {
    if (typeof v === "string" && v !== "") {
      ids[k] = v;
    }
  }
  ids.meta_provider = work.provider;
  ids.meta_id = work.provider_id;
  return ids;
}

function computeSeasonNaturalMinutes(
  s: { number: number; episodes?: number },
  seasonInfo: SeasonInfo | undefined,
  workRuntime: number | null
): number | null {
  const isWhole =
    s.episodes === undefined ||
    (seasonInfo !== undefined &&
      seasonInfo.episodes > 0 &&
      s.episodes >= seasonInfo.episodes);

  if (isWhole) {
    if (seasonInfo?.total_minutes !== null && seasonInfo?.total_minutes !== undefined) {
      return seasonInfo.total_minutes;
    }
    if (
      seasonInfo?.episode_minutes !== null &&
      seasonInfo?.episode_minutes !== undefined
    ) {
      const epCount = s.episodes ?? seasonInfo.episodes;
      return epCount > 0 ? epCount * seasonInfo.episode_minutes : null;
    }
    if (workRuntime !== null && workRuntime > 0) {
      const epCount = s.episodes ?? seasonInfo?.episodes ?? 0;
      return epCount > 0 ? epCount * workRuntime : null;
    }
    return null;
  }

  const watchedEps = s.episodes!;
  if (
    seasonInfo?.episode_minutes !== null &&
    seasonInfo?.episode_minutes !== undefined
  ) {
    return watchedEps * seasonInfo.episode_minutes;
  }
  if (
    seasonInfo?.total_minutes !== null &&
    seasonInfo?.total_minutes !== undefined &&
    seasonInfo.episodes > 0
  ) {
    return (seasonInfo.total_minutes / seasonInfo.episodes) * watchedEps;
  }
  if (workRuntime !== null && workRuntime > 0) {
    return watchedEps * workRuntime;
  }
  return null;
}

function buildUnits(
  entryId: string,
  work: WorkDetails | ManualWork,
  consumed: ArchiveConsumed
): BuiltUnit[] {
  const units: BuiltUnit[] = [];

  if (consumed.seasons && consumed.seasons.length > 0) {
    const seasonMap = new Map<number, SeasonInfo>();
    for (const ws of work.seasons) {
      seasonMap.set(ws.number, ws);
    }

    for (const s of consumed.seasons) {
      const seasonInfo = seasonMap.get(s.number);
      const isWhole =
        s.episodes === undefined ||
        (seasonInfo !== undefined &&
          seasonInfo.episodes > 0 &&
          s.episodes >= seasonInfo.episodes);
      const progress = isWhole
        ? 1
        : seasonInfo && seasonInfo.episodes > 0 && s.episodes !== undefined
          ? Math.min(1, Math.max(0, s.episodes / seasonInfo.episodes))
          : null;
      const naturalMinutes = computeSeasonNaturalMinutes(
        s,
        seasonInfo,
        work.runtime_minutes
      );
      const unit = `s${s.number}`;
      units.push({
        unit,
        source_id: `archive:${entryId}:${unit}`,
        media_type: "episode",
        title: work.title,
        parent_title: null,
        season: s.number,
        episode: null,
        progress,
        naturalMinutes,
      });
    }
    return units;
  }

  const isFilmLike =
    work.category === "film" ||
    (work.category === "anime" && work.seasons.length === 0) ||
    consumed.times !== undefined;

  if (isFilmLike) {
    const times = consumed.times ?? 1;
    const perViewingMinutes =
      work.runtime_minutes !== null && work.runtime_minutes > 0
        ? work.runtime_minutes
        : null;
    for (let i = 1; i <= times; i++) {
      const unit = `v${i}`;
      units.push({
        unit,
        source_id: `archive:${entryId}:${unit}`,
        media_type: "movie",
        title: work.title,
        parent_title: null,
        season: null,
        episode: null,
        progress: 1,
        naturalMinutes: perViewingMinutes,
      });
    }
    return units;
  }

  let mediaType: MediaType = "other";
  if (work.category === "book") {
    mediaType = "book";
  } else if (work.category === "audiobook") {
    mediaType = "audiobook";
  } else if (work.category === "youtube") {
    mediaType = "video";
  }

  const progress = consumed.progress ?? 1;
  let naturalMinutes: number | null = null;
  if (work.category === "book" && work.pages !== null && work.pages > 0) {
    naturalMinutes = work.pages * 1.5 * progress;
  } else if (
    work.category !== "audiobook" &&
    work.runtime_minutes !== null &&
    work.runtime_minutes > 0
  ) {
    naturalMinutes = work.runtime_minutes * progress;
  }

  const parentTitle =
    work.creators.length > 0 ? work.creators.join(", ") : null;

  units.push({
    unit: "b",
    source_id: `archive:${entryId}:b`,
    media_type: mediaType,
    title: work.title,
    parent_title: parentTitle,
    season: null,
    episode: null,
    progress,
    naturalMinutes,
  });

  return units;
}

function computeUnitTimestamps(
  count: number,
  when: ArchiveWhen,
  tz: string,
  unknownFallbackIso: string
): string[] {
  if (count <= 0) {
    return [];
  }
  if (when.precision === "unknown") {
    return Array.from({ length: count }, () => unknownFallbackIso);
  }

  const startLocalDay = periodFirstLocalDay(when.precision, when.date!);
  if (!when.end_date || count === 1 || when.end_date === when.date) {
    const iso = localToUtcIso(`${startLocalDay} 12:00:00`, tz);
    return Array.from({ length: count }, () => iso);
  }

  const endLocalDay = periodFirstLocalDay(when.precision, when.end_date);
  const totalDays = Math.max(0, daysBetween(startLocalDay, endLocalDay));

  const timestamps: string[] = [];
  for (let i = 0; i < count; i++) {
    const offset = Math.round((i / (count - 1)) * totalDays);
    const localDay = addDaysToDate(startLocalDay, offset);
    timestamps.push(localToUtcIso(`${localDay} 12:00:00`, tz));
  }
  return timestamps;
}

/**
 * Ensure `event` gets a `record_hash` that does not collide with an older row
 * in `events` (for example when restoring a tombstoned unit or changing `raw`
 * while `HASH_FIELDS` stay the same).
 */
function ensureUniqueHash(db: Database, event: NewEvent): NewEvent {
  let candidate: NewEvent = event;
  let rev = 2;
  for (;;) {
    const hash = recordHash(candidate);
    const exists = db
      .query<{ id: number }, [string]>(
        "SELECT id FROM events WHERE record_hash = ? LIMIT 1;"
      )
      .get(hash);
    if (!exists) {
      return candidate;
    }
    const baseExt = candidate.external_ids ? { ...candidate.external_ids } : {};
    baseExt._rev = String(rev++);
    candidate = {
      ...candidate,
      external_ids: baseExt,
    };
  }
}

export interface SaveArchiveOptions {
  nowIso?: string;
}

/**
 * Validate and store an archive entry (create, edit, or idempotent re-send).
 */
export function saveArchiveEntry(
  db: Database,
  input: unknown,
  tz: string,
  opts: SaveArchiveOptions = {}
): ArchiveResult {
  if (!isObject(input)) {
    throw new ArchiveValidationError("Request body must be a JSON object");
  }

  const entryIdRaw = input.entry_id;
  if (typeof entryIdRaw !== "string" || !UUID_RE.test(entryIdRaw)) {
    throw new ArchiveValidationError("Field 'entry_id' must be a valid UUID");
  }
  const entryId = entryIdRaw.toLowerCase();

  const work = validateWork(input.work);
  const consumed = validateConsumed(input.consumed, work);
  const when = validateWhen(input.when);

  let rating: number | null | undefined = undefined;
  let note: string | null | undefined = undefined;
  try {
    if ("rating" in input) {
      rating = parseRating(input.rating);
    }
    if ("note" in input) {
      note = parseNote(input.note);
    }
  } catch (err) {
    if (err instanceof AnnotationValidationError) {
      throw new ArchiveValidationError(err.message);
    }
    throw err;
  }

  const nowIso = opts.nowIso ?? new Date().toISOString();

  // Existing latest rows for this entry_id in `events` (including tombstones).
  const likePattern = `archive:${entryId}:%`;
  const existingLatestRows = db
    .query<EventRow, [string, string]>(
      `SELECT * FROM events
       WHERE source = 'manual'
         AND source_kind = 'archive'
         AND source_id LIKE ?
         AND id IN (
           SELECT MAX(id) FROM events
           WHERE source = 'manual'
             AND source_kind = 'archive'
             AND source_id LIKE ?
           GROUP BY source, source_kind, source_id
         )
       ORDER BY id ASC;`
    )
    .all(likePattern, likePattern);

  const existingBySourceId = new Map<string, EventRow>();
  for (const row of existingLatestRows) {
    existingBySourceId.set(row.source_id, row);
  }

  // For `unknown` precision, preserve the creation timestamp when re-sending/editing.
  let unknownCreatedIso = nowIso;
  if (when.precision === "unknown" && existingLatestRows.length > 0) {
    const firstExisting = existingLatestRows[0]!;
    const existingRaw = parseJsonObject(firstExisting.raw);
    const existingWhen = parseJsonObject(existingRaw?.["when"]);
    if (existingWhen?.["precision"] === "unknown") {
      unknownCreatedIso = firstExisting.started_at;
    } else {
      unknownCreatedIso = firstExisting.ingested_at;
    }
  }

  const builtUnits = buildUnits(entryId, work, consumed);
  const timestamps = computeUnitTimestamps(
    builtUnits.length,
    when,
    tz,
    unknownCreatedIso
  );

  // Compute durations and `estimated`.
  let unitSeconds: Array<number | null>;
  let estimated: boolean;

  if (
    consumed.minutes_override !== undefined &&
    consumed.minutes_override !== null
  ) {
    estimated = false;
    const totalOverrideSeconds = Math.round(consumed.minutes_override * 60);
    const naturalSum = builtUnits.reduce(
      (s, u) => s + (u.naturalMinutes ?? 0),
      0
    );
    if (builtUnits.length === 1) {
      unitSeconds = [totalOverrideSeconds];
    } else if (naturalSum > 0) {
      let allocated = 0;
      unitSeconds = builtUnits.map((u, idx) => {
        if (idx === builtUnits.length - 1) {
          return Math.max(0, totalOverrideSeconds - allocated);
        }
        const share = Math.round(
          totalOverrideSeconds * ((u.naturalMinutes ?? 0) / naturalSum)
        );
        allocated += share;
        return share;
      });
    } else {
      let allocated = 0;
      unitSeconds = builtUnits.map((_, idx) => {
        if (idx === builtUnits.length - 1) {
          return Math.max(0, totalOverrideSeconds - allocated);
        }
        const share = Math.round(totalOverrideSeconds / builtUnits.length);
        allocated += share;
        return share;
      });
    }
  } else {
    unitSeconds = builtUnits.map((u) =>
      u.naturalMinutes !== null ? Math.round(u.naturalMinutes * 60) : null
    );
    estimated = unitSeconds.some((sec) => sec !== null && sec > 0);
  }

  const totalMinutes =
    unitSeconds.reduce<number>((sum, sec) => sum + (sec ?? 0), 0) / 60;

  const baseExternalIds = buildExternalIdsForWork(work);

  const rawPayload = {
    category: work.category,
    entry_id: entryId,
    work,
    consumed,
    when,
    estimated,
  };
  const rawPayloadJson = JSON.stringify(rawPayload);

  const eventsToInsert: NewEvent[] = [];
  const activeSourceIds = new Set<string>();

  for (let i = 0; i < builtUnits.length; i++) {
    const u = builtUnits[i]!;
    const startedAt = timestamps[i]!;
    const durationSeconds = unitSeconds[i] ?? null;
    activeSourceIds.add(u.source_id);

    const existing = existingBySourceId.get(u.source_id);
    const existingRawObj = existing ? parseJsonObject(existing.raw) : null;
    const isExistingDeleted = Boolean(existingRawObj?.["deleted"]);

    const isUnchanged =
      existing !== undefined &&
      !isExistingDeleted &&
      existing.media_type === u.media_type &&
      existing.title === u.title &&
      existing.parent_title === u.parent_title &&
      existing.season === u.season &&
      existing.episode === u.episode &&
      existing.started_at === startedAt &&
      existing.duration_seconds === durationSeconds &&
      existing.progress === u.progress &&
      existing.raw === rawPayloadJson;

    if (isUnchanged) {
      continue;
    }

    const desiredEvent: NewEvent = {
      source: ARCHIVE_SOURCE,
      source_kind: ARCHIVE_SOURCE_KIND,
      source_id: u.source_id,
      external_ids: baseExternalIds ? { ...baseExternalIds } : null,
      media_type: u.media_type,
      title: u.title,
      parent_title: u.parent_title,
      season: u.season,
      episode: u.episode,
      started_at: startedAt,
      ended_at: null,
      duration_seconds: durationSeconds,
      progress: u.progress,
      device: null,
      raw: rawPayload,
    };

    eventsToInsert.push(ensureUniqueHash(db, desiredEvent));
  }

  // Write tombstones for any previously active units that were removed.
  for (const existing of existingLatestRows) {
    if (activeSourceIds.has(existing.source_id)) {
      continue;
    }
    const existingRaw = parseJsonObject(existing.raw);
    if (existingRaw?.["deleted"] === true) {
      continue;
    }

    const tombstoneRaw = {
      ...(existingRaw ?? { category: work.category, entry_id: entryId }),
      deleted: true,
    };
    const existingExt = parseExternalIds(existing.external_ids);
    const tombstoneEvent: NewEvent = {
      source: ARCHIVE_SOURCE,
      source_kind: ARCHIVE_SOURCE_KIND,
      source_id: existing.source_id,
      external_ids: existingExt ? { ...existingExt } : null,
      media_type: existing.media_type as MediaType,
      title: existing.title,
      parent_title: existing.parent_title,
      season: existing.season,
      episode: existing.episode,
      started_at: existing.started_at,
      ended_at: existing.started_at,
      duration_seconds: 0,
      progress: null,
      device: null,
      raw: tombstoneRaw,
    };
    eventsToInsert.push(ensureUniqueHash(db, tombstoneEvent));
  }

  let inserted = 0;
  if (eventsToInsert.length > 0) {
    const runId = startRun(db, ARCHIVE_SOURCE, ARCHIVE_SOURCE_KIND);
    try {
      const res = insertEvents(db, runId, eventsToInsert);
      inserted = res.inserted;
      finishRun(db, runId, {
        status: "ok",
        rowsSeen: res.seen,
        rowsInserted: res.inserted,
      });
    } catch (err) {
      finishRun(db, runId, {
        status: "failed",
        rowsSeen: 0,
        rowsInserted: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Save rating / note via the existing append-only annotations table when provided and changed.
  if (rating !== undefined || note !== undefined) {
    const current = getAnnotation(db, ARCHIVE_SOURCE, work.title);
    const nextRating = rating !== undefined ? rating : current.rating;
    const nextNote = note !== undefined ? note : current.note;
    if (current.rating !== nextRating || current.note !== nextNote) {
      saveAnnotation(
        db,
        {
          source: ARCHIVE_SOURCE,
          title: work.title,
          rating: nextRating,
          note: nextNote,
        },
        nowIso
      );
    }
  }

  return {
    entry_id: entryId,
    inserted,
    units: builtUnits.length,
    total_minutes: totalMinutes,
    estimated,
  };
}

export interface DeleteArchiveResult {
  ok: true;
  entry_id: string;
  deleted: number;
  inserted: number;
}

/**
 * Tombstone every active unit of an archive entry (`POST /api/archive/:entry_id/delete`).
 */
export function deleteArchiveEntry(
  db: Database,
  entryIdRaw: string
): DeleteArchiveResult {
  if (typeof entryIdRaw !== "string" || !UUID_RE.test(entryIdRaw)) {
    throw new ArchiveValidationError("Invalid entry_id: expected a UUID");
  }
  const entryId = entryIdRaw.toLowerCase();
  const likePattern = `archive:${entryId}:%`;

  const existingLatestRows = db
    .query<EventRow, [string, string]>(
      `SELECT * FROM events
       WHERE source = 'manual'
         AND source_kind = 'archive'
         AND source_id LIKE ?
         AND id IN (
           SELECT MAX(id) FROM events
           WHERE source = 'manual'
             AND source_kind = 'archive'
             AND source_id LIKE ?
           GROUP BY source, source_kind, source_id
         )
       ORDER BY id ASC;`
    )
    .all(likePattern, likePattern);

  if (existingLatestRows.length === 0) {
    throw new ArchiveNotFoundError(entryId);
  }

  const tombstones: NewEvent[] = [];
  for (const existing of existingLatestRows) {
    const existingRaw = parseJsonObject(existing.raw);
    if (existingRaw?.["deleted"] === true) {
      continue;
    }
    const tombstoneRaw = {
      ...(existingRaw ?? { entry_id: entryId }),
      deleted: true,
    };
    const existingExt = parseExternalIds(existing.external_ids);
    const tombstoneEvent: NewEvent = {
      source: ARCHIVE_SOURCE,
      source_kind: ARCHIVE_SOURCE_KIND,
      source_id: existing.source_id,
      external_ids: existingExt ? { ...existingExt } : null,
      media_type: existing.media_type as MediaType,
      title: existing.title,
      parent_title: existing.parent_title,
      season: existing.season,
      episode: existing.episode,
      started_at: existing.started_at,
      ended_at: existing.started_at,
      duration_seconds: 0,
      progress: null,
      device: null,
      raw: tombstoneRaw,
    };
    tombstones.push(ensureUniqueHash(db, tombstoneEvent));
  }

  let inserted = 0;
  if (tombstones.length > 0) {
    const runId = startRun(db, ARCHIVE_SOURCE, ARCHIVE_SOURCE_KIND);
    try {
      const res = insertEvents(db, runId, tombstones);
      inserted = res.inserted;
      finishRun(db, runId, {
        status: "ok",
        rowsSeen: res.seen,
        rowsInserted: res.inserted,
      });
    } catch (err) {
      finishRun(db, runId, {
        status: "failed",
        rowsSeen: 0,
        rowsInserted: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return {
    ok: true,
    entry_id: entryId,
    deleted: inserted,
    inserted,
  };
}

/**
 * List active archive entries (`GET /api/archive?category=`), newest first.
 */
export function listArchiveEntries(
  db: Database,
  categoryFilter?: Category
): ArchiveEntrySummary[] {
  const latestRows = db
    .query<EventRow, []>(
      `SELECT * FROM events_latest
       WHERE source = 'manual' AND source_kind = 'archive'
       ORDER BY id ASC;`
    )
    .all();

  if (latestRows.length === 0) {
    return [];
  }

  // Earliest ingested_at per entry_id from `events` for accurate `created_at`.
  const allArchiveMeta = db
    .query<{ source_id: string; ingested_at: string }, []>(
      `SELECT source_id, MIN(ingested_at) AS ingested_at
       FROM events
       WHERE source = 'manual' AND source_kind = 'archive'
       GROUP BY source_id;`
    )
    .all();

  const createdByEntryId = new Map<string, string>();
  for (const row of allArchiveMeta) {
    const parts = row.source_id.split(":");
    const entryId = parts[1];
    if (!entryId) continue;
    const prev = createdByEntryId.get(entryId);
    if (prev === undefined || row.ingested_at < prev) {
      createdByEntryId.set(entryId, row.ingested_at);
    }
  }

  const byEntryId = new Map<
    string,
    {
      rows: EventRow[];
      maxId: number;
      updatedAt: string;
    }
  >();

  for (const row of latestRows) {
    const raw = parseJsonObject(row.raw);
    const entryId =
      typeof raw?.["entry_id"] === "string"
        ? (raw["entry_id"] as string)
        : row.source_id.split(":")[1];
    if (!entryId) {
      continue;
    }

    let group = byEntryId.get(entryId);
    if (!group) {
      group = {
        rows: [],
        maxId: row.id,
        updatedAt: row.ingested_at,
      };
      byEntryId.set(entryId, group);
    }
    group.rows.push(row);
    if (row.id > group.maxId) {
      group.maxId = row.id;
    }
    if (row.ingested_at > group.updatedAt) {
      group.updatedAt = row.ingested_at;
    }
  }

  const summaries: Array<{ summary: ArchiveEntrySummary; maxId: number }> = [];

  for (const [entryId, group] of byEntryId.entries()) {
    const newestRow = group.rows[group.rows.length - 1]!;
    const cat = categoryOf(newestRow);
    if (categoryFilter !== undefined && cat !== categoryFilter) {
      continue;
    }

    const raw = parseJsonObject(newestRow.raw);
    const work = parseJsonObject(raw?.["work"]);
    const when = (parseJsonObject(raw?.["when"]) as ArchiveWhen | null) ?? {
      precision: "day",
      date: newestRow.started_at.slice(0, 10),
    };
    const consumed = (parseJsonObject(
      raw?.["consumed"]
    ) as ArchiveConsumed | null) ?? {};

    const title =
      (typeof work?.["title"] === "string" && work["title"].trim() !== ""
        ? work["title"].trim()
        : newestRow.title) ?? "Untitled";

    const coverUrl =
      coverUrlFor(newestRow) ??
      (typeof work?.["cover_url"] === "string" ? work["cover_url"] : null);

    const totalSeconds = group.rows.reduce(
      (sum, r) => sum + (r.duration_seconds ?? 0),
      0
    );

    const createdAt =
      createdByEntryId.get(entryId) ?? group.rows[0]!.ingested_at;

    summaries.push({
      maxId: group.maxId,
      summary: {
        entry_id: entryId,
        category: cat,
        title,
        cover_url: coverUrl,
        when,
        consumed,
        total_minutes: totalSeconds / 60,
        created_at: createdAt,
        updated_at: group.updatedAt,
      },
    });
  }

  summaries.sort(
    (a, b) =>
      b.summary.updated_at.localeCompare(a.summary.updated_at) ||
      b.maxId - a.maxId
  );

  return summaries.map((s) => s.summary);
}
