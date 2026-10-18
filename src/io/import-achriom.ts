/**
 * Achriom library export importer (v2.1 spec section 11).
 *
 * Accepts an Achriom export `.zip` archive (containing `anime.csv`, `books.csv`,
 * `movies.csv`, `shows.csv`, `albums.csv`, `podcasts.csv`, `games.csv`) or any
 * single CSV from that export.
 *
 * Rules:
 * - Each imported row becomes one archive entry saved through `saveArchiveEntry`
 *   (`src/server/archive.ts`) with a deterministic UUID v5-style `entry_id`.
 * - Repeat import is idempotent (0 rows written, all entries counted as `unchanged`).
 * - A changed row writes a new revision of the same `entry_id` (`updated`).
 * - Metadata matching uses `lookupWork` (by `anilist_id` / `imdb_id` / `tmdb_id`
 *   when present) and `lookupSearch` (by title + year, accepting only confident
 *   matches). Unmatched rows become `ManualWork` entries and their export cover
 *   URL is fetched once into the permanent cover cache.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../core/config.ts";
import type {
  AchriomImportResult,
  ArchiveConsumed,
  ArchiveRequest,
  ArchiveWhen,
  Category,
  LookupHit,
  ManualWork,
  SeasonInfo,
  WorkDetails,
} from "../core/contract.ts";
import type { EventRow } from "../core/schema.ts";
import { localToUtcIso } from "../core/time.ts";
import { parseExternalIds, parseJsonObject } from "../server/aggregate.ts";
import {
  ARCHIVE_SOURCE,
  ARCHIVE_SOURCE_KIND,
  saveArchiveEntry,
} from "../server/archive.ts";
import {
  getAnnotation,
  MAX_ANNOTATION_NOTE_LENGTH,
   parseNote,
  parseRating,
} from "../server/annotations.ts";
import {
  defaultMetadataLimiter,
  isTmdbConfigured,
  Limiter,
  lookupSearch,
  lookupWork,
  METADATA_TIMEOUT_MS,
  metaCoverCacheDir,
  metaCoverUrl,
  type MetadataDeps,
  parseYear,
  resolveMetadataConfig,
} from "../server/metadata/index.ts";
import { fetchRemoteCoverImage } from "../server/metadata/http.ts";
import {
   readCachedMetaCover,
  writeCachedMetaCover,
  writeCoverUrlCache,
} from "../server/metadata/cache.ts";
import { normalizeForSearch } from "../server/search.ts";
import { CsvParseError, parseCsvObjects, splitCsvList } from "./csv.ts";
import { isZipBytes, readZip, ZipError, type ReadZipOptions } from "./zip.ts";

export const ACHRIOM_FILES = [
  "anime.csv",
  "books.csv",
  "movies.csv",
  "shows.csv",
  "albums.csv",
  "podcasts.csv",
  "games.csv",
] as const;

export type AchriomFileName = (typeof ACHRIOM_FILES)[number];

const ACHRIOM_FILE_SET: ReadonlySet<string> = new Set(ACHRIOM_FILES);

/** Exact CSV column headers in an Achriom library export. */
export const ACHRIOM_CSV_HEADERS: Record<AchriomFileName, readonly string[]> = {
  "anime.csv": [
    "title",
    "title_english",
    "studios",
    "format",
    "status",
    "episodes",
    "episode_duration",
    "season",
    "season_year",
    "start_date",
    "end_date",
    "genres",
    "source",
    "description",
    "watch_status",
    "user_rating",
    "user_notes",
    "episodes_watched",
    "started_at",
    "finished_at",
    "cover_url",
    "anilist_id",
    "mal_id",
    "average_score",
    "themes",
    "mood",
    "era",
    "ai_summary",
    "notable",
    "created_at",
  ],
  "books.csv": [
    "title",
    "author",
    "isbn",
    "publication_year",
    "genres",
    "page_count",
    "summary",
    "reading_status",
    "user_rating",
    "user_notes",
    "started_at",
    "finished_at",
    "cover_url",
    "themes",
    "reading_level",
    "era",
    "ai_summary",
    "notable",
    "created_at",
  ],
  "movies.csv": [
    "title",
    "director",
    "release_date",
    "runtime_minutes",
    "genres",
    "plot",
    "cast",
    "watch_status",
    "user_rating",
    "user_notes",
    "first_watched_at",
    "last_watched_at",
    "poster_url",
    "tmdb_id",
    "imdb_id",
    "themes",
    "mood",
    "era",
    "ai_summary",
    "notable",
    "created_at",
  ],
  "shows.csv": [
    "title",
    "creator",
    "first_air_date",
    "number_of_seasons",
    "number_of_episodes",
    "genres",
    "plot",
    "cast",
    "watch_status",
    "user_rating",
    "user_notes",
    "first_watched_at",
    "last_watched_at",
    "poster_url",
    "tmdb_id",
    "themes",
    "mood",
    "era",
    "ai_summary",
    "notable",
    "created_at",
  ],
  "albums.csv": [
    "title",
    "artist",
    "release_date",
    "total_tracks",
    "duration_minutes",
    "genres",
    "label",
    "format",
    "listen_status",
    "user_rating",
    "user_notes",
    "first_listened_at",
    "last_listened_at",
    "cover_url",
    "discogs_id",
    "themes",
    "mood",
    "era",
    "ai_summary",
    "notable",
    "genre_tags",
    "created_at",
  ],
  "podcasts.csv": [
    "title",
    "publisher",
    "rss_feed_url",
    "genres",
    "language",
    "explicit",
    "description",
    "episode_count",
    "latest_episode_at",
    "listen_status",
    "user_rating",
    "user_notes",
    "started_at",
    "finished_at",
    "cover_url",
    "podcast_index_id",
    "itunes_id",
    "themes",
    "mood",
    "ai_summary",
    "notable",
    "created_at",
  ],
  "games.csv": [
    "title",
    "developer",
    "publisher",
    "genres",
    "platforms",
    "game_modes",
    "franchises",
    "summary",
    "first_release_date",
    "total_rating",
    "play_status",
    "platform",
    "format",
    "user_rating",
    "user_notes",
    "started_at",
    "finished_at",
    "cover_url",
    "igdb_id",
    "themes",
    "mood",
    "era",
    "ai_summary",
    "notable",
    "created_at",
  ],
};

export class AchriomImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AchriomImportError";
  }
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;
const IMDB_ID_RE = /^tt\d+$/i;
const POSITIVE_INT_RE = /^\d+$/;

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

function parsePositiveInt(raw: string | undefined | null): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

function extractBaseName(filename: string): string {
  const normalized = filename.trim().replace(/\\/g, "/");
  const parts = normalized.split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/**
 * Identify which Achriom CSV file a table belongs to from its filename and/or
 * header columns. Returns `null` when the headers do not match any Achriom CSV.
 */
export function detectAchriomFile(
  filename: string,
  headers: readonly string[]
): AchriomFileName | null {
  if (headers.length === 0) {
    return null;
  }
  const headerSet = new Set(headers.map((h) => h.trim().toLowerCase()));
  if (!headerSet.has("title") || headerSet.has("record_hash")) {
    return null;
  }

  // 1. Check unique column signatures first.
  if (
    headerSet.has("anilist_id") ||
    headerSet.has("episode_duration") ||
    headerSet.has("episodes_watched") ||
    headerSet.has("title_english")
  ) {
    return "anime.csv";
  }
  if (
    headerSet.has("reading_status") ||
    headerSet.has("page_count") ||
    headerSet.has("isbn") ||
    headerSet.has("publication_year")
  ) {
    return "books.csv";
  }
  if (
    headerSet.has("imdb_id") ||
    (headerSet.has("director") && headerSet.has("runtime_minutes"))
  ) {
    return "movies.csv";
  }
  if (
    headerSet.has("first_air_date") ||
    headerSet.has("number_of_seasons") ||
    headerSet.has("number_of_episodes") ||
    (headerSet.has("creator") && headerSet.has("watch_status"))
  ) {
    return "shows.csv";
  }
  if (
    headerSet.has("discogs_id") ||
    headerSet.has("total_tracks") ||
    (headerSet.has("artist") && headerSet.has("listen_status"))
  ) {
    return "albums.csv";
  }
  if (
    headerSet.has("podcast_index_id") ||
    headerSet.has("rss_feed_url") ||
    headerSet.has("latest_episode_at") ||
    (headerSet.has("publisher") && headerSet.has("listen_status"))
  ) {
    return "podcasts.csv";
  }
  if (
    headerSet.has("igdb_id") ||
    headerSet.has("play_status") ||
    headerSet.has("game_modes") ||
    headerSet.has("developer")
  ) {
    return "games.csv";
  }

  // 2. Fall back to exact known filename when headers include a valid Achriom column subset.
  const base = extractBaseName(filename);
  if (ACHRIOM_FILE_SET.has(base)) {
    const knownCols = new Set(ACHRIOM_CSV_HEADERS[base as AchriomFileName]);
    const allRecognized = headers.every((h) => knownCols.has(h.trim().toLowerCase()));
    if (allRecognized && headers.length >= 2) {
      return base as AchriomFileName;
    }
  }

  return null;
}

/**
 * Deterministic UUID v5-style identifier from `("achriom", file, stableId)`.
 */
export function achriomEntryId(file: string, stableId: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`achriom\u0000${file.toLowerCase().trim()}\u0000${stableId.trim()}`);
  const digest = new Uint8Array(hasher.digest());

  // Set UUID version 5 (0101xxxx) and RFC 4122 variant (10xxxxxx).
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  const hex = Array.from(digest.subarray(0, 16), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20, 32)}`;
}

export function extractAchriomRowYear(
  file: AchriomFileName,
  row: Record<string, string>
): number | null {
  switch (file) {
    case "anime.csv":
      return parseYear(row.season_year) ?? parseYear(row.start_date);
    case "books.csv":
      return parseYear(row.publication_year);
    case "movies.csv":
      return parseYear(row.release_date);
    case "shows.csv":
      return parseYear(row.first_air_date);
    case "albums.csv":
      return parseYear(row.release_date);
    case "podcasts.csv":
      return parseYear(row.latest_episode_at);
    case "games.csv":
      return parseYear(row.first_release_date);
  }
}

/**
 * Stable per-row identifier within a file:
 * `anilist_id` / `imdb_id` / `tmdb_id` / `isbn` (or `discogs_id` / `podcast_index_id`
 * / `itunes_id`), else normalized `title` + `year`.
 */
export function achriomRowStableId(
  file: AchriomFileName,
  row: Record<string, string>
): string {
  const clean = (val: string | undefined): string => (val ?? "").trim();

  switch (file) {
    case "anime.csv": {
      const anilist = clean(row.anilist_id);
      if (anilist !== "") return `anilist:${anilist}`;
      const mal = clean(row.mal_id);
      if (mal !== "") return `mal:${mal}`;
      break;
    }
    case "books.csv": {
      const isbn = clean(row.isbn);
      if (isbn !== "") return `isbn:${isbn}`;
      break;
    }
    case "movies.csv":
    case "shows.csv": {
      const imdb = clean(row.imdb_id);
      if (imdb !== "") return `imdb:${imdb.toLowerCase()}`;
      const tmdb = clean(row.tmdb_id);
      if (tmdb !== "") return `tmdb:${tmdb}`;
      break;
    }
    case "albums.csv": {
      const discogs = clean(row.discogs_id);
      if (discogs !== "") return `discogs:${discogs}`;
      break;
    }
    case "podcasts.csv": {
      const pid = clean(row.podcast_index_id);
      if (pid !== "") return `podcast_index:${pid}`;
      const itunes = clean(row.itunes_id);
      if (itunes !== "") return `itunes:${itunes}`;
      break;
    }
    case "games.csv": {
      const igdb = clean(row.igdb_id);
      if (igdb !== "") return `igdb:${igdb}`;
      break;
    }
  }

  const rawTitle = clean(row.title) || clean(row.title_english);
  const normTitle = normalizeForSearch(rawTitle);
  const year = extractAchriomRowYear(file, row);
  return `title:${normTitle}:${year ?? ""}`;
}

export function achriomRowEntryId(
  file: AchriomFileName,
  row: Record<string, string>
): string {
  return achriomEntryId(file, achriomRowStableId(file, row));
}

/**
 * Convert an Achriom rating (`0..5` in halves) to InputTracker's `0..10` scale
 * (`×2`, e.g. `4.5 → 9`). Empty string returns `null`.
 */
export function parseAchriomRating(raw: string | undefined | null): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0 || num > 5) {
    throw new AchriomImportError(
      `Invalid user_rating '${trimmed}' (expected a number between 0 and 5)`
    );
  }
  return Math.round(num * 2 * 10) / 10;
}

export function parseAchriomNote(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trimEnd();
  if (trimmed.trim() === "") {
    return null;
  }
  return trimmed.length > MAX_ANNOTATION_NOTE_LENGTH
    ? trimmed.slice(0, MAX_ANNOTATION_NOTE_LENGTH)
    : trimmed;
}

export type MappedAchriomStatus = "finished" | "in_progress" | "dropped" | "planned";

const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "finished",
  "watched",
  "listened",
  "read",
]);

const PLANNED_STATUSES: ReadonlySet<string> = new Set([
  "plan_to_watch",
  "unread",
  "unwatched",
  "plan_to_read",
  "plan_to_listen",
  "unlistened",
  "unheard",
  "planned",
  "want_to_watch",
  "want_to_read",
  "backlog",
]);

const DROPPED_STATUSES: ReadonlySet<string> = new Set([
  "abandoned",
  "dropped",
  "dnf",
]);

const IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
  "watching",
  "reading",
  "listening",
  "in_progress",
  "currently_reading",
  "currently_watching",
  "playing",
]);

/**
 * Map the row's user status column (`watch_status`, `reading_status`, or
 * `listen_status` — never `anime.csv`'s `status`, which is AniList's airing
 * status) to an InputTracker archive status.
 */
export function parseAchriomStatus(
  file: AchriomFileName,
  row: Record<string, string>
): MappedAchriomStatus | null {
  let rawStatus = "";
  switch (file) {
    case "anime.csv":
    case "movies.csv":
    case "shows.csv":
      rawStatus = row.watch_status ?? "";
      break;
    case "books.csv":
      rawStatus = row.reading_status ?? "";
      break;
    case "albums.csv":
    case "podcasts.csv":
      rawStatus = row.listen_status ?? "";
      break;
    case "games.csv":
      rawStatus = row.play_status ?? "";
      break;
  }

  const norm = rawStatus.trim().toLowerCase();
  if (norm === "" || FINISHED_STATUSES.has(norm)) {
    return "finished";
  }
  if (PLANNED_STATUSES.has(norm)) {
    return "planned";
  }
  if (DROPPED_STATUSES.has(norm)) {
    return "dropped";
  }
  if (IN_PROGRESS_STATUSES.has(norm)) {
    return "in_progress";
  }
  return null;
}

function parseDateValueToWhen(raw: string | undefined): ArchiveWhen | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Match YYYY-MM-DD or ISO timestamp starting with YYYY-MM-DD
  const dayCandidate = trimmed.slice(0, 10);
  if (isValidCalendarDate(dayCandidate)) {
    return { precision: "day", date: dayCandidate };
  }
  if (MONTH_RE.test(trimmed)) {
    return { precision: "month", date: trimmed };
  }
  if (YEAR_RE.test(trimmed)) {
    return { precision: "year", date: trimmed };
  }
  return null;
}

/**
 * Extract `when` from `finished_at` / `last_watched_at` / `last_listened_at`, else `unknown`.
 * Never uses `created_at`. A finish date says when a whole work ended, not that all of its
 * hours happened that day, so a day is widened to its month: the time counts in that month's
 * review and totals instead of piling onto one calendar day.
 */
export function parseAchriomWhen(
  file: AchriomFileName,
  row: Record<string, string>
): ArchiveWhen {
  let rawDate: string | undefined;
  switch (file) {
    case "anime.csv":
    case "books.csv":
    case "podcasts.csv":
    case "games.csv":
      rawDate = row.finished_at;
      break;
    case "movies.csv":
    case "shows.csv":
      rawDate = row.last_watched_at;
      break;
    case "albums.csv":
      rawDate = row.last_listened_at;
      break;
  }

  const when = parseDateValueToWhen(rawDate);
  if (!when) {
    return { precision: "unknown" };
  }
  if (when.precision === "day" && when.date) {
    return { precision: "month", date: when.date.slice(0, 7) };
  }
  return when;
}

function extractCsvCoverUrl(row: Record<string, string>): string | null {
  for (const candidate of [row.cover_url, row.poster_url]) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (/^https?:\/\/\S+$/i.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return null;
}

export type AchriomRowMapResult =
  | {
      kind: "archive";
      file: AchriomFileName;
      request: ArchiveRequest;
      matched: boolean;
      planned: boolean;
      coverUrl: string | null;
    }
  | {
      kind: "skip";
      file: AchriomFileName;
      title: string;
      reason: string;
    };

/**
 * Pure row → `ArchiveRequest` mapper.
 * Given the CSV file type, the parsed CSV row, and an optional `matchedWork`
 * from metadata lookup, returns the `ArchiveRequest` or a skip reason.
 */
export function mapAchriomRow(
  file: AchriomFileName,
  row: Record<string, string>,
  matchedWork: WorkDetails | null = null
): AchriomRowMapResult {
  const rawTitle = (row.title ?? "").trim() || (row.title_english ?? "").trim();

  if (file === "games.csv") {
    return {
      kind: "skip",
      file,
      title: rawTitle || "Untitled",
      reason: "games are not a tracked category",
    };
  }

  if (rawTitle === "") {
    return {
      kind: "skip",
      file,
      title: "",
      reason: "missing title",
    };
  }

  const status = parseAchriomStatus(file, row);
  if (status === null) {
    const rawStatus =
      row.watch_status ?? row.reading_status ?? row.listen_status ?? "";
    return {
      kind: "skip",
      file,
      title: rawTitle,
      reason: `unsupported status: ${rawStatus.trim()}`,
    };
  }

  const entryId = achriomRowEntryId(file, row);
  const when = parseAchriomWhen(file, row);
  const rating = parseAchriomRating(row.user_rating);
  const note = parseAchriomNote(row.user_notes);
  const year = extractAchriomRowYear(file, row);
  const coverUrl = extractCsvCoverUrl(row);
  const planned = status === "planned";

  let work: WorkDetails | ManualWork;
  let consumed: ArchiveConsumed;
  let isMatched = false;

  switch (file) {
    case "anime.csv": {
      const csvEpisodes = parsePositiveInt(row.episodes);
      const csvDuration = parsePositiveInt(row.episode_duration);
      const csvWatched = parsePositiveInt(row.episodes_watched);
      const studios = splitCsvList(row.studios);
      const format = (row.format ?? "").trim().toUpperCase();
      const anilistId = (row.anilist_id ?? "").trim();
      const malId = (row.mal_id ?? "").trim();
      const isMovieFormat = format === "MOVIE";

      if (matchedWork !== null) {
        isMatched = true;
        const extIds: Record<string, string> = { ...matchedWork.external_ids };
        if (anilistId !== "" && !extIds.anilist) extIds.anilist = anilistId;
        if (malId !== "" && !extIds.mal) extIds.mal = malId;

        if (matchedWork.seasons.length > 0 && !isMovieFormat) {
          // Find the season corresponding to this AniList row.
          let targetIndex = 0;
          if (anilistId !== "") {
            const byId = matchedWork.seasons.findIndex(
              (s) => s.provider_id === anilistId
            );
            if (byId >= 0) {
              targetIndex = byId;
            }
          } else {
            const normCsvTitle = normalizeForSearch(rawTitle);
            const byTitle = matchedWork.seasons.findIndex(
              (s) =>
                (s.title !== null && normalizeForSearch(s.title) === normCsvTitle) ||
                (year !== null && s.year === year)
            );
            if (byTitle >= 0) {
              targetIndex = byTitle;
            }
          }

          const updatedSeasons: SeasonInfo[] = matchedWork.seasons.map(
            (s, idx) => {
              if (idx !== targetIndex) return { ...s };
              const episodes = csvEpisodes ?? s.episodes;
              const episodeMinutes = csvDuration ?? s.episode_minutes;
              const totalMinutes =
                episodes > 0 && episodeMinutes !== null
                  ? episodes * episodeMinutes
                  : s.total_minutes;
              return {
                ...s,
                episodes,
                episode_minutes: episodeMinutes,
                total_minutes: totalMinutes,
              };
            }
          );

          const targetSeason = updatedSeasons[targetIndex]!;
          work = {
            ...matchedWork,
            category: "anime",
            seasons: updatedSeasons,
            external_ids: extIds,
          };

          if (status === "finished") {
            consumed = { seasons: [{ number: targetSeason.number }] };
          } else if (status === "planned") {
            consumed = {
              seasons: [{ number: targetSeason.number }],
              minutes_override: 0,
            };
          } else if (status === "dropped") {
            if (csvWatched !== null && csvWatched > 0) {
              consumed = {
                seasons: [{ number: targetSeason.number, episodes: csvWatched }],
              };
            } else {
              consumed = {
                seasons: [{ number: targetSeason.number }],
                progress: 0,
                minutes_override: 0,
              };
            }
          } else {
            // in_progress
            consumed =
              csvWatched !== null && csvWatched > 0
                ? { seasons: [{ number: targetSeason.number, episodes: csvWatched }] }
                : { seasons: [{ number: targetSeason.number }] };
          }
        } else {
          // Single-entry anime movie
          const movieMinutes =
            csvEpisodes !== null && csvDuration !== null
              ? csvEpisodes * csvDuration
              : csvDuration ?? matchedWork.runtime_minutes;
          work = {
            ...matchedWork,
            category: "anime",
            seasons: [],
            runtime_minutes: movieMinutes,
            external_ids: extIds,
          };
          if (status === "finished" || status === "in_progress") {
            consumed = { times: 1 };
          } else if (status === "planned") {
            consumed = { times: 1, minutes_override: 0 };
          } else {
            consumed = { times: 1, progress: 0, minutes_override: 0 };
          }
        }
      } else if (isMovieFormat) {
        const movieMinutes =
          csvEpisodes !== null && csvDuration !== null
            ? csvEpisodes * csvDuration
            : csvDuration;
        work = {
          provider: "manual",
          category: "anime",
          title: rawTitle,
          year,
          creators: studios,
          seasons: [],
          runtime_minutes: movieMinutes,
          pages: null,
        };
        if (status === "finished" || status === "in_progress") {
          consumed = { times: 1 };
        } else if (status === "planned") {
          consumed = { times: 1, minutes_override: 0 };
        } else {
          consumed = { times: 1, progress: 0, minutes_override: 0 };
        }
      } else {
        const epCount = csvEpisodes ?? 0;
        const epMin = csvDuration;
        const totalMin =
          epCount > 0 && epMin !== null ? epCount * epMin : null;
        work = {
          provider: "manual",
          category: "anime",
          title: rawTitle,
          year,
          creators: studios,
          seasons: [
            {
              number: 1,
              title: null,
              year,
              episodes: epCount,
              episode_minutes: epMin,
              total_minutes: totalMin,
              provider_id: anilistId !== "" ? anilistId : null,
            },
          ],
          runtime_minutes: null,
          pages: null,
        };
        if (status === "finished") {
          consumed = { seasons: [{ number: 1 }] };
        } else if (status === "planned") {
          consumed = { seasons: [{ number: 1 }], minutes_override: 0 };
        } else if (status === "dropped") {
          if (csvWatched !== null && csvWatched > 0) {
            consumed = { seasons: [{ number: 1, episodes: csvWatched }] };
          } else {
            consumed = {
              seasons: [{ number: 1 }],
              progress: 0,
              minutes_override: 0,
            };
          }
        } else {
          consumed =
            csvWatched !== null && csvWatched > 0
              ? { seasons: [{ number: 1, episodes: csvWatched }] }
              : { seasons: [{ number: 1 }] };
        }
      }
      break;
    }

    case "books.csv": {
      const csvPages = parsePositiveInt(row.page_count);
      const authors = splitCsvList(row.author);
      const isbn = (row.isbn ?? "").trim();

      if (matchedWork !== null) {
        isMatched = true;
        const extIds: Record<string, string> = { ...matchedWork.external_ids };
        if (isbn !== "" && !extIds.isbn) extIds.isbn = isbn;
        work = {
          ...matchedWork,
          category: "book",
          seasons: [],
          pages: csvPages ?? matchedWork.pages,
          external_ids: extIds,
        };
      } else {
        work = {
          provider: "manual",
          category: "book",
          title: rawTitle,
          year,
          creators: authors,
          seasons: [],
          runtime_minutes: null,
          pages: csvPages,
        };
      }

      if (status === "finished") {
        consumed = { progress: 1 };
      } else if (status === "planned") {
        consumed = { progress: 0 };
      } else if (status === "dropped") {
        consumed = { progress: 0, minutes_override: 0 };
      } else {
        consumed = { progress: 0.5 };
      }
      break;
    }

    case "movies.csv": {
      const csvRuntime = parsePositiveInt(row.runtime_minutes);
      const directors = splitCsvList(row.director);
      const imdbId = (row.imdb_id ?? "").trim();
      const tmdbId = (row.tmdb_id ?? "").trim();

      if (matchedWork !== null) {
        isMatched = true;
        const extIds: Record<string, string> = { ...matchedWork.external_ids };
        if (imdbId !== "" && !extIds.imdb) extIds.imdb = imdbId;
        if (tmdbId !== "" && !extIds.tmdb) extIds.tmdb = tmdbId;
        work = {
          ...matchedWork,
          category: "film",
          seasons: [],
          runtime_minutes: csvRuntime ?? matchedWork.runtime_minutes,
          external_ids: extIds,
        };
      } else {
        work = {
          provider: "manual",
          category: "film",
          title: rawTitle,
          year,
          creators: directors,
          seasons: [],
          runtime_minutes: csvRuntime,
          pages: null,
        };
      }

      if (status === "finished" || status === "in_progress") {
        consumed = { times: 1 };
      } else if (status === "planned") {
        consumed = { times: 1, minutes_override: 0 };
      } else {
        consumed = { times: 1, progress: 0, minutes_override: 0 };
      }
      break;
    }

    case "shows.csv": {
      const creators = splitCsvList(row.creator);
      const csvSeasons = parsePositiveInt(row.number_of_seasons);
      const csvEpisodes = parsePositiveInt(row.number_of_episodes);
      const tmdbId = (row.tmdb_id ?? "").trim();
      const imdbId = (row.imdb_id ?? "").trim();

      if (matchedWork !== null) {
        isMatched = true;
        const extIds: Record<string, string> = { ...matchedWork.external_ids };
        if (tmdbId !== "" && !extIds.tmdb) extIds.tmdb = tmdbId;
        if (imdbId !== "" && !extIds.imdb) extIds.imdb = imdbId;
        work = {
          ...matchedWork,
          category: "series",
          external_ids: extIds,
        };
      } else {
        const manualSeasons: SeasonInfo[] = [];
        if (csvSeasons !== null && csvSeasons > 0) {
          const perSeasonEps =
            csvEpisodes !== null && csvEpisodes > 0
              ? Math.round(csvEpisodes / csvSeasons)
              : 0;
          for (let s = 1; s <= csvSeasons; s++) {
            manualSeasons.push({
              number: s,
              title: null,
              year: s === 1 ? year : null,
              episodes: perSeasonEps,
              episode_minutes: null,
              total_minutes: null,
              provider_id: null,
            });
          }
        }
        work = {
          provider: "manual",
          category: "series",
          title: rawTitle,
          year,
          creators,
          seasons: manualSeasons,
          runtime_minutes: null,
          pages: null,
        };
      }

      if (status === "finished" || status === "in_progress") {
        if (work.seasons.length > 0) {
          consumed = {
            seasons: work.seasons.map((s) => ({ number: s.number })),
          };
        } else {
          consumed = { seasons: [{ number: 1 }] };
        }
      } else if (status === "planned") {
        const firstNum = work.seasons[0]?.number ?? 1;
        consumed = { seasons: [{ number: firstNum }], minutes_override: 0 };
      } else {
        const firstNum = work.seasons[0]?.number ?? 1;
        consumed = {
          seasons: [{ number: firstNum }],
          progress: 0,
          minutes_override: 0,
        };
      }
      break;
    }

    case "albums.csv": {
      const artists = splitCsvList(row.artist);
      const durationMinutes = parsePositiveInt(row.duration_minutes);
      work = {
        provider: "manual",
        category: "music",
        title: rawTitle,
        year,
        creators: artists,
        seasons: [],
        runtime_minutes: durationMinutes,
        pages: null,
      };
      if (status === "finished" || status === "in_progress") {
        consumed = { progress: 1 };
      } else if (status === "planned") {
        consumed = { progress: 0 };
      } else {
        consumed = { progress: 0, minutes_override: 0 };
      }
      break;
    }

    case "podcasts.csv": {
      const publishers = splitCsvList(row.publisher);
      work = {
        provider: "manual",
        category: "podcast",
        title: rawTitle,
        year,
        creators: publishers,
        seasons: [],
        runtime_minutes: null,
        pages: null,
      };
      if (status === "finished" || status === "in_progress") {
        consumed = { progress: 1 };
      } else if (status === "planned") {
        consumed = { progress: 0 };
      } else {
        consumed = { progress: 0, minutes_override: 0 };
      }
      break;
    }
  }

  const request: ArchiveRequest = {
    entry_id: entryId,
    work,
    consumed,
    when,
    rating,
    note,
    status,
  };

  return {
    kind: "archive",
    file,
    request,
    matched: isMatched,
    planned,
    coverUrl,
  };
}

// --- Metadata matching -------------------------------------------------------

function normalizeStrictTitle(s: string): string {
  return normalizeForSearch(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSubtitle(s: string): string {
  const idx = s.indexOf(":");
  if (idx > 2) {
    return s.slice(0, idx).trim();
  }
  return s;
}

/**
 * Pick a confident `LookupHit` from `results` matching the row's title(s) and
 * year. Returns `null` when no hit is a confident match.
 */
export function selectConfidentLookupHit(
  results: readonly LookupHit[],
  candidateTitles: readonly string[],
  targetYear: number | null,
  category: Category,
  creators: readonly string[] = []
): LookupHit | null {
  const exactNorms = new Set<string>();
  const strictNorms = new Set<string>();
  const strippedNorms = new Set<string>();

  for (const t of candidateTitles) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    const n = normalizeForSearch(trimmed);
    const s = normalizeStrictTitle(trimmed);
    if (n) exactNorms.add(n);
    if (s) strictNorms.add(s);
    const stripped = normalizeStrictTitle(stripSubtitle(trimmed));
    if (stripped && stripped.length >= 3) {
      strippedNorms.add(stripped);
    }
  }

  if (exactNorms.size === 0 && strictNorms.size === 0) {
    return null;
  }

  const creatorNorms = creators
    .map((c) => normalizeStrictTitle(c))
    .filter((c) => c.length >= 3);

  let bestHit: LookupHit | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < results.length; i++) {
    const hit = results[i]!;
    if (hit.category !== category) {
      continue;
    }

    const hitNorm = normalizeForSearch(hit.title);
    const hitStrict = normalizeStrictTitle(hit.title);
    const hitStripped = normalizeStrictTitle(stripSubtitle(hit.title));

    let titleTier = 0;
    if (exactNorms.has(hitNorm)) {
      titleTier = 3;
    } else if (strictNorms.has(hitStrict)) {
      titleTier = 2;
    } else if (
      category === "book" &&
      hitStripped.length >= 3 &&
      (strippedNorms.has(hitStrict) || strictNorms.has(hitStripped))
    ) {
      titleTier = 1;
    }

    if (titleTier === 0) {
      continue;
    }

    // Check year compatibility when both row and hit carry a year.
    let yearBonus = 0;
    if (targetYear !== null && hit.year !== null) {
      const diff = Math.abs(hit.year - targetYear);
      if (category === "film" || category === "series") {
        if (diff > 1) {
          continue;
        }
        yearBonus = diff === 0 ? 20 : 10;
      } else if (category === "anime") {
        // AniList collapses sequel seasons into the root S1 hit (whose year is <= sequel year).
        if (diff > 1 && hit.year > targetYear) {
          continue;
        }
        yearBonus = diff === 0 ? 20 : diff === 1 ? 10 : 5;
      } else if (category === "book") {
        // Book editions may have a later publication_year than first_publish_year.
        yearBonus = diff === 0 ? 15 : diff <= 2 ? 8 : 0;
      }
    }

    let creatorBonus = 0;
    if (creatorNorms.length > 0 && hit.subtitle) {
      const subStrict = normalizeStrictTitle(hit.subtitle);
      if (creatorNorms.some((c) => subStrict.includes(c))) {
        creatorBonus = 10;
      }
    }

    // For a stripped book title match, require either creator or close year match.
    if (titleTier === 1 && creatorBonus === 0 && yearBonus === 0) {
      continue;
    }

    const score = titleTier * 100 + yearBonus + creatorBonus - i;
    if (score > bestScore) {
      bestScore = score;
      bestHit = hit;
    }
  }

  return bestHit;
}

/**
 * Resolve metadata for one Achriom CSV row using `lookupWork` and `lookupSearch`.
 * Never throws when a provider fails; returns `null` so the caller falls back
 * to `ManualWork`.
 */
export async function matchAchriomRowMetadata(
  file: AchriomFileName,
  row: Record<string, string>,
  metaDeps: MetadataDeps
): Promise<WorkDetails | null> {
  if (
    file === "games.csv" ||
    file === "albums.csv" ||
    file === "podcasts.csv"
  ) {
    return null;
  }

  if (!resolveMetadataConfig(metaDeps.config).enabled) {
    return null;
  }

  const title = (row.title ?? "").trim();
  const titleEnglish = (row.title_english ?? "").trim();
  if (!title && !titleEnglish) {
    return null;
  }

  const year = extractAchriomRowYear(file, row);
  const csvCover = extractCsvCoverUrl(row);

  const attachFallbackCover = (work: WorkDetails | null): WorkDetails | null => {
    if (work === null) return null;
    if (work.cover_url === null && csvCover !== null) {
      writeCoverUrlCache(
        metaDeps.config,
        work.provider,
        work.provider_id,
        csvCover
      );
      return {
        ...work,
        cover_url: metaCoverUrl(work.provider, work.provider_id),
      };
    }
    return work;
  };

  try {
    if (file === "anime.csv") {
      const anilistId = (row.anilist_id ?? "").trim();
      if (POSITIVE_INT_RE.test(anilistId)) {
        const direct = await lookupWork("anilist", anilistId, metaDeps).catch(
          () => null
        );
        if (direct !== null) {
          return attachFallbackCover(direct);
        }
      }

      const searchQuery = title || titleEnglish;
      const searchRes = await lookupSearch(searchQuery, "anime", metaDeps).catch(
        () => null
      );
      if (searchRes && searchRes.results.length > 0) {
        const candidateTitles = [title, titleEnglish].filter((t) => t !== "");
        const hit = selectConfidentLookupHit(
          searchRes.results,
          candidateTitles,
          year,
          "anime",
          splitCsvList(row.studios)
        );
        if (hit) {
          const work = await lookupWork(
            hit.provider,
            hit.provider_id,
            metaDeps,
            "anime"
          ).catch(() => null);
          if (work !== null) {
            return attachFallbackCover(work);
          }
        }
      }
      return null;
    }

    if (file === "movies.csv") {
      const imdbId = (row.imdb_id ?? "").trim();
      if (IMDB_ID_RE.test(imdbId)) {
        const direct = await lookupWork(
          "cinemeta",
          imdbId.toLowerCase(),
          metaDeps,
          "film"
        ).catch(() => null);
        if (direct !== null) {
          return attachFallbackCover(direct);
        }
      }

      const tmdbId = (row.tmdb_id ?? "").trim();
      if (POSITIVE_INT_RE.test(tmdbId) && isTmdbConfigured(metaDeps.config)) {
        const directTmdb = await lookupWork(
          "tmdb",
          tmdbId,
          metaDeps,
          "film"
        ).catch(() => null);
        if (directTmdb !== null) {
          return attachFallbackCover(directTmdb);
        }
      }

      const searchRes = await lookupSearch(title, "film", metaDeps).catch(
        () => null
      );
      if (searchRes && searchRes.results.length > 0) {
        const hit = selectConfidentLookupHit(
          searchRes.results,
          [title],
          year,
          "film",
          splitCsvList(row.director)
        );
        if (hit) {
          const work = await lookupWork(
            hit.provider,
            hit.provider_id,
            metaDeps,
            "film"
          ).catch(() => null);
          if (work !== null) {
            return attachFallbackCover(work);
          }
        }
      }
      return null;
    }

    if (file === "shows.csv") {
      const imdbId = (row.imdb_id ?? "").trim();
      if (IMDB_ID_RE.test(imdbId)) {
        const direct = await lookupWork(
          "cinemeta",
          imdbId.toLowerCase(),
          metaDeps,
          "series"
        ).catch(() => null);
        if (direct !== null && direct.seasons.length > 0) {
          return attachFallbackCover(direct);
        }
      }

      const tmdbId = (row.tmdb_id ?? "").trim();
      if (POSITIVE_INT_RE.test(tmdbId) && isTmdbConfigured(metaDeps.config)) {
        const directTmdb = await lookupWork(
          "tmdb",
          tmdbId,
          metaDeps,
          "series"
        ).catch(() => null);
        if (directTmdb !== null && directTmdb.seasons.length > 0) {
          return attachFallbackCover(directTmdb);
        }
      }

      const searchRes = await lookupSearch(title, "series", metaDeps).catch(
        () => null
      );
      if (searchRes && searchRes.results.length > 0) {
        const hit = selectConfidentLookupHit(
          searchRes.results,
          [title],
          year,
          "series",
          splitCsvList(row.creator)
        );
        if (hit) {
          const work = await lookupWork(
            hit.provider,
            hit.provider_id,
            metaDeps,
            "series"
          ).catch(() => null);
          if (work !== null) {
            if (work.seasons.length === 0 && work.external_ids.imdb) {
              const cineFallback = await lookupWork(
                "cinemeta",
                work.external_ids.imdb,
                metaDeps,
                "series"
              ).catch(() => null);
              if (cineFallback && cineFallback.seasons.length > 0) {
                return attachFallbackCover(cineFallback);
              }
            }
            return attachFallbackCover(work);
          }
        }
      }
      return null;
    }

    if (file === "books.csv") {
      const searchRes = await lookupSearch(title, "book", metaDeps).catch(
        () => null
      );
      if (searchRes && searchRes.results.length > 0) {
        const hit = selectConfidentLookupHit(
          searchRes.results,
          [title],
          year,
          "book",
          splitCsvList(row.author)
        );
        if (hit) {
          const work = await lookupWork(
            hit.provider,
            hit.provider_id,
            metaDeps,
            "book"
          ).catch(() => null);
          if (work !== null) {
            return attachFallbackCover(work);
          }
        }
      }
      return null;
    }
  } catch {
    return null;
  }

  return null;
}

// --- Manual cover caching ----------------------------------------------------

function manualCoverPaths(
  config: Config,
  entryId: string
): { imgPath: string; typePath: string } {
  const dir = metaCoverCacheDir(config);
  const safeId = entryId.replace(/[^a-zA-Z0-9_-]/g, "");
  return {
    imgPath: join(dir, `manual_${safeId}.img`),
    typePath: join(dir, `manual_${safeId}.type`),
  };
}

function fallbackMetaProviderForCategory(category: Category): "anilist" | "openlibrary" | "cinemeta" | "tvmaze" {
  switch (category) {
    case "anime":
      return "anilist";
    case "book":
    case "audiobook":
      return "openlibrary";
    case "series":
      return "tvmaze";
    default:
      return "cinemeta";
  }
}

/**
 * When a row is stored as a `ManualWork` and the Achriom export has a cover URL,
 * fetch the image once and store it in the permanent cover cache
 * (`<dirname(db_path)>/covers/meta/manual_<entry_id>.img`).
 */
export async function cacheManualCoverOnce(
  entryId: string,
  coverUrl: string,
  metaDeps: MetadataDeps,
  category: Category = "other"
): Promise<boolean> {
  const metaConfig = resolveMetadataConfig(metaDeps.config);
  if (!metaConfig.enabled || metaDeps.config.covers?.external === false) {
    return false;
  }

  const safeId = entryId.replace(/[^a-zA-Z0-9_-]/g, "");
  const provider = fallbackMetaProviderForCategory(category);
  const { imgPath, typePath } = manualCoverPaths(metaDeps.config, entryId);
  if (
    existsSync(imgPath) &&
    existsSync(typePath) &&
    readCachedMetaCover(metaDeps.config, provider, safeId) !== null
  ) {
    return true;
  }

  const ctx = {
    config: metaDeps.config,
    metaConfig,
    fetch: metaDeps.fetch ?? globalThis.fetch,
    limiter: metaDeps.limiter ?? defaultMetadataLimiter,
    timeoutMs: metaDeps.timeoutMs ?? METADATA_TIMEOUT_MS,
    now: metaDeps.now ?? Date.now,
  };

  const downloaded = await fetchRemoteCoverImage(ctx, coverUrl);
  if (downloaded === null) {
    return false;
  }

  try {
    mkdirSync(dirname(imgPath), { recursive: true });
    writeFileSync(imgPath, downloaded.bytes);
    writeFileSync(typePath, downloaded.contentType, "utf8");
    writeCachedMetaCover(metaDeps.config, provider, safeId, downloaded);
    return true;
  } catch {
    return false;
  }
}

// --- Dry-run simulation & state inspection -----------------------------------

function getExistingEntryRows(db: Database, entryId: string): EventRow[] {
  const likePattern = `archive:${entryId}:%`;
  return db
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
}

function computeSeasonMinutes(
  s: { number: number; episodes?: number },
  seasonInfo: SeasonInfo | undefined,
  workRuntime: number | null,
  allSeasons: readonly SeasonInfo[] = []
): number | null {
  const knownEpMins = allSeasons
    .map((ws) => ws.episode_minutes)
    .filter((m): m is number => typeof m === "number" && Number.isFinite(m) && m > 0);
  const fallbackRuntime =
    workRuntime !== null && workRuntime > 0
      ? workRuntime
      : knownEpMins.length > 0
        ? Math.round(knownEpMins.reduce((a, b) => a + b, 0) / knownEpMins.length)
        : null;

  const isWhole =
    s.episodes === undefined ||
    (seasonInfo !== undefined &&
      seasonInfo.episodes > 0 &&
      s.episodes >= seasonInfo.episodes);

  if (isWhole) {
    if (
      seasonInfo?.total_minutes !== null &&
      seasonInfo?.total_minutes !== undefined &&
      seasonInfo.total_minutes > 0
    ) {
      return seasonInfo.total_minutes;
    }
    if (
      seasonInfo?.episode_minutes !== null &&
      seasonInfo?.episode_minutes !== undefined &&
      seasonInfo.episode_minutes > 0
    ) {
      const epCount = s.episodes ?? seasonInfo.episodes;
      return epCount > 0 ? epCount * seasonInfo.episode_minutes : null;
    }
    if (fallbackRuntime !== null && fallbackRuntime > 0) {
      const epCount = s.episodes ?? seasonInfo?.episodes ?? 0;
      return epCount > 0 ? epCount * fallbackRuntime : null;
    }
    return null;
  }

  const watchedEps = s.episodes!;
  if (
    seasonInfo?.episode_minutes !== null &&
    seasonInfo?.episode_minutes !== undefined &&
    seasonInfo.episode_minutes > 0
  ) {
    return watchedEps * seasonInfo.episode_minutes;
  }
  if (
    seasonInfo?.total_minutes !== null &&
    seasonInfo?.total_minutes !== undefined &&
    seasonInfo.total_minutes > 0 &&
    seasonInfo.episodes > 0
  ) {
    return (seasonInfo.total_minutes / seasonInfo.episodes) * watchedEps;
  }
  if (fallbackRuntime !== null && fallbackRuntime > 0) {
    return watchedEps * fallbackRuntime;
  }
  return null;
}

/**
 * Compute `total_minutes` and `estimated` for an `ArchiveRequest` using the
 * exact same rules as `saveArchiveEntry` in `src/server/archive.ts`.
 */
export function computeArchiveRequestMinutes(request: ArchiveRequest): {
  totalMinutes: number;
  estimated: boolean;
  unitSeconds: Array<{ unit: string; seconds: number | null }>;
} {
  const { work, consumed } = request;
  const naturalUnits: Array<{ unit: string; naturalMinutes: number | null }> = [];

  if (consumed.seasons && consumed.seasons.length > 0) {
    const seasonMap = new Map<number, SeasonInfo>();
    for (const ws of work.seasons) {
      seasonMap.set(ws.number, ws);
    }
    const sorted = [...consumed.seasons].sort((a, b) => a.number - b.number);
    for (const s of sorted) {
      const sInfo = seasonMap.get(s.number);
      naturalUnits.push({
        unit: `s${s.number}`,
        naturalMinutes: computeSeasonMinutes(s, sInfo, work.runtime_minutes, work.seasons),
      });
    }
  } else if (
    work.category === "film" ||
    (work.category === "anime" && work.seasons.length === 0) ||
    consumed.times !== undefined
  ) {
    const times = consumed.times ?? 1;
    const perViewing =
      work.runtime_minutes !== null && work.runtime_minutes > 0
        ? work.runtime_minutes
        : null;
    for (let i = 1; i <= times; i++) {
      naturalUnits.push({ unit: `v${i}`, naturalMinutes: perViewing });
    }
  } else {
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
    naturalUnits.push({ unit: "b", naturalMinutes });
  }

  let unitSeconds: Array<{ unit: string; seconds: number | null }>;
  let estimated: boolean;

  if (
    consumed.minutes_override !== undefined &&
    consumed.minutes_override !== null
  ) {
    estimated = false;
    const totalOverrideSeconds = Math.round(consumed.minutes_override * 60);
    const naturalSum = naturalUnits.reduce(
      (s, u) => s + (u.naturalMinutes ?? 0),
      0
    );
    if (naturalUnits.length === 1) {
      unitSeconds = [{ unit: naturalUnits[0]!.unit, seconds: totalOverrideSeconds }];
    } else if (naturalSum > 0) {
      let allocated = 0;
      unitSeconds = naturalUnits.map((u, idx) => {
        if (idx === naturalUnits.length - 1) {
          return {
            unit: u.unit,
            seconds: Math.max(0, totalOverrideSeconds - allocated),
          };
        }
        const share = Math.round(
          totalOverrideSeconds * ((u.naturalMinutes ?? 0) / naturalSum)
        );
        allocated += share;
        return { unit: u.unit, seconds: share };
      });
    } else {
      let allocated = 0;
      unitSeconds = naturalUnits.map((u, idx) => {
        if (idx === naturalUnits.length - 1) {
          return {
            unit: u.unit,
            seconds: Math.max(0, totalOverrideSeconds - allocated),
          };
        }
        const share = Math.round(totalOverrideSeconds / naturalUnits.length);
        allocated += share;
        return { unit: u.unit, seconds: share };
      });
    }
  } else {
    unitSeconds = naturalUnits.map((u) => ({
      unit: u.unit,
      seconds:
        u.naturalMinutes !== null ? Math.round(u.naturalMinutes * 60) : null,
    }));
    estimated = unitSeconds.some((u) => u.seconds !== null && u.seconds > 0);
  }

  const totalMinutes =
    unitSeconds.reduce((sum, u) => sum + (u.seconds ?? 0), 0) / 60;

  return { totalMinutes, estimated, unitSeconds };
}

function simulateDryRunClassification(
  db: Database,
  request: ArchiveRequest,
  tz: string,
  estimated: boolean,
  unitSeconds: Array<{ unit: string; seconds: number | null }>
): "created" | "unchanged" | "updated" {
  const existingRows = getExistingEntryRows(db, request.entry_id);
  const activeRows = existingRows.filter(
    (r) => parseJsonObject(r.raw)?.["deleted"] !== true
  );
  if (activeRows.length === 0) {
    return "created";
  }

  if (activeRows.length !== unitSeconds.length) {
    return "updated";
  }

  const expectedWorkJson = JSON.stringify(request.work);
  const expectedConsumedJson = JSON.stringify(request.consumed);
  const expectedWhenJson = JSON.stringify(request.when);

  const existingBySourceId = new Map<string, EventRow>();
  for (const r of activeRows) {
    existingBySourceId.set(r.source_id, r);
  }

  for (const u of unitSeconds) {
    const sourceId = `archive:${request.entry_id}:${u.unit}`;
    const existing = existingBySourceId.get(sourceId);
    if (!existing) {
      return "updated";
    }
    if (existing.duration_seconds !== u.seconds) {
      return "updated";
    }
    const existingRawObj = parseJsonObject(existing.raw);
    if (!existingRawObj) {
      return "updated";
    }
    if (
      existingRawObj["category"] !== request.work.category ||
      existingRawObj["estimated"] !== estimated ||
      JSON.stringify(existingRawObj["work"]) !== expectedWorkJson ||
      JSON.stringify(existingRawObj["consumed"]) !== expectedConsumedJson ||
      JSON.stringify(existingRawObj["when"]) !== expectedWhenJson
    ) {
      return "updated";
    }
    if (
      "status" in existingRawObj &&
      request.status !== undefined &&
      existingRawObj["status"] !== request.status
    ) {
      return "updated";
    }
    if (request.when.precision !== "unknown" && request.when.date) {
      const localDay =
        request.when.precision === "day"
          ? request.when.date
          : request.when.precision === "month"
            ? `${request.when.date}-01`
            : `${request.when.date}-01-01`;
      const expectedStartedAt = localToUtcIso(`${localDay} 12:00:00`, tz);
      if (existing.started_at !== expectedStartedAt) {
        return "updated";
      }
    }
  }

  const currentAnn = getAnnotation(db, ARCHIVE_SOURCE, request.work.title);
  const nextRating =
    request.rating !== undefined ? parseRating(request.rating) : currentAnn.rating;
  const nextNote =
    request.note !== undefined ? parseNote(request.note) : currentAnn.note;
  if (currentAnn.rating !== nextRating || currentAnn.note !== nextNote) {
    return "updated";
  }

  return "unchanged";
}

// --- Full Import Runner ------------------------------------------------------

export interface ImportAchriomOptions {
  db: Database;
  config: Config;
  /** Raw zip bytes, single CSV bytes, or single CSV text. */
  input: Uint8Array | ArrayBuffer | string;
  /** Filename hint (e.g. `"achriom-library-2026-10-18.zip"` or `"anime.csv"`). */
  filename?: string;
  /** When true, no rows or covers are written; returns the exact preview summary. */
  dryRun?: boolean;
  /** Injectable fetch for metadata providers and cover caching (tests). */
  fetch?: typeof fetch;
  limiter?: Limiter;
  timeoutMs?: number;
  now?: () => number;
  /** Zip size limits override (tests). */
  zipOptions?: ReadZipOptions;
}

interface ParsedAchriomCsvFile {
  file: AchriomFileName;
  rows: Array<Record<string, string>>;
}

function parseInputFiles(
  input: Uint8Array | ArrayBuffer | string,
  filename: string | undefined,
  zipOptions?: ReadZipOptions
): ParsedAchriomCsvFile[] {
  const isZipName = filename?.toLowerCase().endsWith(".zip") ?? false;
  let bytes: Uint8Array | null = null;
  if (typeof input !== "string") {
    bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  }

  if (bytes !== null && (isZipBytes(bytes) || isZipName)) {
    if (!isZipBytes(bytes)) {
      throw new AchriomImportError("Invalid zip archive: missing PK signature");
    }
    let zipEntries;
    try {
      zipEntries = readZip(bytes, zipOptions);
    } catch (err) {
      if (err instanceof ZipError) {
        throw new AchriomImportError(err.message);
      }
      throw err;
    }

    const byFile = new Map<AchriomFileName, Array<Record<string, string>>>();

    for (const entry of zipEntries) {
      // Ignore macOS metadata entries or non-CSV files inside the archive.
      if (
        entry.name.startsWith("__MACOSX/") ||
        entry.baseName.startsWith(".") ||
        !entry.baseName.toLowerCase().endsWith(".csv")
      ) {
        continue;
      }

      let csvText: string;
      try {
        csvText = entry.text();
      } catch {
        throw new AchriomImportError(`File '${entry.name}' is not valid UTF-8`);
      }

      let parsed;
      try {
        parsed = parseCsvObjects(csvText);
      } catch (err) {
        if (err instanceof CsvParseError) {
          throw new AchriomImportError(`Invalid CSV in '${entry.name}': ${err.message}`);
        }
        throw err;
      }

      const detected = detectAchriomFile(entry.baseName, parsed.headers);
      if (detected === null) {
        throw new AchriomImportError(
          `Unrecognized CSV headers in '${entry.name}'`
        );
      }

      byFile.set(detected, parsed.rows);
    }

    if (byFile.size === 0) {
      throw new AchriomImportError(
        "Zip archive contains no recognized Achriom CSV files"
      );
    }

    const ordered: ParsedAchriomCsvFile[] = [];
    for (const knownName of ACHRIOM_FILES) {
      const r = byFile.get(knownName);
      if (r !== undefined) {
        ordered.push({ file: knownName, rows: r });
      }
    }
    return ordered;
  }

  // Single CSV input
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes!);
    } catch {
      throw new AchriomImportError("Uploaded file is neither a valid zip nor UTF-8 CSV");
    }
  }

  let parsed;
  try {
    parsed = parseCsvObjects(text);
  } catch (err) {
    if (err instanceof CsvParseError) {
      throw new AchriomImportError(`Invalid CSV: ${err.message}`);
    }
    throw err;
  }

  const detected = detectAchriomFile(filename ?? "", parsed.headers);
  if (detected === null) {
    throw new AchriomImportError(
      "Could not recognize Achriom CSV format from filename or headers"
    );
  }

  return [{ file: detected, rows: parsed.rows }];
}

/**
 * Import an Achriom library export (`.zip` or single `.csv`) into the archive.
 */
export async function importAchriom(
  opts: ImportAchriomOptions
): Promise<AchriomImportResult> {
  const { db, config, input, filename } = opts;
  const dryRun = Boolean(opts.dryRun);
  const tz = config.timezone ?? "Europe/Bratislava";

  const parsedFiles = parseInputFiles(input, filename, opts.zipOptions);

  const metaDeps: MetadataDeps = {
    config,
    fetch: opts.fetch ?? globalThis.fetch,
    limiter: opts.limiter ?? defaultMetadataLimiter,
    timeoutMs: opts.timeoutMs ?? METADATA_TIMEOUT_MS,
    now: opts.now ?? Date.now,
  };

  const rowsPerFile: Record<string, number> = {};
  const skipped: Array<{ file: string; title: string; reason: string }> = [];
  const mappedArchiveEntries: Array<{
    file: AchriomFileName;
    request: ArchiveRequest;
    matched: boolean;
    planned: boolean;
    coverUrl: string | null;
  }> = [];

  for (const { file, rows } of parsedFiles) {
    rowsPerFile[file] = rows.length;
    for (const row of rows) {
      const matchedWork = await matchAchriomRowMetadata(file, row, metaDeps);
      const mapped = mapAchriomRow(file, row, matchedWork);
      if (mapped.kind === "skip") {
        skipped.push({
          file: mapped.file,
          title: mapped.title,
          reason: mapped.reason,
        });
      } else {
        mappedArchiveEntries.push(mapped);
      }
    }
  }

  // Reconcile annotations across rows that resolve to the same work.title in
  // the batch (e.g. multiple AniList seasons of the same franchise) so they
  // agree on one rating/note and never ping-pong on a repeat import.
  const effectiveAnnotationByTitle = new Map<
    string,
    { rating: number | null; note: string | null }
  >();
  for (const item of mappedArchiveEntries) {
    const titleKey = item.request.work.title.trim();
    const prev = effectiveAnnotationByTitle.get(titleKey) ?? {
      rating: null,
      note: null,
    };
    effectiveAnnotationByTitle.set(titleKey, {
      rating: item.request.rating !== null && item.request.rating !== undefined
        ? item.request.rating
        : prev.rating,
      note: item.request.note !== null && item.request.note !== undefined
        ? item.request.note
        : prev.note,
    });
  }
  for (const item of mappedArchiveEntries) {
    const titleKey = item.request.work.title.trim();
    const eff = effectiveAnnotationByTitle.get(titleKey);
    if (eff) {
      item.request.rating = eff.rating;
      item.request.note = eff.note;
    }
  }

  let created = 0;
  let unchanged = 0;
  let updated = 0;
  let planned = 0;
  let matched = 0;
  let totalMinutes = 0;

  const nowIso = opts.now
    ? new Date(opts.now()).toISOString()
    : new Date().toISOString();

  for (const item of mappedArchiveEntries) {
    if (item.planned) {
      planned += 1;
    }
    if (item.matched) {
      matched += 1;
    }

    if (dryRun) {
      const sim = computeArchiveRequestMinutes(item.request);
      const cls = simulateDryRunClassification(
        db,
        item.request,
        tz,
        sim.estimated,
        sim.unitSeconds
      );
      if (cls === "created") {
        created += 1;
      } else if (cls === "updated") {
        updated += 1;
      } else {
        unchanged += 1;
      }
      totalMinutes += sim.totalMinutes;
      continue;
    }

    // Cache manual cover once into the permanent cover cache when unmatched.
    if (item.request.work.provider === "manual" && item.coverUrl !== null) {
      await cacheManualCoverOnce(
        item.request.entry_id,
        item.coverUrl,
        metaDeps,
        item.request.work.category
      );
    }

    const existingBefore = getExistingEntryRows(db, item.request.entry_id);
    const hadActiveBefore = existingBefore.some(
      (r) => parseJsonObject(r.raw)?.["deleted"] !== true
    );
    const prevAnn = getAnnotation(
      db,
      ARCHIVE_SOURCE,
      item.request.work.title
    );

    const saved = saveArchiveEntry(db, item.request, tz, { nowIso });
    const nextAnn = getAnnotation(
      db,
      ARCHIVE_SOURCE,
      item.request.work.title
    );

    const annChanged =
      prevAnn.rating !== nextAnn.rating || prevAnn.note !== nextAnn.note;

    if (!hadActiveBefore) {
      created += 1;
    } else if (saved.inserted > 0 || annChanged) {
      updated += 1;
    } else {
      unchanged += 1;
    }

    totalMinutes += saved.total_minutes;
  }

  return {
    dry_run: dryRun,
    rows: rowsPerFile,
    created,
    unchanged,
    updated,
    planned,
    matched,
    skipped,
    total_minutes: Math.round(totalMinutes * 100) / 100,
  };
}
