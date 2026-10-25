/**
 * Day map: the selected day's entries as a nested treemap (Dot skin).
 * Outer tiles are categories sized by their minutes; inside each tile the
 * items are packed the same way, sized by their own minutes.
 *
 * Pure and DOM-free so it is testable under Bun.
 */

import type { Category } from "../api";
import type { ContextMenuTarget } from "./context-menu";
import type { HomeDayDetailModel } from "./home";

export interface DayMapItem {
  readonly key: string;
  readonly title: string;
  readonly minutes: number;
  /** Library link for the work, or null when there is nothing to open. */
  readonly href: string | null;
  readonly workKey: string | null;
  /** Right-click / long-press actions, same as the list rows. */
  readonly menu: ContextMenuTarget | null;
}

export interface DayMapGroup {
  readonly category: Category;
  readonly minutes: number;
  readonly items: readonly DayMapItem[];
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type Placed<T> = T & Rect;

const workHref = (key: string) => `#/library?work=${encodeURIComponent(key)}`;

/** Groups the day's works, YouTube videos, music tracks and short-form time by category. */
export function buildDayMapGroups(model: HomeDayDetailModel): DayMapGroup[] {
  const byCat = new Map<Category, DayMapItem[]>();
  const push = (cat: Category, item: DayMapItem) => {
    if (!(item.minutes > 0)) return;
    const list = byCat.get(cat) ?? [];
    list.push(item);
    byCat.set(cat, list);
  };
  for (const row of model.works) {
    push(row.category, {
      key: row.key,
      title: row.title,
      minutes: row.totalSeconds > 0 ? row.totalSeconds / 60 : row.totalMinutes,
      href: workHref(row.workKey),
      workKey: row.workKey,
      menu: {
        kind: row.entryId ? "archive-entry" : "day-work",
        workKey: row.workKey,
        title: row.title,
        category: row.category,
        status: row.status,
        rating: row.rating,
        entryId: row.entryId,
        consumed: row.archiveConsumed,
        when: row.archiveWhen,
        href: workHref(row.workKey),
        source: row.source,
      },
    });
  }
  for (const ch of model.youtube?.channels ?? []) {
    for (const v of ch.videos) {
      push("youtube", {
        key: `yt:${v.id}`,
        title: v.title,
        minutes: v.durationSeconds / 60,
        href: workHref(v.workKey),
        workKey: v.workKey,
        menu: {
          kind: "youtube-video",
          workKey: v.workKey,
          title: v.title,
          channel: v.channel,
          category: "youtube",
          rating: v.rating,
          href: workHref(v.workKey),
          source: "youtube",
        },
      });
    }
  }
  for (const t of model.music?.tracks ?? []) {
    push("music", {
      key: `music:${t.id}`,
      title: t.title,
      minutes: t.durationSeconds / 60,
      href: workHref(t.workKey),
      workKey: t.workKey,
      menu: {
        kind: "day-work",
        workKey: t.workKey,
        title: t.title,
        category: "music",
        href: workHref(t.workKey),
        source: "youtube",
      },
    });
  }
  if (model.shortformMinutes > 0) {
    push("shortform", {
      key: "shortform",
      title: "Short-form",
      minutes: model.shortformMinutes,
      href: null,
      workKey: null,
      menu: null,
    });
  }
  const groups: DayMapGroup[] = [];
  for (const [category, items] of byCat) {
    items.sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title));
    groups.push({ category, items, minutes: items.reduce((s, i) => s + i.minutes, 0) });
  }
  groups.sort((a, b) => b.minutes - a.minutes || a.category.localeCompare(b.category));
  return groups;
}

/**
 * Binary-split treemap. Items should be sorted largest first; each split cuts
 * the longer side so tiles stay close to square. Areas are proportional to
 * `weight(item)`; zero or negative weights are dropped.
 */
export function layoutTreemap<T>(
  items: readonly T[],
  rect: Rect,
  weight: (item: T) => number
): Placed<T>[] {
  const list = items.filter((i) => weight(i) > 0);
  const out: Placed<T>[] = [];
  const split = (part: readonly T[], r: Rect) => {
    if (part.length === 0) return;
    if (part.length === 1) {
      out.push({ ...(part[0] as T), x: r.x, y: r.y, w: r.w, h: r.h });
      return;
    }
    const total = part.reduce((s, i) => s + weight(i), 0);
    let acc = 0;
    let cut = 0;
    for (; cut < part.length - 1; cut++) {
      const next = acc + weight(part[cut] as T);
      if (cut > 0 && next > total / 2) break;
      acc = next;
    }
    if (cut === 0) cut = 1;
    const f = total > 0 ? acc / total : 0.5;
    const a = part.slice(0, cut);
    const b = part.slice(cut);
    if (r.w >= r.h) {
      split(a, { x: r.x, y: r.y, w: r.w * f, h: r.h });
      split(b, { x: r.x + r.w * f, y: r.y, w: r.w * (1 - f), h: r.h });
    } else {
      split(a, { x: r.x, y: r.y, w: r.w, h: r.h * f });
      split(b, { x: r.x, y: r.y + r.h * f, w: r.w, h: r.h * (1 - f) });
    }
  };
  split(list, rect);
  return out;
}

/** "1h52", "48m" — compact time for the map's dot-matrix numbers. */
export function compactMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
