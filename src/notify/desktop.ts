/**
 * Desktop notifications via `notify-send`.
 *
 * Best-effort by construction: when the binary is missing (headless machine,
 * minimal install) or spawning/exiting fails, `notify` resolves silently. It
 * never throws, so a scheduled sync cannot fail because a notification could
 * not be shown.
 */

import type { Notifier } from "./types.ts";

/** Injectable spawner so tests can avoid a real `notify-send` binary. */
export type SpawnFn = typeof Bun.spawn;

export interface DesktopNotifierOptions {
  /** Binary to run; defaults to `notify-send`. */
  command?: string;
  /** Spawner override; defaults to `Bun.spawn`. */
  spawn?: SpawnFn;
}

export class DesktopNotifier implements Notifier {
  private readonly command: string;
  private readonly spawn: SpawnFn;

  constructor(options: DesktopNotifierOptions = {}) {
    this.command = options.command ?? "notify-send";
    this.spawn = options.spawn ?? Bun.spawn;
  }

  async notify(title: string, body: string): Promise<void> {
    try {
      const proc = this.spawn([this.command, title, body], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      // A non-zero exit is fine; we just never propagate it.
      await proc.exited;
    } catch {
      // Missing binary, no display server, spawn/exit failure: stay silent.
    }
  }
}
