/**
 * InputTracker Hono HTTP Application.
 *
 * Exposes data over HTTP with local-timezone aggregation.
 * No server listening here; `createApp` returns a configured `Hono` instance.
 */

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { redactString, type Config } from "../core/config.ts";
import { LocalDbSink, type Sink } from "../core/sink.ts";
import { exportCsv } from "../io/export-csv.ts";
import { exportJson } from "../io/export-json.ts";
import { detectFormat, importNative } from "../io/import-native.ts";
import { addManual, type ManualInput } from "../io/manual.ts";
import { VALID_MEDIA_TYPES } from "../core/events.ts";
import { createAbsClient } from "../sources/audiobookshelf/client.ts";
import {
  importYoutubeTakeout,
  looksLikeTakeout,
} from "../sources/youtube/takeout.ts";
import {
  syncAudiobookshelf,
  SyncFailedError,
  type AbsSyncResult,
  type SyncAbsDeps,
  type SyncClient,
} from "../sources/audiobookshelf/sync.ts";
import { createSimklClient } from "../sources/simkl/client.ts";
import {
  isSimklAuthorised,
  isSimklConfigured,
  syncSimkl,
  type SimklSyncResult,
  type SyncSimklClient,
  type SyncSimklDeps,
} from "../sources/simkl/sync.ts";
import {
  readSimklToken,
  simklTokenPath,
  type SimklToken,
} from "../sources/simkl/token.ts";
import {
  formatLocalParts,
  getCalendar,
  getHeatmapDays,
  getHeatmapHours,
  getInProgress,
  getProgressLists,
  getStats,
} from "./aggregate.ts";
import { getInsights } from "./insights.ts";
import { getYearReview } from "./year-review.ts";
import {
  addGoalRevision,
  getGoals,
  GoalNotFoundError,
  type AddGoalInput,
} from "./goals.ts";
import {
  AnnotationValidationError,
  getAnnotation,
  saveAnnotation,
  type SaveAnnotationInput,
} from "./annotations.ts";
import { getTitleHistory, search } from "./search.ts";
import { getCover, isValidCoverId, prefetchCovers } from "./covers.ts";
import { getSimklPoster, isValidSimklPoster } from "./posters.ts";
import { getYoutubeThumb, isValidYoutubeVideoId } from "./thumbs.ts";
import { handleYoutubePlays } from "./ingest.ts";

export interface AppDeps {
  db: Database;
  config: Config;
  webDist?: string;
  /**
   * Injectable Audiobookshelf sync; defaults to the real `syncAudiobookshelf`.
   * Tests use this so no network access is ever attempted.
   */
  syncAudiobookshelf?: (deps: SyncAbsDeps) => Promise<AbsSyncResult>;
  /** Injectable ABS client factory so tests never hit the network. */
  createAbsClient?: (config: Config) => SyncClient;
  /** Injectable Simkl sync; defaults to the real `syncSimkl`. */
  syncSimkl?: (deps: SyncSimklDeps) => Promise<SimklSyncResult>;
  /** Injectable Simkl client factory so tests never hit the network. */
  createSimklClient?: (config: Config["simkl"]) => SyncSimklClient;
  /** Injectable token reader for Simkl auth check. */
  readSimklToken?: (path: string) => SimklToken | null;
  /**
   * Injectable fetch for remote image proxying (Simkl posters); defaults to the
   * global `fetch`. Tests use this so no network access is ever attempted.
   */
  fetchImage?: typeof fetch;
  /** Injectable sink factory; defaults to a `LocalDbSink`. */
  sinkFor?: (db: Database) => Sink;
  /** Wall clock for the ingest 5-minute-future check; defaults to `Date.now()`. */
  nowMs?: () => number;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isValidDateStr(str: string): boolean {
  if (!DATE_RE.test(str)) {
    return false;
  }
  const parts = str.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Audiobookshelf is usable only when both a URL and a token are configured.
 * The token is non-enumerable on `Config`, but readable here.
 */
function isAbsConfigured(config: Config): boolean {
  const abs = config.audiobookshelf;
  if (!abs) {
    return false;
  }
  const url = typeof abs.url === "string" ? abs.url.trim() : "";
  const token = typeof abs.token === "string" ? abs.token.trim() : "";
  return url !== "" && token !== "";
}

function validateQueryParams(
  urlStr: string,
  allowed: readonly string[]
): string | null {
  const url = new URL(urlStr);
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) {
      return `Unknown query parameter: '${key}'`;
    }
  }
  return null;
}

export function createApp(deps: AppDeps): Hono {
  const { db, config } = deps;
  const tz = config.timezone;
  const webDist = resolve(deps.webDist ?? "web/dist");

  /** Guards against overlapping Audiobookshelf syncs from the same server. */
  let absSyncRunning = false;
  /** Guards against overlapping Simkl syncs from the same server. */
  let simklSyncRunning = false;

  const app = new Hono();

  // GET /api/health
  app.get("/api/health", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }
    return c.json({ ok: true });
  });

  // GET /api/calendar?month=YYYY-MM[&source=...]
  app.get("/api/calendar", (c) => {
    const err = validateQueryParams(c.req.url, ["month", "source"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const month = c.req.query("month");
    if (!month) {
      return c.json({ error: "Missing required query parameter: month" }, 400);
    }
    if (!MONTH_RE.test(month)) {
      return c.json(
        { error: `Invalid month format: '${month}' (expected YYYY-MM)` },
        400
      );
    }

    const source = c.req.query("source") || undefined;
    const result = getCalendar(db, month, tz, source);
    return c.json(result);
  });

  // GET /api/heatmap/days?year=YYYY[&source=...]
  app.get("/api/heatmap/days", (c) => {
    const err = validateQueryParams(c.req.url, ["year", "source"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const year = c.req.query("year");
    if (!year) {
      return c.json({ error: "Missing required query parameter: year" }, 400);
    }
    if (!YEAR_RE.test(year)) {
      return c.json(
        { error: `Invalid year format: '${year}' (expected YYYY)` },
        400
      );
    }

    const source = c.req.query("source") || undefined;
    const result = getHeatmapDays(db, year, tz, source);
    return c.json(result);
  });

  // GET /api/heatmap/hours?[year=YYYY][&source=...]
  app.get("/api/heatmap/hours", (c) => {
    const err = validateQueryParams(c.req.url, ["year", "source"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const year = c.req.query("year");
    if (year !== undefined && !YEAR_RE.test(year)) {
      return c.json(
        { error: `Invalid year format: '${year}' (expected YYYY)` },
        400
      );
    }

    const source = c.req.query("source") || undefined;
    const result = getHeatmapHours(db, year || undefined, tz, source);
    return c.json(result);
  });

  // GET /api/stats[?from=YYYY-MM-DD][&to=YYYY-MM-DD][&source=...]
  app.get("/api/stats", (c) => {
    const err = validateQueryParams(c.req.url, ["from", "to", "source"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const from = c.req.query("from") || undefined;
    if (from !== undefined && !isValidDateStr(from)) {
      return c.json(
        { error: `Invalid from date format: '${from}' (expected YYYY-MM-DD)` },
        400
      );
    }

    const to = c.req.query("to") || undefined;
    if (to !== undefined && !isValidDateStr(to)) {
      return c.json(
        { error: `Invalid to date format: '${to}' (expected YYYY-MM-DD)` },
        400
      );
    }

    const source = c.req.query("source") || undefined;
    const result = getStats(db, { from, to, source, tz });
    return c.json(result);
  });

  // GET /api/insights[?source=][&date=YYYY-MM-DD] — streaks + "On this day".
  // `date` overrides "today" (mainly for tests); it defaults to the current
  // local day in the configured timezone.
  app.get("/api/insights", (c) => {
    const err = validateQueryParams(c.req.url, ["source", "date"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const date = c.req.query("date") || undefined;
    if (date !== undefined && !isValidDateStr(date)) {
      return c.json(
        { error: `Invalid date format: '${date}' (expected YYYY-MM-DD)` },
        400
      );
    }

    const source = c.req.query("source") || undefined;
    const today = date ?? formatLocalParts(new Date().toISOString(), tz).date;
    const result = getInsights(db, { tz, today, source });
    return c.json(result);
  });

  // GET /api/year-review?year=YYYY[&source=...][&date=YYYY-MM-DD] — one year
  // of consumption summarised. `year` defaults to the current local year;
  // `date` overrides "today" (mainly for tests); `source` filters everything,
  // including `available_years`.
  app.get("/api/year-review", (c) => {
    const err = validateQueryParams(c.req.url, ["year", "source", "date"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const date = c.req.query("date") || undefined;
    if (date !== undefined && !isValidDateStr(date)) {
      return c.json(
        { error: `Invalid date format: '${date}' (expected YYYY-MM-DD)` },
        400
      );
    }

    const today = date ?? formatLocalParts(new Date().toISOString(), tz).date;
    const yearRaw = c.req.query("year");
    if (yearRaw !== undefined && !YEAR_RE.test(yearRaw)) {
      return c.json(
        { error: `Invalid year format: '${yearRaw}' (expected YYYY)` },
        400
      );
    }
    const year = yearRaw !== undefined ? Number(yearRaw) : Number(today.slice(0, 4));

    const source = c.req.query("source") || undefined;
    const result = getYearReview(db, { tz, year, today, source });
    return c.json(result);
  });

  // GET /api/goals?year=YYYY[&date=YYYY-MM-DD][&archived=1]
  app.get("/api/goals", (c) => {
    const err = validateQueryParams(c.req.url, ["year", "date", "archived"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const date = c.req.query("date") || undefined;
    if (date !== undefined && !isValidDateStr(date)) {
      return c.json(
        { error: `Invalid date format: '${date}' (expected YYYY-MM-DD)` },
        400
      );
    }

    const today = date ?? formatLocalParts(new Date().toISOString(), tz).date;
    const yearRaw = c.req.query("year");
    if (yearRaw !== undefined && !YEAR_RE.test(yearRaw)) {
      return c.json(
        { error: `Invalid year format: '${yearRaw}' (expected YYYY)` },
        400
      );
    }
    const year =
      yearRaw !== undefined ? Number(yearRaw) : Number(today.slice(0, 4));

    const archivedParam = c.req.query("archived");
    const includeArchived = archivedParam === "1";

    const goals = getGoals(db, {
      year,
      tz,
      today,
      includeArchived,
    });

    return c.json({ year, goals });
  });

  // POST /api/goals
  app.post("/api/goals", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (caught) {
      return c.json(
        {
          error: `Invalid JSON body: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        },
        400
      );
    }

    try {
      const result = addGoalRevision(db, body as AddGoalInput);
      return c.json(result, 201);
    } catch (caught) {
      if (caught instanceof GoalNotFoundError) {
        return c.json({ error: caught.message }, 404);
      }
      return c.json(
        { error: caught instanceof Error ? caught.message : String(caught) },
        400
      );
    }
  });

  // GET /api/annotations?source=&title= — latest rating + note for one
  // title (the Search grouping: `source` + `getSeriesOrTitle(event)`).
  // Returns `{ rating: null, note: null }` when the title has no annotation.
  app.get("/api/annotations", (c) => {
    const err = validateQueryParams(c.req.url, ["source", "title"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const source = c.req.query("source");
    if (source === undefined || source === "") {
      return c.json({ error: "Missing required query parameter: source" }, 400);
    }
    const title = c.req.query("title");
    if (title === undefined || title === "") {
      return c.json({ error: "Missing required query parameter: title" }, 400);
    }

    try {
      return c.json(getAnnotation(db, source, title));
    } catch (caught) {
      if (caught instanceof AnnotationValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });

  // POST /api/annotations — save a new annotation revision
  // (`{ source, title, rating, note, rev_id? }`). Every save is a new row;
  // clearing the rating or note is a new row with `NULL`s. A retried save
  // reuses its `rev_id` and inserts nothing.
  app.post("/api/annotations", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (caught) {
      return c.json(
        {
          error: `Invalid JSON body: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        },
        400
      );
    }

    try {
      const result = saveAnnotation(db, body as SaveAnnotationInput);
      return c.json(result, 201);
    } catch (caught) {
      if (caught instanceof AnnotationValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });

  // GET /api/search?q=&source=&media_type=&limit=&offset= — read-only search
  // over titles, series, authors and YouTube channels. `q` is required (too
  // short queries return an empty result, not an error); limit defaults to 30.
  app.get("/api/search", (c) => {
    const err = validateQueryParams(c.req.url, [
      "q",
      "source",
      "media_type",
      "limit",
      "offset",
    ]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const q = c.req.query("q");
    if (q === undefined || q === "") {
      return c.json({ error: "Missing required query parameter: q" }, 400);
    }
    if (q.length > 200) {
      return c.json(
        { error: `Invalid q: too long (${q.length} characters, max 200)` },
        400
      );
    }

    const source = c.req.query("source") || undefined;
    const mediaType = c.req.query("media_type") || undefined;
    if (mediaType !== undefined && !VALID_MEDIA_TYPES.has(mediaType)) {
      return c.json({ error: `Invalid media_type: '${mediaType}'` }, 400);
    }

    const limitRaw = c.req.query("limit");
    let limit = 30;
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) {
        return c.json(
          { error: `Invalid limit: '${limitRaw}' (expected integer 1..100)` },
          400
        );
      }
      limit = Number(limitRaw);
    }

    const offsetRaw = c.req.query("offset");
    let offset = 0;
    if (offsetRaw !== undefined) {
      if (!/^\d+$/.test(offsetRaw)) {
        return c.json(
          { error: `Invalid offset: '${offsetRaw}' (expected a non-negative integer)` },
          400
        );
      }
      offset = Number(offsetRaw);
    }

    const result = search(db, { tz, q, source, media_type: mediaType, limit, offset });
    return c.json(result);
  });

  // GET /api/title-history?key= — full history of one search hit, read-only.
  app.get("/api/title-history", (c) => {
    const err = validateQueryParams(c.req.url, ["key"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const key = c.req.query("key");
    if (key === undefined || key === "") {
      return c.json({ error: "Missing required query parameter: key" }, 400);
    }
    if (key.length > 500) {
      return c.json(
        { error: `Invalid key: too long (${key.length} characters, max 500)` },
        400
      );
    }

    const result = getTitleHistory(db, { tz, key });
    if (result === null) {
      return c.json({ error: "No title matches the given key" }, 404);
    }
    return c.json(result);
  });

  // GET /api/in-progress[?source=]
  app.get("/api/in-progress", (c) => {
    const err = validateQueryParams(c.req.url, ["source"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const source = c.req.query("source") || undefined;
    const result = getInProgress(db, source);
    return c.json(result);
  });

  // GET /api/progress[?source=] — in-progress + finished media_progress lists
  app.get("/api/progress", (c) => {
    const err = validateQueryParams(c.req.url, ["source"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const source = c.req.query("source") || undefined;
    const result = getProgressLists(db, source);
    return c.json(result);
  });

  // GET /api/cover/:itemId — proxy (and cache) an Audiobookshelf cover.
  // The token/URL stay server-side: the body is image bytes and the headers
  // only ever carry a normalized `image/*` content type.
  app.get("/api/cover/:itemId", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const itemId = c.req.param("itemId");
    if (!isValidCoverId(itemId)) {
      return c.json({ error: "Invalid item id" }, 400);
    }

    const cover = await getCover(itemId, {
      config,
      createAbsClient: deps.createAbsClient,
    });
    if (cover === null) {
      return c.json({ error: "Cover not available" }, 404);
    }

    return new Response(cover.bytes, {
      status: 200,
      headers: {
        "Content-Type": cover.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  // GET /api/poster/simkl/:dir/:name — proxy (and cache) a Simkl poster.
  // The path is re-validated here, so a malformed value never causes a fetch.
  app.get("/api/poster/simkl/:dir/:name", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const path = `${c.req.param("dir")}/${c.req.param("name")}`;
    if (!isValidSimklPoster(path)) {
      return c.json({ error: "Invalid poster path" }, 400);
    }

    const poster = await getSimklPoster(path, {
      config,
      fetch: deps.fetchImage ?? fetch,
    });
    if (poster === null) {
      return c.json({ error: "Poster not available" }, 404);
    }

    return new Response(poster.bytes, {
      status: 200,
      headers: {
        "Content-Type": poster.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  // Any other /api/poster/simkl/... shape is invalid; reject without fetching.
  app.all("/api/poster/simkl/*", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }
    return c.json({ error: "Invalid poster path" }, 400);
  });

  // GET /api/thumb/youtube/:videoId — proxy (and cache) a YouTube thumbnail.
  // The video id is re-validated here, so a malformed value never causes a fetch.
  app.get("/api/thumb/youtube/:videoId", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const videoId = c.req.param("videoId");
    if (!isValidYoutubeVideoId(videoId)) {
      return c.json({ error: "Invalid video id" }, 400);
    }

    const thumb = await getYoutubeThumb(videoId, {
      config,
      fetch: deps.fetchImage ?? fetch,
    });
    if (thumb === null) {
      return c.json({ error: "Thumbnail not available" }, 404);
    }

    return new Response(thumb.bytes, {
      status: 200,
      headers: {
        "Content-Type": thumb.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  // Any other /api/thumb/youtube/... shape is invalid; reject without fetching.
  app.all("/api/thumb/youtube/*", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }
    return c.json({ error: "Invalid video id" }, 400);
  });

  // GET /api/export.json
  app.get("/api/export.json", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const text = exportJson(db);
    return c.text(text, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="inputtracker-export.json"',
    });
  });

  // GET /api/export.csv
  app.get("/api/export.csv", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const text = exportCsv(db);
    return c.text(text, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="inputtracker-export.csv"',
    });
  });

  // POST /api/import
  app.post("/api/import", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch (caught) {
      return c.json(
        { error: `Bad form data: ${caught instanceof Error ? caught.message : String(caught)}` },
        400
      );
    }

    const file = body["file"];
    if (!file) {
      return c.json({ error: "Missing required 'file' in multipart form" }, 400);
    }

    let text: string;
    let filename = "";

    if (typeof file === "string") {
      text = file;
    } else if (file instanceof Blob || typeof (file as { text?: unknown }).text === "function") {
      text = await (file as Blob).text();
      if ("name" in (file as object) && typeof (file as { name: unknown }).name === "string") {
        filename = (file as { name: string }).name;
      }
    } else {
      return c.json({ error: "Invalid file uploaded" }, 400);
    }

    const format = detectFormat(filename) ?? detectFormat(text);

    if (looksLikeTakeout(text)) {
      try {
        const result = importYoutubeTakeout(db, text);
        return c.json({ kind: "youtube-takeout", ...result });
      } catch (caught) {
        return c.json(
          { error: caught instanceof Error ? caught.message : String(caught) },
          400
        );
      }
    }

    if (format === null) {
      return c.json(
        { error: "Could not infer format (expected json or csv)" },
        400
      );
    }

    try {
      const result = importNative(db, text, format);
      return c.json({ kind: "native", ...result });
    } catch (caught) {
      return c.json(
        { error: caught instanceof Error ? caught.message : String(caught) },
        400
      );
    }
  });

  // POST /api/events
  app.post("/api/events", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (caught) {
      return c.json(
        { error: `Invalid JSON body: ${caught instanceof Error ? caught.message : String(caught)}` },
        400
      );
    }

    try {
      const result = addManual(db, body as ManualInput, tz);
      return c.json({ id: result.id, inserted: result.inserted }, 201);
    } catch (caught) {
      return c.json(
        { error: caught instanceof Error ? caught.message : String(caught) },
        400
      );
    }
  });

  // POST /api/sync/audiobookshelf
  app.post("/api/sync/audiobookshelf", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    if (!isAbsConfigured(config)) {
      return c.json(
        {
          error:
            "Audiobookshelf is not configured (set audiobookshelf.url and audiobookshelf.token)",
        },
        400
      );
    }

    if (absSyncRunning) {
      return c.json({ error: "An Audiobookshelf sync is already running" }, 409);
    }

    absSyncRunning = true;
    try {
      const doSync = deps.syncAudiobookshelf ?? syncAudiobookshelf;
      const makeClient =
        deps.createAbsClient ?? ((cfg: Config) => createAbsClient(cfg));
      const sink = (deps.sinkFor ?? ((database: Database) => new LocalDbSink(database)))(
        db
      );
      const client = makeClient(config);
      const result = await doSync({ client, sink, db, config });
      // Cache covers while the items still exist on the server (never throws).
      await prefetchCovers(db, result.runId, {
        config,
        createAbsClient: deps.createAbsClient,
      });
      return c.json({
        runId: result.runId,
        seen: result.seen,
        inserted: result.inserted,
      });
    } catch (caught) {
      // `SyncFailedError.message` is already redacted by the sync module;
      // applying `redactString` again guards against a raw token in any other
      // error reaching the client.
      const message =
        caught instanceof SyncFailedError ? caught.message : errorText(caught);
      return c.json({ error: redactString(message, config) }, 502);
    } finally {
      absSyncRunning = false;
    }
  });

  // POST /api/sync/simkl
  app.post("/api/sync/simkl", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    if (!isSimklConfigured(config)) {
      return c.json(
        {
          error:
            "Simkl is not configured (set simkl.client_id in inputtracker.config.toml)",
        },
        400
      );
    }

    const tokenReader = deps.readSimklToken ?? readSimklToken;
    if (!isSimklAuthorised(config, tokenReader)) {
      return c.json(
        {
          error:
            "Simkl is not authorised (run: bun run it auth simkl)",
        },
        400
      );
    }

    if (simklSyncRunning) {
      return c.json({ error: "A Simkl sync is already running" }, 409);
    }

    simklSyncRunning = true;
    try {
      const doSync = deps.syncSimkl ?? syncSimkl;
      const makeClient =
        deps.createSimklClient ??
        ((cfg: Config["simkl"]) => {
          const tokenPath = simklTokenPath(config);
          return createSimklClient(cfg, {
            tokenPath,
            readToken: () => tokenReader(tokenPath),
          });
        });
      const sink = (deps.sinkFor ?? ((database: Database) => new LocalDbSink(database)))(
        db
      );
      const client = makeClient(config.simkl);
      const result = await doSync({ client, sink, db, config });
      return c.json({
        runId: result.runId,
        seen: result.seen,
        inserted: result.inserted,
        mode: result.mode,
      });
    } catch (caught) {
      const raw =
        caught instanceof SyncFailedError ? caught.message : errorText(caught);
      let message = raw.replace(/\b(?:simkl_at_|simkl_rt_)[A-Za-z0-9_\-]+\b/gi, "***");
      message = redactString(message, config);
      return c.json({ error: message }, 502);
    } finally {
      simklSyncRunning = false;
    }
  });

  // POST /api/ingest/youtube-plays — token-protected ingest from the phone.
  // The handler covers disabled/disabled-token, auth and validation; only the
  // query-parameter check (the first check per the contract) lives here.
  app.post("/api/ingest/youtube-plays", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }
    return handleYoutubePlays(c, { db, config, nowMs: deps.nowMs });
  });

  // GET /api/sync/status — latest run per source (read-only)
  app.get("/api/sync/status", (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const runs = db
      .query<
        {
          source: string;
          started_at: string;
          finished_at: string | null;
          rows_seen: number;
          rows_inserted: number;
          error: string | null;
        },
        []
      >(
        `SELECT source, started_at, finished_at, rows_seen, rows_inserted, error
         FROM ingest_runs
         WHERE id IN (SELECT MAX(id) FROM ingest_runs GROUP BY source)
         ORDER BY source ASC;`
      )
      .all();

    return c.json({ runs });
  });

  // Fallback for unknown /api routes
  app.all("/api", (c) => {
    return c.json({ error: "Not found" }, 404);
  });
  app.all("/api/*", (c) => {
    return c.json({ error: "Not found" }, 404);
  });

  // Static files and SPA fallback for non-API routes
  app.get("*", (c) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!existsSync(webDist) || !statSync(webDist).isDirectory()) {
      return c.text("Not found", 404);
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(c.req.path);
    } catch {
      return c.text("Bad request", 400);
    }

    // Path traversal check
    if (decoded.includes("\0")) {
      return c.text("Forbidden", 403);
    }

    const rel = decoded.replace(/^\/+/, "");
    const target = resolve(webDist, rel);

    if (!target.startsWith(webDist + sep) && target !== webDist) {
      return c.text("Forbidden", 403);
    }

    // Direct file
    if (existsSync(target)) {
      const stat = statSync(target);
      if (stat.isFile()) {
        // Service-worker scripts must never be served stale, otherwise the
        // browser can keep running an old caching strategy.
        if (rel === "sw.js") {
          return new Response(Bun.file(target), {
            headers: { "Cache-Control": "no-cache" },
          });
        }
        return new Response(Bun.file(target));
      }
      if (stat.isDirectory()) {
        const indexFile = join(target, "index.html");
        if (existsSync(indexFile) && statSync(indexFile).isFile()) {
          return new Response(Bun.file(indexFile));
        }
      }
    }

    // SPA fallback
    const spaIndex = join(webDist, "index.html");
    if (existsSync(spaIndex) && statSync(spaIndex).isFile()) {
      return new Response(Bun.file(spaIndex));
    }

    return c.text("Not found", 404);
  });

  return app;
}
