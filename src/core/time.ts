/**
 * Time helpers.
 *
 * Storage is always UTC ISO 8601 with milliseconds (`2026-10-17T08:15:00.000Z`).
 * Local (wall-clock) values are only derived for display/bucketing, and the
 * timezone is always a parameter (defaulting to Europe/Bratislava).
 */

/** ISO 1=Mon .. 7=Sun, indexed by `Date.getUTCDay()` (0=Sun .. 6=Sat). */
const ISO_WEEKDAY: readonly number[] = [7, 1, 2, 3, 4, 5, 6];

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET_RE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

export interface LocalParts {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Local hour, 0-23. */
  hour: number;
  /** ISO weekday, 1=Mon .. 7=Sun. */
  weekday: number;
}

/**
 * Normalize epoch milliseconds, a date string, or a `Date` to a UTC ISO 8601
 * string with milliseconds (`2026-10-17T08:15:00.000Z`).
 *
 * Accepted string forms:
 * - `YYYY-MM-DD` — treated as UTC midnight.
 * - ISO strings with an offset/Z (`2026-10-17T10:15:00+02:00`, `...Z`).
 * - Naive datetimes without an offset — treated as UTC.
 *
 * Throws an `Error` on invalid input.
 */
export function toUtcIso(input: number | string | Date): string {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error(`Invalid timestamp: ${input}`);
    }
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid timestamp: ${input}`);
    }
    return date.toISOString();
  }

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new Error("Invalid timestamp: Invalid Date");
    }
    return input.toISOString();
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") {
      throw new Error('Invalid timestamp: ""');
    }

    let normalized: string;
    if (DATE_ONLY_RE.test(trimmed)) {
      // Date-only is UTC midnight.
      normalized = `${trimmed}T00:00:00.000Z`;
    } else {
      // Allow a space between date and time, then default missing offsets to UTC.
      const withT = trimmed.replace(" ", "T");
      normalized = HAS_OFFSET_RE.test(withT) ? withT : `${withT}Z`;
    }

    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid timestamp: "${trimmed}"`);
    }
    return date.toISOString();
  }

  throw new Error(`Invalid timestamp: ${String(input)}`);
}

/**
 * Break a UTC timestamp into local wall-clock parts for a given IANA timezone.
 *
 * Uses `Intl.DateTimeFormat` with `hourCycle: "h23"` so hours are 0-23 and
 * normalizes the rare "24" hour-at-midnight some ICU versions emit.
 */
export function localParts(iso: string, tz = "Europe/Bratislava"): LocalParts {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: "${iso}"`);
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });

  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  let hourRaw: string | undefined;

  for (const part of formatter.formatToParts(date)) {
    switch (part.type) {
      case "year":
        year = part.value;
        break;
      case "month":
        month = part.value;
        break;
      case "day":
        day = part.value;
        break;
      case "hour":
        hourRaw = part.value;
        break;
      default:
        break;
    }
  }

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hourRaw === undefined
  ) {
    throw new Error(`Could not determine local time parts for timezone "${tz}"`);
  }

  const hour = Number.parseInt(hourRaw, 10) % 24;

  const dateStr = `${year}-${month}-${day}`;
  // Derive the ISO weekday from the *local* calendar date, avoiding locale text.
  const weekday =
    ISO_WEEKDAY[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];

  return { date: dateStr, hour, weekday };
}
