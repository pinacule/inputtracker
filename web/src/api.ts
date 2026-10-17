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
}

export interface MonthStatBucket {
  month: string; // "2026-10"
  by_source: Record<string, number>;
  minutes: number;
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

export interface InProgressItem {
  id: number;
  source: string;
  title: string | null;
  parent_title: string | null;
  progress: number | null;
  started_at: string;
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

export interface ImportResult {
  seen: number;
  inserted: number;
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

export function getInProgress(): Promise<InProgressItem[]> {
  return getJson<InProgressItem[]>("/api/in-progress");
}

export function addEvent(body: ManualEventInput): Promise<AddEventResult> {
  return postJson<AddEventResult>("/api/events", body);
}

export function importFile(file: File): Promise<ImportResult> {
  const form = new FormData();
  form.append("file", file);
  return postForm<ImportResult>("/api/import", form);
}

export function getSyncStatus(): Promise<SyncStatusResult> {
  return getJson<SyncStatusResult>("/api/sync/status");
}

export function syncNow(): Promise<SyncNowResult> {
  return postJson<SyncNowResult>("/api/sync/audiobookshelf", {});
}
