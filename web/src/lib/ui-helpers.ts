/**
 * Pure UI logic for InputTracker's cover-first design system, routing,
 * media kind classification, cover fallback initials, and calendar summaries.
 *
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import type { CalendarDay, CalendarItem } from "../api";

// --- Media / Source Kind ---------------------------------------------------

/**
 * The four visual media kinds used across tokens, badges, covers, and charts:
 * - `audiobook`: Audiobookshelf, audiobooks, podcasts
 * - `youtube`: YouTube videos & streams
 * - `film`: Simkl, movies, TV series & episodes
 * - `manual`: Manual entries, books, music, and other logged items
 */
export type MediaKind = "audiobook" | "youtube" | "film" | "manual";

export interface MediaKindMeta {
  readonly kind: MediaKind;
  readonly label: string;
  readonly shortLabel: string;
  readonly cssVarPrefix: string;
}

export const MEDIA_KINDS: Readonly<Record<MediaKind, MediaKindMeta>> = {
  audiobook: {
    kind: "audiobook",
    label: "Audiobooks & Audio",
    shortLabel: "Audio",
    cssVarPrefix: "--kind-audiobook",
  },
  youtube: {
    kind: "youtube",
    label: "YouTube",
    shortLabel: "YouTube",
    cssVarPrefix: "--kind-youtube",
  },
  film: {
    kind: "film",
    label: "Films & Series",
    shortLabel: "Screen",
    cssVarPrefix: "--kind-film",
  },
  manual: {
    kind: "manual",
    label: "Books & Manual",
    shortLabel: "Manual",
    cssVarPrefix: "--kind-manual",
  },
};

/**
 * Resolves a consistent visual `MediaKind` from an event's `source` and
 * optional `media_type`.
 */
export function resolveMediaKind(
  source: string | null | undefined,
  mediaType?: string | null
): MediaKind {
  const s = (source ?? "").toLowerCase().trim();
  const m = (mediaType ?? "").toLowerCase().trim();

  if (s === "audiobookshelf" || s === "abs") {
    return "audiobook";
  }
  if (s === "youtube") {
    return "youtube";
  }
  if (s === "simkl") {
    return "film";
  }

  if (m === "audiobook" || m === "podcast" || m === "podcast_episode") {
    return "audiobook";
  }
  if (m === "movie" || m === "episode" || m === "tv") {
    return "film";
  }
  if (m === "video" && s === "youtube") {
    return "youtube";
  }

  return "manual";
}

/**
 * Human-readable media type name (e.g. `"podcast_episode"` -> `"Podcast"`).
 */
export function formatMediaTypeLabel(mediaType?: string | null): string {
  const m = (mediaType ?? "").toLowerCase().trim();
  switch (m) {
    case "audiobook":
      return "Audiobook";
    case "podcast":
    case "podcast_episode":
      return "Podcast";
    case "movie":
      return "Film";
    case "episode":
    case "tv":
      return "Episode";
    case "video":
      return "Video";
    case "music":
      return "Music";
    case "book":
      return "Book";
    default:
      return "Entry";
  }
}

// --- Cover Initials --------------------------------------------------------

const SE_PREFIX_RE = /^(?:S\d+\s*E\d+|S\d+|E\d+)\s*[·:\-–—]\s*/i;
const STOP_WORDS = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "and"]);

/**
 * Extracts 1–2 uppercase initials from a title for the cover fallback tile.
 * Strips leading `S01E02 · ` prefixes and ignores common leading articles
 * when multiple words exist.
 */
export function extractInitials(
  title: string | null | undefined,
  fallback = "IT"
): string {
  if (!title) {
    return fallback;
  }
  const cleaned = title.replace(SE_PREFIX_RE, "").trim();
  if (!cleaned) {
    return fallback;
  }

  // Split into alphanumeric/letter words (Unicode-aware).
  const words = cleaned
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

  if (words.length === 0) {
    return fallback;
  }

  if (words.length === 1) {
    const word = words[0]!;
    const chars = Array.from(word);
    return chars.slice(0, 2).join("").toUpperCase();
  }

  // Filter out stop words if at least two meaningful words remain, or skip leading article.
  const significant = words.filter((w, idx) => {
    if (idx === 0 && (w.toLowerCase() === "the" || w.toLowerCase() === "a" || w.toLowerCase() === "an")) {
      return false;
    }
    return !STOP_WORDS.has(w.toLowerCase());
  });

  const pool = significant.length >= 2 ? significant : words[0]!.toLowerCase() === "the" && words.length >= 2 ? words.slice(1) : words;

  if (pool.length >= 2) {
    const first = Array.from(pool[0]!)[0] ?? "";
    const second = Array.from(pool[1]!)[0] ?? "";
    return `${first}${second}`.toUpperCase();
  }

  const single = Array.from(pool[0]!);
  return single.slice(0, 2).join("").toUpperCase();
}

// --- Calendar Intensity & Month Summary ------------------------------------

export type IntensityLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Computes a 5-step intensity cue (`0..4`) for a calendar day cell.
 *
 * - `0`: no activity (`count <= 0` and `minutes <= 0`)
 * - Days with `count > 0` but `minutes === 0` (such as YouTube-only days)
 *   still receive a warm intensity level (`1..3`) based on item count so
 *   activity is never invisible.
 * - Days with positive minutes scale relative to `maxMinutes` (when > 0) or
 *   sensible duration thresholds.
 */
export function computeDayIntensity(
  minutes: number,
  count: number,
  maxMinutes = 0
): IntensityLevel {
  const safeMin = Number.isNaN(minutes) || minutes < 0 ? 0 : minutes;
  const safeCount = Number.isNaN(count) || count < 0 ? 0 : count;

  if (safeMin <= 0 && safeCount <= 0) {
    return 0;
  }

  if (safeMin <= 0) {
    if (safeCount >= 8) return 3;
    if (safeCount >= 4) return 2;
    return 1;
  }

  // Use a blend of absolute thresholds and relative max so a single 15-min day
  // in an empty month looks gentle (level 1-2) rather than max intensity (level 4).
  const effectiveMax = Math.max(maxMinutes, 120);
  const ratio = safeMin / effectiveMax;

  if (ratio >= 0.75 || safeMin >= 180) return 4;
  if (ratio >= 0.45 || safeMin >= 90) return 3;
  if (ratio >= 0.2 || safeMin >= 30) return 2;
  return 1;
}

export interface KindBreakdown {
  readonly kind: MediaKind;
  readonly count: number;
  readonly minutes: number;
}

export interface FeaturedCoverItem {
  readonly id: number;
  readonly title: string;
  readonly subtitle: string | null;
  readonly coverUrl: string | null;
  readonly source: string;
  readonly mediaType: string;
  readonly kind: MediaKind;
  readonly date: string;
  readonly totalMinutes: number;
  readonly sessionCount: number;
}

export interface CalendarMonthSummary {
  readonly totalMinutes: number;
  readonly totalItems: number;
  readonly activeDays: number;
  readonly maxDayMinutes: number;
  readonly busiestDay: { date: string; minutes: number; count: number } | null;
  readonly byKind: Readonly<Record<MediaKind, KindBreakdown>>;
  readonly featuredItems: readonly FeaturedCoverItem[];
}

/**
 * Aggregates a month's `CalendarDay[]` into summary statistics and a
 * deduplicated shelf of featured titles (prioritizing items with cover art).
 */
export function summarizeCalendarMonth(
  days: readonly CalendarDay[],
  month: string
): CalendarMonthSummary {
  let totalMinutes = 0;
  let totalItems = 0;
  let activeDays = 0;
  let maxDayMinutes = 0;
  let busiestDay: { date: string; minutes: number; count: number } | null = null;

  const kindCounts: Record<MediaKind, { count: number; minutes: number }> = {
    audiobook: { count: 0, minutes: 0 },
    youtube: { count: 0, minutes: 0 },
    film: { count: 0, minutes: 0 },
    manual: { count: 0, minutes: 0 },
  };

  const titleGroups = new Map<
    string,
    {
      id: number;
      title: string;
      subtitle: string | null;
      coverUrl: string | null;
      source: string;
      mediaType: string;
      kind: MediaKind;
      date: string;
      totalMinutes: number;
      sessionCount: number;
    }
  >();

  for (const day of days) {
    if (!day.date.startsWith(month)) {
      continue;
    }
    const dayMin = Math.max(0, day.minutes ?? 0);
    const dayCount = Math.max(0, day.count ?? 0);

    totalMinutes += dayMin;
    totalItems += dayCount;

    if (dayCount > 0 || dayMin > 0) {
      activeDays += 1;
      if (dayMin > maxDayMinutes) {
        maxDayMinutes = dayMin;
      }
      if (
        busiestDay === null ||
        dayMin > busiestDay.minutes ||
        (dayMin === busiestDay.minutes && dayCount > busiestDay.count)
      ) {
        busiestDay = { date: day.date, minutes: dayMin, count: dayCount };
      }
    }

    for (const item of day.items ?? []) {
      const kind = resolveMediaKind(item.source, item.media_type);
      const itemMin =
        item.duration_seconds !== null &&
        item.duration_seconds !== undefined &&
        item.duration_seconds > 0
          ? item.duration_seconds / 60
          : 0;

      kindCounts[kind].count += 1;
      kindCounts[kind].minutes += itemMin;

      // Group by parent_title (for series/podcasts) or title so the shelf shows unique works.
      const displayTitle =
        item.media_type === "episode" && item.parent_title
          ? item.parent_title
          : item.title ?? item.parent_title ?? "Untitled";
      const displaySubtitle =
        item.media_type === "episode" && item.parent_title
          ? item.title
          : item.parent_title;

      const groupKey = `${item.source}:${displayTitle.toLowerCase().trim()}`;
      const existing = titleGroups.get(groupKey);
      if (existing) {
        existing.totalMinutes += itemMin;
        existing.sessionCount += 1;
        if (!existing.coverUrl && item.cover_url) {
          existing.coverUrl = item.cover_url;
        }
        if (day.date > existing.date) {
          existing.date = day.date;
        }
      } else {
        titleGroups.set(groupKey, {
          id: item.id,
          title: displayTitle,
          subtitle: displaySubtitle ?? null,
          coverUrl: item.cover_url ?? null,
          source: item.source,
          mediaType: item.media_type,
          kind,
          date: day.date,
          totalMinutes: itemMin,
          sessionCount: 1,
        });
      }
    }
  }

  // Sort featured items: items with real covers first, then by totalMinutes desc, then sessionCount desc.
  const featuredItems = [...titleGroups.values()]
    .sort((a, b) => {
      const aHasCover = a.coverUrl ? 1 : 0;
      const bHasCover = b.coverUrl ? 1 : 0;
      if (bHasCover !== aHasCover) {
        return bHasCover - aHasCover;
      }
      if (b.totalMinutes !== a.totalMinutes) {
        return b.totalMinutes - a.totalMinutes;
      }
      if (b.sessionCount !== a.sessionCount) {
        return b.sessionCount - a.sessionCount;
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, 12);

  return {
    totalMinutes: Math.round(totalMinutes),
    totalItems,
    activeDays,
    maxDayMinutes: Math.round(maxDayMinutes),
    busiestDay,
    byKind: {
      audiobook: {
        kind: "audiobook",
        count: kindCounts.audiobook.count,
        minutes: Math.round(kindCounts.audiobook.minutes),
      },
      youtube: {
        kind: "youtube",
        count: kindCounts.youtube.count,
        minutes: Math.round(kindCounts.youtube.minutes),
      },
      film: {
        kind: "film",
        count: kindCounts.film.count,
        minutes: Math.round(kindCounts.film.minutes),
      },
      manual: {
        kind: "manual",
        count: kindCounts.manual.count,
        minutes: Math.round(kindCounts.manual.minutes),
      },
    },
    featuredItems,
  };
}

/**
 * Picks up to `limit` representative items for a day cell in the calendar grid,
 * prioritizing items with cover images so the calendar grid showcases cover art.
 */
export function pickDayPreviewItems(
  items: readonly CalendarItem[],
  limit = 3
): CalendarItem[] {
  if (!items || items.length === 0 || limit <= 0) {
    return [];
  }
  // Deduplicate by cover_url or title within the day so 5 chapters of the same
  // audiobook don't repeat the same cover 3 times in a single day cell.
  const unique: CalendarItem[] = [];
  const seenKeys = new Set<string>();

  for (const item of items) {
    const key =
      item.cover_url ??
      `${item.source}:${(item.parent_title ?? item.title ?? "").toLowerCase()}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      unique.push(item);
    }
  }

  const sorted = [...unique].sort((a, b) => {
    const aCover = a.cover_url ? 1 : 0;
    const bCover = b.cover_url ? 1 : 0;
    if (bCover !== aCover) return bCover - aCover;
    const aDur = a.duration_seconds ?? 0;
    const bDur = b.duration_seconds ?? 0;
    return bDur - aDur;
  });

  return sorted.slice(0, limit);
}

// --- Hash Routing ----------------------------------------------------------

export type Route =
  | "calendar"
  | "progress"
  | "heatmap"
  | "stats"
  | "importexport"
  | "add"
  | "year"
  | "search";

export interface RouteDef {
  readonly id: Route;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
}

export const ALL_ROUTES: ReadonlyArray<RouteDef> = [
  {
    id: "calendar",
    label: "Calendar",
    shortLabel: "Calendar",
    description: "Daily consumption log and monthly library view",
  },
  {
    id: "progress",
    label: "Reading & Watch List",
    shortLabel: "Progress",
    description: "In-progress and finished titles with ratings and notes",
  },
  {
    id: "stats",
    label: "Statistics",
    shortLabel: "Stats",
    description: "Streaks, weekly and monthly trends, goals, and top titles",
  },
  {
    id: "heatmap",
    label: "Activity Heatmap",
    shortLabel: "Heatmap",
    description: "Year-at-a-glance intensity grid and time-of-day rhythm",
  },
  {
    id: "add",
    label: "Log Activity",
    shortLabel: "Add",
    description: "Record a manual book, film, album, or listening session",
  },
  {
    id: "year",
    label: "Year in Review",
    shortLabel: "Year",
    description: "Annual highlights, milestones, and favourite works",
  },
  {
    id: "search",
    label: "Library Search",
    shortLabel: "Search",
    description: "Search across every logged title, author, series, and channel",
  },
  {
    id: "importexport",
    label: "Sync & Data",
    shortLabel: "Sync",
    description: "Audiobookshelf and Simkl sync, YouTube Takeout import, and backups",
  },
];

/** Main tabs shown in the mobile bottom bar (4 primary + Add, plus More trigger). */
export const MOBILE_PRIMARY_ROUTES: ReadonlyArray<Route> = [
  "calendar",
  "progress",
  "stats",
  "add",
];

/** Routes surfaced inside the mobile "More" sheet. */
export const MOBILE_MORE_ROUTES: ReadonlyArray<Route> = [
  "search",
  "heatmap",
  "year",
  "importexport",
];

export const DEFAULT_ROUTE: Route = "calendar";

export interface ParsedRoute {
  route: Route;
  date?: string;
  year?: string;
  q?: string;
  hitKey?: string;
}

/**
 * Read the route and optional query params out of the hash
 * (e.g. `#/calendar?date=2026-10-17`, `#/search?q=harry`).
 */
export function parseHash(hash: string): ParsedRoute {
  const stripped = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = stripped.split("?");
  const raw = (pathPart ?? "").split(/[?/]/, 1)[0];
  const match = ALL_ROUTES.find((r) => r.id === raw);
  const route = match ? match.id : DEFAULT_ROUTE;

  let date: string | undefined;
  let year: string | undefined;
  let q: string | undefined;
  let hitKey: string | undefined;
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    const d = params.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      date = d;
    }
    const y = params.get("year");
    if (y && /^\d{4}$/.test(y)) {
      year = y;
    }
    const qRaw = params.get("q");
    if (qRaw && qRaw.length <= 200) {
      q = qRaw;
    }
    const keyRaw = params.get("key");
    if (keyRaw && keyRaw.length <= 500) {
      hitKey = keyRaw;
    }
  }

  return { route, date, year, q, hitKey };
}
