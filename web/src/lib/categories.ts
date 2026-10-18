/**
 * Category metadata, colour tokens, and resolution helpers for InputTracker v2.
 *
 * Categories come from `src/core/category.ts`:
 * `anime`, `series`, `film`, `book`, `audiobook`, `youtube`, `podcast`, `music`, `other`.
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
