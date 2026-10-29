import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import type { NewEvent } from "../src/core/events.ts";
import { MAX_EVENT_BODY_BYTES } from "../src/core/ingest-events.ts";
import { HttpSink } from "../src/core/sink.ts";
import { createApp } from "../src/server/app.ts";
import { runCli } from "../src/cli/index.ts";
import { loadPushState, lockPushState, pushStatePath, savePushState } from "../src/sources/activitywatch/push-state.ts";

const TOKEN = "synthetic-push-token-000000000000000000000";
const NOW = new Date("2026-10-20T12:00:00.000Z");
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function event(overrides: Partial<NewEvent> = {}): NewEvent {
  return { source: "youtube", source_kind: "aw_play", source_id: "synthetic-day-play",
    external_ids: { youtube_video: "AAAAAAAAAA1" }, media_type: "video", title: "Synthetic clip",
    started_at: "2026-10-20T08:00:00.000Z", ended_at: "2026-10-20T08:06:00.000Z",
    duration_seconds: 360, device: "pc", raw: { bucket: "synthetic-web" }, ...overrides };
}

describe("ActivityWatch event push API and HttpSink", () => {
  let dir: string;
  let db: Database;
  let config: Config;
  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".w14-push-"));
    db = openDb(":memory:");
    const base = loadConfig({ env: {}, path: join(dir, "missing.toml") });
    config = { ...base, storage: { ...base.storage, db_path: join(dir, "cold.db") },
      activitywatch: { ...base.activitywatch!, mode: "push", include_music: true },
      ingest: { token: TOKEN }, push: { server_url: "https://synthetic-server.invalid", token: TOKEN } };
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  function app() { return createApp({ db, config, nowMs: () => NOW.getTime(), afterEventIngest: async () => {} }); }
  function post(body: unknown, authorization: string | null = `Bearer ${TOKEN}`, extraHeaders = {}, url = "/api/ingest/events") {
    return app().request(url, { method: "POST", headers: { "content-type": "application/json",
      ...(authorization ? { authorization } : {}), ...extraHeaders }, body: typeof body === "string" ? body : JSON.stringify(body) });
  }
  function count(table = "events") { return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table};`).get()!.n; }

  test("authenticated retries insert zero; revisions append and latest totals are not history sums", async () => {
    expect(await (await post({ events: [event()] })).json()).toEqual({ accepted: 1, inserted: 1 });
    expect(await (await post({ events: [event()] })).json()).toEqual({ accepted: 1, inserted: 0 });
    expect(await (await post({ events: [event({ duration_seconds: 420 })] })).json()).toEqual({ accepted: 1, inserted: 1 });
    expect(count()).toBe(2);
    expect(count("events_latest")).toBe(1);
    expect(db.query<{ total: number }, []>("SELECT SUM(duration_seconds) AS total FROM events_latest;").get()!.total).toBe(420);
    expect(db.query<{ source: string; kind: string; status: string }, []>("SELECT source, kind, status FROM ingest_runs;").all())
      .toEqual(Array.from({ length: 3 }, () => ({ source: "activitywatch", kind: "push", status: "ok" })));
  });
  test("only permitted video/music and reserved shortform pairs are accepted; short-form is dropped", async () => {
    const events = [event({ media_type: "music", source_id: "synthetic-music" }),
      event({ source_kind: "shortform_day", source_id: "synthetic-shortform", media_type: "other", external_ids: null }),
      event({ source: "activitywatch", source_kind: "shortform_day", source_id: "synthetic-shortform-2", external_ids: null })];
    expect((await post({ events })).status).toBe(200);
    expect(count()).toBe(1);
    expect((await post({ events: [] })).status).toBe(200);
    expect(count("ingest_runs")).toBe(2);
  });
  test("disabled/missing/wrong bearer, schemes and query parameters cannot insert or echo secrets", async () => {
    for (const auth of [null, "Basic synthetic", "Bearer synthetic-wrong", `Bearer ${TOKEN}x`]) {
      const res = await post({ events: [event()] }, auth);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(TOKEN);
    }
    config = { ...config, ingest: { token: "" } };
    expect((await post({ events: [] })).status).toBe(503);
    expect((await post({ events: [] }, null, {}, "/api/ingest/events?unexpected=1")).status).toBe(400);
    expect(count()).toBe(0);
    expect(count("ingest_runs")).toBe(0);
  });
  test("unknown query names cannot echo secrets", async () => {
    const response = await post({ events: [] }, `Bearer ${TOKEN}`, {}, `/api/ingest/events?${TOKEN}=1`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(TOKEN);
  });
  test("invalid fields reject the whole batch before a run or event is inserted", async () => {
    const invalid: Record<string, unknown>[] = [
      { source: "manual" }, { source: ["youtube"] }, { source_kind: "phone_play" },
      { source_id: "" }, { source_id: "x".repeat(513) }, { title: 4 }, { title: "x".repeat(501) },
      { parent_title: "x".repeat(201) }, { device: "x".repeat(33) }, { title: "bad\nvalue" },
      { media_type: "episode" }, { season: 1 }, { episode: 1 },
      { duration_seconds: -1 }, { duration_seconds: 86401 }, { duration_seconds: "360" },
      { progress: 1.1 }, { progress: -0.1 }, { started_at: "2026-02-30T00:00:00.000Z" },
      { started_at: "2026-10-20T14:00:00.000+02:00" }, { started_at: "2026-10-20T12:05:00.001Z" },
      { ended_at: "2026-10-19T08:00:00.000Z" }, { ended_at: "bad" },
      { external_ids: [] }, { external_ids: { youtube_video: "bad" } },
      { external_ids: { youtube_video: "AAAAAAAAAA1", token: "synthetic-secret" } },
      { external_ids: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"])) },
      { external_ids: { youtube_video: "AAAAAAAAAA1", invalid: {} } },
      { raw: [] }, { raw: { deleted: true } }, { raw: { nested: { api_key: "synthetic-secret" } } },
      { raw: { long: "x".repeat(32769) } }, { record_hash: "untrusted" },
    ];
    let deep: unknown = "x";
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    invalid.push({ raw: deep });
    for (const fields of invalid) {
      const res = await post({ events: [event(), { ...event({ source_id: "second" }), ...fields }] });
      expect(res.status, JSON.stringify(Object.keys(fields))).toBe(400);
      expect(await res.text()).not.toContain("synthetic-secret");
      expect(count()).toBe(0);
    }
    for (const body of ["{invalid", [], { events: "bad" }, { events: [], extra: 1 }, { events: Array.from({ length: 201 }, () => event()) }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(count("ingest_runs")).toBe(0);
  });
  test("declared and streaming size caps reject oversized requests without partial inserts", async () => {
    expect((await post({ events: [] }, `Bearer ${TOKEN}`, { "content-length": String(MAX_EVENT_BODY_BYTES + 1) })).status).toBe(413);
    expect((await post(" ".repeat(MAX_EVENT_BODY_BYTES + 1))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_EVENT_BODY_BYTES));
      controller.enqueue(new Uint8Array(1)); controller.close();
    } });
    const request = new Request("http://synthetic.invalid/api/ingest/events", { method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-length": "1" }, body: stream });
    expect((await app().request(request)).status).toBe(413);
    expect(count()).toBe(0);
  });
  test("DB failures roll back the batch and finish a failed run without leaking details", async () => {
    db.run("CREATE TRIGGER synthetic_failure BEFORE INSERT ON events WHEN NEW.source_id = 'second' BEGIN SELECT RAISE(ABORT, 'synthetic-secret'); END;");
    const response = await post({ events: [event(), event({ source_id: "second" })] });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-secret");
    expect(count()).toBe(0);
    expect(db.query<{ status: string }, []>("SELECT status FROM ingest_runs;").get()!.status).toBe("failed");
  });
  test("HttpSink batches by count/bytes, uses bearer/timeout/no redirects and validates acknowledgements", async () => {
    const sizes: number[] = [];
    const fetchMock = (async (input, init) => {
      expect(String(input)).toBe("https://synthetic-server.invalid/api/ingest/events");
      expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(MAX_EVENT_BODY_BYTES);
      const events = JSON.parse(String(init?.body)).events as NewEvent[];
      sizes.push(events.length); return json({ accepted: events.length, inserted: events.length });
    }) as typeof fetch;
    const sink = new HttpSink(config.push!, fetchMock);
    const events = Array.from({ length: 401 }, (_, i) => event({ source_id: `synthetic-${i}` }));
    expect(await sink.write(events, { source: "activitywatch" })).toEqual({ seen: 401, inserted: 401 });
    expect(sizes).toEqual([200, 200, 1]);
    sizes.length = 0;
    await sink.write(Array.from({ length: 40 }, (_, i) => event({ source_id: `large-${i}`, raw: { data: "x".repeat(30000) } })), { source: "activitywatch" });
    expect(sizes.length).toBe(2);
    expect(await sink.write([], { source: "activitywatch" })).toEqual({ seen: 0, inserted: 0 });
    for (const response of [json({ accepted: 0, inserted: 0 }), json({ accepted: 1, inserted: 2 }),
      json({ accepted: 1, inserted: 0.5 }), json({ accepted: 1, inserted: -1 }), json({ accepted: 1 }),
      json({}, 302), json({}, 401), new Response("invalid")]) {
      const bad = new HttpSink(config.push!, (async () => response) as unknown as typeof fetch);
      await expect(bad.write([event()], { source: "activitywatch" })).rejects.toThrow("not acknowledged");
    }
    const bad = new HttpSink(config.push!, (async () => { throw new Error(TOKEN); }) as unknown as typeof fetch);
    await expect(bad.write([event()], { source: "activitywatch" })).rejects.toThrow("ActivityWatch push failed");
    await expect(sink.write([event({ raw: { data: "x".repeat(MAX_EVENT_BODY_BYTES) } })], { source: "activitywatch" })).rejects.toThrow("too large");
    for (const url of ["file:///synthetic", "https://user:pass@synthetic.invalid", "https://synthetic.invalid?secret=1"]) {
      expect(() => new HttpSink({ server_url: url, token: TOKEN }, fetchMock)).toThrow("Invalid push server URL");
    }
    expect(() => new HttpSink({ ...config.push!, token: "short" }, fetchMock)).toThrow("not configured");
  });
  test("server acknowledgement does not wait for enrichment, which is server-owned", async () => {
    let started = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const server = createApp({ db, config, afterEventIngest: async () => { started = true; await pending; } });
    const res = await server.request("/api/ingest/events", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ events: [event()] }) });
    expect(res.status).toBe(200); expect(started).toBe(true); expect(count()).toBe(1);
    release(); await pending;
  });
  test("ingest during active enrichment queues another pass; metadata failures never fail acknowledgement", async () => {
    let calls = 0;
    let active = 0;
    let release!: () => void;
    let completed!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const done = new Promise<void>((resolve) => { completed = resolve; });
    const server = createApp({ db, config, afterEventIngest: async () => {
      calls++;
      active++;
      expect(active).toBe(1);
      if (calls === 1) {
        await gate;
        active--;
        throw new Error("Synthetic metadata outage");
      }
      expect(count()).toBe(3);
      active--;
      completed();
    } });
    for (let i = 0; i < 3; i++) {
      const response = await server.request("/api/ingest/events", { method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ events: [event({ source_id: `synthetic-queued-${i}` })] }) });
      expect(response.status).toBe(200);
    }
    expect(calls).toBe(1);
    release();
    await done;
    expect(calls).toBe(2);
    expect(count("ingest_runs")).toBe(3);
  });
  test("default server enrichment fetches channel/topic/length then caches a music cover via GET only", async () => {
    const requests: string[] = [];
    let coverFetched!: () => void;
    const coverPromise = new Promise<void>((resolve) => { coverFetched = resolve; });
    const fetchMock = (async (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      const url = String(input); requests.push(url);
      if (url.includes("/oembed")) return json({ title: "Synthetic Melody", author_name: "Synthetic Artist", author_url: "https://www.youtube.com/channel/UCsynthetic" });
      if (url.includes("/watch?")) return new Response('<meta itemprop="genre" content="Music"><meta itemprop="duration" content="PT4M">');
      if (url.includes("/search?")) return json({ results: [{ trackId: 901, trackName: "Synthetic Melody", artistName: "Synthetic Artist", artworkUrl100: "https://synthetic-art.invalid/100x100bb.jpg" }] });
      if (url.includes("synthetic-art.invalid")) { coverFetched(); return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }); }
      throw new Error("Unexpected synthetic server request");
    }) as typeof fetch;
    const server = createApp({ db, config, fetchImage: fetchMock });
    const response = await server.request("/api/ingest/events", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ events: [event({ media_type: "music", title: "Synthetic Melody", duration_seconds: 120 })] }) });
    expect(response.status).toBe(200);
    await coverPromise;
    // Wait for the detached cache write, not merely the artwork request.
    let image: string | undefined;
    for (let i = 0; i < 100; i++) {
      image = existsSync(join(dir, "covers"))
        ? readdirSync(join(dir, "covers")).find((name) => name.endsWith(".img"))
        : undefined;
      if (image) break;
      await Bun.sleep(5);
    }
    const enrichment = db.query<{ channel: string; genre: string; length_seconds: number }, []>("SELECT channel, genre, length_seconds FROM youtube_videos_latest;").get();
    expect(enrichment).toEqual({ channel: "Synthetic Artist", genre: "Music", length_seconds: 240 });
    expect(requests.some((url) => url.includes("/search?"))).toBe(true);
    expect(image).toBeDefined();
    expect(new Uint8Array(readFileSync(join(dir, "covers", image!)))).toEqual(new Uint8Array([1, 2, 3]));
    expect(readFileSync(join(dir, "covers", image!.replace(/\.img$/, ".type")), "utf8")).toBe("image/jpeg");
  });
});

describe("PC push cursor persistence and outage handling", () => {
  let dir: string;
  let serverDb: Database;
  let config: Config;
  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".w14-state-"));
    serverDb = openDb(":memory:");
    const base = loadConfig({ env: {}, path: join(dir, "missing.toml") });
    config = { ...base, storage: { ...base.storage, db_path: join(dir, "cold.db") },
      activitywatch: { ...base.activitywatch!, mode: "push", include_music: true },
      ingest: { token: TOKEN }, push: { server_url: "https://synthetic-server.invalid", token: TOKEN } };
    writeFileSync(config.storage.db_path, "untouched synthetic cold archive");
  });
  afterEach(() => { serverDb.close(); rmSync(dir, { recursive: true, force: true }); });

  test("partial chunk failure retries across restarts, retains cursor and sends one failure/recovery alert", async () => {
    const server = createApp({ db: serverDb, config, nowMs: () => NOW.getTime(), afterEventIngest: async () => {} });
    const notifications: string[] = [];
    const errors: string[] = [];
    const windows: string[] = [];
    let fail = true;
    let calls = 0;
    const fetchMock = (async (input, init) => {
      calls++;
      if (fail && calls >= 2) throw new Error(`synthetic outage ${TOKEN}`);
      return server.request(new Request(String(input), init));
    }) as typeof fetch;
    const raw = Array.from({ length: 201 }, (_, i) => ({ id: i, timestamp: "2026-10-20T08:00:00.000Z", duration: 360,
      data: { url: `https://www.youtube.com/watch?v=${String(i).padStart(11, "A")}`, title: "Synthetic clip - YouTube", audible: true } }));
    const client = { getBuckets: async () => ({ "synthetic-web": { id: "synthetic-web", type: "web.tab.current" } }),
      getEvents: async (_bucket: string, start: string) => { windows.push(start); return raw; } };
    const deps = { loadConfig: () => config, fetch: fetchMock, now: NOW,
      createActivityWatchClient: () => client as never,
      openDb: (path: string) => { expect(path).toBe(":memory:"); return openDb(path); },
      buildNotifier: () => ({ notify: async (_title: string, _body: string, kind?: string) => { notifications.push(kind ?? ""); } }),
      out: () => {}, err: (text: string) => { errors.push(text); } };
    expect(await runCli(["push", "activitywatch"], deps)).toBe(2);
    expect(serverDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;").get()!.n).toBe(200);
    const path = pushStatePath(config);
    expect(JSON.parse(readFileSync(path, "utf8")).state.some((row: { source: string }) => row.source === "activitywatch:synthetic-web")).toBe(false);
    expect(await runCli(["push", "activitywatch"], deps)).toBe(2);
    expect(notifications).toEqual(["failure"]);
    fail = false;
    expect(await runCli(["push", "activitywatch"], deps)).toBe(0);
    expect(notifications).toEqual(["failure", "recovery"]);
    expect(serverDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;").get()!.n).toBe(201);
    expect(await runCli(["push", "activitywatch"], deps)).toBe(0);
    expect(notifications).toHaveLength(2);
    expect(windows[0]).toBe("2026-10-13T12:00:00.000Z");
    expect(windows[1]).toBe(windows[0]); expect(windows[2]).toBe(windows[0]);
    expect(windows[3]).toBe("2026-10-19T22:00:00.000Z");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain(TOKEN);
    expect(errors.join(" ")).not.toContain(TOKEN);
    expect(readFileSync(config.storage.db_path, "utf8")).toBe("untouched synthetic cold archive");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
  test("per-day merge/minimum and music policy match pull; PC does not enrich", async () => {
    const sent: NewEvent[] = [];
    const requests: string[] = [];
    const fetchMock = (async (input, init) => {
      requests.push(String(input));
      if (String(input) === "https://synthetic-server.invalid/api/ingest/events") {
        const events = JSON.parse(String(init?.body)).events as NewEvent[]; sent.push(...events);
        return json({ accepted: events.length, inserted: events.length });
      }
      throw new Error("PC attempted enrichment");
    }) as typeof fetch;
    const activity = (video: string, timestamp: string, duration: number, music = false) => ({ timestamp, duration,
      data: { url: `https://${music ? "music" : "www"}.youtube.com/watch?v=${video}`, title: "Synthetic play", audible: true } });
    const client = { getBuckets: async () => ({ "synthetic-web": { type: "web.tab.current" } }),
      getEvents: async () => [activity("AAAAAAAAAA1", "2026-10-20T08:00:00.000Z", 180),
        activity("AAAAAAAAAA1", "2026-10-20T09:00:00.000Z", 180),
        activity("BBBBBBBBBB2", "2026-10-20T10:00:00.000Z", 60),
        activity("CCCCCCCCCC3", "2026-10-20T11:00:00.000Z", 120, true)] };
    expect(await runCli(["push", "activitywatch"], { loadConfig: () => config, fetch: fetchMock, now: NOW,
      createActivityWatchClient: () => client as never, buildNotifier: () => ({ notify: async () => {} }), out: () => {}, err: () => {} })).toBe(0);
    expect(sent).toHaveLength(2);
    expect(sent.find((ev) => ev.media_type === "video")?.duration_seconds).toBe(360);
    expect(sent.find((ev) => ev.media_type === "music")?.duration_seconds).toBe(120);
    expect(requests.every((url) => url.endsWith("/api/ingest/events"))).toBe(true);
  });
  test("lost acknowledgement preserves an existing cursor and retries complete daily totals after a long outage", async () => {
    const stateDb = openDb(":memory:");
    const cursor = "2026-10-10T12:00:00.000Z";
    try {
      stateDb.run("INSERT INTO sync_state(source, cursor, updated_at) VALUES (?, ?, ?);",
        ["activitywatch:synthetic-web", cursor, cursor]);
      savePushState(stateDb, pushStatePath(config));
    } finally { stateDb.close(); }
    const windows: string[] = [];
    const server = createApp({ db: serverDb, config, nowMs: () => NOW.getTime(), afterEventIngest: async () => {} });
    let loseResponse = true;
    const inserted: number[] = [];
    const fetchMock = (async (input, init) => {
      const response = await server.request(new Request(String(input), init));
      const body = await response.clone().json() as { inserted: number };
      inserted.push(body.inserted);
      if (loseResponse) throw new Error("Synthetic lost response");
      return response;
    }) as typeof fetch;
    const client = { getBuckets: async () => ({ "synthetic-web": { type: "web.tab.current" } }),
      getEvents: async (_bucket: string, start: string) => {
        windows.push(start);
        return ["08", "13"].map((hour) => ({ timestamp: `2026-10-10T${hour}:00:00.000Z`, duration: 180,
          data: { url: "https://www.youtube.com/watch?v=AAAAAAAAAA1", title: "Synthetic daily play", audible: true } }));
      } };
    const deps = { loadConfig: () => config, fetch: fetchMock, now: NOW,
      createActivityWatchClient: () => client as never,
      buildNotifier: () => ({ notify: async () => {} }), out: () => {}, err: () => {} };
    expect(await runCli(["push", "activitywatch"], deps)).toBe(2);
    const saved = JSON.parse(readFileSync(pushStatePath(config), "utf8")) as { state: Array<{ source: string; cursor: string }> };
    expect(saved.state.find((row) => row.source === "activitywatch:synthetic-web")?.cursor).toBe(cursor);
    loseResponse = false;
    expect(await runCli(["push", "activitywatch"], deps)).toBe(0);
    expect(windows).toEqual(["2026-10-09T22:00:00.000Z", "2026-10-09T22:00:00.000Z"]);
    expect(inserted).toEqual([1, 0]);
    expect(serverDb.query<{ duration_seconds: number }, []>("SELECT duration_seconds FROM events_latest;").all())
      .toEqual([{ duration_seconds: 360 }]);
    expect(readFileSync(config.storage.db_path, "utf8")).toBe("untouched synthetic cold archive");
  });
  test("push mode skips ActivityWatch client/DB/network on server; invalid push arguments reject", async () => {
    const never = () => { throw new Error("should not be called"); };
    expect(await runCli(["sync", "activitywatch"], { loadConfig: () => config, createActivityWatchClient: never, openDb: never, fetch: never, out: () => {} })).toBe(0);
    for (const args of [["push"], ["push", "simkl"], ["push", "activitywatch", "--since", "2026-10-01"]]) {
      expect(await runCli(args, { loadConfig: never, err: () => {} })).toBe(1);
    }
  });
  test("state round-trips, rejects malformed state and locks concurrent push without touching archive", () => {
    const path = pushStatePath(config);
    const db = openDb(":memory:"); const restored = openDb(":memory:");
    try {
      db.run("INSERT INTO sync_state(source, cursor, updated_at) VALUES (?, ?, ?);", ["activitywatch:synthetic", NOW.toISOString(), NOW.toISOString()]);
      savePushState(db, path); loadPushState(restored, path);
      expect(restored.query("SELECT * FROM sync_state;").all()).toEqual(db.query("SELECT * FROM sync_state;").all());
      const unlock = lockPushState(path);
      expect(() => lockPushState(path)).toThrow("already running"); unlock();
      const unlockAgain = lockPushState(path); unlockAgain();
      writeFileSync(path, "{bad"); expect(() => loadPushState(restored, path)).toThrow("Invalid ActivityWatch push state");
      writeFileSync(path, JSON.stringify({ version: 1, state: [{ source: "untrusted", cursor: "bad", updated_at: "bad" }] }));
      expect(() => loadPushState(restored, path)).toThrow("Invalid ActivityWatch push state");
    } finally { db.close(); restored.close(); }
  });
  test("an abandoned push lock from a exited process is recovered", async () => {
    const owner = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    expect(await owner.exited).toBe(0);
    const path = pushStatePath(config);
    writeFileSync(`${path}.lock`, String(owner.pid));
    const unlock = lockPushState(path);
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(String(process.pid));
    unlock();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
