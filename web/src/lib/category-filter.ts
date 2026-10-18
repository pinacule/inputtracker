/**
 * Pure helpers for multi-select category chips (`?cat=anime,film`),
 * API `category=` / `exclude=` parameters, and the "Include YouTube in All"
 * setting (`inputtracker.includeYoutubeInAll`).
 *
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import { isCategory, type Category } from "./categories";
import type { ThemeStorageLike } from "./theme";

export const INCLUDE_YOUTUBE_STORAGE_KEY = "inputtracker.includeYoutubeInAll";

function defaultStorage(): ThemeStorageLike | null {
  try {
    const ls = (globalThis as unknown as { localStorage?: ThemeStorageLike })
      .localStorage;
    if (
      ls &&
      typeof ls.getItem === "function" &&
      typeof ls.setItem === "function"
    ) {
      return ls;
    }
  } catch {
    // Ignore storage access errors.
  }
  return null;
}

/**
 * Reads the "Include YouTube in All" setting from storage (default `false`).
 */
export function readIncludeYoutubeInAll(
  storage: ThemeStorageLike | null = defaultStorage()
): boolean {
  if (!storage) {
    return false;
  }
  try {
    const raw = storage.getItem(INCLUDE_YOUTUBE_STORAGE_KEY);
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

/**
 * Saves the "Include YouTube in All" setting to storage.
 */
export function saveIncludeYoutubeInAll(
  include: boolean,
  storage: ThemeStorageLike | null = defaultStorage()
): boolean {
  const valid = Boolean(include);
  if (storage) {
    try {
      storage.setItem(INCLUDE_YOUTUBE_STORAGE_KEY, valid ? "1" : "0");
    } catch {
      // Ignore storage write errors.
    }
  }
  return valid;
}

/**
 * Parses a category selection from a comma-separated list (`"anime,film"`),
 * query string (`"?cat=anime,film"`), location hash (`"#/library?cat=anime,film"`),
 * or `URLSearchParams`.
 *
 * Reads `cat` first, falling back to `category` for backwards compatibility.
 */
export function parseCategorySelection(
  input: string | URLSearchParams | null | undefined
): Category[] {
  if (!input) {
    return [];
  }

  let rawList = "";
  if (input instanceof URLSearchParams) {
    rawList = input.get("cat") ?? input.get("category") ?? "";
  } else {
    const str = input.trim();
    if (str.includes("?") || str.includes("=")) {
      const qIdx = str.indexOf("?");
      const queryPart = qIdx !== -1 ? str.slice(qIdx + 1) : str;
      const params = new URLSearchParams(queryPart);
      rawList = params.get("cat") ?? params.get("category") ?? "";
    } else {
      rawList = str;
    }
  }

  if (!rawList) {
    return [];
  }

  const seen = new Set<Category>();
  const result: Category[] = [];
  for (const part of rawList.split(",")) {
    const token = part.trim().toLowerCase();
    if (isCategory(token) && !seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

/**
 * Serializes selected categories into a comma-separated string (`"anime,film"`),
 * or `undefined` when empty ("All").
 */
export function formatCategorySelectionParam(
  categories: readonly Category[]
): string | undefined {
  const seen = new Set<Category>();
  const valid: Category[] = [];
  for (const cat of categories) {
    if (isCategory(cat) && !seen.has(cat)) {
      seen.add(cat);
      valid.push(cat);
    }
  }
  return valid.length > 0 ? valid.join(",") : undefined;
}

/**
 * Toggles a category chip in a multi-select chip bar:
 * - `"all"` clears the selection (`[]`)
 * - Clicking an active category removes it
 * - Clicking an inactive category adds it
 */
export function toggleCategoryChip(
  current: readonly Category[],
  clicked: Category | "all"
): Category[] {
  if (clicked === "all") {
    return [];
  }
  if (!isCategory(clicked)) {
    return [...current];
  }
  const exists = current.includes(clicked);
  if (exists) {
    return current.filter((c) => c !== clicked);
  }
  return [...current, clicked];
}

/**
 * Builds the `category` and `exclude` API query parameters for a given
 * multi-select category state and `includeYoutubeInAll` preference.
 */
export function buildCategoryFilterParams(
  selected: readonly Category[],
  includeYoutubeInAll = false
): { category?: string; exclude?: string } {
  const catParam = formatCategorySelectionParam(selected);
  if (catParam) {
    return { category: catParam };
  }
  if (!includeYoutubeInAll) {
    return { exclude: "youtube" };
  }
  return {};
}

/**
 * Client-side predicate matching an item's category against the active
 * multi-select chips and the `includeYoutubeInAll` setting.
 */
export function matchesCategorySelection(
  category: Category,
  selected: readonly Category[],
  includeYoutubeInAll = false
): boolean {
  if (selected.length > 0) {
    return selected.includes(category);
  }
  if (!includeYoutubeInAll && category === "youtube") {
    return false;
  }
  return true;
}

/**
 * Updates the `?cat=` query parameter in a location hash while preserving
 * the route path and other query parameters.
 */
export function updateHashCategorySelection(
  hash: string,
  selected: readonly Category[]
): string {
  const stripped = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = stripped.split("?");
  const route = (pathPart ?? "").trim() || "calendar";
  const params = new URLSearchParams(queryPart ?? "");

  params.delete("category");
  const catParam = formatCategorySelectionParam(selected);
  if (catParam) {
    params.set("cat", catParam);
  } else {
    params.delete("cat");
  }

  const qs = params.toString();
  return qs ? `#/${route}?${qs}` : `#/${route}`;
}
