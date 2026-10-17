/**
 * Notification wiring.
 *
 * `buildNotifier(config)` turns the `[notify]` config section into a composite
 * of the enabled channels: desktop (`notify-send`) is on by default, ntfy is
 * used only when `ntfy_url` is set.
 */

import type { Config, NotifyConfig } from "../core/config.ts";
import { CompositeNotifier } from "./composite.ts";
import { DesktopNotifier } from "./desktop.ts";
import { NtfyNotifier } from "./ntfy.ts";
import type { Notifier } from "./types.ts";

export type { Notifier } from "./types.ts";
export { CompositeNotifier } from "./composite.ts";
export { DesktopNotifier } from "./desktop.ts";
export type { DesktopNotifierOptions, SpawnFn } from "./desktop.ts";
export { NtfyNotifier } from "./ntfy.ts";
export type { NtfyFetchFn, NtfyNotifierOptions } from "./ntfy.ts";
export { reportSyncResult } from "./sync-alerts.ts";
export type { ReportSyncResultOptions } from "./sync-alerts.ts";

/**
 * Build the notifier for a config. Defaults: desktop enabled, ntfy off. Missing
 * or partial `notify` sections fall back to those defaults so callers that build
 * a partial config (e.g. tests) still get a working notifier.
 */
export function buildNotifier(config: Config): Notifier {
  const notify: Partial<NotifyConfig> =
    (config as { notify?: Partial<NotifyConfig> }).notify ?? {};

  const desktop = notify.desktop ?? true;
  const ntfyUrl =
    typeof notify.ntfy_url === "string" ? notify.ntfy_url.trim() : "";

  const notifiers: Notifier[] = [];
  if (desktop) {
    notifiers.push(new DesktopNotifier());
  }
  if (ntfyUrl !== "") {
    notifiers.push(new NtfyNotifier({ url: ntfyUrl }));
  }

  return new CompositeNotifier(notifiers);
}
