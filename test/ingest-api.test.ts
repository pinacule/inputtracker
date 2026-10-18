/**
 * `POST /api/ingest/youtube-plays` — contract tests on synthetic data.
 *
 * No network, no real config file: the config is a hand-built object with a
 * synthetic ingest token, and every timestamp is fixed in the past.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { createApp } from "../src/server/app.ts";
import type { CalendarResult, StatsResult } from "../src/server/aggregate.ts";
import type { SearchResult } from "../src/server/search.ts";
import { playToEvent, YOUTUBE_MUSIC_PACKAGES } from "../src/server/ingest.ts";

const TOKEN = "synthetic-ingest-token-0123456789abcdef"; // 39 chars, fake
const NOW = Date.parse("2026-10-17T18:03:00.000Z");
const TZ = "Europe/Bratislava";

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://localhost:13378", token: "secret", timeout_s: 20 },
    simkl: { client_id: "", base_url: "https://api.simkl.test", poster_base_url: "https://simkl.in/posters", timeout_s: 20 },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: { desktop: false, ntfy_url: "", ntfy_token: "", app_url: "", weekly_summary: false },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

function validPlay(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    play_id: "0d1f6a2b-9c4e-4a1e-b2f2-5b1f5f5f5f5f",
    app: "com.google.android.youtube",
    title: "Synthetic Video Trick",
    channel: "Synthetic Channel",
    video_id: "aaaaaaaaaaa",
    started_at: "2026-10-17T18:02:11.000Z",
    ended_at: "2026-10-17T18:08:23.000Z",
    watched_seconds: 420,
    media_duration_seconds: 900,
    last_position_seconds: 412,
    ...overrides,
  };
}

function validBody(plays: Record<string, unknown>[] = [validPlay()]): Record<string, unknown> {
  return { device: "phone", plays };
}

describe("POST /api/ingest/youtube-plays", () => {
  let db: Database;
  let tempWebDir: string;

  beforeEach(() => {
    db = openDb(":memory:");
    tempWebDir = mkdtempSync(join(tmpdir(), "inputtracker-test-ingest-"));
    writeFileSync(join(tempWebDir, "index.html"), "<html><body>SPA</body></html>");
  });

  afterEach(() => {
    rmSync(tempWebDir, { recursive: true, force: true });
  });

  function appWithConfig(config = mockConfig({ ingest: { token: TOKEN } })) {
    return { config, app: createApp({ db, config, nowMs: () => NOW }) };
  }

  function post(
    body: string | Record<string, unknown> | unknown[],
    options: {
      app: ReturnType<typeof createApp>;
      token?: string;
      scheme?: string;
      noAuthHeader?: boolean;
      contentLength?: string;
      url?: string;
    }
  ): Promise<Response> {
    const { app, token = TOKEN, scheme, noAuthHeader, contentLength, url = "/api/ingest/youtube-plays" } = options;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (!noAuthHeader) {
      headers["Authorization"] = scheme ? `${scheme} ${token}` : `Bearer ${token}`;
    }
    if (contentLength !== undefined) {
      headers["Content-Length"] = contentLength;
    }
    const bodyText = typeof body === "string" ? body : JSON.stringify(body);
    const request = new Request(`http://localhost${url}`, {
      method: "POST",
      headers,
      body: bodyText,
    });
    const response = app.request(request) as Response | Promise<Response>;
    return Promise.resolve(response);
  }

  function phonePlayCount(): number {
    return (
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM events WHERE source_kind = 'phone_play';"
        )
        .get()?.n ?? 0
    );
  }

  test("disabled (no ingest section) answers 503 and inserts nothing", async () => {
    const { app } = appWithConfig(mockConfig());
    const res = await post(validBody(), { app });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ingest is disabled" });
    expect(phonePlayCount()).toBe(0);
  });

  test("disabled answers 503 before auth is even checked", async () => {
    const { app } = appWithConfig(mockConfig());
    const res = await post(validBody(), { app, noAuthHeader: true });
    expect(res.status).toBe(503);
  });

  test("missing Authorization header → 401, never echoes the token", async () => {
    const { app } = appWithConfig();
    const res = await post(validBody(), { app, noAuthHeader: true });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({ error: "unauthorized" });
  });

  test("wrong token → 401, never echoes the token", async () => {
    const { app } = appWithConfig();
    const wrong = "synthetic-wrong-token-abcdefghijk";
    const res = await post(validBody(), { app, token: wrong });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(wrong);
    expect(phonePlayCount()).toBe(0);
  });

  test("other scheme (Basic) → 401", async () => {
    const { app } = appWithConfig();
    const res = await post(validBody(), { app, scheme: "Basic" });
    expect(res.status).toBe(401);

    // A raw token without the Bearer prefix is rejected too.
    const res2 = await app.request("/api/ingest/youtube-plays", {
      method: "POST",
      headers: { Authorization: TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res2.status).toBe(401);
  });

  test("declared Content-Length over 1 MB → 413", async () => {
    const { app } = appWithConfig();
    const res = await post(validBody(), { app, contentLength: `${1024 * 1024 + 1}` });
    expect(res.status).toBe(413);
    expect(phonePlayCount()).toBe(0);
  });

  test("actual body over 1 MB → 413", async () => {
    const { app } = appWithConfig();
    const filler = "x".repeat(1024 * 1024);
    const body = JSON.stringify({
      device: "phone",
      plays: [{ ...validPlay(), ignored_extra_field: filler }],
    });
    const res = await post(body, { app });
    expect(res.status).toBe(413);
    expect(phonePlayCount()).toBe(0);
  });

  test("unknown query param → 400", async () => {
    const { app } = appWithConfig();
    const res = await post(validBody(), {
      app,
      url: "/api/ingest/youtube-plays?extra=1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown query parameter");
  });

  test("invalid JSON → 400, nothing inserted", async () => {
    const { app } = appWithConfig();
    const res = await post("{not json", { app });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid JSON");
    expect(phonePlayCount()).toBe(0);
  });

  describe("validation rules reject the whole batch with 400", () => {
    const cases: [string, Record<string, unknown> | unknown[]][] = [
      ["device uppercase", { device: "Phone", plays: [validPlay()] }],
      ["device 33 chars", { device: "a".repeat(33), plays: [validPlay()] }],
      ["device double hyphen", { device: "a--b", plays: [validPlay()] }],
      ["plays not an array", { device: "phone", plays: "nope" }],
      ["plays empty", { device: "phone", plays: [] }],
      ["plays 201 items", { device: "phone", plays: Array.from({ length: 201 }, () => validPlay({ play_id: "0d1f6a2b-9c4e-4a1e-b2f2-5b1f5f5f5f5f" })) }],
      ["play not an object", { device: "phone", plays: ["nope"] }],
      ["play_id not a UUID", { device: "phone", plays: [validPlay({ play_id: "not-a-uuid" })] }],
      ["app empty", { device: "phone", plays: [validPlay({ app: "" })] }],
      ["app over 100", { device: "phone", plays: [validPlay({ app: "a".repeat(101) })] }],
      ["app bad chars", { device: "phone", plays: [validPlay({ app: "com google android" })] }],
      ["title empty after trim", { device: "phone", plays: [validPlay({ title: "   \n\t" })] }],
      ["title over 500", { device: "phone", plays: [validPlay({ title: "a".repeat(501) })] }],
      ["title not a string", { device: "phone", plays: [validPlay({ title: 42 })] }],
      ["channel over 200", { device: "phone", plays: [validPlay({ channel: "c".repeat(201) })] }],
      ["channel not a string", { device: "phone", plays: [validPlay({ channel: 42 })] }],
      ["video_id wrong length", { device: "phone", plays: [validPlay({ video_id: "short" })] }],
      ["started_at wrong format", { device: "phone", plays: [validPlay({ started_at: "2026-10-17 18:02:11" })] }],
      ["started_at not UTC Z", { device: "phone", plays: [validPlay({ started_at: "2026-10-17T18:02:11+00:00" })] }],
      ["started_at invalid date", { device: "phone", plays: [validPlay({ started_at: "2026-13-45T99:00:00.000Z" })] }],
      ["started_at 6 min in future", { device: "phone", plays: [validPlay({ started_at: "2026-10-17T18:09:00.000Z", ended_at: "2026-10-17T18:10:00.000Z" })] }],
      ["ended_at before started_at", { device: "phone", plays: [validPlay({ ended_at: "2026-10-17T18:01:11.000Z" })] }],
      ["watched_seconds negative", { device: "phone", plays: [validPlay({ watched_seconds: -1 })] }],
      ["watched_seconds over 86400", { device: "phone", plays: [validPlay({ watched_seconds: 86401 })] }],
      ["watched_seconds float", { device: "phone", plays: [validPlay({ watched_seconds: 41.5 })] }],
      ["watched_seconds string", { device: "phone", plays: [validPlay({ watched_seconds: "420" })] }],
      ["media_duration_seconds float", { device: "phone", plays: [validPlay({ media_duration_seconds: 900.5 })] }],
      ["last_position_seconds string", { device: "phone", plays: [validPlay({ last_position_seconds: "412" })] }],
      ["second play bad names index", { device: "phone", plays: [validPlay(), validPlay({ watched_seconds: 99999 })] }],
    ];

    for (const [name, body] of cases) {
      test(`${name} → 400 and nothing inserted`, async () => {
        const { app } = appWithConfig();
        const res = await post(body, { app });
        expect(res.status).toBe(400);
        const parsed = (await res.json()) as { error: string };
        expect(typeof parsed.error).toBe("string");
        expect(parsed.error.length).toBeGreaterThan(0);
        expect(phonePlayCount()).toBe(0);
      });
    }

    test("the error message names the field and play index", async () => {
      const { app } = appWithConfig();
      const res = await post(
        { device: "phone", plays: [validPlay(), validPlay({ watched_seconds: 99999 })] },
        { app }
      );
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as { error: string };
      expect(parsed.error).toContain("plays[1].watched_seconds must be an integer 0-86400");
    });

    test("started_at more than 5 minutes in the future is rejected, 4 minutes is fine", async () => {
      const { app } = appWithConfig();
      const bad = await post(
        validBody([
          validPlay({
            play_id: "11111111-2222-4333-8444-555555555555",
            started_at: "2026-10-17T18:09:00.000Z",
            ended_at: "2026-10-17T18:11:00.000Z",
          }),
        ]),
        { app }
      );
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { error: string };
      expect(badBody.error).toContain("5 minutes in the future");

      const ok = await post(
        validBody([
          validPlay({
            play_id: "11111111-2222-4333-8444-555555555555",
            started_at: "2026-10-17T18:07:00.000Z",
            ended_at: "2026-10-17T18:11:00.000Z",
          }),
        ]),
        { app }
      );
      expect(ok.status).toBe(200);
      expect(phonePlayCount()).toBe(1);
    });
  });

  test("valid batch → 200 with correct accepted/inserted, mapped event fields", async () => {
    const { app } = appWithConfig();
    const res = await post(
      validBody([
        validPlay(),
        validPlay({
          // Upper-case UUID is accepted and stored lower-cased; no video id.
          play_id: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
          video_id: null,
          channel: "",
          title: "Synthetic Watch Later Item",
          app: "com.bravesoft.brave",
        }),
      ]),
      { app }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, inserted: 2 });
    expect(phonePlayCount()).toBe(2);

    const rows = db
      .query<
        {
          source: string;
          source_kind: string;
          source_id: string;
          media_type: string;
          title: string | null;
          parent_title: string | null;
          started_at: string;
          ended_at: string;
          duration_seconds: number | null;
          progress: number | null;
          device: string | null;
          external_ids: string | null;
        },
        []
      >("SELECT * FROM events WHERE source_kind = 'phone_play' ORDER BY id ASC;")
      .all();

    expect(rows[0]).toMatchObject({
      source: "youtube",
      source_kind: "phone_play",
      source_id: "0d1f6a2b-9c4e-4a1e-b2f2-5b1f5f5f5f5f",
      media_type: "video",
      title: "Synthetic Video Trick",
      parent_title: "Synthetic Channel",
      started_at: "2026-10-17T18:02:11.000Z",
      ended_at: "2026-10-17T18:08:23.000Z",
      duration_seconds: 420,
      device: "phone",
    });
    // progress clamped normally: 412/900
    expect(rows[0]?.progress).toBeCloseTo(412 / 900, 6);
    expect(JSON.parse(rows[0]?.external_ids ?? "{}")).toEqual({
      youtube_video: "aaaaaaaaaaa",
      android_package: "com.google.android.youtube",
    });

    expect(rows[1]).toMatchObject({
      source_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", // lower-cased
      title: "Synthetic Watch Later Item",
      parent_title: null, // "" becomes null
      device: "phone",
    });
    expect(JSON.parse(rows[1]?.external_ids ?? "{}")).toEqual({
      android_package: "com.bravesoft.brave", // youtube_video omitted
    });
  });

  test("identical re-send (differently formatted equivalent timestamps) inserts 0", async () => {
    const { app } = appWithConfig();
    const first = await post(validBody(), { app });
    expect(await first.json()).toEqual({ accepted: 1, inserted: 1 });

    // Same play, started_at/ended_at spelled without the milliseconds.
    const again = await post(
      validBody([
        validPlay({
          started_at: "2026-10-17T18:02:11Z",
          ended_at: "2026-10-17T18:08:23Z",
        }),
      ]),
      { app }
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ accepted: 1, inserted: 0 });
    expect(phonePlayCount()).toBe(1);
  });

  test("same play_id with more watched seconds inserts a new row; events_latest shows it", async () => {
    const { app } = appWithConfig();
    await post(validBody(), { app });
    const grown = await post(
      validBody([
        validPlay({
          ended_at: "2026-10-17T18:12:23.000Z",
          watched_seconds: 600,
          last_position_seconds: 610,
          media_duration_seconds: 900,
        }),
      ]),
      { app }
    );
    expect(grown.status).toBe(200);
    expect(await grown.json()).toEqual({ accepted: 1, inserted: 1 });

    const latest = db
      .query<{ duration_seconds: number; progress: number }, []>(
        "SELECT duration_seconds, progress FROM events_latest WHERE source_kind = 'phone_play';"
      )
      .all();
    expect(latest).toHaveLength(1);
    expect(latest[0]?.duration_seconds).toBe(600);
    expect(latest[0]?.progress).toBeCloseTo(610 / 900, 6);

    // Progress beyond 1 clamps to 1.
    await post(
      validBody([
        validPlay({
          ended_at: "2026-10-17T18:20:00.000Z",
          watched_seconds: 900,
          last_position_seconds: 950,
          media_duration_seconds: 900,
        }),
      ]),
      { app }
    );
    const clamped = db
      .query<{ progress: number | null }, []>(
        "SELECT progress FROM events_latest WHERE source_kind = 'phone_play';"
      )
      .get();
    expect(clamped?.progress).toBe(1);
  });

  test("no media duration or duration 0 → progress null", async () => {
    const { app } = appWithConfig();
    await post(
      validBody([
        validPlay({ media_duration_seconds: null, last_position_seconds: 412, play_id: "11111111-2222-4333-8444-555555555555" }),
        validPlay({ media_duration_seconds: 0, last_position_seconds: 412, play_id: "22222222-2222-4333-8444-555555555555" }),
      ]),
      { app }
    );
    const rows = db
      .query<{ progress: number | null }, []>(
        "SELECT progress FROM events WHERE source_kind = 'phone_play' ORDER BY id;"
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.progress).toBeNull();
    expect(rows[1]?.progress).toBeNull();
  });

  test("out-of-range media duration or position → null, play still accepted", async () => {
    const { app } = appWithConfig();
    const res = await post(
      validBody([
        validPlay({ media_duration_seconds: 86401, last_position_seconds: 412, play_id: "33333333-2222-4333-8444-555555555555" }),
        validPlay({ media_duration_seconds: 900, last_position_seconds: -1, play_id: "44444444-2222-4333-8444-555555555555" }),
      ]),
      { app }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, inserted: 2 });
    const rows = db
      .query<{ progress: number | null }, []>(
        "SELECT progress FROM events WHERE source_kind = 'phone_play' ORDER BY id;"
      )
      .all();
    expect(rows.map((r) => r.progress)).toEqual([null, null]);
  });

  test("an ingest failure marks the run failed and returns 500", async () => {
    const { config } = appWithConfig();
    // Close the database so the insert throws; the response stays generic.
    db.close();
    const res = await post(validBody(), { app: createApp({ db, config }) });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ingest failed");
  });

  test("ingested plays appear in /api/calendar (minutes) and /api/search", async () => {
    const { app } = appWithConfig();
    const res = await post(validBody(), { app });
    expect(res.status).toBe(200);

    const cal = await app.request("/api/calendar?month=2026-10");
    expect(cal.status).toBe(200);
    const calendar = (await cal.json()) as CalendarResult;
    const day = calendar.days.find((d) => d.date === "2026-10-17");
    expect(day).toBeDefined();
    expect(day?.minutes).toBe(7); // watched_seconds 420 → exactly 7 minutes
    expect(day?.items.some((it) => it.title === "Synthetic Video Trick")).toBe(true);

    const searchRes = await app.request("/api/search?q=trick&source=youtube");
    expect(searchRes.status).toBe(200);
    const search = (await searchRes.json()) as SearchResult;
    expect(search.hits.some((h) => h.title === "Synthetic Video Trick" && h.source === "youtube")).toBe(true);
  });

  test("YouTube Music plays are ingested with media_type = music", async () => {
    const { app } = appWithConfig();
    const res = await post(
      validBody([
        validPlay({
          app: "com.google.android.apps.youtube.music",
          title: "Synthetic Song",
          channel: "Synthetic Artist",
        }),
      ]),
      { app }
    );
    expect(res.status).toBe(200);

    const rows = db
      .query<{ media_type: string; title: string; parent_title: string | null }, []>(
        "SELECT media_type, title, parent_title FROM events WHERE source_kind = 'phone_play';"
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].media_type).toBe("music");
    expect(rows[0].title).toBe("Synthetic Song");
    expect(rows[0].parent_title).toBe("Synthetic Artist");
  });
});

describe("playToEvent media_type mapping", () => {
  test("YouTube Music package → music; YouTube and ReVanced → video", () => {
    expect(YOUTUBE_MUSIC_PACKAGES.has("com.google.android.apps.youtube.music")).toBe(true);

    const makePlay = (app: string) => ({
      play_id: "0d1f6a2b-9c4e-4a1e-b2f2-5b1f5f5f5f5f",
      app,
      title: "Synthetic Track",
      channel: "Synthetic Band",
      video_id: "aaaaaaaaaaa",
      started_at: "2026-10-17T18:02:11.000Z",
      ended_at: "2026-10-17T18:08:23.000Z",
      watched_seconds: 420,
      media_duration_seconds: 900,
      last_position_seconds: 412,
    });

    const musicEvent = playToEvent(makePlay("com.google.android.apps.youtube.music"), "phone");
    expect(musicEvent.media_type).toBe("music");
    expect(musicEvent.parent_title).toBe("Synthetic Band");

    const ytEvent = playToEvent(makePlay("com.google.android.youtube"), "phone");
    expect(ytEvent.media_type).toBe("video");
    expect(ytEvent.parent_title).toBe("Synthetic Band");

    const revancedEvent = playToEvent(makePlay("app.revanced.android.youtube"), "phone");
    expect(revancedEvent.media_type).toBe("video");
    expect(revancedEvent.parent_title).toBe("Synthetic Band");
  });
});
