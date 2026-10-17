/**
 * Notification channel abstraction.
 *
 * A `Notifier` implements a single side-effecting operation: send one message.
 * Implementations are expected to be best-effort (a notification failure must
 * never break the caller), but the interface itself does not swallow errors —
 * the CLI wiring is responsible for keeping notification problems away from the
 * sync exit code.
 */
export interface Notifier {
  /** Send one notification. Implementations may ignore this on failure. */
  notify(title: string, body: string): Promise<void>;
}
