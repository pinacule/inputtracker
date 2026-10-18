/**
 * Typed fetch helpers for the InputTracker HTTP API.
 *
 * All requests use relative `/api/...` paths so the same build works in the
 * Vite dev server (proxied to the Hono server) and in production (served from
 * the same origin). Response types mirror the routes in `src/server/app.ts`.
 *
 * On a non-2xx response the server's `{ error }` message is thrown as an
 * `ApiError` (with `kind: "http"` and the status code); network failures and
 * timeouts throw `ApiError`s with `kind: "network"`. Otherwise the JSON body
 * is parsed and returned.
 */

import type {
  AchriomImportResult,
  ArchiveConsumed,
  ArchiveEntrySummary,
  ArchiveRequest,
  ArchiveResult,
  ArchiveWhen,
  Category,
  CategoryTotal,
  DatePrecision,
  HiddenWorksResult,
  LibraryResult,
  LibraryWork,
  LibraryWorkDetail,
  LookupHit,
  LookupSearchResult,
  ManualWork,
  MetaProvider,
  MonthReview,
  SeasonInfo,
  SeriesPoint,
  SeriesResult,
  SettingsView,
  SourceStatus,
  WorkDetails,
  WorkEdit,
  WorkStatus,
  YearReviewV2,
  YoutubeChannel,
  YoutubeOverview,
  YoutubeTopic,
  YoutubeVideo,
  YoutubeVideosResult,
} from "../../src/core/contract";

export type {
  AchriomImportResult,
  ArchiveConsumed,
  ArchiveEntrySummary,
  ArchiveRequest,
  ArchiveResult,
  ArchiveWhen,
  Category,
  CategoryTotal,
  DatePrecision,
  HiddenWorksResult,
  LibraryResult,
  LibraryWork,
  LibraryWorkDetail,
  LookupHit,
  LookupSearchResult,
  ManualWork,
  MetaProvider,
  MonthReview,
  SeasonInfo,
  SeriesPoint,
  SeriesResult,
  SettingsView,
  SourceStatus,
  WorkDetails,
  WorkEdit,
  WorkStatus,
  YearReviewV2,
  YoutubeChannel,
  YoutubeOverview,
  YoutubeTopic,
  YoutubeVideo,
  YoutubeVideosResult,
};

export type CategoryListParam = Category | readonly Category[] | string;

// --- Response types (mirror src/server/app.ts) -----------------------------

export interface CalendarItem {
  id: number;
  source: string;
  media_type: string;
  category?: Category;
  title: string | null;
  parent_title: string | null;
  season: number | null;
  episode: number | null;
  started_at: string;
  local_time: string;
  duration_seconds: number | null;
  /** `/api/cover/<abs_item>` for ABS items, else null. */
  cover_url: string | null;
  /** Synced later from an offline device: the day is the sync day, the time is unknown. */
  time_uncertain?: boolean;
  also_from?: string[];
}

export interface CalendarDay {
  date: string;
  count: number;
  minutes: number;
  items: CalendarItem[];
}

export interface CalendarResult {
  month: string;
  days: CalendarDay[];
}

export interface HeatmapDay {
  date: string;
  count: number;
  minutes: number;
}

export interface HeatmapDaysResult {
  year: string;
  days: HeatmapDay[];
}

export interface HeatmapHourCell {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** 0-23. */
  hour: number;
  count: number;
  minutes: number;
}

export interface HeatmapHoursResult {
  cells: HeatmapHourCell[];
  /** Sessions left out of the grid because their time of day is unknown. */
  unplaced_count?: number;
  unplaced_minutes?: number;
}

export interface StatBucket {
  count: number;
  items: number;
  minutes: number;
}

export interface WeekStatBucket {
  week: string; // "2026-W42" (ISO week, local)
  by_source: Record<string, number>;
  minutes: number;
  /** Number of items in the bucket. */
  count: number;
  /** Number of items per source in the bucket. */
  count_by_source: Record<string, number>;
}

export interface MonthStatBucket {
  month: string; // "2026-10"
  by_source: Record<string, number>;
  minutes: number;
  /** Number of items in the bucket. */
  count: number;
  /** Number of items per source in the bucket. */
  count_by_source: Record<string, number>;
}

export interface TopItem {
  title: string;
  source: string;
  media_type: string;
  category?: Category;
  minutes: number;
  count: number;
}

export interface StatsResult {
  total_items: number;
  total_minutes: number;
  by_source: Record<string, StatBucket>;
  by_media_type: Record<string, StatBucket>;
  by_week: WeekStatBucket[];
  by_month: MonthStatBucket[];
  top_items: TopItem[];
}

export interface StatsParams {
  from?: string;
  to?: string;
  source?: string;
  category?: CategoryListParam;
  exclude?: CategoryListParam;
}

export interface StreakInfo {
  current: number;
  longest: number;
  longest_start: string | null;
  longest_end: string | null;
  last_active: string | null;
}

export interface StreaksResult {
  today: string;
  overall: StreakInfo;
  by_source: Record<string, StreakInfo>;
}

export interface OnThisDayItem {
  title: string;
  source: string;
  media_type: string | null;
  started_at: string;
  cover_url: string | null;
}

export interface OnThisDayYear {
  year: number;
  years_ago: number;
  items: OnThisDayItem[];
}

export interface OnThisDayResult {
  date: string;
  years: OnThisDayYear[];
}

/** Result of `GET /api/insights` (streaks + "On this day"). */
export interface InsightsResult {
  streaks: StreaksResult;
  on_this_day: OnThisDayResult;
}

export interface ReviewTotals {
  items: number;
  minutes: number;
  active_days: number;
  titles: number;
}

export interface ReviewTitle {
  title: string;
  source: string;
  media_type: string | null;
  minutes: number;
  count: number;
  cover_url: string | null;
  /** Latest rating (1–10) for this title, or null when unrated. */
  rating: number | null;
}

/** YouTube events grouped by channel (`parent_title`). */
export interface ReviewChannel {
  name: string;
  count: number;
}

/** One month bucket ("2026-01"), zeros filled for empty months. */
export interface ReviewMonth {
  month: string;
  minutes: number;
  count: number;
}

/** One local day ("YYYY-MM-DD"). */
export interface ReviewDay {
  date: string;
  minutes: number;
  count: number;
}

/** Earliest / latest event of the year. */
export interface ReviewMoment {
  title: string;
  source: string;
  /** UTC ISO as stored. */
  started_at: string;
}

/** Result of `GET /api/year-review` (one calendar year summarised). */
export interface YearReview {
  year: number;
  /** True when today is inside this year. */
  partial: boolean;
  /** Whole year (365/366), Jan 1..today when partial, 0 for a future year. */
  days_in_range: number;
  /** Every local year with at least one event, newest first. */
  available_years: number[];
  totals: ReviewTotals;
  /** The year before, null when it has no events. */
  previous: ReviewTotals | null;
  by_source: Record<string, ReviewTotals>;
  by_media_type: Record<string, { items: number; minutes: number }>;
  /** Always 12 entries Jan..Dec, zeros filled. */
  by_month: ReviewMonth[];
  /** Always 7 entries, 1 = Monday .. 7 = Sunday, zeros filled. */
  by_weekday: { weekday: number; minutes: number; count: number }[];
  /** Max 10, by minutes desc, then count desc, then title asc. */
  top_titles: ReviewTitle[];
  /** Max 10, YouTube only, by count desc, then name asc. */
  top_channels: ReviewChannel[];
  /** By minutes, then count; tie -> earliest date. */
  busiest_day: ReviewDay | null;
  /** Same rule as `busiest_day`, null when the year is empty. */
  busiest_month: ReviewMonth | null;
  longest_streak: { days: number; start: string | null; end: string | null };
  first: ReviewMoment | null;
  last: ReviewMoment | null;
}

export interface InProgressItem {
  id: number;
  source: string;
  title: string | null;
  parent_title: string | null;
  progress: number | null;
  started_at: string;
  /** `/api/cover/<abs_item>` for ABS items, else null. */
  cover_url: string | null;
}

/** Which field of a group matched the search query. */
export type MatchField = "title" | "series" | "parent" | "channel";

/** One grouped result of `GET /api/search`. */
export interface SearchHit {
  /** Stable id of the group (opaque; pass back to `/api/title-history`). */
  key: string;
  title: string;
  source: string;
  media_type: string | null;
  /** Which fields matched (deduped, in the order title/series/parent/channel). */
  matched: MatchField[];
  /** parent_title (author / channel) of the most recent event, or null. */
  subtitle: string | null;
  count: number;
  minutes: number;
  /** Local "YYYY-MM-DD" of the earliest event. */
  first_date: string;
  /** Local "YYYY-MM-DD" of the latest event. */
  last_date: string;
  cover_url: string | null;
}

/** Result of `GET /api/search`. */
export interface SearchResult {
  query: string;
  /** Number of hits before limit/offset. */
  total: number;
  hits: SearchHit[];
}

export interface SearchParams {
  q: string;
  source?: string;
  media_type?: string;
  category?: CategoryListParam;
  exclude?: CategoryListParam;
  limit?: number;
  offset?: number;
}

/** One event in a title's full history. */
export interface TitleHistoryItem {
  id: number;
  started_at: string;
  /** Local "YYYY-MM-DD". */
  local_date: string;
  /** Local "HH:mm". */
  local_time: string;
  media_type: string | null;
  season: number | null;
  episode: number | null;
  minutes: number;
  /** The raw event title (e.g. YouTube video / episode name). */
  event_title: string | null;
}

/** Result of `GET /api/title-history` (full history of one search hit). */
export interface TitleHistory {
  key: string;
  title: string;
  source: string;
  subtitle: string | null;
  cover_url: string | null;
  count: number;
  minutes: number;
  /** Newest first, capped at 500 (count/minutes still cover all events). */
  items: TitleHistoryItem[];
  /** Latest rating (1–10) for this title, or null when unrated. */
  rating: number | null;
}

/** One item in the in-progress or finished progress list. */
export interface ProgressItem {
  id: number;
  source: string;
  title: string | null;
  parent_title: string | null;
  /** Fraction 0..1, or null when the source gave no progress value. */
  progress: number | null;
  is_finished: boolean;
  /** UTC ISO of the latest progress update. */
  last_update: string;
  /** UTC ISO when the item was finished, or null when unknown. */
  finished_at: string | null;
  /** `/api/cover/<abs_item>` for ABS items, else null. */
  cover_url: string | null;
  /** Latest rating (1–10) for this item's title group, or null when unrated. */
  rating: number | null;
  /**
   * The title group the rating/annotation belongs to (`getSeriesOrTitle` of
   * the underlying event). Use `(source, group_title)` as the annotation key.
   */
  group_title: string;
}

export interface ProgressLists {
  in_progress: ProgressItem[];
  finished: ProgressItem[];
}

/** Body accepted by `POST /api/events` (manual entry). */
export interface ManualEventInput {
  media_type: string;
  title: string;
  parent_title?: string | null;
  season?: number | null;
  episode?: number | null;
  /** Local wall-clock time in the configured timezone (or explicit offset/Z). */
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  progress?: number | null;
  device?: string | null;
  external_ids?: Record<string, unknown> | null;
  /**
   * Idempotency key for this entry. The server stores it as the row's
   * `source_id` (`client:<uuid>`), so sending the same body again — a retry
   * after a lost response — never creates a second row.
   */
  client_id?: string;
}

export interface AddEventResult {
  id: string;
  inserted: number;
}

export interface ImportSkipCounts {
  ads: number;
  no_video: number;
  other: number;
  invalid: number;
}

export interface ImportResult {
  /** Which importer handled the upload. */
  kind?: "native" | "youtube-takeout";
  seen: number;
  inserted: number;
  /** Only for a YouTube Takeout upload: records in the JSON array. */
  records?: number;
  /** Only for a YouTube Takeout upload: counts per skip reason. */
  skipped?: ImportSkipCounts;
  /** Only for a native JSON import: goal and annotation counts. */
  goals?: { seen: number; inserted: number };
  annotations?: { seen: number; inserted: number };
  runId: number;
}

/** One Audiobookshelf sync run, as returned by `GET /api/sync/status`. */
export interface SyncRun {
  source: string;
  started_at: string;
  finished_at: string | null;
  rows_seen: number;
  rows_inserted: number;
  error: string | null;
}

export interface SyncStatusResult {
  runs: SyncRun[];
}

/** Result of `POST /api/sync/audiobookshelf`. */
export interface SyncNowResult {
  runId: number;
  seen: number;
  inserted: number;
}

/** Result of `POST /api/sync/simkl`. */
export interface SimklSyncResult extends SyncNowResult {
  mode: string;
}

export interface HealthResult {
  ok: boolean;
}

// --- Core helpers ----------------------------------------------------------

/** Why a request failed: the network (or a timeout), or an HTTP error status. */
export type ApiErrorKind = "network" | "http";

/**
 * Error thrown by the API helpers. `kind` lets callers tell a network failure
 * or timeout (`"network"`, `status` is `null`) apart from a non-2xx response
 * (`"http"`, with the status code and the server's error message).
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status code, or `null` for network failures and timeouts. */
  readonly status: number | null;

  constructor(kind: ApiErrorKind, status: number | null, message: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error !== "") {
      message = body.error;
    }
  } catch {
    // Non-JSON error body: keep the status-based fallback message.
  }
  return new ApiError("http", res.status, message);
}

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw await apiErrorFromResponse(res);
  }
  return (await res.json()) as T;
}

/** GET `path`, parse the JSON body as `T`, throw on non-2xx. */
export function getJson<T>(path: string): Promise<T> {
  return fetch(path).then((res) => parseResponse<T>(res));
}

/** POST `body` as JSON to `path`, parse the JSON body as `T`, throw on non-2xx. */
export function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => parseResponse<T>(res));
}

/** POST multipart `form` to `path`, parse the JSON body as `T`, throw on non-2xx. */
export function postForm<T>(path: string, form: FormData): Promise<T> {
  // Let the browser set `Content-Type` including the multipart boundary.
  return fetch(path, {
    method: "POST",
    body: form,
  }).then((res) => parseResponse<T>(res));
}

/** Append only the defined, non-empty params, preserving insertion order. */
function withQuery(
  path: string,
  params: Record<string, string | undefined>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, value);
    }
  }
  const qs = search.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

/** Format a category or exclusion filter (single string or array) as a comma-separated query param. */
function formatCategoryList(
  value: CategoryListParam | undefined
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((c) => String(c).trim())
      .filter((c) => c !== "")
      .join(",");
    return joined === "" ? undefined : joined;
  }
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

export interface CategoryFilterOptions {
  source?: string;
  category?: CategoryListParam;
  exclude?: CategoryListParam;
}

// --- Typed endpoint wrappers ----------------------------------------------

export function getHealth(): Promise<HealthResult> {
  return getJson<HealthResult>("/api/health");
}

export function getCalendar(
  month: string,
  sourceOrOptions?: string | CategoryFilterOptions
): Promise<CalendarResult> {
  const opts: CategoryFilterOptions =
    typeof sourceOrOptions === "string"
      ? { source: sourceOrOptions }
      : sourceOrOptions ?? {};
  return getJson<CalendarResult>(
    withQuery("/api/calendar", {
      month,
      source: opts.source,
      category: formatCategoryList(opts.category),
      exclude: formatCategoryList(opts.exclude),
    })
  );
}

export function getHeatmapDays(
  year: string,
  sourceOrOptions?: string | CategoryFilterOptions
): Promise<HeatmapDaysResult> {
  const opts: CategoryFilterOptions =
    typeof sourceOrOptions === "string"
      ? { source: sourceOrOptions }
      : sourceOrOptions ?? {};
  return getJson<HeatmapDaysResult>(
    withQuery("/api/heatmap/days", {
      year,
      source: opts.source,
      category: formatCategoryList(opts.category),
      exclude: formatCategoryList(opts.exclude),
    })
  );
}

export function getHeatmapHours(
  year?: string,
  sourceOrOptions?: string | CategoryFilterOptions
): Promise<HeatmapHoursResult> {
  const opts: CategoryFilterOptions =
    typeof sourceOrOptions === "string"
      ? { source: sourceOrOptions }
      : sourceOrOptions ?? {};
  return getJson<HeatmapHoursResult>(
    withQuery("/api/heatmap/hours", {
      year,
      source: opts.source,
      category: formatCategoryList(opts.category),
      exclude: formatCategoryList(opts.exclude),
    })
  );
}

export function getStats(
  paramsOrSource?: StatsParams | string
): Promise<StatsResult> {
  const params: StatsParams =
    typeof paramsOrSource === "string"
      ? { source: paramsOrSource }
      : paramsOrSource ?? {};
  return getJson<StatsResult>(
    withQuery("/api/stats", {
      from: params.from,
      to: params.to,
      source: params.source,
      category: formatCategoryList(params.category),
      exclude: formatCategoryList(params.exclude),
    })
  );
}

export function getInsights(
  sourceOrOptions?: string | CategoryFilterOptions
): Promise<InsightsResult> {
  const opts: CategoryFilterOptions =
    typeof sourceOrOptions === "string"
      ? { source: sourceOrOptions }
      : sourceOrOptions ?? {};
  return getJson<InsightsResult>(
    withQuery("/api/insights", {
      source: opts.source,
      category: formatCategoryList(opts.category),
      exclude: formatCategoryList(opts.exclude),
    })
  );
}

export function getYearReview(
  year?: number,
  sourceOrOptions?: string | CategoryFilterOptions
): Promise<YearReview> {
  const opts: CategoryFilterOptions =
    typeof sourceOrOptions === "string"
      ? { source: sourceOrOptions }
      : sourceOrOptions ?? {};
  return getJson<YearReview>(
    withQuery("/api/year-review", {
      year: year !== undefined ? String(year) : undefined,
      source: opts.source,
      category: formatCategoryList(opts.category),
      exclude: formatCategoryList(opts.exclude),
    })
  );
}

export function getInProgress(): Promise<InProgressItem[]> {
  return getJson<InProgressItem[]>("/api/in-progress");
}

export function search(params: SearchParams): Promise<SearchResult> {
  return getJson<SearchResult>(
    withQuery("/api/search", {
      q: params.q,
      source: params.source,
      media_type: params.media_type,
      category: formatCategoryList(params.category),
      exclude: formatCategoryList(params.exclude),
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      offset: params.offset !== undefined ? String(params.offset) : undefined,
    })
  );
}

export function getTitleHistory(key: string): Promise<TitleHistory> {
  // The key is opaque and can contain any characters: always URL-encode it.
  return getJson<TitleHistory>(withQuery("/api/title-history", { key }));
}

export function getProgress(source?: string): Promise<ProgressLists> {
  return getJson<ProgressLists>(withQuery("/api/progress", { source }));
}

export interface AddEventOptions {
  /** Abort the request after this many milliseconds (default 10 000). */
  timeoutMs?: number;
}

/**
 * POST one manual entry to `/api/events`.
 *
 * Aborts with a network `ApiError` after `timeoutMs` (default 10 s) and turns
 * non-2xx responses into `ApiError`s carrying the status and the server's
 * error message, so callers can decide between retrying and showing the
 * problem to the user.
 */
export async function addEvent(
  body: ManualEventInput,
  options: AddEventOptions = {}
): Promise<AddEventResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (caught) {
      if (controller.signal.aborted) {
        throw new ApiError(
          "network",
          null,
          `Request timed out after ${timeoutMs} ms`
        );
      }
      throw new ApiError(
        "network",
        null,
        `Could not reach the server: ${
          caught instanceof Error ? caught.message : String(caught)
        }`
      );
    }
    if (!res.ok) {
      throw await apiErrorFromResponse(res);
    }
    return (await res.json()) as AddEventResult;
  } catch (caught) {
    if (caught instanceof ApiError) {
      throw caught;
    }
    // e.g. `res.json()` failed on a truncated body: retrying is safe.
    throw new ApiError(
      "network",
      null,
      `Could not read the server response: ${
        caught instanceof Error ? caught.message : String(caught)
      }`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function importFile(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  // Let the browser set `Content-Type` including the multipart boundary.
  const res = await fetch("/api/import", { method: "POST", body: form });
  if (res.status === 413) {
    throw new Error(
      "File too large for upload. On the server run: bun run it import youtube-takeout <file>"
    );
  }
  return parseResponse<ImportResult>(res);
}

export function getSyncStatus(): Promise<SyncStatusResult> {
  return getJson<SyncStatusResult>("/api/sync/status");
}

export function syncNow(): Promise<SyncNowResult> {
  return postJson<SyncNowResult>("/api/sync/audiobookshelf", {});
}

export function syncSimklNow(): Promise<SimklSyncResult> {
  return postJson<SimklSyncResult>("/api/sync/simkl", {});
}

// --- Goals (F8) ------------------------------------------------------------

export type GoalMetric = "items" | "hours" | "titles" | "active_days";
export type GoalStatus =
  | "done"
  | "on_track"
  | "behind"
  | "missed"
  | "not_started";

export interface GoalProgress {
  current: number;
  target: number;
  percent: number;
  expected: number;
  status: GoalStatus;
}

export interface Goal {
  goal_id: string;
  year: number;
  metric: GoalMetric;
  source: string | null;
  media_type: string | null;
  target: number;
  archived: number;
  created_at: string;
  progress: GoalProgress;
}

export interface GoalsResult {
  year: number;
  goals: Goal[];
}

export interface SaveGoalInput {
  goal_id?: string;
  rev_id?: string;
  year: number;
  metric: GoalMetric;
  source?: string | null;
  media_type?: string | null;
  target: number;
  archived?: number;
}

export interface SaveGoalResult {
  goal_id: string;
  rev_id: string;
  inserted: boolean;
}

export function getGoals(
  year?: number,
  options?: { archived?: boolean | number; date?: string }
): Promise<GoalsResult> {
  const params: Record<string, string | undefined> = {};
  if (year !== undefined) {
    params.year = String(year);
  }
  if (options?.archived) {
    params.archived = "1";
  }
  if (options?.date) {
    params.date = options.date;
  }
  return getJson<GoalsResult>(withQuery("/api/goals", params));
}

export function saveGoal(body: SaveGoalInput): Promise<SaveGoalResult> {
  const rev_id = body.rev_id ?? crypto.randomUUID();
  return postJson<SaveGoalResult>("/api/goals", {
    ...body,
    rev_id,
  });
}

/** One annotation revision: the current rating + note of a title. */
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

/** What `GET /api/annotations` returns for a title nobody annotated yet. */
export interface EmptyAnnotation {
  rating: null;
  note: null;
}

export interface SaveAnnotationInput {
  source: string;
  title: string;
  rating?: number | null;
  note?: string | null;
  rev_id?: string;
}

export interface SaveAnnotationResult {
  rev_id: string;
  inserted: boolean;
  annotation: Annotation;
}

/** Latest annotation for one title (the Search grouping key). */
export function getAnnotation(
  source: string,
  title: string
): Promise<Annotation | EmptyAnnotation> {
  return getJson<Annotation | EmptyAnnotation>(
    withQuery("/api/annotations", { source, title })
  );
}

/**
 * Save a new annotation revision. A `rev_id` is generated once per call;
 * pass an explicit one and reuse it when retrying a save so the retry
 * inserts nothing.
 */
export function saveAnnotation(
  body: SaveAnnotationInput
): Promise<SaveAnnotationResult> {
  const rev_id = body.rev_id ?? crypto.randomUUID();
  return postJson<SaveAnnotationResult>("/api/annotations", {
    ...body,
    rev_id,
  });
}

// --- V2 API: Metadata Lookup, Archive, Library, Reviews, Settings ----------

export interface LookupSearchParams {
  q: string;
  category?: Category | "any";
}

/**
 * Search external metadata providers (`GET /api/lookup/search`).
 * Accepts either `(q, category?)` or `({ q, category? })`.
 */
export function lookupSearch(
  qOrParams: string | LookupSearchParams,
  category?: Category | "any"
): Promise<LookupSearchResult> {
  const params: LookupSearchParams =
    typeof qOrParams === "string"
      ? { q: qOrParams, category }
      : qOrParams;
  return getJson<LookupSearchResult>(
    withQuery("/api/lookup/search", {
      q: params.q,
      category: params.category,
    })
  );
}

/**
 * Fetch full details for one work from a metadata provider
 * (`GET /api/lookup/work/:provider/:id`).
 */
export function lookupWork(
  provider: MetaProvider | string,
  id: string
): Promise<WorkDetails> {
  return getJson<WorkDetails>(
    `/api/lookup/work/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`
  );
}

/**
 * Create or update an archive entry (`POST /api/archive`).
 * Re-sending with the same `entry_id` updates the entry's units.
 */
export function saveArchiveEntry(
  body: ArchiveRequest
): Promise<ArchiveResult> {
  return postJson<ArchiveResult>("/api/archive", body);
}

export interface DeleteArchiveResult {
  entry_id?: string;
  deleted?: number;
  ok?: boolean;
}

/**
 * Delete an archive entry by writing tombstones for every unit
 * (`POST /api/archive/:entry_id/delete`).
 */
export function deleteArchiveEntry(
  entryId: string
): Promise<DeleteArchiveResult> {
  return postJson<DeleteArchiveResult>(
    `/api/archive/${encodeURIComponent(entryId)}/delete`,
    {}
  );
}

/**
 * List archive entries, newest first (`GET /api/archive?category=`).
 */
export function listArchive(
  categoryOrParams?:
    | CategoryListParam
    | { category?: CategoryListParam; exclude?: CategoryListParam }
): Promise<ArchiveEntrySummary[]> {
  const opts: { category?: CategoryListParam; exclude?: CategoryListParam } =
    typeof categoryOrParams === "string" || Array.isArray(categoryOrParams)
      ? { category: categoryOrParams }
      : (categoryOrParams as {
          category?: CategoryListParam;
          exclude?: CategoryListParam;
        }) ?? {};
  return getJson<ArchiveEntrySummary[]>(
    withQuery("/api/archive", {
      category: formatCategoryList(opts.category),
      exclude: formatCategoryList(opts.exclude),
    })
  );
}

export type LibrarySort = "recent" | "time" | "title";

export interface LibraryParams {
  category?: CategoryListParam;
  exclude?: CategoryListParam;
  q?: string;
  sort?: LibrarySort;
}

/**
 * Fetch the unified library (`GET /api/library?category=&exclude=&q=&sort=`).
 */
export function getLibrary(
  paramsOrCategory?: LibraryParams | CategoryListParam
): Promise<LibraryResult> {
  const params: LibraryParams =
    typeof paramsOrCategory === "string" || Array.isArray(paramsOrCategory)
      ? { category: paramsOrCategory }
      : (paramsOrCategory as LibraryParams) ?? {};
  return getJson<LibraryResult>(
    withQuery("/api/library", {
      category: formatCategoryList(params.category),
      exclude: formatCategoryList(params.exclude),
      q: params.q || undefined,
      sort: params.sort || undefined,
    })
  );
}

/**
 * Fetch full details, season progress, and history for one library work
 * (`GET /api/library/work?key=`).
 */
export function getLibraryWork(key: string): Promise<LibraryWorkDetail> {
  return getJson<LibraryWorkDetail>(
    withQuery("/api/library/work", { key })
  );
}

export interface SeriesParams {
  bucket: "day" | "week" | "month";
  from?: string;
  to?: string;
  category?: CategoryListParam;
  exclude?: CategoryListParam;
}

/**
 * Fetch stacked category time series (`GET /api/series?bucket=&from=&to=&category=&exclude=`).
 */
export function getSeries(params: SeriesParams): Promise<SeriesResult> {
  return getJson<SeriesResult>(
    withQuery("/api/series", {
      bucket: params.bucket,
      from: params.from,
      to: params.to,
      category: formatCategoryList(params.category),
      exclude: formatCategoryList(params.exclude),
    })
  );
}

export interface ReviewFilterOptions {
  category?: CategoryListParam;
  exclude?: CategoryListParam;
}

/**
 * Fetch a monthly review (`GET /api/review/month?month=YYYY-MM[&category=&exclude=]`).
 */
export function getMonthReview(
  month?: string,
  options?: ReviewFilterOptions
): Promise<MonthReview> {
  return getJson<MonthReview>(
    withQuery("/api/review/month", {
      month,
      category: formatCategoryList(options?.category),
      exclude: formatCategoryList(options?.exclude),
    })
  );
}

/**
 * Fetch a v2 yearly review built from the twelve months (`GET /api/review/year?year=YYYY[&category=&exclude=]`).
 */
export function getYearReviewV2(
  year?: number | string,
  options?: ReviewFilterOptions
): Promise<YearReviewV2> {
  return getJson<YearReviewV2>(
    withQuery("/api/review/year", {
      year: year !== undefined && year !== "" ? String(year) : undefined,
      category: formatCategoryList(options?.category),
      exclude: formatCategoryList(options?.exclude),
    })
  );
}

/**
 * Fetch read-only settings and source status (`GET /api/settings`).
 */
export function getSettings(): Promise<SettingsView> {
  return getJson<SettingsView>("/api/settings");
}

// --- V2.1 API: Work Edits, Hidden Works, YouTube, Achriom Import -----------

/**
 * Apply a partial override to a library work (`POST /api/library/work/edit?key=`).
 * Returns the updated `LibraryWorkDetail`.
 */
export function editWork(
  key: string,
  edit: WorkEdit
): Promise<LibraryWorkDetail> {
  return postJson<LibraryWorkDetail>(
    withQuery("/api/library/work/edit", { key }),
    edit
  );
}

/**
 * List hidden works (`GET /api/library/hidden`).
 */
export function getHiddenWorks(): Promise<HiddenWorksResult> {
  return getJson<HiddenWorksResult>("/api/library/hidden");
}

export interface YoutubeOverviewParams {
  from?: string;
  to?: string;
}

/**
 * Fetch YouTube overview by topic and channel (`GET /api/youtube?from=&to=`).
 */
export function getYoutubeOverview(
  params: YoutubeOverviewParams = {}
): Promise<YoutubeOverview> {
  return getJson<YoutubeOverview>(
    withQuery("/api/youtube", {
      from: params.from,
      to: params.to,
    })
  );
}

export interface YoutubeVideosParams {
  channel?: string;
  topic?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * Fetch filtered YouTube videos (`GET /api/youtube/videos?channel=&topic=&from=&to=&q=&limit=&offset=`).
 */
export function getYoutubeVideos(
  params: YoutubeVideosParams = {}
): Promise<YoutubeVideosResult> {
  return getJson<YoutubeVideosResult>(
    withQuery("/api/youtube/videos", {
      channel: params.channel,
      topic: params.topic,
      from: params.from,
      to: params.to,
      q: params.q,
      limit: params.limit !== undefined ? String(params.limit) : undefined,
      offset: params.offset !== undefined ? String(params.offset) : undefined,
    })
  );
}

export interface SetChannelTopicResult {
  ok?: boolean;
  channel: string;
  topic: string | null;
}

/**
 * Set or clear the user topic for a YouTube channel (`POST /api/youtube/channel-topic`).
 */
export function setChannelTopic(
  channel: string,
  topic: string | null
): Promise<SetChannelTopicResult> {
  return postJson<SetChannelTopicResult>("/api/youtube/channel-topic", {
    channel,
    topic,
  });
}

export interface ImportAchriomOptions {
  dryRun?: boolean;
}

/**
 * Upload an Achriom library export `.zip` or `.csv` (`POST /api/import/achriom[?dry_run=1]`).
 */
export function importAchriom(
  file: File,
  options: ImportAchriomOptions = {}
): Promise<AchriomImportResult> {
  const form = new FormData();
  form.append("file", file);
  const path = withQuery("/api/import/achriom", {
    dry_run: options.dryRun ? "1" : undefined,
  });
  return postForm<AchriomImportResult>(path, form);
}


