/**
 * Typed fetch helpers for the InputTracker HTTP API.
 *
 * All requests use relative `/api/...` paths so the same build works in the
 * Vite dev server (proxied to the Hono server) and in production (served from
 * the same origin). Response types mirror the routes in `src/server/app.ts`.
 *
 * On a non-2xx response the server's `{ error }` message is thrown as an
 * `Error`; otherwise the JSON body is parsed and returned.
 */

// --- Response types (mirror src/server/app.ts) -----------------------------

export interface CalendarItem {
  id: number;
  source: string;
  media_type: string;
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

async function parseResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === "string" && body.error !== "") {
        message = body.error;
      }
    } catch {
      // Non-JSON error body: keep the status-based fallback message.
    }
    throw new Error(message);
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

// --- Typed endpoint wrappers ----------------------------------------------

export function getHealth(): Promise<HealthResult> {
  return getJson<HealthResult>("/api/health");
}

export function getCalendar(
  month: string,
  source?: string
): Promise<CalendarResult> {
  return getJson<CalendarResult>(
    withQuery("/api/calendar", { month, source })
  );
}

export function getHeatmapDays(
  year: string,
  source?: string
): Promise<HeatmapDaysResult> {
  return getJson<HeatmapDaysResult>(
    withQuery("/api/heatmap/days", { year, source })
  );
}

export function getHeatmapHours(
  year?: string,
  source?: string
): Promise<HeatmapHoursResult> {
  return getJson<HeatmapHoursResult>(
    withQuery("/api/heatmap/hours", { year, source })
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
    })
  );
}

export function getInsights(source?: string): Promise<InsightsResult> {
  return getJson<InsightsResult>(withQuery("/api/insights", { source }));
}

export function getYearReview(
  year?: number,
  source?: string
): Promise<YearReview> {
  return getJson<YearReview>(
    withQuery("/api/year-review", {
      year: year !== undefined ? String(year) : undefined,
      source,
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

export function addEvent(body: ManualEventInput): Promise<AddEventResult> {
  return postJson<AddEventResult>("/api/events", body);
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

