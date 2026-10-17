/**
 * Notification channel abstraction.
 *
 * A `Notifier` implements a single side-effecting operation: send one message.
 * Implementations are expected to be best-effort (a notification failure must
 * never break the caller), but the interface itself does not swallow errors —
 * the CLI wiring is responsible for keeping notification problems away from the
 * sync exit code.
 */
/**
 * What kind of message is being sent. Channels may use it to pick urgency
 * (priority, tags, …); implementations that have no such knob ignore it.
 */
export type NotifyKind = "failure" | "recovery" | "summary" | "test";

export interface Notifier {
  /**
   * Send one notification. Implementations may ignore this on failure.
   * `kind` is optional and defaults to a plain, neutral message ("test").
   */
  notify(title: string, body: string, kind?: NotifyKind): Promise<void>;
}
