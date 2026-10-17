/**
 * Sync failure/recovery alerts.
 *
 * `reportSyncResult` is called once per sync run. It keeps a per-source flag in
 * the existing `sync_state` table and notifies at most once per outage:
 *
 *   first failure after success (or never notified) → one "failed" notification
 *   further consecutive failures                    → nothing (no spam)
 *   first success after a notified failure          → one "recovered" notification
 *   success after success                           → nothing
 *
 * The flag lives in its own `sync_state` row (`source = "notify:<source>"`) so
 * it never competes with the sync cursor row, which the ABS sync advances with
 * an `ON CONFLICT ... DO UPDATE`. This reuses the table's existing key/value
 * columns, so no migration is needed and `events` is untouched.
 */

import type { Database } from "bun:sqlite";
import type { Notifier } from "./types.ts";

/** Prefix for the synthetic `sync_state.source` key holding the alert flag. */
const ALERT_SOURCE_PREFIX = "notify:";

/** `sync_state.cursor` value meaning "a failure notification is outstanding". */
const NOTIFIED = "1";
const CLEARED = "0";

/** Longest failure message embedded in a notification body. */
const MAX_MESSAGE_LENGTH = 200;

export interface ReportSyncResultOptions {
  /** Injectable clock for the `sync_state.updated_at` stamp. */
  now?: () => Date;
}

interface AlertRow {
  cursor: string | null;
}

function alertSource(source: string): string {
  return `${ALERT_SOURCE_PREFIX}${source}`;
}

function hasNotifiedFailure(db: Database, source: string): boolean {
  const row = db
    .query<AlertRow, [string]>("SELECT cursor FROM sync_state WHERE source = ?;")
    .get(alertSource(source));
  return row?.cursor === NOTIFIED;
}

function setNotifiedFailure(
  db: Database,
  source: string,
  notified: boolean,
  now: () => Date
): void {
  db.run(
    `INSERT INTO sync_state (source, cursor, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE
       SET cursor = excluded.cursor, updated_at = excluded.updated_at;`,
    [alertSource(source), notified ? NOTIFIED : CLEARED, now().toISOString()]
  );
}

/** Collapse whitespace and clamp the message so a notification stays short. */
function shortMessage(message: string | undefined): string {
  const collapsed = (message ?? "").replace(/\s+/g, " ").trim();
  if (collapsed === "") {
    return "unknown error";
  }
  if (collapsed.length <= MAX_MESSAGE_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/**
 * Subject used in the alert titles: sync sources read "sync <source>", the
 * backup reads simply "backup", so "sync backup failed" never appears.
 */
function alertSubject(source: string): string {
  return source === "backup" ? "backup" : `sync ${source}`;
}

/**
 * Record one sync result and notify on the first failure and on recovery only.
 * `errorMessage` should already be redacted by the caller.
 */
export async function reportSyncResult(
  db: Database,
  source: string,
  ok: boolean,
  errorMessage: string | undefined,
  notifier: Notifier,
  options: ReportSyncResultOptions = {}
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const subject = alertSubject(source);
  const outstanding = hasNotifiedFailure(db, source);

  if (!ok) {
    if (outstanding) {
      return;
    }
    await notifier.notify(
      `${subject} failed`,
      shortMessage(errorMessage),
      "failure"
    );
    setNotifiedFailure(db, source, true, now);
    return;
  }

  if (!outstanding) {
    return;
  }
  await notifier.notify(
    `${subject} recovered`,
    `${subject} is working again`,
    "recovery"
  );
  setNotifiedFailure(db, source, false, now);
}
