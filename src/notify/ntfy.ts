/**
 * ntfy.sh notification channel.
 *
 * Enabled only when `[notify] ntfy_url` is set. `notify` performs a POST to
 * that URL; the title travels in the `Title` header and the body is the
 * plain-text message. Tests mock `fetch`, so no test ever hits the network.
 *
 * The call is best-effort by contract: it has a 10 s timeout (per attempt) and
 * retries exactly once after 2 s, and only for a network error (or a 5xx
 * response). A 4xx status is a configuration problem — no retry. Timeouts are
 * not retried either: a dead URL just delays the sync, and one attempt is
 * enough signal.
 *
 * Hard limits follow the ntfy server: title ≤ 250 characters, body ≤ 4096
 * UTF-8 bytes. Both are truncated on a code-point boundary with an appended
 * "…", so multi-byte characters are never split.
 *
 * The URL (which may embed the topic) and the optional access token are never
 * echoed: any error is stripped of both and passed through `redact()`, so a
 * failure can never leak credentials into a log.
 */

import { redact } from "../core/config.ts";
import type { NotifyKind, Notifier } from "./types.ts";

export type NtfyFetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface NtfyNotifierOptions {
  url: string;
  /** Optional ntfy access token; sent as `Authorization: Bearer …`. */
  token?: string;
  /** Optional web app URL sent as the notification's `Click` header. */
  appUrl?: string;
  /** Fetch override; defaults to the global `fetch`. */
  fetch?: NtfyFetchFn;
  /** Wait between attempts; defaults to a real 2 s timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt timeout in ms; defaults to 10 000. */
  timeoutMs?: number;
}

/** ntfy sizes (see https://docs.ntfy.sh/publish/#message-limit). */
const TITLE_MAX_CHARS = 250;
const BODY_MAX_BYTES = 4096;
/** Per-attempt timeout and the wait before the single retry. */
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
const MAX_ATTEMPTS = 2;

/** Priority header per message kind. */
const PRIORITY: Record<NotifyKind, string> = {
  failure: "high",
  recovery: "default",
  summary: "low",
  test: "default",
};

/** Tags header per message kind (ntfy emoji short codes). */
const TAGS: Record<NotifyKind, string> = {
  failure: "warning",
  recovery: "white_check_mark",
  summary: "bar_chart",
  test: "bell",
};

/** UTF-8 byte length of `s`, as the ntfy server counts it. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Trim `text` to at most `maxBytes` UTF-8 bytes, cutting on a code-point
 * boundary and ending with "…" (the ellipsis counts toward the budget).
 */
function truncateBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const ellipsis = "…";
  const budget = Math.max(0, maxBytes - byteLength(ellipsis));
  let out = "";
  let bytes = 0;
  // `for..of` walks whole code points, so a cut can never split a surrogate
  // pair or other multi-byte character.
  for (const ch of text) {
    const size = byteLength(ch);
    if (bytes + size > budget) {
      break;
    }
    out += ch;
    bytes += size;
  }
  return `${out}${ellipsis}`;
}

/** Trim the title to at most `maxChars` characters, ending with "…". */
function truncateTitle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const ellipsis = "…";
  // Walk code points so a surrogate pair is never split in half.
  const chars = Array.from(text).slice(0, maxChars - 1);
  return `${chars.join("")}${ellipsis}`;
}

/**
 * Strip `url` and `token` from a raw error string; never let a ntfy URL,
 * topic or credential appear in a typed message.
 */
function sanitize(raw: string, url: string, token: string): string {
  let clean = raw;
  if (url !== "") {
    clean = clean.split(url).join("***");
  }
  if (token !== "") {
    clean = clean.split(token).join("***");
  }
  return redact(clean);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class NtfyNotifier implements Notifier {
  private readonly url: string;
  private readonly token: string;
  private readonly appUrl: string;
  private readonly fetchFn: NtfyFetchFn;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: NtfyNotifierOptions) {
    this.url = options.url;
    this.token = options.token ?? "";
    this.appUrl = options.appUrl ?? "";
    this.fetchFn = options.fetch ?? (globalThis.fetch as NtfyFetchFn);
    this.sleepFn =
      options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private sanitize(raw: string): string {
    return sanitize(raw, this.url, this.token);
  }

  /**
   * POST one message. Retries once on network error or 5xx; 4xx and timeouts
   * fail without retry. A dropped connection or a bad status becomes an
   * exception whose text never contains the URL or the token.
   */
  async notify(title: string, body: string, kind: NotifyKind = "test"): Promise<void> {
    const headers: Record<string, string> = {
      Title: truncateTitle(title, TITLE_MAX_CHARS),
      Priority: PRIORITY[kind] ?? "default",
      Tags: TAGS[kind] ?? "bell",
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (this.appUrl !== "") {
      headers.Click = this.appUrl;
    }
    if (this.token !== "") {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        await this.sleepFn(RETRY_DELAY_MS);
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: Response;
        try {
          response = await this.fetchFn(this.url, {
            method: "POST",
            headers,
            body: truncateBytes(body, BODY_MAX_BYTES),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (response.ok) {
          return;
        }
        if (response.status < 500) {
          // 3xx/4xx: configuration problem, do not retry.
          throw new Error(`HTTP ${response.status}`);
        }
        lastError = `HTTP ${response.status}`;
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (isAbort) {
          throw new Error("ntfy request timed out");
        }
        const message = errorText(err);
        // Only a transport failure is worth the second attempt; anything we
        // raise ourselves above (e.g. HTTP 4xx) is final.
        if (message.startsWith("ntfy returned") || message.startsWith("HTTP ")) {
          throw new Error(`ntfy notification failed: ${this.sanitize(message)}`);
        }
        lastError = message;
      }
    }
    throw new Error(`ntfy notification failed: ${this.sanitize(lastError)}`);
  }
}
