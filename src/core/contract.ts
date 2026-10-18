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
  /** Optional 1..10 rating and note, stored through the existing annotations table. */
  rating?: number | null;
  note?: string | null;
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

export type WorkStatus = "in_progress" | "finished" | "dropped" | "unknown";

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
  rating: number | null;
  sources: string[];
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
