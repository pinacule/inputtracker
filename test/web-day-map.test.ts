import { describe, expect, test } from "bun:test";
import {
  buildDayMapGroups,
  compactMinutes,
  layoutTreemap,
  splitEpisodeTitle,
} from "../web/src/lib/day-map.ts";
import type { HomeDayDetailModel, HomeDayWorkRow } from "../web/src/lib/home.ts";

function row(partial: Partial<HomeDayWorkRow> & Pick<HomeDayWorkRow, "title" | "category" | "totalMinutes">): HomeDayWorkRow {
  return {
    key: `k:${partial.title}`,
    workKey: `${partial.category}:${partial.title.toLowerCase()}`,
    subtitle: null,
    creator: null,
    source: "manual",
    mediaType: "movie",
    coverUrl: null,
    totalSeconds: partial.totalMinutes * 60,
    sessionCount: 1,
    durationLabel: `${partial.totalMinutes}m`,
    barRatio: 1,
    rating: null,
    canRate: true,
    entryId: null,
    latestLocalTime: "20:00",
    timeUncertain: false,
    ...partial,
  };
}

const model: HomeDayDetailModel = {
  shortformMinutes: 12,
  date: "2026-10-25",
  heading: "Today",
  totalMinutes: 300,
  totalCount: 7,
  isEmpty: false,
  segments: [],
  works: [
    row({ title: "Fake Film", category: "film", totalMinutes: 112 }),
    row({ title: "Fake Show S1E2", category: "series", totalMinutes: 32 }),
    row({ title: "Fake Show S1E3", category: "series", totalMinutes: 37 }),
  ],
  youtube: {
    count: 2, totalMinutes: 20, totalSeconds: 1200, summaryLabel: "2 videos · 20m", channelsPreview: "Fake Channel",
    channels: [{
      channel: "Fake Channel", count: 2, totalMinutes: 20, totalSeconds: 1200, durationLabel: "20m", barRatio: 1,
      videos: [
        { id: 1, workKey: "youtube:a", title: "Video A", channel: "Fake Channel", durationSeconds: 840, durationLabel: "14m", localTime: "10:00", rating: null },
        { id: 2, workKey: "youtube:b", title: "Video B", channel: "Fake Channel", durationSeconds: 360, durationLabel: "6m", localTime: "11:00", rating: null },
      ],
    }],
  },
  music: null,
};

describe("day map", () => {
  test("groups by category, sorts largest first, keeps item links and menus", () => {
    const groups = buildDayMapGroups(model);
    expect(groups.map((g) => g.category)).toEqual(["film", "series", "youtube", "shortform"]);
    const series = groups[1]!;
    expect(series.minutes).toBe(69);
    // Two episodes of one show merge into a single block.
    expect(series.items).toHaveLength(1);
    expect(series.items[0]!.title).toBe("Fake Show");
    expect(series.items[0]!.detail).toBe("S1E2 · S1E3 · 2 episodes");
    expect(series.items[0]!.minutes).toBe(69);
    expect(series.items[0]!.href).toBe("#/library?work=series%3Afake%20show%20s1e2");
    expect(groups[2]!.items[0]!.menu?.kind).toBe("youtube-video");
    const short = groups[3]!.items[0]!;
    expect(short.href).toBeNull();
    expect(short.menu).toBeNull();
  });

  test("treemap fills the rect exactly, areas match weights, nothing overlaps", () => {
    const weights = [112, 69, 40, 20, 12, 3];
    const rect = { x: 0, y: 0, w: 900, h: 360 };
    const cells = layoutTreemap(weights.map((m, i) => ({ id: i, m })), rect, (c) => c.m);
    expect(cells).toHaveLength(weights.length);
    const total = weights.reduce((a, b) => a + b, 0);
    let area = 0;
    for (const c of cells) {
      area += c.w * c.h;
      expect(c.w * c.h).toBeCloseTo((rect.w * rect.h * c.m) / total, 3);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(rect.w + 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(rect.h + 1e-6);
    }
    expect(area).toBeCloseTo(rect.w * rect.h, 3);
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i]!, b = cells[j]!;
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapX <= 1e-6 || overlapY <= 1e-6).toBe(true);
      }
    }
  });

  test("episode markers split off show names; plain titles are left alone", () => {
    expect(splitEpisodeTitle("Fake Show S1E12")).toEqual({ show: "Fake Show", mark: "S1E12" });
    expect(splitEpisodeTitle("Fake Cast #3")).toEqual({ show: "Fake Cast", mark: "#3" });
    expect(splitEpisodeTitle("Fake Show - Episode 4")).toEqual({ show: "Fake Show", mark: "E4" });
    expect(splitEpisodeTitle("Step 4")).toBeNull();
    expect(splitEpisodeTitle("Fake Film")).toBeNull();
  });

  test("treemap handles one item, drops zero weights, and compact times read well", () => {
    const one = layoutTreemap([{ m: 5 }, { m: 0 }], { x: 3, y: 3, w: 100, h: 50 }, (c) => c.m);
    expect(one).toEqual([{ m: 5, x: 3, y: 3, w: 100, h: 50 }]);
    expect(compactMinutes(112)).toBe("1h52");
    expect(compactMinutes(48.4)).toBe("48m");
    expect(compactMinutes(60)).toBe("1h00");
  });
});
