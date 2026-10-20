/**
 * API contract for the v2 features (metadata lookup, archive entries, library,
 * month/year review, settings). Types only: the server returns exactly these
 * shapes and the web app imports them (`import type`). Behaviour is described
 * in docs/v2-spec.md. Change this file only together with that doc.
 */

import type { Category } from "./category.ts";

export type { Category } from "./category.ts";

// --- metadata lookup (GET /api/lookup/...) ---------------------------------

export type MetaProvider = "anilist" | "tvmaze" | "cinemeta" | "itunes" | "openlibrary" | "tmdb";

/** One search result: enough to show a row with a small cover and pick it. */
export interface LookupHit {
  provider: MetaProvider;
  /** Provider's id as a string, [A-Za-z0-9_-]{1,64}. */
  provider_id: string;
  category: Category;
  title: string;
  /** e.g. "2019 · 2 seasons · 48 episodes" or "Ursula K. Le Guin · 1968". */
  subtitle: string | null;
  year: number | null;
  /** Local URL `/api/meta-cover/<provider>/<provider_id>` or null. */
  cover_url: string | null;
}

export interface LookupSearchResult {
  query: string;
  category: Category | "any";
  results: LookupHit[];
  /** Providers that failed (timeout, 5xx); the rest still returned results. */
  failed_providers: MetaProvider[];
}

/** A season (series/anime). Anime seasons are separate entries on AniList, joined in order. */
export interface SeasonInfo {
  /** 1-based, in watch order. */
  number: number;
  title: string | null;
  year: number | null;
  episodes: number;
  /** Typical episode length in minutes (null if unknown). */
  episode_minutes: number | null;
  /** Sum of episode runtimes when known per episode, else episodes * episode_minutes, else null. */
  total_minutes: number | null;
  /** Provider id of this season when it differs from the work (AniList: one id per season). */
  provider_id: string | null;
}

/** Full details for one work, used by the "add to archive" form and stored as a snapshot. */
export interface WorkDetails {
  provider: MetaProvider;
  provider_id: string;
  category: Category;
  title: string;
  original_title: string | null;
  year: number | null;
  cover_url: string | null;
  /** Authors, directors or studio: short display names. */
  creators: string[];
  genres: string[];
  /** Plain text, at most 600 characters. */
  description: string | null;
  /** Series and anime; [] for films and books. */
  seasons: SeasonInfo[];
  /** Films (and a single-entry anime film). */
  runtime_minutes: number | null;
  /** Books. */
  pages: number | null;
  /** Ids in other databases, e.g. { anilist: "101348", mal: "37521", imdb: "tt..." }. */
  external_ids: Record<string, string>;
}

// --- archive entries (POST /api/archive ...) --------------------------------

export type DatePrecision = "day" | "month" | "year" | "unknown";

export interface ArchiveWhen {
  precision: DatePrecision;
  /** "YYYY-MM-DD" | "YYYY-MM" | "YYYY", matching precision; omitted for "unknown". Local date. */
  date?: string;
  /** Optional end of a range with the same precision (e.g. watched S1 from 2021-03 to 2021-05). */
  end_date?: string;
}

/** What part of the work was consumed. Exactly one of the fields fits the category. */
export interface ArchiveConsumed {
  /** Series/anime: seasons watched; omit `episodes` for the whole season. */
  seasons?: Array<{ number: number; episodes?: number }>;
  /** Films: how many times watched (default 1). */
  times?: number;
  /** Books/audiobooks/other: 0..1 share finished (1 = finished). */
  progress?: number;
  /** Optional manual override of the total time in minutes (e.g. a book's reading hours). */
  minutes_override?: number;
}

export interface ArchiveRequest {
  /** UUID made by the client once per archive entry; reused to edit the entry. */
  entry_id: string;
  /** Snapshot from GET /api/lookup/work/..., or a hand-made ManualWork when no provider knows the title. */
  work: WorkDetails | ManualWork;
  consumed: ArchiveConsumed;
  when: ArchiveWhen;
  /** Optional rating 0..10 with at most one decimal (7.5), and a note. */
  rating?: number | null;
  note?: string | null;
  /** v2.1: default "finished" (or "in_progress" when progress < 1). "planned" = watchlist, counts no time. */
  status?: "finished" | "in_progress" | "dropped" | "planned";
}

/** For things no provider knows: the user types the basics. */
export interface ManualWork {
  provider: "manual";
  category: Category;
  title: string;
  year: number | null;
  creators: string[];
  seasons: SeasonInfo[];
  runtime_minutes: number | null;
  pages: number | null;
}

export interface ArchiveResult {
  entry_id: string;
  /** Rows written now (0 when the same request was already stored). */
  inserted: number;
  /** Units stored for this entry (one per season, one per film viewing, one per book). */
  units: number;
  total_minutes: number;
  /** True when the time is an estimate (from runtimes/pages, not measured). */
  estimated: boolean;
  /** A stale manual re-save was repaired using the entry's stored linked snapshot. */
  kept_link?: true;
}

export interface ArchiveEntrySummary {
  entry_id: string;
  category: Category;
  title: string;
  cover_url: string | null;
  when: ArchiveWhen;
  consumed: ArchiveConsumed;
  total_minutes: number;
  created_at: string;
  updated_at: string;
}

// --- library (GET /api/library, /api/library/work) --------------------------

/** v2.1 adds "planned" (watchlist: in the library, counts no time). */
export type WorkStatus = "in_progress" | "finished" | "dropped" | "planned" | "unknown";

/** One work across all sources (a show's episodes from Simkl + an archive entry are one work). */
export interface LibraryWork {
  /** Stable opaque key for /api/library/work?key=. */
  key: string;
  category: Category;
  title: string;
  cover_url: string | null;
  total_minutes: number;
  /** Episodes / sessions / plays / archive units. */
  units: number;
  first_at: string | null;
  last_at: string | null;
  status: WorkStatus;
  /** 0..10 with at most one decimal. */
  rating: number | null;
  sources: string[];
  /** v2.1: true when the user changed this work with POST /api/library/work/edit. */
  edited: boolean;
  /** v2.1: YouTube only: channel name and topic, else null. */
  channel: string | null;
  topic: string | null;
  /**
   * v2.2: explicit progress for works with seasons (series/anime), else null. Replaces guessing
   * from `units` ("6 episodes" when 6 seasons were meant). Totals come from the linked metadata.
   */
  progress: {
    seasons_watched: number;
    seasons_total: number | null;
    episodes_watched: number;
    episodes_total: number | null;
  } | null;
  /** v2.2: author (books/audiobooks), artist (music), channel (YouTube), studio/creator, else null. */
  creator: string | null;
  /** v2.2 (W11): true when a track/video is in Favorite Songs. */
  favorite?: boolean;
}

export interface CategoryTotal {
  category: Category;
  total_minutes: number;
  works: number;
  units: number;
}

export interface LibraryResult {
  categories: CategoryTotal[];
  works: LibraryWork[];
  total_minutes: number;
}

export interface LibraryWorkDetail extends LibraryWork {
  /** Stored snapshot for logging this work again; never reconstructed from display/progress fields. */
  work_snapshot?: WorkDetails | ManualWork | null;
  /** Seasons with watched counts, when the work has seasons. */
  seasons: Array<SeasonInfo & { watched_episodes: number }>;
  /** Newest first; archive units and real sessions mixed. */
  history: Array<{
    started_at: string;
    precision: DatePrecision;
    label: string;
    minutes: number;
    source: string;
    entry_id: string | null;
  }>;
  note: string | null;
}

// --- reviews and charts ------------------------------------------------------

export interface SeriesPoint {
  /** "YYYY-MM-DD" for day buckets, "YYYY-Www" for weeks, "YYYY-MM" for months. Local time. */
  bucket: string;
  minutes_by_category: Partial<Record<Category, number>>;
}

/** GET /api/series?bucket=day|week|month&from=YYYY-MM-DD&to=YYYY-MM-DD[&category=] */
export interface SeriesResult {
  bucket: "day" | "week" | "month";
  from: string;
  to: string;
  points: SeriesPoint[];
}

/** GET /api/review/month?month=YYYY-MM */
export interface MonthReview {
  month: string;
  total_minutes: number;
  /** The previous month's total, for "+12% vs September". */
  previous_month_minutes: number;
  categories: CategoryTotal[];
  /** One point per day of the month. */
  days: SeriesPoint[];
  /** Minutes per hour of day 0..23 and weekday 0=Mon..6=Sun, for a punch-card chart. */
  hour_weekday: number[][];
  top_works: LibraryWork[];
  started_works: LibraryWork[];
  finished_works: LibraryWork[];
  active_days: number;
  longest_streak_days: number;
  /** Archive entries with month precision in this month (time known only to the month). */
  undated_minutes: number;
}

/** GET /api/review/year?year=YYYY: the twelve month reviews' totals plus year-level lists. */
export interface YearReviewV2 {
  year: number;
  total_minutes: number;
  months: Array<{ month: string; total_minutes: number; categories: CategoryTotal[] }>;
  categories: CategoryTotal[];
  top_works: LibraryWork[];
  finished_works: LibraryWork[];
  active_days: number;
  longest_streak_days: number;
  /** Archive entries known only to the year. */
  undated_minutes: number;
}

// --- settings (GET /api/settings) --------------------------------------------

export interface SourceStatus {
  source: string;
  enabled: boolean;
  /** Host only (no path, no credentials), or null. */
  host: string | null;
  last_sync_at: string | null;
  last_status: "ok" | "failed" | "running" | null;
  last_error: string | null;
  can_sync_now: boolean;
}

export interface SettingsView {
  timezone: string;
  version: string;
  sources: SourceStatus[];
  metadata_providers: Array<{ provider: MetaProvider; enabled: boolean }>;
  covers_external: boolean;
  ingest_token_set: boolean;
  database: { events: number; size_bytes: number | null; last_backup_at: string | null };
}

// --- v2.1: editing any work (POST /api/library/work/edit?key=) ---------------

/**
 * A partial edit of one library work, from the work page, the quick-edit menu or the quick rating.
 * Omitted fields stay as they are; `null` clears that override (back to the source's value),
 * except `meta: null`, which explicitly unlinks metadata without rewriting source history.
 * Stored append-only (a new row per edit); works from every source can be edited, including
 * Audiobookshelf/YouTube/Simkl ones (their source rows are never changed).
 * Response: the updated LibraryWorkDetail.
 */
export interface WorkEdit {
  title?: string | null;
  category?: Category | null;
  status?: WorkStatus | null;
  /** 0..10, at most one decimal. */
  rating?: number | null;
  note?: string | null;
  /** Hidden works disappear from every view, total and chart; Settings lists them to unhide. */
  hidden?: boolean;
  /** Link the work to metadata; null explicitly unlinks (canonical identity/history stay intact). */
  meta?: { provider: MetaProvider; provider_id: string } | null;
  /** YouTube works: the topic of this video (channel topics are set with /api/youtube/channel-topic). */
  topic?: string | null;
}

/** GET /api/library/hidden */
export interface HiddenWorksResult {
  works: LibraryWork[];
}

// --- v2.1: YouTube (GET /api/youtube, /api/youtube/videos) -------------------

export interface YoutubeTopic {
  topic: string;
  channels: number;
  videos: number;
  total_minutes: number;
}

export interface YoutubeChannel {
  channel: string;
  channel_id: string | null;
  /** The user's topic for this channel, else the most common YouTube category of its videos. */
  topic: string | null;
  videos: number;
  total_minutes: number;
  last_at: string | null;
  /** v2.2 (W11): true when the channel is in Takeout subscriptions.csv. */
  subscribed?: boolean;
}

export interface YoutubeVideo {
  /** Library work key of this video. */
  key: string;
  video_id: string;
  title: string;
  channel: string | null;
  topic: string | null;
  watched_minutes: number;
  plays: number;
  first_at: string;
  last_at: string;
  /** Local URL or null. */
  thumbnail_url: string | null;
}

/** GET /api/youtube?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional: all time). */
export interface YoutubeOverview {
  from: string | null;
  to: string | null;
  total_minutes: number;
  videos: number;
  topics: YoutubeTopic[];
  channels: YoutubeChannel[];
  /** Minutes per day for a sparkline (local days, only when from/to are given). */
  days: SeriesPoint[];
  /** Video-days below the minimum watch time, left out of everything. */
  short_plays_hidden: number;
  min_watch_minutes: number;
}

/** GET /api/youtube/videos?channel=&topic=&from=&to=&q=&limit=50&offset=0, newest first. */
export interface YoutubeVideosResult {
  videos: YoutubeVideo[];
  total: number;
}

// --- v2.1: Achriom import (POST /api/import/achriom[?dry_run=1], CLI `import achriom`) ---

export interface AchriomImportResult {
  dry_run: boolean;
  /** Rows read per file, e.g. { "anime.csv": 30 }. */
  rows: Record<string, number>;
  /** Archive entries written now (0 on a repeat import). */
  created: number;
  /** Entries already stored unchanged. */
  unchanged: number;
  /** Entries whose earlier import changed (re-saved as a new revision). */
  updated: number;
  planned: number;
  /** Rows matched to a metadata provider (better cover, runtime, seasons). */
  matched: number;
  /** Rows not imported, with a reason (e.g. games and albums are not tracked categories). */
  skipped: Array<{ file: string; title: string; reason: string }>;
  total_minutes: number;
}

// --- v2.2 ---------------------------------------------------------------------

/**
 * GET /api/library sort values (v2.2 adds "category" and "creator"):
 * plays | recent | time | title | category | creator. YouTube videos also support topic.
 */
export type LibrarySortV2 = "recent" | "plays" | "time" | "title" | "category" | "creator";

export type TopKind = "songs" | "artists" | "channels";
export type TopBy = "plays" | "time";
export interface TopEntry {
  key: string;
  title: string;
  creator: string | null;
  plays: number;
  total_minutes: number;
}
export interface TopResult {
  kind: TopKind;
  by: TopBy;
  from: string | null;
  to: string | null;
  entries: TopEntry[];
}

/**
 * POST /api/library/work/refresh-metadata?key=  → LibraryWorkDetail.
 * Re-looks up the work's linked metadata (bypassing the cache) and, for archive entries, re-saves
 * them as new revisions when seasons/runtimes changed (append-only). Also: CLI
 * `archive refresh-metadata [--dry-run]` for every archive entry.
 */
export interface RefreshMetadataResult {
  key: string;
  changed: boolean;
  /** Minutes before and after, for "Vikings: 89 h → 66 h". */
  minutes_before: number;
  minutes_after: number;
}
