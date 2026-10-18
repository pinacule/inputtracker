import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import type { Config } from "../src/core/config.ts";
import { createApp } from "../src/server/app.ts";
import { saveAnnotation } from "../src/server/annotations.ts";
import type { TitleHistory } from "../src/server/search.ts";
import type { ProgressLists } from "../src/server/aggregate.ts";
import type { YearReview } from "../src/server/year-review.ts";

const TZ = "Europe/Bratislava";
const NUL = String.fromCharCode(0);
const REV_A = "11111111-1111-4111-8111-111111111111";
const REV_B = "22222222-2222-4222-8222-222222222222";

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
    notify: { desktop: false, ntfy_url: "", ntfy_token: "", app_url: "", weekly_summary: false },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

/**
 * Wraps a Database so tests can count how many annotation SELECTs a request
 * performs. Pass `counted.db` to `createApp`, then read `counted.selects`.
 */
function countingDb(db: Database): { db: Database; selects: { value: number } } {
  const selects = { value: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (sql: string, ...rest: unknown[]) => {
          if (sql.includes("annotations")) {
            selects.value += 1;
          }
          const query = Reflect.get(target, prop, receiver) as (
            sql: string,
            ...args: unknown[]
          ) => unknown;
          return query.call(target, sql, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy as Database, selects };
}

describe("Annotations API (/api/annotations)", () => {
  let db: Database;
  const config = mockConfig();

  beforeEach(() => {
    db = openDb(":memory:");
  });

  test("GET returns nulls for a title with no annotation", async () => {
    const app = createApp({ db, config });
    const res = await app.request(
      "/api/annotations?source=manual&title=Synthetic%20Film"
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rating: null, note: null });
  });

  test("POST creates, GET returns the latest annotation", async () => {
    const app = createApp({ db, config });

    const postRes = await app.request("/api/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "manual",
        title: "Synthetic Film",
        rating: 8,
        note: "A synthetic triumph 🎬",
      }),
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as {
      rev_id: string;
      inserted: boolean;
      annotation: { rating: number; note: string; rev_id: string };
    };
    expect(created.inserted).toBe(true);
    expect(created.rev_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(created.annotation.rating).toBe(8);
    expect(created.annotation.note).toBe("A synthetic triumph 🎬");
    expect(created.annotation.rev_id).toBe(created.rev_id);

    const getRes = await app.request(
      "/api/annotations?source=manual&title=Synthetic%20Film"
    );
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as {
      rating: number;
      note: string;
      rev_id: string;
    };
    expect(got.rating).toBe(8);
    expect(got.note).toBe("A synthetic triumph 🎬");
    expect(got.rev_id).toBe(created.rev_id);
  });

  test("POST update writes a new revision; POST clear nulls both fields", async () => {
    const app = createApp({ db, config });
    const post = (body: unknown) =>
      app.request("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    await post({ source: "manual", title: "Synthetic Film", rating: 5, rev_id: REV_A });
    const upd = await post({
      source: "manual",
      title: "Synthetic Film",
      rating: 9,
      note: "Better the second time",
      rev_id: REV_B,
    });
    expect(upd.status).toBe(201);
    expect(((await upd.json()) as { inserted: boolean }).inserted).toBe(true);

    const cleared = await post({
      source: "manual",
      title: "Synthetic Film",
      rating: null,
      note: null,
    });
    expect(cleared.status).toBe(201);
    const clearedBody = (await cleared.json()) as {
      annotation: { rating: null; note: null };
    };
    expect(clearedBody.annotation.rating).toBeNull();
    expect(clearedBody.annotation.note).toBeNull();
  });

  test("POST with the same rev_id twice inserts once", async () => {
    const app = createApp({ db, config });
    const body = {
      source: "manual",
      title: "Synthetic Film",
      rating: 7,
      rev_id: REV_A,
    };
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    const first = (await (await app.request("/api/annotations", opts)).json()) as {
      inserted: boolean;
    };
    const second = (await (await app.request("/api/annotations", opts)).json()) as {
      inserted: boolean;
    };
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  test("validation failures return 400 with the { error } shape", async () => {
    const app = createApp({ db, config });
    const post = (body: unknown) =>
      app.request("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const badBodies: Array<[string, unknown]> = [
      ["rating -0.1", { source: "manual", title: "T", rating: -0.1 }],
      ["rating 10.1", { source: "manual", title: "T", rating: 10.1 }],
      ["rating 11", { source: "manual", title: "T", rating: 11 }],
      ["rating 7.25", { source: "manual", title: "T", rating: 7.25 }],
      ["rating string", { source: "manual", title: "T", rating: "8" }],
      ["note too long", { source: "manual", title: "T", note: "x".repeat(5001) }],
      ["title too long", { source: "manual", title: "x".repeat(501) }],
      ["empty title", { source: "manual", title: "   " }],
      ["missing title", { source: "manual" }],
      ["source too long", { source: "x".repeat(65), title: "T" }],
      ["missing source", { title: "T" }],
      ["bad rev_id", { source: "manual", title: "T", rev_id: "nope" }],
      ["non-object body", [1, 2, 3]],
    ];
    for (const [label, body] of badBodies) {
      const res = await post(body);
      expect(res.status, label).toBe(400);
      const json = (await res.json()) as { error?: unknown };
      expect(typeof json.error, label).toBe("string");
    }
  });

  test("GET validates its parameters", async () => {
    const app = createApp({ db, config });

    for (const path of [
      "/api/annotations",
      "/api/annotations?source=manual",
      "/api/annotations?title=Synthetic",
      "/api/annotations?source=&title=Synthetic",
      `/api/annotations?source=${"x".repeat(65)}&title=T`,
      "/api/annotations?source=manual&title=T&bogus=1",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(400);
      expect(typeof ((await res.json()) as { error?: unknown }).error).toBe("string");
    }
  });

  test("POST rejects unknown query params and invalid JSON", async () => {
    const app = createApp({ db, config });

    const qp = await app.request("/api/annotations?bogus=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "manual", title: "T" }),
    });
    expect(qp.status).toBe(400);

    const badJson = await app.request("/api/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
    expect(
      typeof ((await badJson.json()) as { error?: unknown }).error
    ).toBe("string");
  });
});

describe("rating in title-history, progress and year-review", () => {
  let db: Database;
  const config = mockConfig();

  beforeEach(() => {
    db = openDb(":memory:");
  });

  function seed(eventsToInsert: NewEvent[]): void {
    const runId = startRun(db, "test-api");
    insertEvents(db, runId, eventsToInsert);
    finishRun(db, runId, {
      status: "ok",
      rowsSeen: eventsToInsert.length,
      rowsInserted: eventsToInsert.length,
    });
  }

  function progressEvent(sourceId: string, overrides: Partial<NewEvent> = {}): NewEvent {
    return {
      source: "audiobookshelf",
      source_kind: "media_progress",
      source_id: sourceId,
      media_type: "audiobook",
      title: `Book ${sourceId}`,
      parent_title: "Synthetic Author",
      started_at: "2026-10-17T08:00:00.000Z",
      progress: 0.5,
      ...overrides,
    };
  }

  test("title-history carries the rating (single lookup)", async () => {
    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Fake Book",
        started_at: "2026-06-01T12:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);
    saveAnnotation(db, {
      source: "audiobookshelf",
      title: "Fake Book",
      rating: 9,
      note: "Loved it",
      rev_id: REV_A,
    });

    const counted = countingDb(db);
    const app = createApp({ db: counted.db, config });
    const key = encodeURIComponent(`audiobookshelf${NUL}Fake Book`);
    const res = await app.request(`/api/title-history?key=${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TitleHistory;
    expect(body.rating).toBe(9);
    // Exactly one annotation lookup for the one title in the response.
    expect(counted.selects.value).toBe(1);
  });

  test("title-history rating is null when unrated", async () => {
    seed([
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Fake Movie",
        started_at: "2026-06-01T12:00:00.000Z",
        duration_seconds: 7200,
      },
    ]);

    const app = createApp({ db, config });
    const key = encodeURIComponent(`manual${NUL}Fake Movie`);
    const res = await app.request(`/api/title-history?key=${key}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as TitleHistory).rating).toBeNull();
  });

  test("progress items carry ratings from one batch lookup", async () => {
    seed([
      progressEvent("p1"),
      progressEvent("p2"),
      // Finished items go to the `finished` list too.
      progressEvent("p3", { progress: 1 }),
      progressEvent("p4", { progress: 1 }),
    ]);
    saveAnnotation(db, {
      source: "audiobookshelf",
      title: "Book p1",
      rating: 8,
      rev_id: REV_A,
    });
    saveAnnotation(db, {
      source: "audiobookshelf",
      title: "Book p4",
      rating: 4,
      rev_id: REV_B,
    });

    const counted = countingDb(db);
    const app = createApp({ db: counted.db, config });
    const res = await app.request("/api/progress");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProgressLists;

    const byTitle = new Map(
      [...body.in_progress, ...body.finished].map((i) => [i.title, i.rating])
    );
    expect(byTitle.get("Book p1")).toBe(8);
    expect(byTitle.get("Book p2")).toBeNull();
    expect(byTitle.get("Book p3")).toBeNull();
    expect(byTitle.get("Book p4")).toBe(4);

    // One batch query for all items, not one query per item.
    expect(counted.selects.value).toBe(1);
  });

  test("year-review top_titles carry ratings from one batch lookup", async () => {
    seed([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "Top Book",
        started_at: "2026-03-01T12:00:00.000Z",
        duration_seconds: 10800,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Top Movie",
        started_at: "2026-04-01T12:00:00.000Z",
        duration_seconds: 7200,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-2",
        media_type: "movie",
        title: "Unrated Movie",
        started_at: "2026-05-01T12:00:00.000Z",
        duration_seconds: 3600,
      },
    ]);
    saveAnnotation(db, {
      source: "audiobookshelf",
      title: "Top Book",
      rating: 10,
      rev_id: REV_A,
    });
    saveAnnotation(db, {
      source: "manual",
      title: "Top Movie",
      rating: 6,
      rev_id: REV_B,
    });

    const counted = countingDb(db);
    const app = createApp({ db: counted.db, config });
    const res = await app.request("/api/year-review?year=2026&date=2026-10-17");
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearReview;

    const byTitle = new Map(body.top_titles.map((t) => [t.title, t.rating]));
    expect(byTitle.get("Top Book")).toBe(10);
    expect(byTitle.get("Top Movie")).toBe(6);
    expect(byTitle.get("Unrated Movie")).toBeNull();

    // One batch query for all top titles, not one query per title.
    expect(counted.selects.value).toBe(1);
  });
});
