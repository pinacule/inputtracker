/**
 * Time helpers.
 *
 * Storage is always UTC ISO 8601 with milliseconds (`2026-10-17T08:15:00.000Z`).
 * Local (wall-clock) values are only derived for display/bucketing, and the
 * timezone is always a parameter (defaulting to Europe/Bratislava).
 */

/** ISO 1=Mon .. 7=Sun, indexed by `Date.getUTCDay()` (0=Sun .. 6=Sat). */
const ISO_WEEKDAY: readonly number[] = [7, 1, 2, 3, 4, 5, 6];

export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
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

// --- local wall-clock → UTC ------------------------------------------------

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const EXPLICIT_OFFSET_RE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;
const HOUR_MS = 3_600_000;

/** `Intl.DateTimeFormat`s are expensive; cache one per timezone. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached !== undefined) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new Error(`Invalid timezone: "${tz}"`);
  }
  formatterCache.set(tz, formatter);
  return formatter;
}

/** Wall-clock parts of the UTC instant `utcMs` in timezone `tz`. */
function wallClockAt(tz: string, utcMs: number): WallClock {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const valueOf = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? Number.NaN : Number.parseInt(part.value, 10);
  };
  return {
    year: valueOf("year"),
    month: valueOf("month"),
    day: valueOf("day"),
    // Some ICU versions report the midnight hour as "24"; normalize to 0.
    hour: valueOf("hour") % 24,
    minute: valueOf("minute"),
    second: valueOf("second"),
  };
}

/** Offset (local − UTC, in ms) of timezone `tz` at the UTC instant `utcMs`. */
function zoneOffsetMs(tz: string, utcMs: number): number {
  const w = wallClockAt(tz, utcMs);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Offsets that could apply to the wall-clock time whose "pretend UTC" value is
 * `naive`. Transitions are at most a few hours from the requested time, so
 * sampling around it collects every candidate without walking the tz database.
 */
function candidateOffsets(tz: string, naive: number): number[] {
  const offsets = new Set<number>();
  for (const hours of [-12, -6, -1, 0, 1, 6, 12]) {
    offsets.add(zoneOffsetMs(tz, naive + hours * HOUR_MS));
  }
  return [...offsets];
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * Convert a local wall-clock string in the IANA timezone `tz` to a UTC ISO 8601
 * string (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 *
 * Accepted forms: `2026-10-17 21:30`, `2026-10-17T21:30`, an optional `:SS`, or
 * a bare date (`2026-10-17` ⇒ 00:00 local). An input that already ends in `Z` or
 * a numeric offset is passed straight to {@link toUtcIso} and respected as-is.
 *
 * DST edge cases:
 * - **Spring-forward gap** (a local time that does not exist): the time is
 *   shifted *forward* by the gap to the next valid instant, matching Temporal's
 *   default `compatible` disambiguation (`02:30` on a 02:00→03:00 day becomes
 *   `03:30` local).
 * - **Fall-back ambiguity** (a local time that happens twice): the *first*
 *   (earlier) occurrence is used.
 *
 * Throws a clear `Error` on invalid input or an unknown timezone.
 */
export function localToUtcIso(local: string, tz: string): string {
  if (typeof local !== "string") {
    throw new Error("Invalid local time: expected a string");
  }
  const trimmed = local.trim();
  if (trimmed === "") {
    throw new Error('Invalid local time: ""');
  }

  // Already unambiguous: an explicit `Z` or numeric offset wins.
  if (EXPLICIT_OFFSET_RE.test(trimmed)) {
    return toUtcIso(trimmed);
  }

  const match = NAIVE_RE.exec(trimmed);
  if (match === null) {
    throw new Error(`Invalid local time: "${trimmed}"`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(`Invalid local time: "${trimmed}"`);
  }

  // Reject impossible calendar dates such as 2026-02-30.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new Error(`Invalid local time: "${trimmed}"`);
  }

  const wanted: WallClock = { year, month, day, hour, minute, second };
  // Treat the wall-clock fields as if they were UTC; subtracting the zone offset
  // yields the real instant.
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);

  const validInstants: number[] = [];
  for (const offset of candidateOffsets(tz, naive)) {
    const instant = naive - offset;
    if (sameWallClock(wallClockAt(tz, instant), wanted)) {
      validInstants.push(instant);
    }
  }

  if (validInstants.length > 0) {
    // Ambiguous (fall-back): `min` is the first, earlier occurrence.
    return new Date(Math.min(...validInstants)).toISOString();
  }

  // No exact match: the requested wall-clock time falls in a spring-forward gap.
  // Pick the candidate shifted forward by the smallest positive amount.
  let bestInstant: number | null = null;
  let bestShift = Number.POSITIVE_INFINITY;
  for (const offset of candidateOffsets(tz, naive)) {
    const instant = naive - offset;
    const w = wallClockAt(tz, instant);
    const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const shift = wall - naive;
    if (shift > 0 && shift < bestShift) {
      bestShift = shift;
      bestInstant = instant;
    }
  }

  if (bestInstant === null) {
    throw new Error(`Could not resolve local time "${trimmed}" in timezone "${tz}"`);
  }
  return new Date(bestInstant).toISOString();
}

