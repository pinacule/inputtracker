/**
 * Fan-out notifier: sends the same message to several channels.
 *
 * Each channel is isolated: a failure in one must not stop the others, and the
 * composite itself never throws. That keeps notification problems from ever
 * affecting a sync run.
 */

import type { NotifyKind, Notifier } from "./types.ts";

export class CompositeNotifier implements Notifier {
  private readonly notifiers: readonly Notifier[];

  constructor(notifiers: readonly Notifier[] = []) {
    this.notifiers = notifiers;
  }

  async notify(title: string, body: string, kind?: NotifyKind): Promise<void> {
    await Promise.all(
      this.notifiers.map(async (notifier) => {
        try {
          await notifier.notify(title, body, kind);
        } catch {
          // One channel failing must not affect the others or the caller.
        }
      })
    );
  }
}
