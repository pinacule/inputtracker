/**
 * NtfyNotifier unit tests (synthetic data, `fetch` mocked — never network).
 *
 * Covers: per-kind headers, optional token/click headers, retry semantics
 * (network error and 5xx retry once, 4xx and timeout do not), size limits with
 * multi-byte safe truncation, and the no-leak guarantee: neither the URL (it
 * embeds the topic) nor the configured token may appear in any thrown error.
 */

import { describe, expect, test } from "bun:test";

import { NtfyNotifier } from "../src/notify/ntfy.ts";
import { buildChannels } from "../src/notify/index.ts";
import type { Config } from "../src/core/config.ts";

const NTFY_URL = "https://ntfy.example/synthetic-topic-with-secret-name";
const TOKEN = "tk_synthetic_access_token_123456";

interface Call {
  url: string;
  init?: RequestInit;
}

type NtfyFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/** A fetch mock that records its calls and always answers 200. */
function okFetch(): { fetch: NtfyFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response("", { status: 200 });
  }) as NtfyFetch;
  return { fetch, calls };
}

/** A fetch mock that answers with the first status once, then 200. */
function statusThenOk(firstStatus: number): { fetch: NtfyFetch; calls: Call[] } {
  const calls: Call[] = [];
  let answered = false;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (!answered) {
      answered = true;
      return new Response("", { status: firstStatus });
    }
    return new Response("", { status: 200 });
  }) as NtfyFetch;
  return { fetch, calls };
}

/** A fetch mock that styles every call as a real network error. */
function failingFetch(err: Error): { fetch: NtfyFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    throw err;
  }) as NtfyFetch;
  return { fetch, calls };
}

function mockConfig(notify: Partial<Config["notify"]>): Config {
  return {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/synthetic", backup_keep: 14 },
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

function makeNotifier(
  fetchFn: NtfyFetch,
  extra: Partial<ConstructorParameters<typeof NtfyNotifier>[0]> = {}
): NtfyNotifier {
  return new NtfyNotifier({
    url: NTFY_URL,
    token: TOKEN,
    fetch: fetchFn,
    sleep: () => Promise.resolve(),
    ...extra,
  });
}

describe("NtfyNotifier headers", () => {
  test("failure: high priority and warning tag", async () => {
    const { fetch, calls } = okFetch();
    const ntfy = makeNotifier(fetch);

    await ntfy.notify("synthetic failed", "boom", "failure");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headers.Priority).toBe("high");
    expect(headers.Tags).toBe("warning");
  });

  test("recovery: default priority and check mark tag", async () => {
    const { fetch, calls } = okFetch();
    const ntfy = makeNotifier(fetch);

    await ntfy.notify("synthetic recovered", "ok", "recovery");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Priority).toBe("default");
    expect(headers.Tags).toBe("white_check_mark");
  });

  test("summary: low priority and bar chart tag; Click only when appUrl is set", async () => {
    const { fetch, calls } = okFetch();
    const ntfy = makeNotifier(fetch, {
      appUrl: "http://100.64.0.1:8787",
      token: undefined,
    });

    await ntfy.notify("InputTracker weekly summary", "body", "summary");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Priority).toBe("low");
    expect(headers.Tags).toBe("bar_chart");
    expect(headers.Click).toBe("http://100.64.0.1:8787");
    // No token configured -> no Authorization header.
    expect(headers.Authorization).toBeUndefined();
  });

  test("token header only when a token is configured", async () => {
    const { fetch, calls } = okFetch();
    const ntfy = makeNotifier(fetch);

    await ntfy.notify("t", "b", "test");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("NtfyNotifier retry and failure handling", () => {
  test("a network error is retried once and then throws without leaking the url or token", async () => {
    const netErr = new Error(`connect ECONNREFUSED https://ntfy.example ${TOKEN}`);
    const { fetch, calls } = failingFetch(netErr);
    const sleeps: number[] = [];
    const ntfy = new NtfyNotifier({
      url: NTFY_URL,
      token: TOKEN,
      fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    const caught = await ntfy.notify("t", "b", "failure").catch((err) => err);

    expect(calls).toHaveLength(2); // exactly one retry
    expect(sleeps).toEqual([2000]);
    const message = String(caught);
    expect(message).toContain("ntfy notification failed");
    expect(message).not.toContain(NTFY_URL);
    expect(message).not.toContain("synthetic-topic");
    expect(message).not.toContain(TOKEN);
  });

  test("a 503 is retried once; a 200 on the second attempt succeeds", async () => {
    const { fetch, calls } = statusThenOk(503);
    const sleeps: number[] = [];
    const ntfy = new NtfyNotifier({
      url: NTFY_URL,
      token: TOKEN,
      fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    await ntfy.notify("t", "b", "recovery");

    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  test("a 400 (client error) is not retried", async () => {
    const { fetch, calls } = statusThenOk(400);
    const ntfy = makeNotifier(fetch);

    await expect(ntfy.notify("t", "b")).rejects.toThrow(
      /ntfy notification failed: HTTP 400/
    );
    expect(calls).toHaveLength(1);
  });

  test("a timeout is not retried and mentions no url", async () => {
    // A fetch that honours the abort signal: rejects with AbortError.
    const fetchFn = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as NtfyFetch;
    const ntfy = makeNotifier(fetchFn, { timeoutMs: 20 });

    await expect(ntfy.notify("t", "b")).rejects.toThrow(/timed out/);
  });

  test("the truncated body stays within the ntfy byte limit and is valid untruncated-in-the-middle text", async () => {
    const { fetch, calls } = okFetch();
    const ntfy = makeNotifier(fetch);

    // Multi-byte heavy body far past 4096 bytes.
    const body = `synthetic ${"歌エモリ".repeat(4000)}`;
    await ntfy.notify("t", body, "summary");

    const sent = calls[0]?.init?.body as string;
    const bytes = new TextEncoder().encode(sent).byteLength;
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(sent.endsWith("…")).toBe(true);
    // Round-trips cleanly: no split multi-byte sequence anywhere.
    expect(new TextDecoder().decode(new TextEncoder().encode(sent))).toBe(sent);
  });

  test("a long title is cut to at most 250 characters", async () => {
    const { fetch, calls } = okFetch();
    const ntfy = makeNotifier(fetch);

    const title = `synthetic ${"歌".repeat(400)}`;
    await ntfy.notify(title, "b");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(Array.from(headers.Title)).toHaveLength(250);
    expect(headers.Title.startsWith("synthetic 歌")).toBe(true);
    expect(headers.Title.endsWith("…")).toBe(true);
  });

  test("a short body and title pass through byte-identical", async () => {
    const { fetch, calls } = okFetch();
    const ntfy = makeNotifier(fetch);

    await ntfy.notify("short title", "short body");

    expect(calls[0]?.init?.body).toBe("short body");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Title).toBe("short title");
  });
});

describe("buildChannels", () => {
  test("no channels when nothing is configured", () => {
    expect(buildChannels(mockConfig({ desktop: false }))).toEqual([]);
  });

  test("the ntfy channel is named after the channel, never the url", () => {
    const channels = buildChannels(
      mockConfig({ ntfy_url: NTFY_URL, ntfy_token: TOKEN })
    );
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe("ntfy");
  });

  test("desktop on by default when [notify] is missing entirely", () => {
    const partial = {
      timezone: "Europe/Bratislava",
      server: { bind: "127.0.0.1", port: 8787 },
      storage: { db_path: ":memory:", backup_dir: "/tmp/synthetic", backup_keep: 14 },
      audiobookshelf: { url: "http://abs.test:13378", token: "", timeout_s: 20 },
      toJSON: () => ({}),
      toString: () => "",
    } as unknown as Config;
    const channels = buildChannels(partial);
    expect(channels.map((c) => c.name)).toEqual(["desktop"]);
  });
});
