import type { Category, CategoryTotal } from "../api";
import { CATEGORIES, categoryPluralLabel } from "../lib/categories";
import {
  toggleCategoryChip,
  updateHashCategorySelection,
  type CategoryFilterScope,
} from "../lib/category-filter";
import { formatHours } from "../lib/year-review";

export interface CategoryChipsProps {
  selected: readonly Category[];
  onChange: (next: Category[]) => void;
  totals?: readonly CategoryTotal[];
  availableCategories?: readonly Category[];
  /** @deprecated Kept for home page (`Calendar.tsx`) prop compatibility. */
  includeYoutubeInAll?: boolean;
  scope?: CategoryFilterScope;
  ariaLabel?: string;
  showCounts?: "units" | "works" | "hours" | "hours-works" | "none";
  syncUrl?: boolean;
  class?: string;
}

/**
 * Multi-select category filter chips.
 * - Clicking a category chip toggles it in `selected`.
 * - Clicking "All" clears `selected` (`[]`).
 * - Syncs selection to `?cat=anime,film` in `window.location.hash` when `syncUrl` is true.
 */
export function CategoryChips({
  selected,
  onChange,
  totals = [],
  availableCategories,
  scope = "all",
  ariaLabel = "Filter by category",
  showCounts = "none",
  syncUrl = true,
  class: className,
}: CategoryChipsProps) {
  const presentSet = new Set<Category>();
  for (const t of totals) {
    if (t.total_minutes > 0 || t.works > 0 || t.units > 0) {
      presentSet.add(t.category);
    }
  }
  for (const c of availableCategories ?? []) {
    presentSet.add(c);
  }
  for (const c of selected) {
    presentSet.add(c);
  }

  // Always show categories that have data; in Library also ensure YouTube and Music
  // chips remain reachable even when "All" excludes them.
  const categoriesToShow =
    presentSet.size > 0
      ? CATEGORIES.filter(
          (c) =>
            presentSet.has(c) ||
            (scope === "library" && (c === "youtube" || c === "music"))
        )
      : CATEGORIES;

  const applyChange = (next: Category[]) => {
    if (syncUrl && typeof window !== "undefined") {
      const nextHash = updateHashCategorySelection(window.location.hash, next);
      window.history.replaceState(null, "", nextHash);
    }
    onChange(next);
  };

  const handleToggle = (target: Category | "all") => {
    const next = toggleCategoryChip(selected, target);
    applyChange(next);
  };

  const isAllActive = selected.length === 0;

  const formatChipCount = (cat: Category): string | undefined => {
    if (showCounts === "none") return undefined;
    const entry = totals.find((t) => t.category === cat);
    if (!entry) return undefined;
    switch (showCounts) {
      case "units":
        return entry.units > 0 ? String(entry.units) : undefined;
      case "works":
        return entry.works > 0 ? String(entry.works) : undefined;
      case "hours":
        return entry.total_minutes > 0
          ? formatHours(entry.total_minutes)
          : undefined;
      case "hours-works":
        if (entry.total_minutes > 0) {
          return `${formatHours(entry.total_minutes)} · ${entry.works}`;
        }
        return entry.works > 0 ? String(entry.works) : undefined;
    }
  };

  return (
    <div
      class={`ui-cat-chips ${className ?? ""}`.trim()}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        class={
          isAllActive
            ? "ui-cat-chip ui-cat-chip--active"
            : "ui-cat-chip"
        }
        aria-pressed={isAllActive}
        onClick={() => handleToggle("all")}
        title={
          scope === "library"
            ? "All works (excluding YouTube and Music — click their chips to view)"
            : "All categories"
        }
      >
        <span>All</span>
      </button>

      {categoriesToShow.map((cat) => {
        const isSelected = selected.includes(cat);
        const countLabel = formatChipCount(cat);
        return (
          <button
            key={cat}
            type="button"
            class={
              isSelected
                ? `ui-cat-chip ui-cat-chip--active ui-cat-chip--${cat}`
                : `ui-cat-chip ui-cat-chip--${cat}`
            }
            aria-pressed={isSelected}
            onClick={() => handleToggle(cat)}
          >
            <span
              class={`ui-tab-dot ui-tab-dot--${cat}`}
              aria-hidden="true"
            />
            <span>{categoryPluralLabel(cat)}</span>
            {countLabel && (
              <span class="ui-cat-chip-count tabular-nums">{countLabel}</span>
            )}
          </button>
        );
      })}

      {selected.length > 1 && (
        <button
          type="button"
          class="ui-cat-chip-clear"
          onClick={() => handleToggle("all")}
        >
          Clear ({selected.length})
        </button>
      )}
    </div>
  );
}
