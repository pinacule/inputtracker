/**
 * Pure UI logic for InputTracker's cover-first design system, routing,
 * media kind classification, cover fallback initials, and calendar summaries.
 *
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import type { CalendarDay, CalendarItem, Category, CategoryTotal } from "../api";
import { formatDuration, formatSeasonEpisode } from "./calendar";
import { CATEGORIES, formatCategoryUnits, groupCategory, resolveItemCategory } from "./categories";

export {
  CATEGORIES,
  CATEGORY_META,
  categoryColor,
  categoryCssColor,
  categoryLabel,
  categoryOf,
  categoryPluralLabel,
  formatCategoryUnits,
  isCategory,
  resolveItemCategory,
  type Category,
  type CategoryMeta,
} from "./categories";

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

// --- V2 Category-First Calendar Cell & Month Summaries ---------------------

export interface DayCategorySegment {
  readonly category: Category;
  readonly minutes: number;
  readonly count: number;
  readonly sharePct: number;
}

export interface DayWorkPreview {
  readonly title: string;
  readonly category: Category;
  readonly minutes: number;
  readonly count: number;
}

export interface DayCellSummaryV2 {
  readonly count: number;
  readonly minutes: number;
  readonly intensity: IntensityLevel;
  /** Overall bar width ratio (0..1) relative to the month's peak day. */
  readonly barWidthRatio: number;
  readonly categorySegments: readonly DayCategorySegment[];
  readonly workTitles: readonly DayWorkPreview[];
  readonly overflowWorks: number;
}

/**
 * Resolves the work/group title for a calendar item (e.g., show name for an episode,
 * channel for a YouTube video when parent_title exists, or item title).
 */
export function resolveCalendarWorkTitle(item: CalendarItem): string {
  const cat = resolveItemCategory(item);
  if (
    (cat === "anime" ||
      cat === "series" ||
      cat === "podcast" ||
      item.media_type === "episode") &&
    item.parent_title &&
    item.parent_title.trim() !== ""
  ) {
    return item.parent_title.trim();
  }
  return (item.title ?? item.parent_title ?? "Untitled").trim() || "Untitled";
}

/**
 * Summarizes one calendar day into a compact, cover-free cell representation:
 * category time segments (for the bottom proportional bar) + deduplicated work
 * titles with category dots (for desktop cells).
 */
export function summarizeDayCellV2(
  day: CalendarDay | undefined,
  maxMonthMinutes: number,
  maxPreviews = 2
): DayCellSummaryV2 {
  const count = Math.max(0, day?.count ?? 0);
  const minutes = Math.max(0, day?.minutes ?? 0);
  const items = day?.items ?? [];

  if (count === 0 && minutes === 0 && items.length === 0) {
    return {
      count: 0,
      minutes: 0,
      intensity: 0,
      barWidthRatio: 0,
      categorySegments: [],
      workTitles: [],
      overflowWorks: 0,
    };
  }

  const intensity = computeDayIntensity(minutes, count, maxMonthMinutes);
  const effectiveMax = Math.max(maxMonthMinutes, 60);
  const barWidthRatio =
    minutes > 0
      ? Math.max(0.22, Math.min(1, minutes / effectiveMax))
      : Math.max(0.22, Math.min(1, count / 10));

  const catTotals = new Map<Category, { minutes: number; count: number }>();
  const worksMap = new Map<
    string,
    { title: string; category: Category; minutes: number; count: number }
  >();

  for (const item of items) {
    const cat = groupCategory(resolveItemCategory(item));
    const durMin =
      item.duration_seconds !== null &&
      item.duration_seconds !== undefined &&
      item.duration_seconds > 0
        ? item.duration_seconds / 60
        : 0;

    const existingCat = catTotals.get(cat);
    if (existingCat) {
      existingCat.minutes += durMin;
      existingCat.count += 1;
    } else {
      catTotals.set(cat, { minutes: durMin, count: 1 });
    }

    const workTitle =
      cat === "youtube" && item.parent_title
        ? item.parent_title.trim()
        : resolveCalendarWorkTitle(item);
    const workKey = `${cat}:${workTitle.toLowerCase()}`;
    const existingWork = worksMap.get(workKey);
    if (existingWork) {
      existingWork.minutes += durMin;
      existingWork.count += 1;
    } else {
      worksMap.set(workKey, {
        title: workTitle,
        category: cat,
        minutes: durMin,
        count: 1,
      });
    }
  }

  // Compute category segment percentages
  let totalWeight = 0;
  const useMinutesWeight = [...catTotals.values()].some((c) => c.minutes > 0);
  for (const entry of catTotals.values()) {
    totalWeight += useMinutesWeight
      ? Math.max(1, entry.minutes)
      : entry.count;
  }

  const categorySegments: DayCategorySegment[] = [];
  for (const cat of CATEGORIES) {
    const entry = catTotals.get(cat);
    if (!entry) continue;
    const weight = useMinutesWeight
      ? Math.max(1, entry.minutes)
      : entry.count;
    const sharePct =
      totalWeight > 0 ? Math.round((weight / totalWeight) * 1000) / 10 : 0;
    categorySegments.push({
      category: cat,
      minutes: Math.round(entry.minutes),
      count: entry.count,
      sharePct,
    });
  }

  const sortedWorks = [...worksMap.values()].sort((a, b) => {
    if (b.minutes !== a.minutes) return b.minutes - a.minutes;
    if (b.count !== a.count) return b.count - a.count;
    return a.title.localeCompare(b.title);
  });

  const workTitles = sortedWorks.slice(0, Math.max(0, maxPreviews)).map((w) => ({
    title: w.title,
    category: w.category,
    minutes: Math.round(w.minutes),
    count: w.count,
  }));
  const overflowWorks = Math.max(0, sortedWorks.length - workTitles.length);

  return {
    count,
    minutes: Math.round(minutes),
    intensity,
    barWidthRatio: Math.round(barWidthRatio * 100) / 100,
    categorySegments,
    workTitles,
    overflowWorks,
  };
}

export interface CalendarMonthSummaryV2 {
  readonly totalMinutes: number;
  readonly totalItems: number;
  readonly activeDays: number;
  readonly daysInMonth: number;
  readonly maxDayMinutes: number;
  readonly busiestDay: { date: string; minutes: number; count: number } | null;
  readonly dailyMinutesSeries: readonly number[];
  readonly categories: readonly CategoryTotal[];
}

/**
 * Aggregates a month's `CalendarDay[]` by `Category` and produces a daily
 * minutes array for the month sparkline.
 */
export function summarizeCalendarMonthV2(
  days: readonly CalendarDay[],
  month: string
): CalendarMonthSummaryV2 {
  const mMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  const yearNum = mMatch ? Number.parseInt(mMatch[1]!, 10) : 2026;
  const monthNum = mMatch ? Number.parseInt(mMatch[2]!, 10) : 10;
  const daysInMonth = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();

  const dailyMinutes = Array.from({ length: daysInMonth }, () => 0);

  let totalMinutes = 0;
  let totalItems = 0;
  let activeDays = 0;
  let maxDayMinutes = 0;
  let busiestDay: { date: string; minutes: number; count: number } | null = null;

  const catMap = new Map<
    Category,
    { minutes: number; units: number; works: Set<string> }
  >();

  for (const day of days) {
    if (!day.date.startsWith(month)) continue;
    const dayMin = Math.max(0, day.minutes ?? 0);
    const dayCount = Math.max(0, day.count ?? 0);
    const dayIndex = Number.parseInt(day.date.slice(8, 10), 10) - 1;
    if (dayIndex >= 0 && dayIndex < daysInMonth) {
      dailyMinutes[dayIndex] = Math.round(dayMin);
    }

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
        busiestDay = { date: day.date, minutes: Math.round(dayMin), count: dayCount };
      }
    }

    for (const item of day.items ?? []) {
      const cat = groupCategory(resolveItemCategory(item));
      const itemMin =
        item.duration_seconds !== null &&
        item.duration_seconds !== undefined &&
        item.duration_seconds > 0
          ? item.duration_seconds / 60
          : 0;
      const workTitle = resolveCalendarWorkTitle(item).toLowerCase();

      const existing = catMap.get(cat);
      if (existing) {
        existing.minutes += itemMin;
        existing.units += 1;
        existing.works.add(workTitle);
      } else {
        catMap.set(cat, {
          minutes: itemMin,
          units: 1,
          works: new Set([workTitle]),
        });
      }
    }
  }

  const categories: CategoryTotal[] = CATEGORIES.map((cat) => {
    const entry = catMap.get(cat);
    return {
      category: cat,
      total_minutes: Math.round(entry?.minutes ?? 0),
      works: entry?.works.size ?? 0,
      units: entry?.units ?? 0,
    };
  }).filter((c) => c.total_minutes > 0 || c.units > 0);

  return {
    totalMinutes: Math.round(totalMinutes),
    totalItems,
    activeDays,
    daysInMonth,
    maxDayMinutes: Math.round(maxDayMinutes),
    busiestDay,
    dailyMinutesSeries: dailyMinutes,
    categories,
  };
}

// --- V2.1 Day Panel Grouping (Grouped by Work + Collapsed YouTube Line) ----

export interface DayWorkGroup {
  readonly key: string;
  readonly workTitle: string;
  readonly category: Category;
  readonly source: string;
  readonly mediaType: string;
  readonly coverUrl: string | null;
  readonly totalMinutes: number;
  readonly totalSeconds: number;
  readonly sessionCount: number;
  /** Compact episode/subtitle summary, e.g. "S01E03–E05 · 3 episodes" or "S01E03 · The Journey". */
  readonly detailLabel: string | null;
  readonly latestLocalTime: string;
  readonly timeUncertain: boolean;
  readonly alsoFrom: readonly string[];
  readonly items: readonly CalendarItem[];
}

export interface DayYoutubeChannelGroup {
  readonly channel: string;
  readonly count: number;
  readonly minutes: number;
  readonly items: readonly CalendarItem[];
}

export interface DayYoutubeSummary {
  readonly count: number;
  readonly totalMinutes: number;
  readonly totalSeconds: number;
  /** e.g. "12 videos · 48 min" */
  readonly summaryLabel: string;
  readonly channels: readonly DayYoutubeChannelGroup[];
  readonly items: readonly CalendarItem[];
}

export interface GroupedDayPanel {
  readonly workGroups: readonly DayWorkGroup[];
  readonly youtubeSummary: DayYoutubeSummary | null;
}

function summarizeWorkEpisodesOrSessions(
  category: Category,
  workTitle: string,
  items: readonly CalendarItem[]
): string | null {
  if (items.length === 0) return null;

  if (items.length === 1) {
    const it = items[0]!;
    const se = formatSeasonEpisode(it.season, it.episode);
    const rawTitle = (it.title ?? "").trim();
    const isDifferentTitle =
      rawTitle !== "" && rawTitle.toLowerCase() !== workTitle.toLowerCase();
    if (se && isDifferentTitle) {
      return `${se} · ${rawTitle}`;
    }
    if (se) {
      return se;
    }
    if (isDifferentTitle) {
      return rawTitle;
    }
    if (it.parent_title && it.parent_title.trim().toLowerCase() !== workTitle.toLowerCase()) {
      return it.parent_title.trim();
    }
    return null;
  }

  // Multiple items for the same work on the same day
  const episodes = items
    .filter((i) => i.episode !== null && i.episode !== undefined)
    .sort((a, b) => {
      if ((a.season ?? 0) !== (b.season ?? 0)) {
        return (a.season ?? 0) - (b.season ?? 0);
      }
      return (a.episode ?? 0) - (b.episode ?? 0);
    });

  if (episodes.length >= 2) {
    const first = episodes[0]!;
    const last = episodes[episodes.length - 1]!;
    const firstSe = formatSeasonEpisode(first.season, first.episode);
    if (first.season === last.season && first.episode !== last.episode) {
      const epPad = String(last.episode).padStart(2, "0");
      return `${firstSe}–E${epPad} (${items.length} episodes)`;
    }
    const lastSe = formatSeasonEpisode(last.season, last.episode);
    if (firstSe && lastSe && firstSe !== lastSe) {
      return `${firstSe}–${lastSe} (${items.length} episodes)`;
    }
  }

  return formatCategoryUnits(category, items.length);
}

/**
 * Groups a day's `CalendarItem[]` for the compact v2.1 Day Panel:
 * - Non-YouTube items are grouped by work (category + normalized work title).
 * - YouTube items collapse into one expandable summary line ("12 videos · 48 min").
 */
export function groupDayPanelItems(
  items: readonly CalendarItem[]
): GroupedDayPanel {
  const workMap = new Map<
    string,
    {
      workTitle: string;
      category: Category;
      source: string;
      mediaType: string;
      coverUrl: string | null;
      totalSeconds: number;
      latestLocalTime: string;
      timeUncertain: boolean;
      alsoFrom: Set<string>;
      items: CalendarItem[];
    }
  >();

  const ytItems: CalendarItem[] = [];
  let ytTotalSeconds = 0;
  const ytChannelsMap = new Map<
    string,
    { channel: string; seconds: number; items: CalendarItem[] }
  >();

  for (const item of items) {
    const cat = groupCategory(resolveItemCategory(item));
    const sec =
      item.duration_seconds !== null &&
      item.duration_seconds !== undefined &&
      item.duration_seconds > 0
        ? item.duration_seconds
        : 0;

    if (cat === "youtube") {
      ytItems.push(item);
      ytTotalSeconds += sec;
      const chName = (item.parent_title ?? "YouTube").trim() || "YouTube";
      const existingCh = ytChannelsMap.get(chName);
      if (existingCh) {
        existingCh.seconds += sec;
        existingCh.items.push(item);
      } else {
        ytChannelsMap.set(chName, {
          channel: chName,
          seconds: sec,
          items: [item],
        });
      }
      continue;
    }

    const workTitle = resolveCalendarWorkTitle(item);
    const key = `${cat}:${workTitle.toLowerCase()}`;
    const existing = workMap.get(key);
    if (existing) {
      existing.totalSeconds += sec;
      if (!existing.coverUrl && item.cover_url) {
        existing.coverUrl = item.cover_url;
      }
      if (item.local_time && item.local_time > existing.latestLocalTime) {
        existing.latestLocalTime = item.local_time;
      }
      if (item.time_uncertain) {
        existing.timeUncertain = true;
      }
      for (const src of item.also_from ?? []) {
        existing.alsoFrom.add(src);
      }
      existing.items.push(item);
    } else {
      workMap.set(key, {
        workTitle,
        category: cat,
        source: item.source,
        mediaType: item.media_type,
        coverUrl: item.cover_url ?? null,
        totalSeconds: sec,
        latestLocalTime: item.local_time ?? "",
        timeUncertain: Boolean(item.time_uncertain),
        alsoFrom: new Set(item.also_from ?? []),
        items: [item],
      });
    }
  }

  const workGroups: DayWorkGroup[] = [...workMap.entries()]
    .map(([key, g]) => ({
      key,
      workTitle: g.workTitle,
      category: g.category,
      source: g.source,
      mediaType: g.mediaType,
      coverUrl: g.coverUrl,
      totalMinutes: Math.round(g.totalSeconds / 60),
      totalSeconds: g.totalSeconds,
      sessionCount: g.items.length,
      detailLabel: summarizeWorkEpisodesOrSessions(
        g.category,
        g.workTitle,
        g.items
      ),
      latestLocalTime: g.latestLocalTime,
      timeUncertain: g.timeUncertain,
      alsoFrom: [...g.alsoFrom],
      items: g.items,
    }))
    .sort((a, b) => {
      if (b.totalSeconds !== a.totalSeconds) {
        return b.totalSeconds - a.totalSeconds;
      }
      return a.workTitle.localeCompare(b.workTitle);
    });

  let youtubeSummary: DayYoutubeSummary | null = null;
  if (ytItems.length > 0) {
    const ytMin = Math.round(ytTotalSeconds / 60);
    const countLabel = `${ytItems.length} ${
      ytItems.length === 1 ? "video" : "videos"
    }`;
    const summaryLabel =
      ytTotalSeconds >= 60
        ? `${countLabel} · ${formatDuration(ytTotalSeconds)}`
        : countLabel;

    const channels: DayYoutubeChannelGroup[] = [...ytChannelsMap.values()]
      .map((c) => ({
        channel: c.channel,
        count: c.items.length,
        minutes: Math.round(c.seconds / 60),
        items: c.items,
      }))
      .sort((a, b) => {
        if (b.minutes !== a.minutes) return b.minutes - a.minutes;
        if (b.count !== a.count) return b.count - a.count;
        return a.channel.localeCompare(b.channel);
      });

    youtubeSummary = {
      count: ytItems.length,
      totalMinutes: ytMin,
      totalSeconds: ytTotalSeconds,
      summaryLabel,
      channels,
      items: ytItems,
    };
  }

  return { workGroups, youtubeSummary };
}

export interface CurrentWeekSummary {
  readonly todayMinutes: number;
  readonly todayItems: number;
  readonly todayWorks: number;
  readonly weekMinutes: number;
  readonly weekActiveDays: number;
  readonly weekDailyMinutes: readonly number[];
}

/**
 * Computes today's activity and the current Monday–Sunday week's summary
 * from a month's `CalendarDay[]`.
 */
export function summarizeCurrentWeek(
  days: readonly CalendarDay[],
  todayStr: string
): CurrentWeekSummary {
  const dayMap = new Map<string, CalendarDay>();
  for (const d of days) {
    dayMap.set(d.date, d);
  }

  const todayData = dayMap.get(todayStr);
  const todayGrouped = groupDayPanelItems(todayData?.items ?? []);
  const todayMinutes = Math.round(todayData?.minutes ?? 0);
  const todayItems = todayData?.count ?? 0;
  const todayWorks =
    todayGrouped.workGroups.length + (todayGrouped.youtubeSummary ? 1 : 0);

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayStr);
  if (!match) {
    return {
      todayMinutes,
      todayItems,
      todayWorks,
      weekMinutes: todayMinutes,
      weekActiveDays: todayMinutes > 0 || todayItems > 0 ? 1 : 0,
      weekDailyMinutes: [0, 0, 0, 0, 0, 0, 0],
    };
  }

  const y = Number.parseInt(match[1]!, 10);
  const m = Number.parseInt(match[2]!, 10);
  const d = Number.parseInt(match[3]!, 10);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const monOffset = (dt.getUTCDay() + 6) % 7; // 0 = Mon .. 6 = Sun
  const monday = new Date(Date.UTC(y, m - 1, d - monOffset));

  let weekMinutes = 0;
  let weekActiveDays = 0;
  const weekDailyMinutes: number[] = [];

  for (let i = 0; i < 7; i++) {
    const cur = new Date(
      Date.UTC(
        monday.getUTCFullYear(),
        monday.getUTCMonth(),
        monday.getUTCDate() + i
      )
    );
    const ds = `${String(cur.getUTCFullYear()).padStart(4, "0")}-${String(
      cur.getUTCMonth() + 1
    ).padStart(2, "0")}-${String(cur.getUTCDate()).padStart(2, "0")}`;
    const entry = dayMap.get(ds);
    const mins = Math.round(Math.max(0, entry?.minutes ?? 0));
    const cnt = Math.max(0, entry?.count ?? 0);
    weekDailyMinutes.push(mins);
    weekMinutes += mins;
    if (mins > 0 || cnt > 0) {
      weekActiveDays += 1;
    }
  }

  return {
    todayMinutes,
    todayItems,
    todayWorks,
    weekMinutes,
    weekActiveDays,
    weekDailyMinutes,
  };
}

