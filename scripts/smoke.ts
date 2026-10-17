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
 * 12. Guaranteed cleanup of temporary directories and background processes
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, Subprocess } from "bun";

const FAKE_TOKEN = "smoke-token";

interface CheckFailure {
  name: string;
  status?: number;
  details: string;
}

const failures: CheckFailure[] = [];
let passedCount = 0;

function redact(text: string, tmpDir?: string): string {
  let out = text.replaceAll(FAKE_TOKEN, "***");
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
        fakeAbsCoverFetches === fetchesBefore + 1
      ) {
        recordPass("GET /api/cover/item-fake-book-1 (first fetch)");
      } else {
        recordFail(
          "GET /api/cover/item-fake-book-1 (first fetch)",
          `status=${res1.status}, bytes=${bytes1.length}, fetches=${fakeAbsCoverFetches}`,
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
