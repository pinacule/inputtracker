/**
 * Pure helpers for multi-select category chips (`?cat=anime,film`) and
 * API `category=` / `exclude=` parameters (v2.2 placement rules).
 *
 * Placement rules (spec section 15):
 * - Library "All" excludes YouTube and music (`exclude=youtube,music`).
 * - Calendar, Insights, Review, and Search include YouTube and music in "All".
 *
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import { isCategory, type Category } from "./categories";

export const LIBRARY_ALL_EXCLUDED_CATEGORIES: readonly Category[] = [
  "youtube",
  "music",
];

export type CategoryFilterScope = "all" | "library";

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
 * multi-select category state.
 *
 * - In `"library"` scope, `"All"` (`selected.length === 0`) returns `{ exclude: "youtube,music" }`.
 * - In `"all"` scope (default: Calendar, Insights, Review, Search), `"All"` returns `{}`
 *   so YouTube and music are included.
 */
export function buildCategoryFilterParams(
  selected: readonly Category[],
  scopeOrLegacy?: CategoryFilterScope | boolean
): { category?: string; exclude?: string } {
  const catParam = formatCategorySelectionParam(selected);
  if (catParam) {
    return { category: catParam };
  }
  if (scopeOrLegacy === "library") {
    return { exclude: LIBRARY_ALL_EXCLUDED_CATEGORIES.join(",") };
  }
  return {};
}

/**
 * Convenience helper for Library's "All" filter (`exclude=youtube,music`).
 */
export function buildLibraryCategoryFilterParams(
  selected: readonly Category[]
): { category?: string; exclude?: string } {
  return buildCategoryFilterParams(selected, "library");
}

/**
 * Client-side predicate matching an item's category against the active
 * multi-select chips.
 *
 * - In `"library"` scope, `"All"` (`selected.length === 0`) excludes `youtube` and `music`.
 * - In `"all"` scope (default: Calendar, Insights, Review, Search), `"All"` includes every category.
 */
export function matchesCategorySelection(
  category: Category,
  selected: readonly Category[],
  scopeOrLegacy?: CategoryFilterScope | boolean
): boolean {
  if (selected.length > 0) {
    return selected.includes(category);
  }
  if (scopeOrLegacy === "library") {
    return !LIBRARY_ALL_EXCLUDED_CATEGORIES.includes(category);
  }
  return true;
}

/**
 * Convenience predicate for Library's "All" filter (excludes YouTube and music when no chip is selected).
 */
export function matchesLibraryCategorySelection(
  category: Category,
  selected: readonly Category[]
): boolean {
  return matchesCategorySelection(category, selected, "library");
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
