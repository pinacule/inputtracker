/**
 * `client_id` on `POST /api/events`: idempotent manual entry for the phone's
 * offline queue. Synthetic data only, through the HTTP app like the other API
 * tests, with a `:memory:` database.
 */

import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { createApp } from "../src/server/app.ts";
import type { EventRow } from "../src/core/schema.ts";

const TZ = "Europe/Bratislava";

/** Uppercase on purpose: the server must normalise it to lowercase. */
const CLIENT_ID = "0123ABCD-89EF-4ABC-9DEF-0123456789AB";
const CLIENT_SOURCE_ID = "client:0123abcd-89ef-4abc-9def-0123456789ab";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mockConfig(): Config {
  const cfg = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://localhost:13378", token: "secret", timeout_s: 20 },
    simkl: {
      client_id: "",
      base_url: "https://api.simkl.test",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: { desktop: false, ntfy_url: "" },
  };
  return cfg as unknown as Config;
}

function manualBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    media_type: "movie",
    title: "Synthetic Movie",
    started_at: "2026-10-17 21:30",
    ...overrides,
  };
}

async function postEvent(
  app: Hono,
  body: unknown
): Promise<Response> {
  return app.request("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function count(db: Database, table: string): number {
  return (
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table};`).get()?.n ?? 0
  );
}

describe("POST /api/events with client_id", () => {
  test("stores source_id = client:<lowercase uuid> and responds with it", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, config: mockConfig() });

    const res = await postEvent(app, manualBody({ client_id: CLIENT_ID }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; inserted: number };
    expect(body.inserted).toBe(1);
    expect(body.id).toBe(CLIENT_SOURCE_ID);

    const row = db.query<EventRow, []>("SELECT * FROM events;").get();
    expect(row?.source).toBe("manual");
    expect(row?.source_kind).toBe("history_item");
    expect(row?.source_id).toBe(CLIENT_SOURCE_ID);
    expect(row?.started_at).toBe("2026-10-17T19:30:00.000Z");
    db.close();
  });

  test("sending the same body twice inserts one row (201 + inserted: 0)", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, config: mockConfig() });
    const body = manualBody({ client_id: CLIENT_ID });

    const first = await postEvent(app, body);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { inserted: number };
    expect(firstBody.inserted).toBe(1);

    const second = await postEvent(app, body);
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { inserted: number };
    expect(secondBody.inserted).toBe(0);

    expect(count(db, "events")).toBe(1);
    expect(count(db, "events_latest")).toBe(1);
    // Each attempt records its own (failed-to-insert) ingest run.
    expect(count(db, "ingest_runs")).toBe(2);
    db.close();
  });

  test("an invalid client_id is a 400 with no row and no ingest run", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, config: mockConfig() });

    for (const invalid of ["not-a-uuid", "", "0123abcd-89ef-4abc-9def", 12345]) {
      const res = await postEvent(app, manualBody({ client_id: invalid }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/client_id/i);
    }

    expect(count(db, "events")).toBe(0);
    expect(count(db, "ingest_runs")).toBe(0);
    db.close();
  });

  test("without client_id the behaviour is unchanged (random UUID source_id)", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, config: mockConfig() });

    const res = await postEvent(app, manualBody());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; inserted: number };
    expect(body.inserted).toBe(1);
    expect(body.id).toMatch(UUID_RE);
    expect(body.id.startsWith("client:")).toBe(false);

    const row = db.query<EventRow, []>("SELECT * FROM events;").get();
    expect(row?.source_id).toBe(body.id);
    expect(count(db, "events")).toBe(1);
    db.close();
  });

  test("the same client_id with a different body is a different event", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, config: mockConfig() });

    const first = await postEvent(
      app,
      manualBody({ client_id: CLIENT_ID, title: "Synthetic First" })
    );
    const second = await postEvent(
      app,
      manualBody({ client_id: CLIENT_ID, title: "Synthetic Second" })
    );
    expect(((await first.json()) as { inserted: number }).inserted).toBe(1);
    expect(((await second.json()) as { inserted: number }).inserted).toBe(1);
    expect(count(db, "events")).toBe(2);
    db.close();
  });
});
