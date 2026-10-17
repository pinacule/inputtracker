/**
 * `it notify test|weekly` and backup alert CLI tests.
 *
 * Synthetic data only; `fetch` is mocked, the database is a tmp file, and the
 * clock is fixed via `deps.now`. Nothing here touches the network or the real
 * user config.
 */

import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { localToUtcIso } from "../src/io/manual.ts";
import type { Notifier } from "../src/notify/types.ts";
import { formatLocalParts } from "../src/server/aggregate.ts";

const TZ = "Europe/Bratislava";
const NTFY_URL = "https://ntfy.example/synthetic-topic-with-secret-name";
const TOKEN = "tk_synthetic_access_token_123456";

/** The fixed test clock: a Saturday afternoon in the config timezone. */
const NOW = new Date("2026-10-17T12:00:00.000Z"); // 2026-10-17 14:00 local

// --- helpers -----------------------------------------------------------------

function mockConfig(notify: Partial<Config["notify"]>, dbPath = ":memory:"): Config {
  return {
    timezone: TZ,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: dbPath,
      backup_dir: "/tmp/synthetic-backups",
      backup_keep: 14,
    },
    audiobookshelf: { url: "http://abs.test:13378", token: "", timeout_s: 20 },
    notify: {
      desktop: false,
      ntfy_url: "",
      ntfy_token: "",
      app_url: "",
      weekly_summary: false,
      ...notify,
    },
    toJSON: () => ({}),
    toString: () => "",
  } as Config;
}

interface FetchCall {
  input: string;
  init?: RequestInit;
}

/**
 * Swap globalThis.fetch for a recording mock. Returns the recorded calls and a
 * restore function the caller must invoke (try/finally).
 */
function useFetchMock(
  handler: (calls: FetchCall[]) => Response | never
): { calls: FetchCall[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return handler(calls);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

function outputBuffers() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
}

/** One tmp file database, shared lazily; `makeTempDb` returns a fresh handle. */
let tempDbDir = "";
let tempDbPath = "";

function makeTempDb(): Database {
  if (tempDbDir === "") {
    tempDbDir = mkdtempSync(join(tmpdir(), "it-notify-cli-"));
    tempDbPath = join(tempDbDir, "synthetic.db");
  }
  return openDb(tempDbPath);
}

/** Insert one synthetic consumption event at a local wall-clock time. */
function seedEvent(
  db: Database,
  title: string,
  local: string,
  durationSeconds: number
): void {
  const hash = `syn-${title.replace(/\W+/g, "-").toLowerCase()}-${local}`;
  db.run(
    `INSERT INTO events
       (record_hash, source, source_kind, source_id, media_type, title,
        started_at, duration_seconds, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      hash,
      "synthsource",
      "watch",
      `sid-${hash}`,
      "movie",
      title,
      localToUtcIso(local, TZ),
      durationSeconds,
      "2026-10-17T18:00:00.000Z",
    ]
  );
}

// --- `it notify test` --------------------------------------------------------

describe("it notify test", () => {
  test("no configured channel exits 1 and never fetches", async () => {
    const { calls, restore } = useFetchMock(() => new Response("", { status: 200 }));
    try {
      const { out, deps } = outputBuffers();

      const code = await runCli(["notify", "test"], {
        loadConfig: () => mockConfig({ desktop: false }),
        ...deps,
      });

      expect(code).toBe(1);
      expect(out.join("\n")).toContain("No notification channel is configured");
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("a working ntfy channel exits 0 and prints only the channel name", async () => {
    const { calls, restore } = useFetchMock(() => new Response("", { status: 200 }));
    try {
      const { out, deps } = outputBuffers();

      const code = await runCli(["notify", "test"], {
        loadConfig: () => mockConfig({ ntfy_url: NTFY_URL, ntfy_token: TOKEN }),
        ...deps,
      });

      const printed = out.join("\n");
      expect(code).toBe(0);
      expect(printed).toContain("ntfy: ok");
      expect(printed).not.toContain(NTFY_URL);
      expect(printed).not.toContain(TOKEN);
      expect(printed).not.toContain("synthetic-topic");

      const headers = calls[0]?.init?.headers as Record<string, string>;
      expect(headers.Title).toBe("InputTracker test notification");
    } finally {
      restore();
    }
  });

  test("a broken channel exits 2, prints 'failed' and no url or token", async () => {
    const { restore } = useFetchMock(() => {
      throw new Error(`connect ECONNREFUSED ${NTFY_URL} ${TOKEN}`);
    });
    try {
      const { out, deps } = outputBuffers();

      const code = await runCli(["notify", "test"], {
        loadConfig: () => mockConfig({ ntfy_url: NTFY_URL, ntfy_token: TOKEN }),
        sleep: async () => {}, // skip the 2 s retry wait
        ...deps,
      });

      const printed = out.join("\n");
      expect(code).toBe(2);
      expect(printed).toContain("ntfy: failed");
      expect(printed).not.toContain(NTFY_URL);
      expect(printed).not.toContain(TOKEN);
      expect(printed).not.toContain("synthetic-topic");
    } finally {
      restore();
    }
  });
});

// --- `it notify weekly` ------------------------------------------------------

describe("it notify weekly", () => {
  test("disabled by default: prints 'weekly summary disabled', sends nothing", async () => {
    const { calls, restore } = useFetchMock(() => new Response("", { status: 200 }));
    try {
      const { out, deps } = outputBuffers();

      const code = await runCli(["notify", "weekly"], {
        loadConfig: () => mockConfig({ ntfy_url: NTFY_URL }),
        now: NOW,
        ...deps,
      });

      expect(code).toBe(0);
      expect(out.join("\n")).toContain("weekly summary disabled");
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("enabled: builds the 7-local-day window text and sends it once", async () => {
    const { calls, restore } = useFetchMock(() => new Response("", { status: 200 }));
    try {
      const db = makeTempDb();
      // In-window events (window: 2026-10-11 .. 2026-10-17 local).
      seedEvent(db, "Synthetic Alpha", "2026-10-17 13:00", 5_400); // 90 min
      seedEvent(db, "Synthetic Beta", "2026-10-17 09:00", 1_800); // 30 min
      seedEvent(db, "Synthetic Gamma", "2026-10-11 15:00", 1_800); // 30 min
      // Window boundary: local midnight of 2026-10-11 is included.
      seedEvent(db, "Synthetic Delta", "2026-10-11 00:05", 600); // 10 min
      // Out of the window: 2026-10-10 local (the 8th day back) is excluded.
      seedEvent(db, "Synthetic Old", "2026-10-10 22:30", 3_600); // 60 min
      // Far outside.
      seedEvent(db, "Synthetic Ancient", "2026-10-05 10:00", 3_600);
      db.close();
      // Sanity: the seeded instants really land on the intended local day
      // (CEST = UTC+2 in October 2026).
      expect(formatLocalParts("2026-10-17T11:00:00.000Z", TZ).date).toBe("2026-10-17");
      expect(formatLocalParts("2026-10-10T20:30:00.000Z", TZ).date).toBe("2026-10-10");
      expect(formatLocalParts("2026-10-10T22:05:00.000Z", TZ).date).toBe(
        "2026-10-11"
      ); // the Midnight Delta event straddles into the window
      expect(NOW.toISOString()).toBe("2026-10-17T12:00:00.000Z");

      const { out, deps } = outputBuffers();

      const code = await runCli(["notify", "weekly"], {
        loadConfig: () =>
          mockConfig(
            { ntfy_url: NTFY_URL, ntfy_token: TOKEN, weekly_summary: true },
            tempDbPath
          ),
        now: NOW,
        ...deps,
      });

      const printed = out.join("\n");
      expect(code).toBe(0);
      expect(printed).toContain("ntfy: sent");
      expect(printed).not.toContain(NTFY_URL);
      expect(printed).not.toContain(TOKEN);

      expect(calls).toHaveLength(1);
      const headers = calls[0]?.init?.headers as Record<string, string>;
      expect(headers.Title).toBe("InputTracker weekly summary");
      expect(headers.Priority).toBe("low");
      expect(headers.Tags).toBe("bar_chart");

      const body = calls[0]?.init?.body as string;
      // Window and totals: 90 + 30 + 30 + 10 = 160 min across 4 items.
      expect(body).toContain("Last 7 days (2026-10-11 to 2026-10-17)");
      expect(body).toContain("2.7 h across 4 items");
      expect(body).toContain("synthsource: 2.7 h, 4 items");
      // Top 3 titles with durations; the 10-minute item ranks 4th and is cut.
      expect(body).toContain(
        "Top: Synthetic Alpha (1h 30m), Synthetic Beta (30 min), Synthetic Gamma (30 min)"
      );
      expect(body).not.toContain("Synthetic Delta");
      // Out-of-window events never appear.
      expect(body).not.toContain("Synthetic Old");
      expect(body).not.toContain("Synthetic Ancient");
      // Current streak as of the fixed today.
      expect(body).toContain("Streak: 1 day");
    } finally {
      restore();
      if (tempDbDir !== "") {
        rmSync(tempDbDir, { recursive: true, force: true });
        tempDbDir = "";
        tempDbPath = "";
      }
    }
  });

  test("enabled but no channel configured exits 1", async () => {
    const { out, deps } = outputBuffers();

    const code = await runCli(["notify", "weekly"], {
      loadConfig: () => mockConfig({ desktop: false, weekly_summary: true }),
      now: NOW,
      ...deps,
    });

    const printed = out.join("\n");
    expect(code).toBe(1);
    expect(printed).toContain("No notification channel is configured");
  });
});

// --- backup failure alerts ---------------------------------------------------

class RecordingNotifier implements Notifier {
  readonly calls: Array<{ title: string; body: string }> = [];

  async notify(title: string, body: string): Promise<void> {
    this.calls.push({ title, body });
  }
}

const FAKE_BACKUP = {
  dbPath: "/tmp/synthetic-backups/inputtracker-2026-10-17.db",
  jsonPath: "/tmp/synthetic-backups/inputtracker-2026-10-17.json",
  pruned: [] as string[],
};

describe("backup failure alerts (once per outage)", () => {
  test("failure notifies once, a second failure is silent, success notifies once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "it-backup-alerts-"));
    try {
      const dbPath = join(dir, "synthetic.db");
      const notifier = new RecordingNotifier();
      let outcome: "fail" | "ok" = "fail";

      const runOne = (): Promise<number> =>
        runCli(["backup"], {
          loadConfig: () => mockConfig({}, dbPath),
          runBackup: () => {
            if (outcome === "fail") {
              throw new Error("synthetic backup failure");
            }
            return FAKE_BACKUP;
          },
          buildNotifier: () => notifier,
          out: () => {},
          err: () => {},
        });

      const code1 = await runOne(); // first failure -> one alert
      const code2 = await runOne(); // second failure -> silent
      outcome = "ok";
      const code3 = await runOne(); // recovery -> one notice

      expect(code1).toBe(2);
      expect(code2).toBe(2);
      expect(code3).toBe(0);
      expect(notifier.calls).toHaveLength(2);
      expect(notifier.calls[0]?.title).toBe("backup failed");
      expect(notifier.calls[0]?.body).toContain("synthetic backup failure");
      expect(notifier.calls[1]?.title).toBe("backup recovered");

      // A success with no outage never notifies.
      const quiet = new RecordingNotifier();
      await runCli(["backup"], {
        loadConfig: () => mockConfig({}, dbPath),
        runBackup: () => FAKE_BACKUP,
        buildNotifier: () => quiet,
        out: () => {},
        err: () => {},
      });
      expect(quiet.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
