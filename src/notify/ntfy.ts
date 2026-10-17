/**
 * ntfy.sh notification channel (stub).
 *
 * Enabled only when `[notify] ntfy_url` is set. `notify` performs a single
 * POST to that URL; the title travels in the `Title` header and the body is the
 * plain-text message. Tests mock `fetch`, so no test ever hits the network.
 *
 * The URL may embed a topic or credentials, so it is never echoed: any error
 * raised is stripped of the URL and passed through `redact()` to mask a
 * configured token.
 */

import { redact } from "../core/config.ts";
import type { Notifier } from "./types.ts";

export type NtfyFetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface NtfyNotifierOptions {
  url: string;
  /** Fetch override; defaults to the global `fetch`. */
  fetch?: NtfyFetchFn;
}

export class NtfyNotifier implements Notifier {
  private readonly url: string;
  private readonly fetchFn: NtfyFetchFn;

  constructor(options: NtfyNotifierOptions) {
    this.url = options.url;
    this.fetchFn = options.fetch ?? (globalThis.fetch as NtfyFetchFn);
  }

  async notify(title: string, body: string): Promise<void> {
    try {
      await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          Title: title,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const maskedUrl =
        this.url === "" ? raw : raw.split(this.url).join("***");
      throw new Error(`ntfy notification failed: ${redact(maskedUrl)}`);
    }
  }
}
