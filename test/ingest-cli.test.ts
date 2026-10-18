/**
 * `it ingest token|status` and the `it doctor` ingest line — synthetic config,
 * no network, no real files written.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { generateIngestToken, runCli } from "../src/cli/index.ts";
import { runDoctor, type DoctorDeps, type DoctorRunResult } from "../src/cli/doctor.ts";
import { openDb } from "../src/core/db.ts";
import { insertEvents, startRun } from "../src/core/events.ts";
import type { EventRow } from "../src/core/schema.ts";
import { playToEvent } from "../src/server/ingest.ts";

const FAKE_INGEST_TOKEN = "synthetic-ingest-token-0123456789abcdef"; // 39 chars

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: "Europe/Bratislava",
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

describe("it ingest token", () => {
  test("prints a 43-char base64url token and the hint, exits 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["ingest", "token"], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      // The command must not read the config; a throwing loader proves that.
      loadConfig: () => {
        throw new Error("config must not be read");
      },
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out[1]).toBe(
      "add it to [ingest] token in your config, then restart the server"
    );
  });

  test("generateIngestToken yields a fresh value on every call", () => {
    const a = generateIngestToken();
    const b = generateIngestToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("it ingest status", () => {
  test("disabled (empty token) — never prints the token", async () => {
    const out: string[] = [];
    const code = await runCli(["ingest", "status"], {
      out: (l) => out.push(l),
      err: () => {},
      loadConfig: () => mockConfig(),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["ingest: disabled"]);
    expect(out.join("\n")).not.toContain(FAKE_INGEST_TOKEN);
  });

  test("enabled — prints only the status line", async () => {
    const out: string[] = [];
    const code = await runCli(["ingest", "status"], {
      out: (l) => out.push(l),
      err: () => {},
      loadConfig: () => mockConfig({ ingest: { token: FAKE_INGEST_TOKEN } }),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["ingest: enabled"]);
    expect(out.join("\n")).not.toContain(FAKE_INGEST_TOKEN);
  });

  test("a config load failure exits 2", async () => {
    const err: string[] = [];
    const code = await runCli(["ingest", "status"], {
      out: () => {},
      err: (l) => err.push(l),
      loadConfig: () => {
        throw new Error("config unreadable");
      },
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("config unreadable");
  });

  test("unknown subcommand → usage error", async () => {
    const err: string[] = [];
    const code = await runCli(["ingest", "frobnicate"], {
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Usage: it ingest token|status|remap");
  });
});

describe("it ingest remap", () => {
  test("remaps stored video phone plays for YouTube Music to music in an append-only run", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "it-remap-test-"));
    const dbPath = join(tempDir, "test.db");

    try {
      const db = openDb(dbPath);

      const play1 = {
        play_id: "11111111-1111-4111-8111-111111111111",
        app: "com.google.android.apps.youtube.music",
        title: "Synthetic Song 1",
        channel: "Artist 1",
        video_id: "vidmusic001",
        started_at: "2026-10-17T18:00:00.000Z",
        ended_at: "2026-10-17T18:05:00.000Z",
        watched_seconds: 300,
        media_duration_seconds: 300,
        last_position_seconds: 300,
      };
      const play2 = {
        play_id: "22222222-2222-4222-8222-222222222222",
        app: "com.google.android.apps.youtube.music",
        title: "Synthetic Song 2",
        channel: "Artist 2",
        video_id: "vidmusic002",
        started_at: "2026-10-17T18:10:00.000Z",
        ended_at: "2026-10-17T18:15:00.000Z",
        watched_seconds: 300,
        media_duration_seconds: 300,
        last_position_seconds: 300,
      };
      const play3 = {
        play_id: "33333333-3333-4333-8333-333333333333",
        app: "com.google.android.youtube",
        title: "Synthetic Video 3",
        channel: "Channel 3",
        video_id: "vidvideo003",
        started_at: "2026-10-17T18:20:00.000Z",
        ended_at: "2026-10-17T18:25:00.000Z",
        watched_seconds: 300,
        media_duration_seconds: 300,
        last_position_seconds: 300,
      };

      // Seed two synthetic music plays stored as video + one YouTube play
      const runId = startRun(db, "youtube", "phone");
      insertEvents(db, runId, [
        { ...playToEvent(play1, "phone"), media_type: "video" },
        { ...playToEvent(play2, "phone"), media_type: "video" },
        playToEvent(play3, "phone"),
      ]);

      const initialEvents = db.query<EventRow, []>("SELECT * FROM events ORDER BY id ASC;").all();
      expect(initialEvents).toHaveLength(3);
      expect(initialEvents.every((e) => e.media_type === "video")).toBe(true);
      db.close();

      const config = mockConfig({ storage: { db_path: dbPath, backup_dir: "/tmp", backup_keep: 14 } });

      // First remap run
      const out1: string[] = [];
      const code1 = await runCli(["ingest", "remap"], {
        out: (l) => out1.push(l),
        err: () => {},
        loadConfig: () => config,
      });
      expect(code1).toBe(0);
      expect(out1).toEqual(["remapped 2 of 3 phone plays"]);

      const dbAfter1 = openDb(dbPath);
      // Events table is append-only: 3 initial + 2 new = 5 rows
      const allEventsAfter1 = dbAfter1.query<EventRow, []>("SELECT * FROM events ORDER BY id ASC;").all();
      expect(allEventsAfter1).toHaveLength(5);
      // Old rows are untouched
      expect(allEventsAfter1[0].media_type).toBe("video");
      expect(allEventsAfter1[1].media_type).toBe("video");
      expect(allEventsAfter1[2].media_type).toBe("video");

      // events_latest picks the new music rows and the unchanged video row
      const latestAfter1 = dbAfter1.query<EventRow, []>("SELECT * FROM events_latest ORDER BY source_id ASC;").all();
      expect(latestAfter1).toHaveLength(3);
      const music1 = latestAfter1.find((e) => e.source_id === "11111111-1111-4111-8111-111111111111");
      const music2 = latestAfter1.find((e) => e.source_id === "22222222-2222-4222-8222-222222222222");
      const video3 = latestAfter1.find((e) => e.source_id === "33333333-3333-4333-8333-333333333333");
      expect(music1?.media_type).toBe("music");
      expect(music2?.media_type).toBe("music");
      expect(video3?.media_type).toBe("video");
      dbAfter1.close();

      // Second remap run inserts 0
      const out2: string[] = [];
      const code2 = await runCli(["ingest", "remap"], {
        out: (l) => out2.push(l),
        err: () => {},
        loadConfig: () => config,
      });
      expect(code2).toBe(0);
      expect(out2).toEqual(["remapped 0 of 3 phone plays"]);

      const dbAfter2 = openDb(dbPath);
      const allEventsAfter2 = dbAfter2.query<EventRow, []>("SELECT * FROM events ORDER BY id ASC;").all();
      expect(allEventsAfter2).toHaveLength(5);
      dbAfter2.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("extra argument → usage error", async () => {
    const err: string[] = [];
    const code = await runCli(["ingest", "remap", "extra"], {
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unexpected argument: extra");
  });
});

describe("it doctor ingest line", () => {
  const lines: string[] = [];
  function deps(config: Config): DoctorDeps {
    return {
      arch: "x64",
      bunVersion: "1.2.3",
      loadConfig: () => config,
      exists: () => false,
      isWritableDir: () => true,
      which: () => null,
      run: (): DoctorRunResult => ({ code: 0, stdout: "" }),
      isPortFree: () => true,
      env: {},
      user: "tester",
      out: (line) => lines.push(line),
    };
  }

  test("ingest: disabled when the token is empty", async () => {
    lines.length = 0;
    await runDoctor(deps(mockConfig()));
    expect(lines.join("\n")).toContain("ingest: disabled");
    expect(lines.join("\n")).not.toContain(FAKE_INGEST_TOKEN);
  });

  test("ingest: enabled with a token, never the value", async () => {
    lines.length = 0;
    await runDoctor(deps(mockConfig({ ingest: { token: FAKE_INGEST_TOKEN } })));
    expect(lines.join("\n")).toContain("ingest: enabled");
    expect(lines.join("\n")).not.toContain(FAKE_INGEST_TOKEN);
  });
});
