/**
 * Notification wiring.
 *
 * `buildNotifier(config)` turns the `[notify]` config section into a composite
 * of the enabled channels: desktop (`notify-send`) is on by default, ntfy is
 * used only when `ntfy_url` is set. `buildChannels(config)` returns the same
 * channels as a named list, used by `it notify test` to report per-channel
 * results without ever printing a channel's URL or token.
 */

import type { Config, NotifyConfig } from "../core/config.ts";
import { CompositeNotifier } from "./composite.ts";
import { DesktopNotifier } from "./desktop.ts";
import { NtfyNotifier } from "./ntfy.ts";
import type { Notifier } from "./types.ts";

export type { Notifier, NotifyKind } from "./types.ts";
export { CompositeNotifier } from "./composite.ts";
export { DesktopNotifier } from "./desktop.ts";
export type { DesktopNotifierOptions, SpawnFn } from "./desktop.ts";
export { NtfyNotifier } from "./ntfy.ts";
export type { NtfyFetchFn, NtfyNotifierOptions } from "./ntfy.ts";
export { reportSyncResult } from "./sync-alerts.ts";
export type { ReportSyncResultOptions } from "./sync-alerts.ts";
export { buildWeeklySummary } from "./weekly.ts";
export type { WeeklySummaryOptions, WeeklySummary } from "./weekly.ts";

/** One configured notification channel, by display name (never a URL). */
export interface NotifyChannel {
  name: string;
  notifier: Notifier;
}

interface BuildParams {
  /** Retry wait override for tests / CLI injection. */
  sleep?: (ms: number) => Promise<void>;
  /** Fetch override for tests. */
  fetch?: typeof fetch;
}

/**
 * The enabled channels of a config. Defaults: desktop enabled, ntfy off.
 * Missing or partial `notify` sections fall back to those defaults so callers
 * that build a partial config (e.g. tests) still get a working notifier.
 */
export function buildChannels(
  config: Config,
  params: BuildParams = {}
): NotifyChannel[] {
  const notify: Partial<NotifyConfig> =
    (config as { notify?: Partial<NotifyConfig> }).notify ?? {};

  const desktop = notify.desktop ?? true;
  const ntfyUrl =
    typeof notify.ntfy_url === "string" ? notify.ntfy_url.trim() : "";
  const ntfyToken =
    typeof notify.ntfy_token === "string" ? notify.ntfy_token.trim() : "";
  const appUrl =
    typeof notify.app_url === "string" ? notify.app_url.trim() : "";

  const channels: NotifyChannel[] = [];
  if (desktop) {
    channels.push({ name: "desktop", notifier: new DesktopNotifier() });
  }
  if (ntfyUrl !== "") {
    channels.push({
      name: "ntfy",
      notifier: new NtfyNotifier({
        url: ntfyUrl,
        token: ntfyToken !== "" ? ntfyToken : undefined,
        appUrl: appUrl !== "" ? appUrl : undefined,
        sleep: params.sleep,
        fetch: params.fetch,
      }),
    });
  }
  return channels;
}

/** Build the notifier for a config (a composite of `buildChannels`). */
export function buildNotifier(config: Config): Notifier {
  return new CompositeNotifier(buildChannels(config).map((c) => c.notifier));
}
