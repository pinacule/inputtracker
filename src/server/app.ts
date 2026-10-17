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
import type { Config } from "../core/config.ts";
import { exportCsv } from "../io/export-csv.ts";
import { exportJson } from "../io/export-json.ts";
import { detectFormat, importNative } from "../io/import-native.ts";
import { addManual, type ManualInput } from "../io/manual.ts";
import {
  getCalendar,
  getHeatmapDays,
  getHeatmapHours,
  getInProgress,
  getStats,
} from "./aggregate.ts";

export interface AppDeps {
  db: Database;
  config: Config;
  webDist?: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

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

  // GET /api/stats[?source=]
  app.get("/api/stats", (c) => {
    const err = validateQueryParams(c.req.url, ["source"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const source = c.req.query("source") || undefined;
    const result = getStats(db, source);
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
    if (format === null) {
      return c.json(
        { error: "Could not infer format (expected json or csv)" },
        400
      );
    }

    try {
      const result = importNative(db, text, format);
      return c.json(result);
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
