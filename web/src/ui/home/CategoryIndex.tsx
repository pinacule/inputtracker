/** @jsxImportSource preact */
import type { Category, CategoryTotal } from "../../api";
import { CATEGORIES, categoryPluralLabel } from "../../lib/categories";
import { toggleCategoryChip } from "../../lib/category-filter";
import { formatMinutes } from "../../lib/stats";

export interface CategoryIndexProps {
  readonly selected: readonly Category[];
  readonly totals: readonly CategoryTotal[];
  readonly availableCategories: readonly Category[];
  readonly onChange: (next: Category[]) => void;
}

/** A native disclosure and checkbox contents index, rather than another chip row. */
export function CategoryIndex({ selected, totals, availableCategories, onChange }: CategoryIndexProps) {
  const present = new Set([
    ...availableCategories,
    ...totals.filter((t) => t.total_minutes > 0 || t.works > 0 || t.units > 0).map((t) => t.category),
    ...selected,
  ]);
  const categories = present.size ? CATEGORIES.filter((c) => present.has(c)) : CATEGORIES;
  return (
    <details class="home-category-index">
      <summary>
        <span class="home-kicker">Contents</span>
        <span class="home-filter-selection">{selected.length ? selected.map(categoryPluralLabel).join(" / ") : "All categories"}</span>
        <span class="home-index-toggle" aria-hidden="true">+</span>
      </summary>
      <fieldset class="home-index-options">
        <legend class="sr-only">Filter calendar by category (select several)</legend>
        <label class="home-index-option home-index-option--all">
          <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
          <span>All categories</span><span class="home-index-note">Reset</span>
        </label>
        {categories.map((category) => {
          const total = totals.find((t) => t.category === category);
          return (
            <label key={category} class="home-index-option">
              <input type="checkbox" checked={selected.includes(category)} onChange={() => onChange(toggleCategoryChip(selected, category))} />
              <span>{categoryPluralLabel(category)}</span>
              <span class="home-index-note">{total && total.total_minutes > 0 ? formatMinutes(total.total_minutes) : "—"}</span>
            </label>
          );
        })}
      </fieldset>
    </details>
  );
}
