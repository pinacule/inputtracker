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
  getCalendar,
  getHeatmapDays,
  getHeatmapHours,
  getInProgress,
  getProgressLists,
  getStats,
} from "./aggregate.ts";
import { getCover, isValidCoverId, prefetchCovers } from "./covers.ts";

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
  /** Injectable sink factory; defaults to a `LocalDbSink`. */
  sinkFor?: (db: Database) => Sink;
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
