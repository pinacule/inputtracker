import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun } from "../src/core/events.ts";
import type { Config } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import type { GoalWithProgress } from "../src/server/goals.ts";

const TZ = "Europe/Bratislava";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
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
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

describe("Goals API (/api/goals)", () => {
  let db: Database;
  const config = mockConfig();

  beforeEach(() => {
    db = openDb(":memory:");
  });

  function seedEvents() {
    const runId = startRun(db, "test-goals-api");
    insertEvents(db, runId, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Synthetic Book",
        started_at: "2026-03-01T12:00:00.000Z",
        duration_seconds: 3600,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Synthetic Movie",
        started_at: "2026-04-01T12:00:00.000Z",
        duration_seconds: 7200,
      },
    ]);
    finishRun(db, runId, { status: "ok", rowsSeen: 2, rowsInserted: 2 });
  }

  test("GET /api/goals defaults to current year and evaluates progress", async () => {
    seedEvents();
    const app = createApp({ db, config });

    // Create a goal for 2026
    const postRes = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: 2026,
        metric: "items",
        target: 20,
      }),
    });
    expect(postRes.status).toBe(201);

    const res = await app.request("/api/goals?date=2026-06-01");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { year: number; goals: GoalWithProgress[] };

    expect(body.year).toBe(2026);
    expect(body.goals).toHaveLength(1);
    expect(body.goals[0]!.target).toBe(20);
    expect(body.goals[0]!.progress.current).toBe(2);
  });

  test("GET /api/goals with year= and date= query params", async () => {
    seedEvents();
    const app = createApp({ db, config });

    await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: 2025,
        metric: "hours",
        target: 50,
      }),
    });

    const res = await app.request("/api/goals?year=2025&date=2026-10-17");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { year: number; goals: GoalWithProgress[] };

    expect(body.year).toBe(2025);
    expect(body.goals).toHaveLength(1);
    expect(body.goals[0]!.year).toBe(2025);
    expect(body.goals[0]!.progress.status).toBe("missed");
  });

  test("archived goals hidden by default and shown with archived=1", async () => {
    const app = createApp({ db, config });

    // Create active goal
    const activeRes = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: 2026,
        metric: "items",
        target: 10,
      }),
    });
    const activeBody = (await activeRes.json()) as { goal_id: string };

    // Create and archive another goal
    const archRes = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: 2026,
        metric: "hours",
        target: 20,
      }),
    });
    const archBody = (await archRes.json()) as { goal_id: string };

    await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal_id: archBody.goal_id,
        year: 2026,
        metric: "hours",
        target: 20,
        archived: 1,
      }),
    });

    // Default GET should only return active goal
    const defaultRes = await app.request("/api/goals?year=2026");
    const defaultBody = (await defaultRes.json()) as { goals: GoalWithProgress[] };
    expect(defaultBody.goals).toHaveLength(1);
    expect(defaultBody.goals[0]!.goal_id).toBe(activeBody.goal_id);

    // With ?archived=1, both goals returned
    const allRes = await app.request("/api/goals?year=2026&archived=1");
    const allBody = (await allRes.json()) as { goals: GoalWithProgress[] };
    expect(allBody.goals).toHaveLength(2);
  });

  test("POST create / change / archive flow", async () => {
    const app = createApp({ db, config });

    // 1. Create
    const createRes = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: 2026,
        metric: "titles",
        target: 15,
        source: "audiobookshelf",
        media_type: "audiobook",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      goal_id: string;
      rev_id: string;
      inserted: boolean;
    };
    expect(created.inserted).toBe(true);
    expect(created.goal_id).toBeDefined();

    // 2. Retry with same rev_id → inserted: false
    const retryRes = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal_id: created.goal_id,
        rev_id: created.rev_id,
        year: 2026,
        metric: "titles",
        target: 15,
        source: "audiobookshelf",
        media_type: "audiobook",
      }),
    });
    expect(retryRes.status).toBe(201);
    const retried = (await retryRes.json()) as { inserted: boolean };
    expect(retried.inserted).toBe(false);

    // 3. Change target to 25
    const changeRes = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal_id: created.goal_id,
        year: 2026,
        metric: "titles",
        target: 25,
      }),
    });
    expect(changeRes.status).toBe(201);
    const changed = (await changeRes.json()) as { inserted: boolean };
    expect(changed.inserted).toBe(true);

    const getRes1 = await app.request("/api/goals?year=2026");
    const getBody1 = (await getRes1.json()) as { goals: GoalWithProgress[] };
    expect(getBody1.goals[0]!.target).toBe(25);

    // 4. Archive
    const archiveRes = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal_id: created.goal_id,
        year: 2026,
        metric: "titles",
        target: 25,
        archived: 1,
      }),
    });
    expect(archiveRes.status).toBe(201);

    const getRes2 = await app.request("/api/goals?year=2026");
    const getBody2 = (await getRes2.json()) as { goals: GoalWithProgress[] };
    expect(getBody2.goals).toHaveLength(0);
  });

  test("POST validation returns 400 for bad inputs", async () => {
    const app = createApp({ db, config });

    const badPayloads = [
      {}, // missing year, metric, target
      { year: 1999, metric: "items", target: 10 }, // year < 2000
      { year: 2101, metric: "items", target: 10 }, // year > 2100
      { year: "2026", metric: "items", target: 10 }, // year not number
      { year: 2026.5, metric: "items", target: 10 }, // year float
      { year: 2026, metric: "invalid_metric", target: 10 }, // invalid metric
      { year: 2026, metric: "items", target: 0 }, // target <= 0
      { year: 2026, metric: "items", target: -5 }, // negative target
      { year: 2026, metric: "items", target: 1_000_001 }, // target > 1,000,000
      { year: 2026, metric: "items", target: NaN }, // NaN target
      { year: 2026, metric: "items", target: Infinity }, // Infinity target
      { year: 2026, metric: "items", target: 10, source: "a".repeat(65) }, // source > 64 chars
      { year: 2026, metric: "items", target: 10, media_type: "unknown_media" }, // invalid media_type
      { year: 2026, metric: "items", target: 10, goal_id: "not-a-uuid" }, // bad goal_id
      { year: 2026, metric: "items", target: 10, rev_id: "not-a-uuid" }, // bad rev_id
      { year: 2026, metric: "items", target: 10, archived: 2 }, // invalid archived
    ];

    for (const body of badPayloads) {
      const res = await app.request("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error?: string };
      expect(json.error).toBeDefined();
    }

    // Invalid JSON text
    const invalidJsonRes = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });
    expect(invalidJsonRes.status).toBe(400);
  });

  test("POST returns 404 for unknown goal_id", async () => {
    const app = createApp({ db, config });

    const res = await app.request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal_id: "e0000000-0000-0000-0000-000000000099",
        year: 2026,
        metric: "items",
        target: 10,
      }),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain("Goal not found");
  });

  test("unknown query parameters return 400", async () => {
    const app = createApp({ db, config });

    // Unknown param on GET
    const getRes = await app.request("/api/goals?foo=bar");
    expect(getRes.status).toBe(400);
    const getJson = (await getRes.json()) as { error: string };
    expect(getJson.error).toContain("Unknown query parameter: 'foo'");

    // Invalid year format on GET
    const badYearRes = await app.request("/api/goals?year=abc");
    expect(badYearRes.status).toBe(400);

    // Invalid date format on GET
    const badDateRes = await app.request("/api/goals?date=2026-02-30");
    expect(badDateRes.status).toBe(400);

    // Unknown param on POST
    const postRes = await app.request("/api/goals?extra=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: 2026, metric: "items", target: 10 }),
    });
    expect(postRes.status).toBe(400);
    const postJson = (await postRes.json()) as { error: string };
    expect(postJson.error).toContain("Unknown query parameter: 'extra'");
  });
});
