/**
 * Shared date/time display helpers for InputTracker.
 *
 * Timestamps are stored as UTC ISO 8601; formatting to a local wall-clock
 * string happens only here, using the configured IANA timezone.
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

/** Fallback timezone used when the web app has no configured timezone. */
export const DEFAULT_TIMEZONE = "Europe/Bratislava";

/** `Intl.DateTimeFormat`s are expensive; cache one per timezone. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      // Explicit 24-hour cycle so midnight is "00" rather than "24".
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Format a UTC ISO timestamp as `DD.MM.YYYY HH:mm` (24 h, zero-padded) in the
 * given IANA `timeZone`. Built from `formatToParts` so the output never
 * depends on the locale's own field order or separators.
 *
 * Invalid input is returned unchanged.
 */
export function formatDateTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const parts = formatterFor(timeZone).formatToParts(date);
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }

  const day = values.day ?? "";
  const month = values.month ?? "";
  const year = values.year ?? "";
  const hour = values.hour ?? "";
  const minute = values.minute ?? "";

  return `${day}.${month}.${year} ${hour}:${minute}`;
}

/**
 * Format an already-local calendar date ("YYYY-MM-DD", e.g. a streak day from
 * the API) as `DD.MM.YYYY`. No timezone conversion: the server already
 * resolved the local day, so re-parsing as a timestamp could shift it by a day
 * in zones behind UTC.
 *
 * Invalid input is returned unchanged.
 */
export function formatLocalDay(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    return dateStr;
  }
  return `${match[3]}.${match[2]}.${match[1]}`;
}
