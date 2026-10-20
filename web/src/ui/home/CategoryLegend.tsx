import type { Category } from "../../../../src/core/category";
import { categoryCssColor, categoryPluralLabel } from "../../lib/categories";
import { formatMinutes } from "../../lib/stats";

export interface LegendEntry {
  readonly category: Category;
  readonly minutes: number;
  readonly count: number;
}

/** Category name, colour and time, biggest first; entries without time show their count. */
export function CategoryLegend({ entries, label }: { entries: readonly LegendEntry[]; label: string }) {
  const sorted = [...entries]
    .filter((e) => e.minutes > 0 || e.count > 0)
    .sort((a, b) => b.minutes - a.minutes || b.count - a.count);
  if (sorted.length === 0) return null;
  return (
    <ul class="home-legend" aria-label={label}>
      {sorted.map((e) => (
        <li key={e.category} class="home-legend-item">
          <span class="home-legend-dot" style={{ backgroundColor: categoryCssColor(e.category) }} aria-hidden="true" />
          <span class="home-legend-name">{categoryPluralLabel(e.category)}</span>
          <span class="home-legend-value tabular-nums">{e.minutes > 0 ? formatMinutes(e.minutes) : `${e.count}`}</span>
        </li>
      ))}
    </ul>
  );
}

/** Sum per-day segments into one entry per category. */
export function sumLegend(groups: ReadonlyArray<readonly LegendEntry[]>): LegendEntry[] {
  const totals = new Map<Category, { minutes: number; count: number }>();
  for (const group of groups) {
    for (const s of group) {
      const t = totals.get(s.category) ?? { minutes: 0, count: 0 };
      t.minutes += s.minutes;
      t.count += s.count;
      totals.set(s.category, t);
    }
  }
  return [...totals].map(([category, t]) => ({ category, ...t }));
}
