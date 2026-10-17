import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { CompositeNotifier } from "../src/notify/composite.ts";
import { DesktopNotifier } from "../src/notify/desktop.ts";
import { buildNotifier } from "../src/notify/index.ts";
import { NtfyNotifier } from "../src/notify/ntfy.ts";
import { reportSyncResult } from "../src/notify/sync-alerts.ts";
import type { Notifier } from "../src/notify/types.ts";

/** All names/IDs here are synthetic — never real personal data. */
const SOURCE = "fakesource";
const OTHER_SOURCE = "othersynthetic";

class FakeNotifier implements Notifier {
  readonly calls: Array<{ title: string; body: string }> = [];
  fail = false;

  async notify(title: string, body: string): Promise<void> {
    if (this.fail) {
      throw new Error("synthetic notifier failure");
    }
    this.calls.push({ title, body });
  }
}

function mockConfig(notify: Partial<Config["notify"]> = {}): Config {
  return {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/synthetic", backup_keep: 14 },
    audiobookshelf: { url: "http://abs.test:13378", token: "", timeout_s: 20 },
    notify: { desktop: false, ntfy_url: "", ...notify },
    toJSON: () => ({}),
    toString: () => "",
  } as Config;
}

describe("reportSyncResult", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  test("three consecutive failures notify once; then recovery notifies once; success after success is silent", async () => {
    const notifier = new FakeNotifier();

    await reportSyncResult(db, SOURCE, false, "connection refused", notifier);
    await reportSyncResult(db, SOURCE, false, "connection refused again", notifier);
    await reportSyncResult(db, SOURCE, false, "connection refused yet again", notifier);

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]?.title).toBe(`sync ${SOURCE} failed`);
    expect(notifier.calls[0]?.body).toContain("connection refused");

    await reportSyncResult(db, SOURCE, true, undefined, notifier);
    expect(notifier.calls).toHaveLength(2);
    expect(notifier.calls[1]?.title).toBe(`sync ${SOURCE} recovered`);

    // Success after success: nothing.
    await reportSyncResult(db, SOURCE, true, undefined, notifier);
    await reportSyncResult(db, SOURCE, true, undefined, notifier);
    expect(notifier.calls).toHaveLength(2);
  });

  test("success on the very first run never notifies", async () => {
    const notifier = new FakeNotifier();

    await reportSyncResult(db, SOURCE, true, undefined, notifier);
    expect(notifier.calls).toHaveLength(0);
  });

  test("a new failure after recovery notifies once again", async () => {
    const notifier = new FakeNotifier();

    await reportSyncResult(db, SOURCE, false, "boom", notifier);
    await reportSyncResult(db, SOURCE, true, undefined, notifier);
    await reportSyncResult(db, SOURCE, false, "boom again", notifier);

    expect(notifier.calls.map((c) => c.title)).toEqual([
      `sync ${SOURCE} failed`,
      `sync ${SOURCE} recovered`,
      `sync ${SOURCE} failed`,
    ]);
  });

  test("state is kept per source and survives across calls", async () => {
    const notifier = new FakeNotifier();

    await reportSyncResult(db, SOURCE, false, "boom", notifier);
    await reportSyncResult(db, OTHER_SOURCE, false, "boom", notifier);
    expect(notifier.calls).toHaveLength(2);

    // Both sources are now flagged as notified.
    await reportSyncResult(db, SOURCE, false, "boom", notifier);
    await reportSyncResult(db, OTHER_SOURCE, false, "boom", notifier);
    expect(notifier.calls).toHaveLength(2);

    await reportSyncResult(db, SOURCE, true, undefined, notifier);
    expect(notifier.calls).toHaveLength(3);
    expect(notifier.calls[2]?.title).toBe(`sync ${SOURCE} recovered`);

    // The other source stays failed: its next success still recovers once.
    await reportSyncResult(db, OTHER_SOURCE, true, undefined, notifier);
    expect(notifier.calls).toHaveLength(4);
    expect(notifier.calls[3]?.title).toBe(`sync ${OTHER_SOURCE} recovered`);
  });

  test("a missing message still yields a short body", async () => {
    const notifier = new FakeNotifier();

    await reportSyncResult(db, SOURCE, false, undefined, notifier);

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]?.body).not.toBe("");
  });
});

describe("DesktopNotifier", () => {
  test("missing binary does not throw", async () => {
    const notifier = new DesktopNotifier({
      command: "/nonexistent/inputtracker-notify-send-does-not-exist",
    });

    await expect(notifier.notify("sync fake failed", "boom")).resolves.toBeUndefined();
  });
});

describe("NtfyNotifier", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("buildNotifier posts to the configured ntfy url via fetch", async () => {
    const url = "https://ntfy.example/synthetic-topic";
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const notifier = buildNotifier(mockConfig({ desktop: false, ntfy_url: url }));
    await notifier.notify("sync fakesource failed", "boom");

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe(url);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe("boom");
  });

  test("ntfy url is not used when unset", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const notifier = buildNotifier(mockConfig({ desktop: false, ntfy_url: "" }));
    await notifier.notify("sync fakesource failed", "boom");

    expect(called).toBe(false);
  });

  test("a fetch failure never leaks the url and does not throw through the composite", async () => {
    const url = "https://ntfy.example/secret-topic-token";
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;

    const ntfy = new NtfyNotifier({ url });
    await expect(ntfy.notify("t", "b")).rejects.toThrow(/ntfy notification failed/);
    await ntfy.notify("t", "b").catch((err: unknown) => {
      expect(String(err)).not.toContain(url);
    });

    // The composite isolates the failing channel.
    const composite = new CompositeNotifier([ntfy]);
    await expect(composite.notify("t", "b")).resolves.toBeUndefined();
  });
});

describe("CompositeNotifier", () => {
  test("one failing channel does not prevent the others", async () => {
    const bad = new FakeNotifier();
    bad.fail = true;
    const good = new FakeNotifier();
    const composite = new CompositeNotifier([bad, good]);

    await composite.notify("sync fakesource failed", "boom");

    expect(good.calls).toHaveLength(1);
  });
});

describe("CLI sync wiring", () => {
  test("a failing sync notifies once and exits 2", async () => {
    const notifier = new FakeNotifier();
    let errText = "";

    const code = await runCli(["sync", "audiobookshelf"], {
      loadConfig: () => mockConfig(),
      syncAudiobookshelf: async () => {
        throw new Error("synthetic sync failure");
      },
      buildNotifier: () => notifier,
      out: () => {},
      err: (line) => {
        errText += `${line}\n`;
      },
    });

    expect(code).toBe(2);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]?.title).toBe("sync audiobookshelf failed");
    expect(errText).toContain("synthetic sync failure");
  });

  test("a successful sync exits 0 without notifying", async () => {
    const notifier = new FakeNotifier();

    const code = await runCli(["sync", "audiobookshelf"], {
      loadConfig: () => mockConfig(),
      syncAudiobookshelf: async () => ({ runId: 1, seen: 3, inserted: 2 }),
      buildNotifier: () => notifier,
      out: () => {},
      err: () => {},
    });

    expect(code).toBe(0);
    expect(notifier.calls).toHaveLength(0);
  });

  test("a throwing notifier never changes the sync exit code", async () => {
    const throwing: Notifier = {
      notify: async () => {
        throw new Error(`synthetic notifier failure ${SOURCE}`);
      },
    };

    const code = await runCli(["sync", "audiobookshelf"], {
      loadConfig: () => mockConfig(),
      syncAudiobookshelf: async () => {
        throw new Error("synthetic sync failure");
      },
      buildNotifier: () => throwing,
      out: () => {},
      err: () => {},
    });

    expect(code).toBe(2);
  });
});

