import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CATEGORIES, categoryOf } from "../src/core/category.ts";
import { loadConfig } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import {
  createDemoConfig,
  DEMO_PARENT_TITLES,
  DEMO_TITLES,
  seedDemoData,
  startDemoServer,
} from "../scripts/demo-server.ts";

describe("demo-server", () => {
  test("creates demo config with covers.external=false and metadata.enabled=false", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-cfg-test-"));
    try {
      const { configPath } = createDemoConfig(dir, 8790);
      const parsedConfig = loadConfig({ path: configPath });
      expect(parsedConfig.covers?.external).toBe(false);
      expect(parsedConfig.metadata?.enabled).toBe(false);
      expect(parsedConfig.server.port).toBe(8790);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("seeds into a temp dir and contains every category", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-cat-test-"));
    const dbPath = join(dir, "inputtracker.db");
    try {
      const db = openDb(dbPath);
      const result = seedDemoData(db, { today: "2026-10-26" });
      expect(result.inserted).toBeGreaterThan(0);
      expect(result.daysSeeded).toBeGreaterThan(90);

      const allEvents = db.query<any, []>("SELECT * FROM events_latest;").all();
      expect(allEvents.length).toBeGreaterThan(0);

      const categoriesSeen = new Set<string>();
      for (const ev of allEvents) {
        categoriesSeen.add(categoryOf(ev));
      }

      for (const cat of CATEGORIES) {
        expect(categoriesSeen.has(cat)).toBe(true);
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same seed produces identical rows", () => {
    const dir1 = mkdtempSync(join(tmpdir(), "demo-seed1-test-"));
    const dir2 = mkdtempSync(join(tmpdir(), "demo-seed2-test-"));
    const db1Path = join(dir1, "inputtracker.db");
    const db2Path = join(dir2, "inputtracker.db");
    try {
      const db1 = openDb(db1Path);
      const db2 = openDb(db2Path);

      seedDemoData(db1, { today: "2026-10-26" });
      seedDemoData(db2, { today: "2026-10-26" });

      const selectSql = `
        SELECT record_hash, source, source_kind, source_id, media_type,
               title, parent_title, season, episode, started_at, duration_seconds, progress
        FROM events
        ORDER BY id ASC;
      `;

      const rows1 = db1.query(selectSql).all();
      const rows2 = db2.query(selectSql).all();

      expect(rows1.length).toBeGreaterThan(0);
      expect(rows1).toEqual(rows2);

      db1.close();
      db2.close();
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("re-running the seed inserts 0 rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-rerun-test-"));
    const dbPath = join(dir, "inputtracker.db");
    try {
      const db = openDb(dbPath);
      const firstRun = seedDemoData(db, { today: "2026-10-26" });
      expect(firstRun.inserted).toBeGreaterThan(0);

      const countBefore = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;")
        .get()?.count;

      const secondRun = seedDemoData(db, { today: "2026-10-26" });
      expect(secondRun.inserted).toBe(0);

      const countAfter = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;")
        .get()?.count;

      expect(countAfter).toBe(countBefore);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("all event titles and parent titles come from the script's own lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-titles-test-"));
    const dbPath = join(dir, "inputtracker.db");
    try {
      const db = openDb(dbPath);
      seedDemoData(db, { today: "2026-10-26" });

      const allowedTitles = new Set<string>([...DEMO_TITLES, ...DEMO_PARENT_TITLES]);
      const allowedParents = new Set<string>(DEMO_PARENT_TITLES);

      const rows = db
        .query<{ title: string | null; parent_title: string | null }, []>(
          "SELECT title, parent_title FROM events;"
        )
        .all();

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        if (row.title !== null) {
          expect(allowedTitles.has(row.title)).toBe(true);
        }
        if (row.parent_title !== null) {
          expect(allowedParents.has(row.parent_title)).toBe(true);
        }
      }

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("starts the HTTP server on port 0 and serves health and library", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-http-test-"));
    let instance: Awaited<ReturnType<typeof startDemoServer>> | undefined;
    try {
      instance = await startDemoServer({
        port: 0,
        dir,
        today: "2026-10-26",
      });

      expect(instance.port).toBeGreaterThan(0);

      const healthRes = await fetch(`http://127.0.0.1:${instance.port}/api/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as { ok: boolean };
      expect(healthJson.ok).toBe(true);

      const libRes = await fetch(`http://127.0.0.1:${instance.port}/api/library`);
      expect(libRes.status).toBe(200);
      const libJson = (await libRes.json()) as { works: any[] };
      expect(libJson.works.length).toBeGreaterThan(0);

      const statuses = new Set(libJson.works.map((w: any) => w.status));
      expect(statuses.has("finished")).toBe(true);
      expect(statuses.has("in_progress")).toBe(true);
      expect(statuses.has("planned")).toBe(true);
    } finally {
      instance?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
