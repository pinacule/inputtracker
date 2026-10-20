/**
 * Category metadata, colour tokens, resolution helpers, and v2.2 work progress /
 * card / season / history label formatters for InputTracker.
 *
 * Categories come from `src/core/category.ts`:
 * `anime`, `series`, `film`, `book`, `audiobook`, `youtube`, `podcast`, `music`, `shortform`, `other`.
 * Every category has one consistent colour across badges, calendar bars, charts,
 * library tabs, and fallback cover tiles.
 *
 * Pure and DOM-free; safe to run under Bun or in the browser.
 */

import {
  CATEGORIES,
  categoryOf,
  isCategory,
  type Category,
} from "../../../src/core/category";
import { formatLocalDay } from "./format-date";
import { sourceLabel } from "./sources";
import { formatMinutes } from "./stats";

export { CATEGORIES, categoryOf, isCategory, type Category };

export interface CategoryMeta {
  readonly category: Category;
  readonly label: string;
  readonly pluralLabel: string;
  readonly shortLabel: string;
  readonly unitSingular: string;
  readonly unitPlural: string;
  readonly cssVarPrefix: string;
  /** Light-mode / chart solid hex colour. */
  readonly color: string;
  /** Default cover aspect ratio in the Library grid. */
  readonly defaultAspect: "poster" | "square" | "wide";
}

export const CATEGORY_META: Readonly<Record<Category, CategoryMeta>> = {
  anime: {
    category: "anime",
    label: "Anime",
    pluralLabel: "Anime",
    shortLabel: "Anime",
    unitSingular: "episode",
    unitPlural: "episodes",
    cssVarPrefix: "--cat-anime",
    color: "#5248c9",
    defaultAspect: "poster",
  },
  series: {
    category: "series",
    label: "Series",
    pluralLabel: "Series",
    shortLabel: "Series",
    unitSingular: "episode",
    unitPlural: "episodes",
    cssVarPrefix: "--cat-series",
    color: "#157a8c",
    defaultAspect: "poster",
  },
  film: {
    category: "film",
    label: "Film",
    pluralLabel: "Films",
    shortLabel: "Film",
    unitSingular: "viewing",
    unitPlural: "viewings",
    cssVarPrefix: "--cat-film",
    color: "#be7112",
    defaultAspect: "poster",
  },
  book: {
    category: "book",
    label: "Book",
    pluralLabel: "Books",
    shortLabel: "Book",
    unitSingular: "book",
    unitPlural: "books",
    cssVarPrefix: "--cat-book",
    color: "#267855",
    defaultAspect: "poster",
  },
  audiobook: {
    category: "audiobook",
    label: "Audiobook",
    pluralLabel: "Audiobooks",
    shortLabel: "Audiobook",
    unitSingular: "session",
    unitPlural: "sessions",
    cssVarPrefix: "--cat-audiobook",
    color: "#6d3fa0",
    defaultAspect: "square",
  },
  youtube: {
    category: "youtube",
    label: "YouTube",
    pluralLabel: "YouTube",
    shortLabel: "YouTube",
    unitSingular: "video",
    unitPlural: "videos",
    cssVarPrefix: "--cat-youtube",
    color: "#c23528",
    defaultAspect: "wide",
  },
  podcast: {
    category: "podcast",
    label: "Podcast",
    pluralLabel: "Podcasts",
    shortLabel: "Podcast",
    unitSingular: "episode",
    unitPlural: "episodes",
    cssVarPrefix: "--cat-podcast",
    color: "#b8511b",
    defaultAspect: "square",
  },
  music: {
    category: "music",
    label: "Music",
    pluralLabel: "Music",
    shortLabel: "Music",
    unitSingular: "play",
    unitPlural: "plays",
    cssVarPrefix: "--cat-music",
    color: "#b0306a",
    defaultAspect: "square",
  },
  shortform: {
    category: "shortform", label: "Short-form", pluralLabel: "Short-form", shortLabel: "Short-form",
    unitSingular: "minute", unitPlural: "minutes", cssVarPrefix: "--cat-shortform", color: "#6194cf", defaultAspect: "square",
  },
  other: {
    category: "other",
    label: "Other",
    pluralLabel: "Other",
    shortLabel: "Other",
    unitSingular: "entry",
    unitPlural: "entries",
    cssVarPrefix: "--cat-other",
    color: "#756a5d",
    defaultAspect: "square",
  },
};

/**
 * Resolves the canonical `Category` for any UI item or event.
 * Checks explicit `item.category` first, then `categoryOf`, with source-aware
 * fallback when `media_type` is omitted.
 */
export function resolveItemCategory(item: {
  category?: string | null;
  media_type?: string | null;
  source?: string | null;
  external_ids?: unknown;
  raw?: unknown;
}): Category {
  if (isCategory(item.category)) {
    return item.category;
  }

  let mediaType = (item.media_type ?? "").toLowerCase().trim();
  const source = (item.source ?? "").toLowerCase().trim();

  if (!mediaType) {
    if (source === "audiobookshelf" || source === "abs") {
      mediaType = "audiobook";
    } else if (source === "youtube") {
      mediaType = "video";
    } else if (source === "simkl") {
      mediaType = "movie";
    } else {
      mediaType = "other";
    }
  }

  return categoryOf({
    media_type: mediaType,
    external_ids: item.external_ids,
    raw: item.raw,
  });
}

export function categoryLabel(category: Category | string | null | undefined): string {
  if (isCategory(category)) {
    return CATEGORY_META[category].label;
  }
  return "Other";
}

export function categoryPluralLabel(
  category: Category | string | null | undefined
): string {
  if (isCategory(category)) {
    return CATEGORY_META[category].pluralLabel;
  }
  return "Other";
}

export function categoryColor(category: Category | string | null | undefined): string {
  if (isCategory(category)) {
    return CATEGORY_META[category].color;
  }
  return CATEGORY_META.other.color;
}

export function categoryCssColor(
  category: Category | string | null | undefined
): string {
  if (isCategory(category)) {
    return `var(${CATEGORY_META[category].cssVarPrefix}-solid)`;
  }
  return "var(--cat-other-solid)";
}

export function formatCategoryUnits(category: Category, units: number): string {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.other;
  const safe = Math.max(0, Math.round(units));
  return `${safe} ${safe === 1 ? meta.unitSingular : meta.unitPlural}`;
}

// --- v2.2 Work Progress, Card/Row Labels, Compact Seasons & History ---------

export interface WorkProgressLike {
  readonly seasons_watched: number;
  readonly seasons_total: number | null;
  readonly episodes_watched: number;
  readonly episodes_total: number | null;
}

/**
 * Resolves explicit `progress` for a work, falling back to `seasons` on
 * `LibraryWorkDetail` when `progress` is not yet populated by the backend.
 */
export function resolveWorkProgress(work: {
  category: Category;
  progress?: WorkProgressLike | null;
  seasons?: ReadonlyArray<{ episodes: number; watched_episodes?: number }>;
}): WorkProgressLike | null {
  if (work.progress) {
    return work.progress;
  }
  if (
    (work.category === "series" || work.category === "anime") &&
    work.seasons &&
    work.seasons.length > 0
  ) {
    const seasons_total = work.seasons.length;
    const seasons_watched = work.seasons.filter(
      (s) => (s.watched_episodes ?? 0) > 0
    ).length;
    const episodes_total = work.seasons.reduce(
      (acc, s) => acc + Math.max(0, s.episodes || 0),
      0
    );
    const episodes_watched = work.seasons.reduce(
      (acc, s) => acc + Math.max(0, s.watched_episodes ?? 0),
      0
    );
    return {
      seasons_watched,
      seasons_total,
      episodes_watched,
      episodes_total: episodes_total > 0 ? episodes_total : null,
    };
  }
  return null;
}

/**
 * Formats the unit/progress badge for a Library card or row (v2.2 section 13 & 15):
 * - NEVER prints `"N episodes"` from `work.units` for series/anime!
 * - Series / Anime: uses `progress` (`"3 seasons · 36 ep"`, `"planned · 3 seasons"`),
 *   degrading gracefully to `null` when `progress` is null.
 * - Audiobooks: `"1 session"` / `"N sessions"`
 * - Music / YouTube: `"1 play"` / `"N plays"`
 * - Films: `"N viewings"` (when > 1, or `"1 viewing"` when 0 minutes)
 * - Podcasts: `"1 episode"` / `"N episodes"`
 */
export function formatWorkUnitLabel(work: {
  category: Category;
  status?: string;
  units: number;
  total_minutes?: number;
  progress?: WorkProgressLike | null;
  seasons?: ReadonlyArray<{ episodes: number; watched_episodes?: number }>;
}): string | null {
  const p = resolveWorkProgress(work);

  if (work.category === "series" || work.category === "anime") {
    if (work.status === "planned") {
      if (p && p.seasons_total && p.seasons_total > 0) {
        return `planned · ${p.seasons_total} ${
          p.seasons_total === 1 ? "season" : "seasons"
        }`;
      }
      if (p && p.episodes_total && p.episodes_total > 0) {
        return `planned · ${p.episodes_total} ep`;
      }
      return "Planned";
    }

    if (!p) {
      return null;
    }

    const sWatched = Math.max(0, Math.round(p.seasons_watched || 0));
    const epWatched = Math.max(0, Math.round(p.episodes_watched || 0));
    const sTotal =
      p.seasons_total !== null && p.seasons_total !== undefined
        ? Math.max(0, Math.round(p.seasons_total))
        : null;

    if (sWatched > 0 && epWatched > 0) {
      return `${sWatched} ${
        sWatched === 1 ? "season" : "seasons"
      } · ${epWatched} ep`;
    }
    if (sWatched > 0) {
      return `${sWatched} ${sWatched === 1 ? "season" : "seasons"}`;
    }
    if (epWatched > 0) {
      return `${epWatched} ep`;
    }
    if (sTotal && sTotal > 0) {
      return `${sTotal} ${sTotal === 1 ? "season" : "seasons"}`;
    }
    return null;
  }

  if (work.status === "planned") {
    return "Planned";
  }

  const u = Math.max(0, Math.round(work.units || 0));

  switch (work.category) {
    case "shortform":
      return null;
    case "audiobook":
      return u > 0 ? `${u} ${u === 1 ? "session" : "sessions"}` : null;
    case "music":
    case "youtube":
      return u > 0 ? `${u} ${u === 1 ? "play" : "plays"}` : null;
    case "film":
      if (u > 1) return `${u} viewings`;
      if (u === 1 && (!work.total_minutes || work.total_minutes <= 0)) {
        return "1 viewing";
      }
      return null;
    case "podcast":
      return u > 0 ? `${u} ${u === 1 ? "episode" : "episodes"}` : null;
    case "book":
      return null;
    case "other":
      return u > 1 ? `${u} entries` : null;
  }
}

/**
 * Formats the complete meta line for a Library card or row, combining
 * duration and `formatWorkUnitLabel` (e.g. `"27h · 3 seasons · 36 ep"`,
 * `"planned · 3 seasons"`, `"12h · 14 sessions"`, `"18m · 5 plays"`).
 */
export function formatWorkCardMeta(work: {
  category: Category;
  status?: string;
  units: number;
  total_minutes: number;
  consumption_progress?: number | null;
  progress?: WorkProgressLike | null;
  seasons?: ReadonlyArray<{ episodes: number; watched_episodes?: number }>;
}): string {
  const unitLabel = formatWorkUnitLabel(work);

  if (work.status === "planned") {
    return unitLabel ?? "Planned";
  }

  const timeLabel =
    work.total_minutes > 0 ? formatMinutes(work.total_minutes) : null;
  if ((work.category === "book" || work.category === "audiobook") && work.consumption_progress != null) {
    const percent = `${Math.round(work.consumption_progress * 100)}%`;
    return [percent, timeLabel, unitLabel].filter(Boolean).join(" · ");
  }

  if (timeLabel && unitLabel) {
    return `${timeLabel} · ${unitLabel}`;
  }
  if (timeLabel) {
    return timeLabel;
  }
  if (unitLabel) {
    return unitLabel;
  }

  switch (work.status) {
    case "in_progress":
      return "In progress";
    case "finished":
      return "Finished";
    case "dropped":
      return "Dropped";
    default:
      return "Logged";
  }
}

/**
 * Formats the full progress line for the Work detail page (spec section 17):
 * e.g. `"6 of 6 seasons · 65 of 65 episodes"` or `"Planned · 3 seasons · 36 episodes"`.
 */
export function formatWorkDetailProgress(work: {
  category: Category;
  status?: string;
  progress?: WorkProgressLike | null;
  seasons?: ReadonlyArray<{ episodes: number; watched_episodes?: number }>;
}): string | null {
  const p = resolveWorkProgress(work);
  if (!p) {
    return null;
  }

  const sWatched = Math.max(0, Math.round(p.seasons_watched || 0));
  const sTotal =
    p.seasons_total !== null &&
    p.seasons_total !== undefined &&
    p.seasons_total > 0
      ? Math.round(p.seasons_total)
      : null;
  const epWatched = Math.max(0, Math.round(p.episodes_watched || 0));
  const epTotal =
    p.episodes_total !== null &&
    p.episodes_total !== undefined &&
    p.episodes_total > 0
      ? Math.round(p.episodes_total)
      : null;

  if (work.status === "planned" && sWatched === 0 && epWatched === 0) {
    const parts: string[] = ["Planned"];
    if (sTotal) {
      parts.push(`${sTotal} ${sTotal === 1 ? "season" : "seasons"}`);
    }
    if (epTotal) {
      parts.push(`${epTotal} ${epTotal === 1 ? "episode" : "episodes"}`);
    }
    return parts.join(" · ");
  }

  const parts: string[] = [];
  if (sTotal !== null) {
    parts.push(
      `${sWatched} of ${sTotal} ${sTotal === 1 ? "season" : "seasons"}`
    );
  } else if (sWatched > 0) {
    parts.push(`${sWatched} ${sWatched === 1 ? "season" : "seasons"}`);
  }

  if (epTotal !== null) {
    parts.push(
      `${epWatched} of ${epTotal} ${epTotal === 1 ? "episode" : "episodes"}`
    );
  } else if (epWatched > 0) {
    parts.push(`${epWatched} ${epWatched === 1 ? "episode" : "episodes"}`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface CompactSeasonDisplay {
  readonly number: number;
  readonly heading: string;
  /** e.g. `"Season 2 · 2019 · 10 ep"` */
  readonly summary: string;
  /** e.g. `"2019 · 10 ep"` */
  readonly meta: string;
  readonly watchedEpisodes: number;
  readonly totalEpisodes: number;
  readonly statusLabel: string;
  readonly ratio: number;
  readonly isFinished: boolean;
  readonly isInProgress: boolean;
}

/**
 * Formats a season row compactly for the Work page (spec section 17):
 * Provider season titles like `"Cobra Kaii (2019)"` are noise — always show
 * `"Season 2 · 2019 · 10 ep"`.
 */
export function formatCompactSeasonRow(season: {
  number: number;
  title?: string | null;
  year?: number | null;
  episodes: number;
  watched_episodes?: number;
  total_minutes?: number | null;
}): CompactSeasonDisplay {
  const num = season.number;
  const heading = `Season ${num}`;
  const totalEp = Math.max(0, Math.round(season.episodes || 0));
  const watchedEp = Math.max(
    0,
    Math.min(
      totalEp > 0 ? totalEp : Math.max(0, season.watched_episodes ?? 0),
      Math.round(season.watched_episodes ?? 0)
    )
  );

  const metaParts: string[] = [];
  if (season.year && Number.isFinite(season.year)) {
    metaParts.push(String(season.year));
  }
  if (totalEp > 0) {
    metaParts.push(`${totalEp} ep`);
  }
  const meta = metaParts.join(" · ");
  const summary = [heading, ...metaParts].join(" · ");

  const isFinished = totalEp > 0 ? watchedEp >= totalEp : watchedEp > 0;
  const isInProgress = watchedEp > 0 && !isFinished;
  const ratio =
    totalEp > 0
      ? Math.max(0, Math.min(1, watchedEp / totalEp))
      : isFinished
        ? 1
        : 0;

  let statusLabel = "Not watched";
  if (isFinished) {
    statusLabel = totalEp > 0 ? `${totalEp} / ${totalEp} ep` : "Watched";
  } else if (isInProgress) {
    statusLabel = `${watchedEp} / ${totalEp} ep`;
  } else if (totalEp > 0) {
    statusLabel = `0 / ${totalEp} ep`;
  }

  return {
    number: num,
    heading,
    summary,
    meta,
    watchedEpisodes: watchedEp,
    totalEpisodes: totalEp,
    statusLabel,
    ratio,
    isFinished,
    isInProgress,
  };
}

export interface ReadableHistoryRow {
  readonly label: string;
  readonly dateLabel: string | null;
  readonly dateHref: string | null;
  readonly sourceBadge: string;
  /** Combined clean subtitle without `"Undated · Manual (Archive)"`. */
  readonly metaText: string;
  readonly minutesLabel: string | null;
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Formats a work history row cleanly without noisy `"Undated · Manual (Archive)"` text
 * (spec section 17).
 */
export function formatReadableHistoryItem(
  item: {
    started_at: string;
    precision: "day" | "month" | "year" | "unknown";
    label: string;
    minutes: number;
    source: string;
    entry_id: string | null;
  },
  workTitle: string
): ReadableHistoryRow {
  const cleanLabel = (item.label ?? "").trim() || workTitle;

  let dateLabel: string | null = null;
  let dateHref: string | null = null;

  if (item.precision !== "unknown" && item.started_at) {
    const datePart = item.started_at.slice(0, 10);
    if (item.precision === "year") {
      dateLabel = datePart.slice(0, 4);
    } else if (item.precision === "month") {
      const m = /^(\d{4})-(0[1-9]|1[0-2])/.exec(datePart);
      if (m) {
        const monthIdx = Number.parseInt(m[2]!, 10) - 1;
        dateLabel = `${SHORT_MONTHS[monthIdx]} ${m[1]}`;
      } else {
        dateLabel = datePart.slice(0, 7);
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      dateLabel = formatLocalDay(datePart);
      dateHref = `#/calendar?date=${datePart}`;
    }
  }

  const srcNorm = (item.source ?? "").trim().toLowerCase();
  const sourceBadge =
    item.entry_id || srcNorm === "manual" || srcNorm === "archive"
      ? "Archive"
      : sourceLabel(item.source);

  const metaParts: string[] = [];
  if (dateLabel) {
    metaParts.push(dateLabel);
  }
  if (sourceBadge) {
    metaParts.push(sourceBadge);
  }

  return {
    label: cleanLabel,
    dateLabel,
    dateHref,
    sourceBadge,
    metaText: metaParts.join(" · "),
    minutesLabel: item.minutes > 0 ? formatMinutes(item.minutes) : null,
  };
}
