/**
 * End-to-end smoke test runner (`bun run smoke`).
 *
 * Verifies the complete application lifecycle:
 * 1. Web build (Vite SPA)
 * 2. Fake Audiobookshelf API server (GET-only, bearer authenticated)
 * 3. Configuration generation in a temporary directory
 * 4. Real server process launch and health polling
 * 5. Audiobookshelf sync, idempotency, and status checks
 * 6. Manual event creation
 * 7. Aggregation routes (calendar, heatmaps, stats, in-progress, progress lists)
 * 8. Cover retrieval, proxying, and on-disk caching
 * 9. Archive export and round-trip import (JSON and CSV)
 * 10. Web application root HTML and PWA manifest serving
 * 11. CLI export and backup commands against the real database
 * 12. Simkl auth, sync, posters and idempotency against a fake Simkl server
 * 13. YouTube Takeout import, calendar/stats views and thumbnail caching
 * 14. Cross-source duplicate display (manual + Simkl pair shown once,
 *     both raw rows kept in the export)
 * 15. Goals: create, progress counting, and edit as a new latest revision
 * 16. Ratings and notes: annotations create/edit with latest-wins reads
 * 17. Export v2: version, goals + annotations revisions, and a second
 *     import that reports 0 new rows
 * 18. Guaranteed cleanup of temporary directories and background processes
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Server, Subprocess } from "bun";
import { APP_VERSION } from "../src/core/version.ts";

const FAKE_TOKEN = "smoke-token";
const FAKE_SIMKL_DEVICE_CODE = "smoke-simkl-device-code";
const FAKE_SIMKL_ACCESS_TOKEN = "simkl_at_smokefake1234567890abcdef";
const FAKE_SIMKL_REFRESH_TOKEN = "simkl_rt_smokefake1234567890abcdef";

interface CheckFailure {
  name: string;
  status?: number;
  details: string;
}

const failures: CheckFailure[] = [];
let passedCount = 0;

function redact(text: string, tmpDir?: string): string {
  let out = text.replaceAll(FAKE_TOKEN, "***");
  out = out.replaceAll(FAKE_SIMKL_DEVICE_CODE, "***");
  out = out.replaceAll(FAKE_SIMKL_ACCESS_TOKEN, "***");
  out = out.replaceAll(FAKE_SIMKL_REFRESH_TOKEN, "***");
  if (tmpDir) {
    out = out.replaceAll(tmpDir, "<temp-dir>");
  }
  return out;
}

function recordPass(name: string): void {
  console.log(`ok   ${name}`);
  passedCount++;
}

function recordFail(
  name: string,
  details: string,
  status?: number,
  tmpDir?: string
): void {
  const statusPart = status !== undefined ? ` (HTTP ${status})` : "";
  const safeDetails = redact(details, tmpDir);
  console.log(`FAIL ${name}${statusPart} — ${safeDetails}`);
  failures.push({ name, status, details: safeDetails });
}

async function main(): Promise<void> {
  // 1. Setup temporary directory
  const tmpDir = mkdtempSync(join(tmpdir(), "it-smoke-"));
  const tempConfigPath = join(tmpDir, "inputtracker.config.toml");
  const dbPath = join(tmpDir, "inputtracker.db");
  const backupDir = join(tmpDir, "backups");

  let fakeAbsServer: Server<unknown> | null = null;
  let fakeSimklServer: Server<unknown> | null = null;
  let fakeImageServer: Server<unknown> | null = null;
  let serverProc: Subprocess | null = null;
  const serverStderrLines: string[] = [];

  // Fake Audiobookshelf tracking
  let fakeAbsTotalRequests = 0;
  let fakeAbsCoverFetches = 0;
  const fakeAbsNonGetRequests: { method: string; url: string }[] = [];
  const fakeAbsAuthFailures: { auth: string | null; url: string }[] = [];

  try {
    // 2. Build web assets first
    mkdirSync("node_modules", { recursive: true });
    const buildProc = Bun.spawn(["bun", "run", "build:web"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const buildExit = await buildProc.exited;
    if (buildExit === 0) {
      recordPass("build:web");
    } else {
      const buildErr = await new Response(buildProc.stderr).text();
      recordFail("build:web", buildErr.slice(0, 300), undefined, tmpDir);
      throw new Error(`Web build failed with exit code ${buildExit}`);
    }

    // 3. Start fake Audiobookshelf server
    const meJson = readFileSync("test/fixtures/abs/me.json", "utf8");
    const sessionsPage0Json = readFileSync(
      "test/fixtures/abs/sessions-page0.json",
      "utf8"
    );
    const listeningStatsJson = readFileSync(
      "test/fixtures/abs/listening-stats.json",
      "utf8"
    );
    // 1x1 transparent PNG
    const tinyPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex"
    );

    fakeAbsServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        fakeAbsTotalRequests++;

        if (req.method !== "GET") {
          fakeAbsNonGetRequests.push({ method: req.method, url: req.url });
          return new Response("Method Not Allowed", { status: 405 });
        }

        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${FAKE_TOKEN}`) {
          fakeAbsAuthFailures.push({ auth, url: req.url });
          return new Response("Unauthorized", { status: 401 });
        }

        const url = new URL(req.url);
        const path = url.pathname;

        if (path === "/api/me") {
          return new Response(meJson, {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (path === "/api/me/listening-sessions") {
          const page = url.searchParams.get("page");
          if (!page || page === "0") {
            return new Response(sessionsPage0Json, {
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              total: 2,
              numPages: 1,
              page: Number(page),
              itemsPerPage: 10,
              sessions: [],
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }

        if (path === "/api/me/listening-stats") {
          return new Response(listeningStatsJson, {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (/^\/api\/items\/[A-Za-z0-9_-]+\/cover$/.test(path)) {
          fakeAbsCoverFetches++;
          return new Response(tinyPng, {
            headers: { "Content-Type": "image/png" },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    // 3b. Start fake Simkl server
    const simklDeviceCodeFixture = JSON.parse(
      readFileSync("test/fixtures/simkl/device-code.json", "utf8")
    );
    const simklDeviceResponse = JSON.stringify({
      ...simklDeviceCodeFixture,
      device_code: FAKE_SIMKL_DEVICE_CODE,
      interval: 1,
    });
    const simklActivitiesJson = readFileSync(
      "test/fixtures/simkl/activities.json",
      "utf8"
    );
    const simklAllItemsJson = readFileSync(
      "test/fixtures/simkl/all-items.json",
      "utf8"
    );
    const simklAllItems = JSON.parse(simklAllItemsJson) as {
      shows?: unknown[];
      movies?: unknown[];
      anime?: unknown[];
    };

    interface RecordedSimklRequest {
      method: string;
      url: string;
      path: string;
      query: Record<string, string>;
      headers: Record<string, string>;
      status: number;
    }
    const fakeSimklRequests: RecordedSimklRequest[] = [];
    let simklTokenPollCount = 0;

    fakeSimklServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const query: Record<string, string> = {};
        for (const [k, v] of url.searchParams.entries()) {
          query[k] = v;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of req.headers.entries()) {
          headers[k.toLowerCase()] = v;
        }

        let status = 200;
        let response: Response;

        if (req.method === "POST" && path === "/oauth2/device") {
          status = 200;
          response = new Response(simklDeviceResponse, {
            status,
            headers: { "Content-Type": "application/json" },
          });
        } else if (req.method === "POST" && path === "/oauth2/token") {
          simklTokenPollCount++;
          if (simklTokenPollCount === 1) {
            status = 400;
            response = new Response(
              JSON.stringify({ error: "authorization_pending" }),
              {
                status,
                headers: { "Content-Type": "application/json" },
              }
            );
          } else {
            status = 200;
            response = new Response(
              JSON.stringify({
                access_token: FAKE_SIMKL_ACCESS_TOKEN,
                token_type: "Bearer",
                expires_in: 604800,
                refresh_token: FAKE_SIMKL_REFRESH_TOKEN,
                scope: "media:read",
              }),
              {
                status,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
        } else if (req.method === "GET" && path === "/sync/activities") {
          status = 200;
          response = new Response(simklActivitiesJson, {
            status,
            headers: { "Content-Type": "application/json" },
          });
        } else if (req.method === "GET" && path === "/sync/all-items/shows") {
          status = 200;
          response = new Response(
            JSON.stringify({ shows: simklAllItems.shows ?? [] }),
            {
              status,
              headers: { "Content-Type": "application/json" },
            }
          );
        } else if (req.method === "GET" && path === "/sync/all-items/movies") {
          status = 200;
          response = new Response(
            JSON.stringify({ movies: simklAllItems.movies ?? [] }),
            {
              status,
              headers: { "Content-Type": "application/json" },
            }
          );
        } else if (req.method === "GET" && path === "/sync/all-items/anime") {
          status = 200;
          response = new Response(
            JSON.stringify({ anime: simklAllItems.anime ?? [] }),
            {
              status,
              headers: { "Content-Type": "application/json" },
            }
          );
        } else if (req.method === "GET" && path === "/sync/all-items") {
          status = 200;
          response = new Response(
            JSON.stringify({ shows: [], movies: [], anime: [] }),
            {
              status,
              headers: { "Content-Type": "application/json" },
            }
          );
        } else {
          status = 404;
          response = new Response("Not Found", { status: 404 });
        }

        fakeSimklRequests.push({
          method: req.method,
          url: req.url,
          path,
          query,
          headers,
          status,
        });

        return response;
      },
    });

    // 3c. Start fake Image server for posters and thumbnails
    interface RecordedImageRequest {
      method: string;
      url: string;
      path: string;
      headers: Record<string, string>;
    }
    const fakeImageRequests: RecordedImageRequest[] = [];
    const fakeImageRequestsPerPath = new Map<string, number>();

    fakeImageServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const headers: Record<string, string> = {};
        for (const [k, v] of req.headers.entries()) {
          headers[k.toLowerCase()] = v;
        }

        fakeImageRequests.push({
          method: req.method,
          url: req.url,
          path,
          headers,
        });
        fakeImageRequestsPerPath.set(
          path,
          (fakeImageRequestsPerPath.get(path) ?? 0) + 1
        );

        if (req.method !== "GET") {
          return new Response("Method Not Allowed", { status: 405 });
        }

        if (path.startsWith("/posters/") && path.endsWith("_m.webp")) {
          return new Response(tinyPng, {
            headers: { "Content-Type": "image/webp" },
          });
        }

        if (path.startsWith("/vi/") && path.endsWith("/mqdefault.jpg")) {
          return new Response(tinyPng, {
            headers: { "Content-Type": "image/jpeg" },
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    // 4. Reserve a free port for the InputTracker server
    const portProbe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response();
      },
    });
    const serverPort = portProbe.port;
    portProbe.stop(true);

    // 5. Write temporary config file
    const tomlContent = [
      'timezone = "Europe/Bratislava"',
      "",
      "[server]",
      'bind = "127.0.0.1"',
      `port = ${serverPort}`,
      "",
      "[storage]",
      `db_path = "${dbPath}"`,
      `backup_dir = "${backupDir}"`,
      "backup_keep = 14",
      "",
      "[audiobookshelf]",
      `url = "http://127.0.0.1:${fakeAbsServer.port}"`,
      `token = "${FAKE_TOKEN}"`,
      "timeout_s = 20",
      "",
      "[simkl]",
      'client_id = "smoke-fake-client-id"',
      `base_url = "http://127.0.0.1:${fakeSimklServer.port}"`,
      `poster_base_url = "http://127.0.0.1:${fakeImageServer.port}/posters"`,
      "timeout_s = 20",
      "",
      "[youtube]",
      `thumb_base_url = "http://127.0.0.1:${fakeImageServer.port}/vi"`,
      "",
      "[notify]",
      "desktop = false",
      'ntfy_url = ""',
      "",
    ].join("\n");
    await Bun.write(tempConfigPath, tomlContent);

    // 6. Spawn the real server process
    serverProc = Bun.spawn(["bun", "run", "src/server/main.ts"], {
      env: {
        ...process.env,
        INPUTTRACKER_CONFIG: tempConfigPath,
        XDG_DATA_HOME: tmpDir,
        XDG_CONFIG_HOME: tmpDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Capture stderr in a ring buffer
    (async () => {
      if (
        serverProc &&
        serverProc.stderr &&
        typeof serverProc.stderr !== "number"
      ) {
        const reader = serverProc.stderr.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              serverStderrLines.push(line);
              if (serverStderrLines.length > 50) {
                serverStderrLines.shift();
              }
            }
          }
          if (buf) {
            serverStderrLines.push(buf);
          }
        } catch {
          // ignore stream close
        }
      }
    })();

    // Drain stdout to prevent pipe blockage
    (async () => {
      if (
        serverProc &&
        serverProc.stdout &&
        typeof serverProc.stdout !== "number"
      ) {
        const reader = serverProc.stdout.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          // ignore stream close
        }
      }
    })();

    // Poll server health until responsive
    const pollStart = Date.now();
    const timeoutMs = 15000;
    let healthy = false;
    while (Date.now() - pollStart < timeoutMs) {
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean } | null;
          if (body?.ok === true) {
            healthy = true;
            break;
          }
        }
      } catch {
        // server still starting up
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!healthy) {
      recordFail(
        "server startup",
        "Server failed to become healthy within 15s",
        undefined,
        tmpDir
      );
      throw new Error("Server failed health check timeout");
    }

    const baseUrl = `http://127.0.0.1:${serverPort}`;

    // 7. Test API endpoints

    // GET /api/health
    {
      const res = await fetch(`${baseUrl}/api/health`);
      const body = (await res.json()) as { ok?: boolean } | null;
      if (res.status === 200 && body?.ok === true) {
        recordPass("GET /api/health");
      } else {
        recordFail(
          "GET /api/health",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // POST /api/sync/audiobookshelf (first run)
    {
      const res = await fetch(`${baseUrl}/api/sync/audiobookshelf`, {
        method: "POST",
      });
      const body = (await res.json()) as {
        runId?: number;
        seen?: number;
        inserted?: number;
      } | null;
      if (
        res.status === 200 &&
        typeof body?.inserted === "number" &&
        body.inserted > 0
      ) {
        recordPass("POST /api/sync/audiobookshelf");
      } else {
        recordFail(
          "POST /api/sync/audiobookshelf",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/sync/status
    {
      const res = await fetch(`${baseUrl}/api/sync/status`);
      const body = (await res.json()) as {
        runs?: {
          source: string;
          error: string | null;
          rows_inserted: number;
        }[];
      } | null;
      const absRun = body?.runs?.find((r) => r.source === "audiobookshelf");
      if (
        res.status === 200 &&
        absRun &&
        absRun.error === null &&
        absRun.rows_inserted > 0
      ) {
        recordPass("GET /api/sync/status");
      } else {
        recordFail(
          "GET /api/sync/status",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // POST /api/sync/audiobookshelf (second run, idempotent 0 inserted)
    {
      const res = await fetch(`${baseUrl}/api/sync/audiobookshelf`, {
        method: "POST",
      });
      const body = (await res.json()) as {
        runId?: number;
        seen?: number;
        inserted?: number;
      } | null;
      if (res.status === 200 && body?.inserted === 0) {
        recordPass("POST /api/sync/audiobookshelf (idempotent second run)");
      } else {
        recordFail(
          "POST /api/sync/audiobookshelf (idempotent second run)",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // POST /api/events (manual entry)
    {
      const manualPayload = {
        media_type: "book",
        title: "Smoke Test Book",
        started_at: "2025-10-17 14:00",
        duration_seconds: 1800,
      };
      const res = await fetch(`${baseUrl}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manualPayload),
      });
      const body = (await res.json()) as {
        id?: string;
        inserted?: number;
      } | null;
      if (
        res.status === 201 &&
        body?.inserted === 1 &&
        typeof body?.id === "string"
      ) {
        recordPass("POST /api/events (manual entry)");
      } else {
        recordFail(
          "POST /api/events (manual entry)",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/calendar?month=2025-10
    {
      const res = await fetch(`${baseUrl}/api/calendar?month=2025-10`);
      const body = (await res.json()) as {
        month?: string;
        days?: {
          date: string;
          items: { title: string | null; source: string }[];
        }[];
      } | null;
      const day = body?.days?.find((d) => d.date === "2025-10-17");
      const hasManual = day?.items?.some(
        (it) => it.title === "Smoke Test Book" && it.source === "manual"
      );
      const hasAbs = day?.items?.some(
        (it) =>
          it.title === "The Synthetic Tale" && it.source === "audiobookshelf"
      );
      if (res.status === 200 && day && hasManual && hasAbs) {
        recordPass("GET /api/calendar?month=2025-10");
      } else {
        recordFail(
          "GET /api/calendar?month=2025-10",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/calendar?month=2025-10&source=audiobookshelf
    {
      const res = await fetch(
        `${baseUrl}/api/calendar?month=2025-10&source=audiobookshelf`
      );
      const body = (await res.json()) as {
        month?: string;
        days?: {
          date: string;
          items: { title: string | null; source: string }[];
        }[];
      } | null;
      const day = body?.days?.find((d) => d.date === "2025-10-17");
      const hasManual = day?.items?.some(
        (it) => it.title === "Smoke Test Book"
      );
      const hasAbs = day?.items?.some(
        (it) =>
          it.title === "The Synthetic Tale" && it.source === "audiobookshelf"
      );
      if (res.status === 200 && day && !hasManual && hasAbs) {
        recordPass("GET /api/calendar?month=2025-10&source=audiobookshelf");
      } else {
        recordFail(
          "GET /api/calendar?month=2025-10&source=audiobookshelf",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/heatmap/days?year=2025
    {
      const res = await fetch(`${baseUrl}/api/heatmap/days?year=2025`);
      const body = (await res.json()) as {
        year?: string;
        days?: { date: string; count: number }[];
      } | null;
      const day = body?.days?.find((d) => d.date === "2025-10-17");
      if (res.status === 200 && body?.year === "2025" && day && day.count >= 3) {
        recordPass("GET /api/heatmap/days?year=2025");
      } else {
        recordFail(
          "GET /api/heatmap/days?year=2025",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/heatmap/days?year=2025&source=audiobookshelf
    {
      const res = await fetch(
        `${baseUrl}/api/heatmap/days?year=2025&source=audiobookshelf`
      );
      const body = (await res.json()) as {
        year?: string;
        days?: { date: string; count: number }[];
      } | null;
      const day = body?.days?.find((d) => d.date === "2025-10-17");
      if (res.status === 200 && body?.year === "2025" && day && day.count >= 2) {
        recordPass("GET /api/heatmap/days?year=2025&source=audiobookshelf");
      } else {
        recordFail(
          "GET /api/heatmap/days?year=2025&source=audiobookshelf",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/heatmap/hours?year=2025
    {
      const res = await fetch(`${baseUrl}/api/heatmap/hours?year=2025`);
      const body = (await res.json()) as {
        cells?: { count: number; hour: number; weekday: number }[];
      } | null;
      const hasActiveCell = body?.cells?.some((c) => c.count > 0);
      if (res.status === 200 && Array.isArray(body?.cells) && hasActiveCell) {
        recordPass("GET /api/heatmap/hours?year=2025");
      } else {
        recordFail(
          "GET /api/heatmap/hours?year=2025",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/heatmap/hours?year=2025&source=audiobookshelf
    {
      const res = await fetch(
        `${baseUrl}/api/heatmap/hours?year=2025&source=audiobookshelf`
      );
      const body = (await res.json()) as {
        cells?: { count: number; hour: number; weekday: number }[];
      } | null;
      const hasActiveCell = body?.cells?.some((c) => c.count > 0);
      if (res.status === 200 && Array.isArray(body?.cells) && hasActiveCell) {
        recordPass("GET /api/heatmap/hours?year=2025&source=audiobookshelf");
      } else {
        recordFail(
          "GET /api/heatmap/hours?year=2025&source=audiobookshelf",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/stats
    {
      const res = await fetch(`${baseUrl}/api/stats`);
      const body = (await res.json()) as {
        total_items?: number;
        by_source?: Record<string, { count: number }>;
      } | null;
      if (
        res.status === 200 &&
        typeof body?.total_items === "number" &&
        body.total_items >= 3 &&
        body.by_source?.manual &&
        body.by_source?.audiobookshelf
      ) {
        recordPass("GET /api/stats");
      } else {
        recordFail(
          "GET /api/stats",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/stats?source=audiobookshelf
    {
      const res = await fetch(`${baseUrl}/api/stats?source=audiobookshelf`);
      const body = (await res.json()) as {
        total_items?: number;
        by_source?: Record<string, { count: number }>;
      } | null;
      if (
        res.status === 200 &&
        typeof body?.total_items === "number" &&
        body.total_items >= 2 &&
        body.by_source?.audiobookshelf &&
        !body.by_source?.manual
      ) {
        recordPass("GET /api/stats?source=audiobookshelf");
      } else {
        recordFail(
          "GET /api/stats?source=audiobookshelf",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/in-progress
    {
      const res = await fetch(`${baseUrl}/api/in-progress`);
      const body = (await res.json()) as unknown[] | null;
      if (res.status === 200 && Array.isArray(body) && body.length > 0) {
        recordPass("GET /api/in-progress");
      } else {
        recordFail(
          "GET /api/in-progress",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/in-progress?source=audiobookshelf
    {
      const res = await fetch(
        `${baseUrl}/api/in-progress?source=audiobookshelf`
      );
      const body = (await res.json()) as unknown[] | null;
      if (res.status === 200 && Array.isArray(body) && body.length > 0) {
        recordPass("GET /api/in-progress?source=audiobookshelf");
      } else {
        recordFail(
          "GET /api/in-progress?source=audiobookshelf",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/progress
    {
      const res = await fetch(`${baseUrl}/api/progress`);
      const body = (await res.json()) as {
        in_progress?: unknown[];
        finished?: unknown[];
      } | null;
      if (
        res.status === 200 &&
        Array.isArray(body?.in_progress) &&
        body.in_progress.length > 0 &&
        Array.isArray(body?.finished) &&
        body.finished.length > 0
      ) {
        recordPass("GET /api/progress");
      } else {
        recordFail(
          "GET /api/progress",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/progress?source=audiobookshelf
    {
      const res = await fetch(`${baseUrl}/api/progress?source=audiobookshelf`);
      const body = (await res.json()) as {
        in_progress?: unknown[];
        finished?: unknown[];
      } | null;
      if (
        res.status === 200 &&
        Array.isArray(body?.in_progress) &&
        body.in_progress.length > 0 &&
        Array.isArray(body?.finished) &&
        body.finished.length > 0
      ) {
        recordPass("GET /api/progress?source=audiobookshelf");
      } else {
        recordFail(
          "GET /api/progress?source=audiobookshelf",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // GET /api/cover/item-fake-book-1 (initial fetch and cache check)
    let coverHeadersClean = true;
    {
      const fetchesBefore = fakeAbsCoverFetches;
      const res1 = await fetch(`${baseUrl}/api/cover/item-fake-book-1`);
      const bytes1 = new Uint8Array(await res1.arrayBuffer());

      for (const [key, val] of res1.headers.entries()) {
        if (
          key.toLowerCase().includes(FAKE_TOKEN) ||
          val.toLowerCase().includes(FAKE_TOKEN)
        ) {
          coverHeadersClean = false;
        }
      }

      if (
        res1.status === 200 &&
        res1.headers.get("content-type")?.startsWith("image/") &&
        bytes1.length > 0 &&
        fetchesBefore >= 1 &&
        fakeAbsCoverFetches === fetchesBefore
      ) {
        recordPass("GET /api/cover/item-fake-book-1 (first fetch)");
      } else {
        recordFail(
          "GET /api/cover/item-fake-book-1 (first fetch)",
          `status=${res1.status}, bytes=${bytes1.length}, fetchesBefore=${fetchesBefore}, fetches=${fakeAbsCoverFetches}`,
          res1.status,
          tmpDir
        );
      }

      // Second request: must be served from cache without fetching from ABS again
      const fetchesBeforeSecond = fakeAbsCoverFetches;
      const res2 = await fetch(`${baseUrl}/api/cover/item-fake-book-1`);
      const bytes2 = new Uint8Array(await res2.arrayBuffer());

      for (const [key, val] of res2.headers.entries()) {
        if (
          key.toLowerCase().includes(FAKE_TOKEN) ||
          val.toLowerCase().includes(FAKE_TOKEN)
        ) {
          coverHeadersClean = false;
        }
      }

      if (
        res2.status === 200 &&
        bytes2.length > 0 &&
        fakeAbsCoverFetches === fetchesBeforeSecond
      ) {
        recordPass("GET /api/cover/item-fake-book-1 (cache hit)");
      } else {
        recordFail(
          "GET /api/cover/item-fake-book-1 (cache hit)",
          `status=${res2.status}, bytes=${bytes2.length}, fetches=${fakeAbsCoverFetches}`,
          res2.status,
          tmpDir
        );
      }

      if (coverHeadersClean) {
        recordPass("cover response headers omit token");
      } else {
        recordFail(
          "cover response headers omit token",
          "Token detected in cover response headers",
          undefined,
          tmpDir
        );
      }
    }

    // Check fake Audiobookshelf invariants
    if (
      fakeAbsNonGetRequests.length === 0 &&
      fakeAbsAuthFailures.length === 0 &&
      fakeAbsTotalRequests > 0
    ) {
      recordPass("fake ABS received only GET requests with valid token");
    } else {
      recordFail(
        "fake ABS received only GET requests with valid token",
        `non-GET=${fakeAbsNonGetRequests.length}, auth failures=${fakeAbsAuthFailures.length}, total=${fakeAbsTotalRequests}`,
        undefined,
        tmpDir
      );
    }

    // GET /api/export.json and POST /api/import round-trip
    let apiExportEventsCount = 0;
    let exportJsonText = "";
    {
      const res = await fetch(`${baseUrl}/api/export.json`);
      exportJsonText = await res.text();
      let parsed: { format?: string; events?: unknown[] } | null = null;
      try {
        parsed = JSON.parse(exportJsonText);
      } catch {
        // invalid json
      }

      if (
        res.status === 200 &&
        parsed?.format === "inputtracker-export" &&
        Array.isArray(parsed?.events) &&
        parsed.events.length > 0
      ) {
        apiExportEventsCount = parsed.events.length;
        recordPass("GET /api/export.json");
      } else {
        recordFail(
          "GET /api/export.json",
          exportJsonText.slice(0, 200),
          res.status,
          tmpDir
        );
      }

      // Round-trip import JSON
      const formJson = new FormData();
      formJson.append(
        "file",
        new Blob([exportJsonText], { type: "application/json" }),
        "inputtracker-export.json"
      );
      const importJsonRes = await fetch(`${baseUrl}/api/import`, {
        method: "POST",
        body: formJson,
      });
      const importJsonBody = (await importJsonRes.json()) as {
        inserted?: number;
        seen?: number;
      } | null;
      if (
        importJsonRes.status === 200 &&
        importJsonBody?.inserted === 0 &&
        typeof importJsonBody?.seen === "number" &&
        importJsonBody.seen > 0
      ) {
        recordPass("POST /api/import (roundtrip JSON)");
      } else {
        recordFail(
          "POST /api/import (roundtrip JSON)",
          JSON.stringify(importJsonBody),
          importJsonRes.status,
          tmpDir
        );
      }
    }

    // GET /api/export.csv and POST /api/import round-trip
    {
      const res = await fetch(`${baseUrl}/api/export.csv`);
      const exportCsvText = await res.text();
      if (
        res.status === 200 &&
        exportCsvText.includes("record_hash") &&
        exportCsvText.split("\n").length > 2
      ) {
        recordPass("GET /api/export.csv");
      } else {
        recordFail(
          "GET /api/export.csv",
          exportCsvText.slice(0, 200),
          res.status,
          tmpDir
        );
      }

      // Round-trip import CSV
      const formCsv = new FormData();
      formCsv.append(
        "file",
        new Blob([exportCsvText], { type: "text/csv" }),
        "inputtracker-export.csv"
      );
      const importCsvRes = await fetch(`${baseUrl}/api/import`, {
        method: "POST",
        body: formCsv,
      });
      const importCsvBody = (await importCsvRes.json()) as {
        inserted?: number;
        seen?: number;
      } | null;
      if (
        importCsvRes.status === 200 &&
        importCsvBody?.inserted === 0 &&
        typeof importCsvBody?.seen === "number" &&
        importCsvBody.seen > 0
      ) {
        recordPass("POST /api/import (roundtrip CSV)");
      } else {
        recordFail(
          "POST /api/import (roundtrip CSV)",
          JSON.stringify(importCsvBody),
          importCsvRes.status,
          tmpDir
        );
      }
    }

    // GET / (SPA index)
    {
      const res = await fetch(`${baseUrl}/`);
      const html = await res.text();
      if (res.status === 200 && html.includes('id="app"')) {
        recordPass("GET / (web app root)");
      } else {
        recordFail("GET / (web app root)", html.slice(0, 200), res.status, tmpDir);
      }
    }

    // GET /manifest.webmanifest
    {
      const res = await fetch(`${baseUrl}/manifest.webmanifest`);
      const text = await res.text();
      let parsed: { name?: string; icons?: unknown[] } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // invalid json
      }
      if (
        res.status === 200 &&
        parsed &&
        (parsed.name !== undefined || parsed.icons !== undefined)
      ) {
        recordPass("GET /manifest.webmanifest");
      } else {
        recordFail(
          "GET /manifest.webmanifest",
          text.slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // 8. CLI checks against the temporary database

    // CLI export --format json
    {
      const cliExportPath = join(tmpDir, "cli-export.json");
      const cliProc = Bun.spawn(
        [
          "bun",
          "run",
          "src/cli/index.ts",
          "export",
          "--format",
          "json",
          "--out",
          cliExportPath,
        ],
        {
          env: {
            ...process.env,
            INPUTTRACKER_CONFIG: tempConfigPath,
            XDG_DATA_HOME: tmpDir,
            XDG_CONFIG_HOME: tmpDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const cliExit = await cliProc.exited;
      let cliExportParsed: { events?: unknown[] } | null = null;
      try {
        cliExportParsed = JSON.parse(readFileSync(cliExportPath, "utf8"));
      } catch {
        // failed to read or parse
      }

      if (
        cliExit === 0 &&
        Array.isArray(cliExportParsed?.events) &&
        cliExportParsed.events.length === apiExportEventsCount
      ) {
        recordPass("CLI export --format json");
      } else {
        const cliErr = await new Response(cliProc.stderr).text();
        recordFail(
          "CLI export --format json",
          `exit=${cliExit}, events=${cliExportParsed?.events?.length} (expected ${apiExportEventsCount}), stderr=${cliErr.slice(0, 200)}`,
          undefined,
          tmpDir
        );
      }
    }

    // CLI backup
    {
      const cliBackupProc = Bun.spawn(
        ["bun", "run", "src/cli/index.ts", "backup"],
        {
          env: {
            ...process.env,
            INPUTTRACKER_CONFIG: tempConfigPath,
            XDG_DATA_HOME: tmpDir,
            XDG_CONFIG_HOME: tmpDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const cliBackupExit = await cliBackupProc.exited;
      let backupFiles: string[] = [];
      try {
        backupFiles = readdirSync(backupDir);
      } catch {
        // directory missing
      }
      const hasDb = backupFiles.some((f) =>
        /^inputtracker-\d{4}-\d{2}-\d{2}\.db$/.test(f)
      );
      const hasJson = backupFiles.some((f) =>
        /^inputtracker-\d{4}-\d{2}-\d{2}\.json$/.test(f)
      );

      if (cliBackupExit === 0 && hasDb && hasJson) {
        recordPass("CLI backup");
      } else {
        const cliErr = await new Response(cliBackupProc.stderr).text();
        recordFail(
          "CLI backup",
          `exit=${cliBackupExit}, files=${backupFiles.join(", ")}, stderr=${cliErr.slice(0, 200)}`,
          undefined,
          tmpDir
        );
      }
    }

    // 9. Simkl checks

    // 1. CLI sync simkl (not authorised)
    {
      const cliProc = Bun.spawn(
        ["bun", "run", "src/cli/index.ts", "sync", "simkl"],
        {
          env: {
            ...process.env,
            INPUTTRACKER_CONFIG: tempConfigPath,
            XDG_DATA_HOME: tmpDir,
            XDG_CONFIG_HOME: tmpDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const cliExit = await cliProc.exited;
      const stdout = await new Response(cliProc.stdout).text();
      const stderr = await new Response(cliProc.stderr).text();

      const statusRes = await fetch(`${baseUrl}/api/sync/status`);
      const statusBody = (await statusRes.json()) as {
        runs?: { source: string }[];
      } | null;
      const hasSimklRun = statusBody?.runs?.some((r) => r.source === "simkl");

      if (
        cliExit === 0 &&
        stdout.toLowerCase().includes("not authorised") &&
        !hasSimklRun &&
        fakeSimklRequests.length === 0
      ) {
        recordPass("CLI sync simkl (not authorised)");
      } else {
        recordFail(
          "CLI sync simkl (not authorised)",
          `exit=${cliExit}, stdout=${stdout}, stderr=${stderr}, hasSimklRun=${hasSimklRun}, fakeReqs=${fakeSimklRequests.length}`,
          undefined,
          tmpDir
        );
      }
    }

    // 2. CLI auth simkl
    {
      const authStart = Date.now();
      const authProc = Bun.spawn(
        ["bun", "run", "src/cli/index.ts", "auth", "simkl"],
        {
          env: {
            ...process.env,
            INPUTTRACKER_CONFIG: tempConfigPath,
            XDG_DATA_HOME: tmpDir,
            XDG_CONFIG_HOME: tmpDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const authExit = await authProc.exited;
      const durationMs = Date.now() - authStart;
      const stdout = await new Response(authProc.stdout).text();
      const stderr = await new Response(authProc.stderr).text();

      const tokenFilePath = join(tmpDir, "secrets", "simkl-token.json");
      const tokenDir = dirname(tokenFilePath);
      const tokenFileExists = existsSync(tokenFilePath);
      const fileMode = tokenFileExists ? statSync(tokenFilePath).mode & 0o777 : 0;
      const dirMode = existsSync(tokenDir) ? statSync(tokenDir).mode & 0o777 : 0;

      const devicePosts = fakeSimklRequests.filter(
        (r) => r.method === "POST" && r.path === "/oauth2/device"
      ).length;
      const tokenPosts = fakeSimklRequests.filter(
        (r) => r.method === "POST" && r.path === "/oauth2/token"
      ).length;

      const hasCompleteUri = stdout.includes(
        "https://simkl.com/pin?user_code=BDWP-HQPK"
      );
      const hasUserCode = stdout.includes("BDWP-HQPK");
      const leaksSecrets =
        stdout.includes(FAKE_SIMKL_DEVICE_CODE) ||
        stdout.includes(FAKE_SIMKL_ACCESS_TOKEN) ||
        stdout.includes(FAKE_SIMKL_REFRESH_TOKEN);

      if (
        authExit === 0 &&
        durationMs < 15000 &&
        hasCompleteUri &&
        hasUserCode &&
        !leaksSecrets &&
        devicePosts === 1 &&
        tokenPosts === 2 &&
        tokenFileExists &&
        fileMode === 0o600 &&
        dirMode === 0o700
      ) {
        recordPass("CLI auth simkl");
      } else {
        recordFail(
          "CLI auth simkl",
          `exit=${authExit}, dur=${durationMs}ms, uri=${hasCompleteUri}, code=${hasUserCode}, leak=${leaksSecrets}, devPosts=${devicePosts}, tokPosts=${tokenPosts}, fileExists=${tokenFileExists}, fileMode=${fileMode.toString(8)}, dirMode=${dirMode.toString(8)}, stderr=${stderr}`,
          undefined,
          tmpDir
        );
      }
    }

    // 3. CLI auth simkl --status
    {
      const statusProc = Bun.spawn(
        ["bun", "run", "src/cli/index.ts", "auth", "simkl", "--status"],
        {
          env: {
            ...process.env,
            INPUTTRACKER_CONFIG: tempConfigPath,
            XDG_DATA_HOME: tmpDir,
            XDG_CONFIG_HOME: tmpDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const statusExit = await statusProc.exited;
      const stdout = await new Response(statusProc.stdout).text();
      const stderr = await new Response(statusProc.stderr).text();

      const saysConnected = stdout.toLowerCase().includes("connected");
      const leaksSecrets =
        stdout.includes(FAKE_SIMKL_ACCESS_TOKEN) ||
        stdout.includes(FAKE_SIMKL_REFRESH_TOKEN) ||
        stdout.includes(FAKE_SIMKL_DEVICE_CODE);

      if (statusExit === 0 && saysConnected && !leaksSecrets) {
        recordPass("CLI auth simkl --status");
      } else {
        recordFail(
          "CLI auth simkl --status",
          `exit=${statusExit}, connected=${saysConnected}, leak=${leaksSecrets}, stdout=${stdout}, stderr=${stderr}`,
          undefined,
          tmpDir
        );
      }
    }

    // 4. POST /api/sync/simkl (first sync)
    {
      const reqsBefore = fakeSimklRequests.length;
      const res = await fetch(`${baseUrl}/api/sync/simkl`, { method: "POST" });
      const body = (await res.json()) as {
        runId?: number;
        seen?: number;
        inserted?: number;
        mode?: string;
      } | null;

      const syncReqs = fakeSimklRequests.slice(reqsBefore);
      const actIdx = syncReqs.findIndex(
        (r) => r.method === "GET" && r.path === "/sync/activities"
      );
      const showsReq = syncReqs.find(
        (r) => r.method === "GET" && r.path === "/sync/all-items/shows"
      );
      const moviesReq = syncReqs.find(
        (r) => r.method === "GET" && r.path === "/sync/all-items/movies"
      );
      const animeReq = syncReqs.find(
        (r) => r.method === "GET" && r.path === "/sync/all-items/anime"
      );

      const showsIdx = syncReqs.indexOf(showsReq!);
      const moviesIdx = syncReqs.indexOf(moviesReq!);
      const animeIdx = syncReqs.indexOf(animeReq!);

      const orderValid =
        actIdx !== -1 &&
        showsIdx > actIdx &&
        moviesIdx > actIdx &&
        animeIdx > actIdx;

      const paramsValid = (req?: RecordedSimklRequest) =>
        req?.query["extended"] === "full" &&
        req?.query["episode_watched_at"] === "yes" &&
        req?.query["include_all_episodes"] === "original";

      const queryValid =
        paramsValid(showsReq) &&
        paramsValid(moviesReq) &&
        paramsValid(animeReq);

      if (
        res.status === 200 &&
        typeof body?.inserted === "number" &&
        body.inserted > 0 &&
        orderValid &&
        queryValid
      ) {
        recordPass("POST /api/sync/simkl (first sync)");
      } else {
        recordFail(
          "POST /api/sync/simkl (first sync)",
          `status=${res.status}, inserted=${body?.inserted}, order=${orderValid}, query=${queryValid}, body=${JSON.stringify(body)}`,
          res.status,
          tmpDir
        );
      }
    }

    // 5. POST /api/sync/simkl (unchanged, second run)
    {
      const reqsBefore = fakeSimklRequests.length;
      const res = await fetch(`${baseUrl}/api/sync/simkl`, { method: "POST" });
      const body = (await res.json()) as {
        runId?: number;
        seen?: number;
        inserted?: number;
        mode?: string;
      } | null;

      const secondReqs = fakeSimklRequests.slice(reqsBefore);
      const hasAllItemsCall = secondReqs.some((r) =>
        r.path.startsWith("/sync/all-items")
      );

      if (
        res.status === 200 &&
        body?.inserted === 0 &&
        body?.mode === "unchanged" &&
        !hasAllItemsCall
      ) {
        recordPass("POST /api/sync/simkl (unchanged, second run)");
      } else {
        recordFail(
          "POST /api/sync/simkl (unchanged, second run)",
          `status=${res.status}, inserted=${body?.inserted}, mode=${body?.mode}, hasAllItems=${hasAllItemsCall}`,
          res.status,
          tmpDir
        );
      }
    }

    // 6. GET /api/calendar?month=2026-04&source=simkl
    {
      const res = await fetch(
        `${baseUrl}/api/calendar?month=2026-04&source=simkl`
      );
      const body = (await res.json()) as {
        month?: string;
        days?: {
          date: string;
          items: {
            title: string | null;
            source: string;
            season: number | null;
            episode: number | null;
            cover_url: string | null;
          }[];
        }[];
      } | null;

      const allItems = body?.days?.flatMap((d) => d.items) ?? [];
      const hasSimklEpisode = allItems.some(
        (it) =>
          it.source === "simkl" &&
          it.title === "Synthetic Show 1" &&
          it.season === 1 &&
          it.episode === 1 &&
          typeof it.cover_url === "string" &&
          it.cover_url.startsWith("/api/poster/simkl/")
      );

      if (res.status === 200 && allItems.length > 0 && hasSimklEpisode) {
        recordPass("GET /api/calendar?month=2026-04&source=simkl");
      } else {
        recordFail(
          "GET /api/calendar?month=2026-04&source=simkl",
          `status=${res.status}, itemsCount=${allItems.length}, hasEpisode=${hasSimklEpisode}, body=${JSON.stringify(body).slice(0, 200)}`,
          res.status,
          tmpDir
        );
      }
    }

    // 7. GET /api/poster/simkl/<path> (first fetch and cache hit)
    {
      const posterPath = "12/12345678abcdef01";
      const expectedRemotePath = `/posters/${posterPath}_m.webp`;
      const fetchesBefore =
        fakeImageRequestsPerPath.get(expectedRemotePath) ?? 0;

      const res1 = await fetch(`${baseUrl}/api/poster/simkl/${posterPath}`);
      const bytes1 = new Uint8Array(await res1.arrayBuffer());
      const fetchesAfter1 =
        fakeImageRequestsPerPath.get(expectedRemotePath) ?? 0;

      if (
        res1.status === 200 &&
        res1.headers.get("content-type")?.startsWith("image/") &&
        bytes1.length > 0 &&
        fetchesAfter1 === fetchesBefore + 1
      ) {
        recordPass(`GET /api/poster/simkl/${posterPath} (first fetch)`);
      } else {
        recordFail(
          `GET /api/poster/simkl/${posterPath} (first fetch)`,
          `status=${res1.status}, bytes=${bytes1.length}, fetchesBefore=${fetchesBefore}, fetchesAfter=${fetchesAfter1}`,
          res1.status,
          tmpDir
        );
      }

      const res2 = await fetch(`${baseUrl}/api/poster/simkl/${posterPath}`);
      const bytes2 = new Uint8Array(await res2.arrayBuffer());
      const fetchesAfter2 =
        fakeImageRequestsPerPath.get(expectedRemotePath) ?? 0;

      if (
        res2.status === 200 &&
        bytes2.length > 0 &&
        fetchesAfter2 === fetchesAfter1
      ) {
        recordPass(`GET /api/poster/simkl/${posterPath} (cache hit)`);
      } else {
        recordFail(
          `GET /api/poster/simkl/${posterPath} (cache hit)`,
          `status=${res2.status}, bytes=${bytes2.length}, fetchesBefore=${fetchesAfter1}, fetchesAfter=${fetchesAfter2}`,
          res2.status,
          tmpDir
        );
      }
    }

    // 8. fake Simkl received only allowed requests
    {
      let valid = true;
      let failureReason = "";

      for (const req of fakeSimklRequests) {
        const isSyncGet = req.method === "GET" && req.path.startsWith("/sync/");
        const isDevicePost =
          req.method === "POST" && req.path === "/oauth2/device";
        const isTokenPost =
          req.method === "POST" && req.path === "/oauth2/token";

        if (!isSyncGet && !isDevicePost && !isTokenPost) {
          valid = false;
          failureReason = `Disallowed method/path: ${req.method} ${req.path}`;
          break;
        }

        if (req.query["client_id"] !== "smoke-fake-client-id") {
          valid = false;
          failureReason = `Invalid client_id in query: ${req.query["client_id"]}`;
          break;
        }

        if (req.query["app-name"] !== "inputtracker") {
          valid = false;
          failureReason = `Invalid app-name in query: ${req.query["app-name"]}`;
          break;
        }

        if (req.query["app-version"] !== APP_VERSION) {
          valid = false;
          failureReason = `Invalid app-version in query: ${req.query["app-version"]}`;
          break;
        }

        if (req.headers["user-agent"] !== `inputtracker/${APP_VERSION}`) {
          valid = false;
          failureReason = `Invalid User-Agent header: ${req.headers["user-agent"]}`;
          break;
        }

        if (req.path.startsWith("/sync/")) {
          if (
            req.headers["authorization"] !== `Bearer ${FAKE_SIMKL_ACCESS_TOKEN}`
          ) {
            valid = false;
            failureReason = `Invalid or missing Authorization header on ${req.path}`;
            break;
          }
        }

        if (req.status === 404) {
          valid = false;
          failureReason = `404 status recorded for ${req.path}`;
          break;
        }
      }

      for (const req of fakeImageRequests) {
        if (req.method !== "GET") {
          valid = false;
          failureReason = `Image request method was not GET: ${req.method}`;
          break;
        }
        if (req.headers["authorization"] !== undefined) {
          valid = false;
          failureReason = `Image request contained Authorization header`;
          break;
        }
        if (req.headers["cookie"] !== undefined) {
          valid = false;
          failureReason = `Image request contained Cookie header`;
          break;
        }
      }

      if (
        valid &&
        fakeSimklRequests.length > 0 &&
        fakeImageRequests.length > 0
      ) {
        recordPass("fake Simkl received only allowed requests");
      } else {
        recordFail(
          "fake Simkl received only allowed requests",
          failureReason ||
            `fakeSimklReqs=${fakeSimklRequests.length}, fakeImageReqs=${fakeImageRequests.length}`,
          undefined,
          tmpDir
        );
      }
    }

    // 9. GET /api/sync/status (simkl)
    {
      const res = await fetch(`${baseUrl}/api/sync/status`);
      const body = (await res.json()) as {
        runs?: {
          source: string;
          error: string | null;
          rows_inserted: number;
        }[];
      } | null;
      const simklRun = body?.runs?.find((r) => r.source === "simkl");
      if (
        res.status === 200 &&
        simklRun &&
        simklRun.error === null &&
        simklRun.finished_at !== null
      ) {
        recordPass("GET /api/sync/status (simkl)");
      } else {
        recordFail(
          "GET /api/sync/status (simkl)",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // 10. YouTube Takeout checks

    // 10. CLI import youtube-takeout
    {
      const youtubeFixturePath = "test/fixtures/youtube/synthetic-takeout.json";
      const importProc = Bun.spawn(
        [
          "bun",
          "run",
          "src/cli/index.ts",
          "import",
          "youtube-takeout",
          youtubeFixturePath,
        ],
        {
          env: {
            ...process.env,
            INPUTTRACKER_CONFIG: tempConfigPath,
            XDG_DATA_HOME: tmpDir,
            XDG_CONFIG_HOME: tmpDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const importExit = await importProc.exited;
      const stdout = await new Response(importProc.stdout).text();
      const stderr = await new Response(importProc.stderr).text();

      const hasPrefix = stdout.includes("youtube-takeout:");
      const hasCounts =
        stdout.includes("views") &&
        stdout.includes("new") &&
        stdout.includes("skipped");

      const match = stdout.match(/(\d+)\s+new/);
      const insertedCount = match ? Number(match[1]) : 0;

      if (importExit === 0 && hasPrefix && hasCounts && insertedCount > 0) {
        recordPass("CLI import youtube-takeout");
      } else {
        recordFail(
          "CLI import youtube-takeout",
          `exit=${importExit}, inserted=${insertedCount}, stdout=${stdout}, stderr=${stderr}`,
          undefined,
          tmpDir
        );
      }
    }

    // 11. POST /api/import (YouTube Takeout, re-import)
    {
      const youtubeTakeoutContent = readFileSync(
        "test/fixtures/youtube/synthetic-takeout.json",
        "utf8"
      );
      const form = new FormData();
      form.append(
        "file",
        new Blob([youtubeTakeoutContent], { type: "application/json" }),
        "synthetic-takeout.json"
      );
      const res = await fetch(`${baseUrl}/api/import`, {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as {
        kind?: string;
        inserted?: number;
      } | null;

      if (
        res.status === 200 &&
        body?.kind === "youtube-takeout" &&
        body?.inserted === 0
      ) {
        recordPass("POST /api/import (YouTube Takeout, re-import)");
      } else {
        recordFail(
          "POST /api/import (YouTube Takeout, re-import)",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // 12. GET /api/calendar?month=2026-10&source=youtube
    {
      const res = await fetch(
        `${baseUrl}/api/calendar?month=2026-10&source=youtube`
      );
      const body = (await res.json()) as {
        month?: string;
        days?: {
          date: string;
          items: {
            title: string | null;
            parent_title: string | null;
            source: string;
            cover_url: string | null;
          }[];
        }[];
      } | null;

      const allItems = body?.days?.flatMap((d) => d.items) ?? [];
      const hasYoutubeItem = allItems.some(
        (it) =>
          it.source === "youtube" &&
          typeof it.parent_title === "string" &&
          it.parent_title.length > 0 &&
          typeof it.cover_url === "string" &&
          /^\/api\/thumb\/youtube\/[A-Za-z0-9_-]{11}$/.test(it.cover_url)
      );

      if (res.status === 200 && allItems.length > 0 && hasYoutubeItem) {
        recordPass("GET /api/calendar?month=2026-10&source=youtube");
      } else {
        recordFail(
          "GET /api/calendar?month=2026-10&source=youtube",
          `status=${res.status}, itemsCount=${allItems.length}, hasYoutubeItem=${hasYoutubeItem}, body=${JSON.stringify(body).slice(0, 200)}`,
          res.status,
          tmpDir
        );
      }
    }

    // 13a. GET /api/heatmap/days?year=2026&source=youtube
    {
      const res = await fetch(
        `${baseUrl}/api/heatmap/days?year=2026&source=youtube`
      );
      const body = (await res.json()) as {
        year?: string;
        days?: { date: string; count: number; minutes: number }[];
      } | null;

      const hasActiveDay = body?.days?.some(
        (d) => d.count > 0 && d.minutes === 0
      );

      if (res.status === 200 && body?.year === "2026" && hasActiveDay) {
        recordPass("GET /api/heatmap/days?year=2026&source=youtube");
      } else {
        recordFail(
          "GET /api/heatmap/days?year=2026&source=youtube",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // 13b. GET /api/stats?source=youtube
    {
      const res = await fetch(`${baseUrl}/api/stats?source=youtube`);
      const body = (await res.json()) as {
        total_items?: number;
        by_source?: Record<string, { count: number; minutes: number }>;
      } | null;

      const youtubeSource = body?.by_source?.youtube;
      const hasCount =
        typeof body?.total_items === "number" &&
        body.total_items > 0 &&
        typeof youtubeSource?.count === "number" &&
        youtubeSource.count > 0 &&
        youtubeSource.minutes === 0;

      if (res.status === 200 && hasCount) {
        recordPass("GET /api/stats?source=youtube");
      } else {
        recordFail(
          "GET /api/stats?source=youtube",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // 14. GET /api/thumb/youtube/<id> (first fetch, cache hit, bad)
    {
      const videoId = "AbCdEfGhIjK";
      const expectedRemotePath = `/vi/${videoId}/mqdefault.jpg`;
      const fetchesBefore =
        fakeImageRequestsPerPath.get(expectedRemotePath) ?? 0;

      const res1 = await fetch(`${baseUrl}/api/thumb/youtube/${videoId}`);
      const bytes1 = new Uint8Array(await res1.arrayBuffer());
      const fetchesAfter1 =
        fakeImageRequestsPerPath.get(expectedRemotePath) ?? 0;

      if (
        res1.status === 200 &&
        res1.headers.get("content-type") === "image/jpeg" &&
        bytes1.length > 0 &&
        fetchesAfter1 === fetchesBefore + 1
      ) {
        recordPass(`GET /api/thumb/youtube/${videoId} (first fetch)`);
      } else {
        recordFail(
          `GET /api/thumb/youtube/${videoId} (first fetch)`,
          `status=${res1.status}, bytes=${bytes1.length}, type=${res1.headers.get("content-type")}, fetchesBefore=${fetchesBefore}, fetchesAfter=${fetchesAfter1}`,
          res1.status,
          tmpDir
        );
      }

      const res2 = await fetch(`${baseUrl}/api/thumb/youtube/${videoId}`);
      const bytes2 = new Uint8Array(await res2.arrayBuffer());
      const fetchesAfter2 =
        fakeImageRequestsPerPath.get(expectedRemotePath) ?? 0;

      if (
        res2.status === 200 &&
        res2.headers.get("content-type") === "image/jpeg" &&
        bytes2.length > 0 &&
        fetchesAfter2 === fetchesAfter1
      ) {
        recordPass(`GET /api/thumb/youtube/${videoId} (cache hit)`);
      } else {
        recordFail(
          `GET /api/thumb/youtube/${videoId} (cache hit)`,
          `status=${res2.status}, bytes=${bytes2.length}, fetchesBefore=${fetchesAfter1}, fetchesAfter=${fetchesAfter2}`,
          res2.status,
          tmpDir
        );
      }

      const resBad = await fetch(`${baseUrl}/api/thumb/youtube/bad`);
      if (resBad.status === 400) {
        recordPass("GET /api/thumb/youtube/bad");
      } else {
        recordFail(
          "GET /api/thumb/youtube/bad",
          `status=${resBad.status}`,
          resBad.status,
          tmpDir
        );
      }
    }

    // 14–17. Phase 3: cross-source duplicates, goals and annotations

    // 14a. Add the same movie by hand that Simkl already synced. The Simkl
    // fixture contains "Synthetic Movie 1", last watched 2026-05-01T20:15:00Z
    // (= local date 2026-05-01 in Europe/Bratislava), so a manual movie with
    // the same title on the same local date is the classic duplicate pair.
    {
      const res = await fetch(`${baseUrl}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "movie",
          title: "Synthetic Movie 1",
          started_at: "2026-05-01 21:30",
          duration_seconds: 7200,
        }),
      });
      const body = (await res.json()) as {
        id?: string;
        inserted?: number;
      } | null;
      if (res.status === 201 && body?.inserted === 1 && typeof body?.id === "string") {
        recordPass("POST /api/events (duplicate movie entry)");
      } else {
        recordFail(
          "POST /api/events (duplicate movie entry)",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // 14b. The calendar shows the pair once: the Simkl row wins and reports
    // "also from manual". Both rows stay in the archive (checked in 17).
    {
      const res = await fetch(`${baseUrl}/api/calendar?month=2026-05`);
      const body = (await res.json()) as {
        month?: string;
        days?: {
          date: string;
          items: { title: string | null; source: string; also_from?: string[] }[];
        }[];
      } | null;
      const day = body?.days?.find((d) => d.date === "2026-05-01");
      const movieItems = (day?.items ?? []).filter(
        (it) => it.title === "Synthetic Movie 1"
      );
      const shownOnce =
        movieItems.length === 1 &&
        movieItems[0]!.source === "simkl" &&
        Array.isArray(movieItems[0]!.also_from) &&
        movieItems[0]!.also_from!.includes("manual");
      if (res.status === 200 && day && shownOnce) {
        recordPass("GET /api/calendar?month=2026-05 (duplicate shown once)");
      } else {
        recordFail(
          "GET /api/calendar?month=2026-05 (duplicate shown once)",
          `day=${JSON.stringify(day).slice(0, 200)}`,
          res.status,
          tmpDir
        );
      }
    }

    // 14c. Stats over the same local day also count the pair once.
    {
      const res = await fetch(
        `${baseUrl}/api/stats?from=2026-05-01&to=2026-05-01`
      );
      const body = (await res.json()) as {
        total_items?: number;
        by_source?: Record<string, { count: number }>;
      } | null;
      const ok =
        res.status === 200 &&
        body?.total_items === 1 &&
        body.by_source?.simkl?.count === 1 &&
        body.by_source?.manual === undefined;
      if (ok) {
        recordPass("GET /api/stats?from&to (duplicate shown once)");
      } else {
        recordFail(
          "GET /api/stats?from&to (duplicate shown once)",
          JSON.stringify(body).slice(0, 200),
          res.status,
          tmpDir
        );
      }
    }

    // The current local year in the configured timezone (Europe/Bratislava),
    // matching how the server computes "today" for GET /api/goals.
    const currentLocalYear = Number(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Bratislava",
        year: "numeric",
      }).format(new Date())
    );

    // 15d. Create a goal for the current year: 2 Simkl items. The Simkl
    // fixture contributes exactly 4 events in 2026 (Synthetic Show 1 S01E01,
    // Synthetic Movie 1, Synthetic Anime TV S01E01 and Synthetic Anime
    // Movie), so progress must count them (deduplicated).
    let goalId: string | null = null;
    {
      const res = await fetch(`${baseUrl}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: currentLocalYear,
          metric: "items",
          source: "simkl",
          target: 2,
        }),
      });
      const body = (await res.json()) as {
        goal_id?: string;
        rev_id?: string;
        inserted?: boolean;
      } | null;
      if (
        res.status === 201 &&
        body?.inserted === true &&
        typeof body?.goal_id === "string" &&
        typeof body?.rev_id === "string"
      ) {
        goalId = body.goal_id;
        recordPass("POST /api/goals (create goal)");
      } else {
        recordFail(
          "POST /api/goals (create goal)",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      }
    }

    // 15e. GET /api/goals returns the goal with progress counted from the
    // synced events (4 items → 200 % of the target 2 → done).
    {
      const res = await fetch(`${baseUrl}/api/goals?year=${currentLocalYear}`);
      const body = (await res.json()) as {
        year?: number;
        goals?: {
          goal_id: string;
          target: number;
          progress: {
            current: number;
            target: number;
            percent: number;
            status: string;
          };
        }[];
      } | null;
      const goal = body?.goals?.[0];
      const ok =
        res.status === 200 &&
        body?.year === currentLocalYear &&
        goal !== undefined &&
        goal.goal_id === goalId &&
        goal.progress.current === 4 &&
        goal.progress.target === 2 &&
        Math.abs(goal.progress.percent - 200) < 0.01 &&
        goal.progress.status === "done";
      if (ok) {
        recordPass("GET /api/goals (progress counts synced events)");
      } else {
        recordFail(
          "GET /api/goals (progress counts synced events)",
          JSON.stringify(body).slice(0, 300),
          res.status,
          tmpDir
        );
      }
    }

    // 15f. Editing the goal (same goal_id, new target) is a new revision:
    // POST succeeds again and the read path still shows exactly one goal,
    // now with the new target.
    if (goalId !== null) {
      const res = await fetch(`${baseUrl}/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal_id: goalId,
          year: currentLocalYear,
          metric: "items",
          source: "simkl",
          target: 5,
        }),
      });
      const body = (await res.json()) as {
        goal_id?: string;
        rev_id?: string;
        inserted?: boolean;
      } | null;

      const editOk =
        res.status === 201 &&
        body?.inserted === true &&
        body.goal_id === goalId &&
        typeof body.rev_id === "string";

      if (!editOk) {
        recordFail(
          "POST /api/goals (edit as new revision)",
          JSON.stringify(body),
          res.status,
          tmpDir
        );
      } else {
        const getRes = await fetch(
          `${baseUrl}/api/goals?year=${currentLocalYear}`
        );
        const getBody = (await getRes.json()) as {
          year?: number;
          goals?: {
            goal_id: string;
            target: number;
            progress: { current: number; percent: number };
          }[];
        } | null;
        const goal = getBody?.goals?.[0];
        const readOk =
          getRes.status === 200 &&
          getBody?.goals?.length === 1 &&
          goal !== undefined &&
          goal.goal_id === goalId &&
          goal.target === 5 &&
          goal.progress.current === 4 &&
          Math.abs(goal.progress.percent - 80) < 0.01;
        if (readOk) {
          recordPass("POST + GET /api/goals (edit keeps one latest revision)");
        } else {
          recordFail(
            "POST + GET /api/goals (edit keeps one latest revision)",
            JSON.stringify(getBody).slice(0, 300),
            getRes.status,
            tmpDir
          );
        }
      }
    }

    // 15g. Ratings and notes: annotate an item that exists (the manual
    // "Smoke Test Book" added earlier), then change it — latest wins.
    {
      const post = (rating: number, note: string) =>
        fetch(`${baseUrl}/api/annotations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "manual",
            title: "Smoke Test Book",
            rating,
            note,
          }),
        });

      const res1 = await post(8, "Smoke note one");
      const body1 = (await res1.json()) as {
        rev_id?: string;
        inserted?: boolean;
        annotation?: { rating?: number | null; note?: string | null };
      } | null;
      const firstOk =
        res1.status === 201 &&
        body1?.inserted === true &&
        typeof body1?.rev_id === "string" &&
        body1.annotation?.rating === 8 &&
        body1.annotation?.note === "Smoke note one";
      if (firstOk) {
        recordPass("POST /api/annotations (rating + note)");
      } else {
        recordFail(
          "POST /api/annotations (rating + note)",
          JSON.stringify(body1),
          res1.status,
          tmpDir
        );
      }

      const getRes = await fetch(
        `${baseUrl}/api/annotations?source=manual&title=${encodeURIComponent(
          "Smoke Test Book"
        )}`
      );
      const getBody = (await getRes.json()) as {
        rating?: number | null;
        note?: string | null;
      } | null;
      const getOk =
        getRes.status === 200 &&
        getBody?.rating === 8 &&
        getBody?.note === "Smoke note one";
      if (getOk) {
        recordPass("GET /api/annotations (returns rating + note)");
      } else {
        recordFail(
          "GET /api/annotations (returns rating + note)",
          JSON.stringify(getBody),
          getRes.status,
          tmpDir
        );
      }

      const res2 = await post(9, "Smoke note two");
      const body2 = (await res2.json()) as {
        inserted?: boolean;
        annotation?: { rating?: number | null; note?: string | null };
      } | null;
      const edited =
        res2.status === 201 &&
        body2?.inserted === true &&
        body2.annotation?.rating === 9;

      const getRes2 = await fetch(
        `${baseUrl}/api/annotations?source=manual&title=${encodeURIComponent(
          "Smoke Test Book"
        )}`
      );
      const getBody2 = (await getRes2.json()) as {
        rating?: number | null;
        note?: string | null;
      } | null;
      const latestWins =
        getRes2.status === 200 &&
        getBody2?.rating === 9 &&
        getBody2?.note === "Smoke note two";
      if (edited && latestWins) {
        recordPass("POST + GET /api/annotations (latest revision wins)");
      } else {
        recordFail(
          "POST + GET /api/annotations (latest revision wins)",
          `post2=${JSON.stringify(body2)}, get2=${JSON.stringify(getBody2)}`,
          getRes2.status,
          tmpDir
        );
      }
    }

    // 15h. Export v2: version 2, containing both goal revisions, both
    // annotation revisions and both raw rows of the duplicate movie pair.
    {
      const res = await fetch(`${baseUrl}/api/export.json`);
      const text = await res.text();
      let parsed: {
        format?: string;
        version?: number;
        events?: { title?: string | null }[];
        goals?: { goal_id?: string; target?: number }[];
        annotations?: {
          source?: string;
          title?: string;
          rating?: number | null;
        }[];
      } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // invalid json
      }

      const goalRevisions = (parsed?.goals ?? []).filter(
        (g) => g.goal_id === goalId
      );
      const annotationRows = (parsed?.annotations ?? []).filter(
        (a) => a.source === "manual" && a.title === "Smoke Test Book"
      );
      const movieRows = (parsed?.events ?? []).filter(
        (e) => e.title === "Synthetic Movie 1"
      );

      const ok =
        res.status === 200 &&
        parsed?.format === "inputtracker-export" &&
        parsed?.version === 2 &&
        goalRevisions.length === 2 &&
        goalRevisions.some((g) => g.target === 2) &&
        goalRevisions.some((g) => g.target === 5) &&
        annotationRows.length === 2 &&
        annotationRows.some((a) => a.rating === 8) &&
        annotationRows.some((a) => a.rating === 9) &&
        movieRows.length === 2;

      if (ok) {
        recordPass("GET /api/export.json (v2 with goals and annotations)");
      } else {
        recordFail(
          "GET /api/export.json (v2 with goals and annotations)",
          `version=${parsed?.version}, goals=${goalRevisions.length}, ` +
            `annotations=${annotationRows.length}, movieRows=${movieRows.length}`,
          res.status,
          tmpDir
        );
      }

      // Second import of that archive into the same (already populated) DB:
      // everything is a duplicate, so all three tables report 0 new rows.
      const form = new FormData();
      form.append(
        "file",
        new Blob([text], { type: "application/json" }),
        "inputtracker-export.json"
      );
      const importRes = await fetch(`${baseUrl}/api/import`, {
        method: "POST",
        body: form,
      });
      const importBody = (await importRes.json()) as {
        kind?: string;
        events?: { inserted?: number; seen?: number };
        goals?: { inserted?: number; seen?: number };
        annotations?: { inserted?: number; seen?: number };
      } | null;
      const importOk =
        importRes.status === 200 &&
        importBody?.kind === "native" &&
        importBody.events?.inserted === 0 &&
        (importBody.events?.seen ?? 0) > 0 &&
        importBody.goals?.inserted === 0 &&
        (importBody.goals?.seen ?? 0) > 0 &&
        importBody.annotations?.inserted === 0 &&
        (importBody.annotations?.seen ?? 0) > 0;
      if (importOk) {
        recordPass("POST /api/import (second import reports 0 new)");
      } else {
        recordFail(
          "POST /api/import (second import reports 0 new)",
          JSON.stringify(importBody),
          importRes.status,
          tmpDir
        );
      }
    }
  } finally {
    // Teardown: kill server, stop fake ABS, clean up temp dir
    if (serverProc) {
      try {
        serverProc.kill();
        await serverProc.exited;
      } catch {
        // ignore kill error
      }
    }

    if (fakeAbsServer) {
      try {
        fakeAbsServer.stop(true);
      } catch {
        // ignore stop error
      }
    }

    if (fakeSimklServer) {
      try {
        fakeSimklServer.stop(true);
      } catch {
        // ignore stop error
      }
    }

    if (fakeImageServer) {
      try {
        fakeImageServer.stop(true);
      } catch {
        // ignore stop error
      }
    }

    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore rm error
    }
  }

  // Summary and exit
  if (failures.length > 0) {
    console.error(`\nsmoke: ${failures.length} check(s) failed:`);
    for (const f of failures) {
      const statusPart = f.status !== undefined ? ` [HTTP ${f.status}]` : "";
      console.error(`  - ${f.name}${statusPart}: ${f.details}`);
    }
    if (serverStderrLines.length > 0) {
      console.error("\nServer stderr (last 30 lines):");
      for (const line of serverStderrLines.slice(-30)) {
        console.error(`  ${redact(line, tmpDir)}`);
      }
    }
    process.exit(1);
  }

  console.log(`smoke: ${passedCount} checks passed`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Smoke test aborted: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
