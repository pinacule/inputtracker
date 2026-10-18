import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { WorkDetails } from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import { saveArchiveEntry } from "../src/server/archive.ts";
import { refreshAllArchiveMetadata } from "../src/server/library.ts";

function work(id: string, title: string): WorkDetails {
  return {
    provider: "tvmaze",
    provider_id: id,
    category: "series",
    title,
    original_title: null,
    year: 2015,
    cover_url: null,
    creators: [],
    genres: [],
    description: null,
    seasons: [
      { number: 1, title: null, year: 2015, episodes: 2, episode_minutes: 60, total_minutes: 120, provider_id: null },
    ],
    runtime_minutes: null,
    pages: null,
    external_ids: { tvmaze: id },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** TVmaze answers for a synthetic two-episode show with 30-minute episodes. */
function show(id: number, title: string, url: string): Response | null {
  if (url.endsWith(`/shows/${id}`)) return json({ id, name: title, premiered: "2015-01-01", runtime: 30 });
  if (url.endsWith(`/shows/${id}/seasons`)) return json([{ id: 1, number: 1, episodeOrder: 2, premiereDate: "2015-01-01" }]);
  if (url.endsWith(`/shows/${id}/episodes`))
    return json([1, 2].map((n) => ({ id: n, season: 1, number: n, type: "regular", runtime: 30 })));
  return null;
}

describe("bulk archive refresh-metadata keeps going when a provider fails", () => {
  let dir: string;
  let db: Database;
  let config: Config;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "it-refresh-bulk-"));
    const dbPath = join(dir, "inputtracker.db");
    db = openDb(dbPath);
    const base = loadConfig({ env: {}, path: join(dir, "missing.toml") });
    config = {
      ...base,
      storage: { ...base.storage, db_path: dbPath },
      metadata: { ...base.metadata, enabled: true, tvmaze_url: "https://tvmaze.invalid", cinemeta_url: "https://cinemeta.invalid" },
    } as Config;
    for (const [entry, id, title] of [
      ["11111111-1111-4111-8111-111111111111", "901", "Synthetic Throttled Show"],
      ["22222222-2222-4222-8222-222222222222", "902", "Synthetic Broken Show"],
    ] as const) {
      saveArchiveEntry(
        db,
        { entry_id: entry, work: work(id, title), consumed: { seasons: [{ number: 1 }] }, when: { precision: "unknown" } },
        "Europe/Bratislava"
      );
    }
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a 429 is retried after a wait; a persistent failure is reported and the rest still refreshes", async () => {
    let throttled = 1;
    const waits: number[] = [];
    const fetchMock = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/shows/901") && throttled > 0) {
        throttled -= 1;
        return json({ message: "Too Many Requests" }, 429);
      }
      if (url.includes("/shows/902")) return json({ message: "boom" }, 500);
      return show(901, "Synthetic Throttled Show", url) ?? json({}, 404);
    }) as unknown as typeof fetch;

    const results = await refreshAllArchiveMetadata(db, {
      config,
      fetch: fetchMock,
      dryRun: true,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    const throttledShow = results.find((r) => r.title === "Synthetic Throttled Show");
    const brokenShow = results.find((r) => r.title === "Synthetic Broken Show");
    expect(throttledShow?.error).toBeUndefined();
    expect(throttledShow?.changed).toBe(true);
    expect(Math.round(throttledShow?.minutes_after ?? 0)).toBe(60);
    expect(brokenShow?.error).toBeDefined();
    expect(brokenShow?.changed).toBe(false);
    expect(waits).toContain(30_000);
  });
});
