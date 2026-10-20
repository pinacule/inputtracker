import { describe, expect, test } from "bun:test";
import {
  buildRollingGraphModel, clampWindowEnd, dayNormSentence, median, normComparison,
  rollingWindowDates, seriesDayTotals, shiftWindowEnd, usualMinutes, windowNormSentence,
} from "../web/src/lib/home-norm.ts";
import { buildHomeDayDetailModel, computeCategorySegmentsFromItems, getTodayLocalDate, shiftDateStr } from "../web/src/lib/home.ts";
import { categoryCssColor, categoryLabel, formatWorkCardMeta } from "../web/src/lib/categories.ts";
import { canRateCategory } from "../web/src/lib/rating.ts";
import { buildContextMenuActions } from "../web/src/lib/context-menu.ts";
import type { CalendarItem } from "../web/src/api.ts";

describe("rolling local-date windows", () => {
  test("today/deep-linked date is the rightmost day, not Sunday", () => {
    const end = clampWindowEnd("2026-10-13", "2026-10-20");
    expect(rollingWindowDates(end)).toEqual([
      "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13",
    ]);
    expect(clampWindowEnd(undefined, "2026-10-20")).toBe("2026-10-20");
    expect(clampWindowEnd("2026-10-21", "2026-10-20")).toBe("2026-10-20");
    expect(clampWindowEnd("2026-02-30", "2026-10-20")).toBe("2026-10-20");
    const model = buildRollingGraphModel([], end, end, "2026-10-20", [], null);
    expect(model.days[6]?.isSelected).toBe(true);
    expect(model.days[6]?.weekdayShort).toBe("Tue");
  });

  test("steps seven days and clamps forward navigation at today", () => {
    expect(shiftWindowEnd("2026-01-03", -1, "2026-01-03")).toBe("2025-12-27");
    expect(shiftWindowEnd("2025-12-27", 1, "2026-01-03")).toBe("2026-01-03");
    expect(shiftWindowEnd("2026-01-01", 1, "2026-01-03")).toBe("2026-01-03");
    expect(rollingWindowDates("2026-01-03")[0]).toBe("2025-12-28");
    expect(rollingWindowDates("2024-03-02")).toContain("2024-02-29");
  });

  test("spring and autumn DST do not duplicate or skip local dates", () => {
    for (const end of ["2026-03-31", "2026-10-27"]) {
      const dates = rollingWindowDates(end);
      expect(new Set(dates).size).toBe(7);
      expect(dates[0]).toBe(shiftDateStr(end, -6));
      expect(dates[6]).toBe(end);
    }
    expect(getTodayLocalDate(new Date("2026-03-29T22:30:00Z"))).toBe("2026-03-30");
    expect(getTodayLocalDate(new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
  });
});

describe("weekday norms", () => {
  test("median is pure, even/odd and empty", () => {
    const values = [9, 1, 3, 7];
    expect(median(values)).toBe(5);
    expect(values).toEqual([9, 1, 3, 7]);
    expect(median([1, 9, 3])).toBe(3);
    expect(median([])).toBe(0);
  });

  test("uses exactly the eight preceding weekdays, including zero days", () => {
    const date = "2026-10-20";
    const totals = new Map(Array.from({ length: 8 }, (_, i) => [shiftDateStr(date, -7 * (i + 1)), [0, 0, 30, 60, 90, 120, 180, 240][i]! ]));
    totals.set(date, 9999); // Never include today.
    totals.set(shiftDateStr(date, -63), 9999); // Never include the ninth Tuesday.
    totals.set(shiftDateStr(date, -1), 9999); // Other weekdays don't affect the norm.
    expect(usualMinutes(date, totals, "2026-01-01")).toBe(75);
    totals.delete(shiftDateStr(date, -28)); // Missing is zero, not omitted.
    expect(usualMinutes(date, totals, "2026-01-01")).toBe(60);
  });

  test("four preceding weekdays suffice; three use the previous 30-day median", () => {
    const date = "2026-10-20";
    const totals = new Map(Array.from({ length: 30 }, (_, i) => [shiftDateStr(date, -i - 1), 10]));
    for (let i = 1; i <= 4; i++) totals.set(shiftDateStr(date, -7 * i), 100);
    expect(usualMinutes(date, totals, shiftDateStr(date, -28))).toBe(100);
    expect(usualMinutes(date, totals, shiftDateStr(date, -27))).toBe(10);
    expect(usualMinutes(date, new Map([["2026-10-19", 30]]), "2026-10-19")).toBe(30);
    expect(usualMinutes(date, totals, date)).toBe(0);
    expect(usualMinutes(date, totals, null)).toBe(0);
  });

  test("fallback includes zero days, excludes days before the archive and beyond 30 days", () => {
    const totals = new Map([["2026-10-19", 120], ["2026-09-19", 9999]]);
    expect(usualMinutes("2026-10-20", totals, "2026-10-17")).toBe(0);
    expect(usualMinutes("2026-10-20", totals, "2026-09-20")).toBe(0);
  });

  test("counts short-form and every category by time, even with zero items", () => {
    const totals = seriesDayTotals([{ bucket: "2026-10-20", minutes_by_category: { shortform: 47, music: 3, book: 10 } }]);
    expect(totals.get("2026-10-20")).toBe(60);
    const model = buildRollingGraphModel([{ date: "2026-10-20", count: 0, minutes: 47, items: [] }],
      "2026-10-19", "2026-10-20", "2026-10-20", [], null);
    expect(model.days[6]?.totalMinutes).toBe(47);
    expect(model.days[5]?.isSelected).toBe(true); // Selecting a pill doesn't reposition the window.
    expect(model.activeDays).toBe(1);
    expect(model.weekMinutes).toBe(47);
  });

  test("marker uses the same scale as bars and seven-day comparison sums all seven norms", () => {
    const points = Array.from({ length: 63 }, (_, i) => ({ bucket: shiftDateStr("2026-10-20", i - 62), minutes_by_category: { book: 100 } }));
    const model = buildRollingGraphModel([{ date: "2026-10-20", count: 1, minutes: 20, items: [] }],
      "2026-10-20", "2026-10-20", "2026-10-20", points, "2026-01-01");
    expect(model.normRatios.get("2026-10-20")).toBe(1);
    expect(model.days[6]?.heightRatio).toBe(0.2);
    expect(model.windowSentence).toBe(windowNormSentence(20, 700, true));
  });
});

describe("norm comparison wording", () => {
  test("inclusive ±10% threshold, more/less and a zero norm", () => {
    expect(normComparison(90, 100)).toBe("about usual");
    expect(normComparison(110, 100)).toBe("about usual");
    expect(normComparison(89, 100)).toBe("11 min less than usual");
    expect(normComparison(111, 100)).toBe("11 min more than usual");
    expect(normComparison(0, 0)).toBe("about usual");
    expect(normComparison(1, 0)).toBe("1 min more than usual");
  });
  test("plain-word day and window sentences", () => {
    expect(dayNormSentence("2026-10-20", "2026-10-20", 122, 82)).toBe("Today 2h 2m · 40 min more than a usual Tuesday");
    expect(dayNormSentence("2026-10-13", "2026-10-20", 60, 100)).toBe("Tuesday 1h · 40 min less than a usual Tuesday");
    expect(windowNormSentence(239, 179, true)).toBe("Last 7 days 3h 59m · 1h more than usual");
    expect(windowNormSentence(100, 100, false)).toBe("These 7 days 1h 40m · about usual");
  });
});

test("short-form is a coloured, non-rateable time-only home line; music always folds", () => {
  const item: CalendarItem = { id: 1, source: "phone", media_type: "shortform", title: null, parent_title: null,
    season: null, episode: null, started_at: "2026-10-20T10:00:00Z", local_time: "12:00", duration_seconds: 2820, cover_url: null };
  const model = buildHomeDayDetailModel({ date: "2026-10-20", todayStr: "2026-10-20",
    day: { date: "2026-10-20", count: 0, minutes: 47, items: [item] } });
  expect(model.shortformMinutes).toBe(47);
  expect(model.works).toEqual([]);
  expect(model.segments[0]?.category).toBe("shortform");
  expect(categoryLabel("shortform")).toBe("Short-form");
  expect(categoryCssColor("shortform")).toBe("var(--cat-shortform-solid)");
  expect(canRateCategory("shortform")).toBe(false);
  expect(buildContextMenuActions({ kind: "day-work", category: "shortform", title: "Short-form" })).toEqual([]);
  const music = buildHomeDayDetailModel({ date: "2026-10-20", todayStr: "2026-10-20", day: {
    date: "2026-10-20", count: 1, minutes: 4, items: [{ ...item, media_type: "music", duration_seconds: 240, title: "Synthetic Track" }],
  } });
  expect(music.music?.collapsedByDefault).toBe(true);
});

test("timed category segments are proportional to seconds, not a minimum one-minute weight", () => {
  const base: CalendarItem = { id: 1, source: "manual", media_type: "book", title: "Synthetic Book", parent_title: null,
    season: null, episode: null, started_at: "2026-10-20T10:00:00Z", local_time: "12:00", duration_seconds: 30, cover_url: null };
  const segments = computeCategorySegmentsFromItems([base, { ...base, id: 2, media_type: "music", duration_seconds: 90 }]);
  expect(segments.map((s) => s.sharePct)).toEqual([25, 75]);
});

test("audiobook position label includes authoritative zero separately from logged time", () => {
  expect(formatWorkCardMeta({ category: "audiobook", units: 2, total_minutes: 71, consumption_progress: 0.06 }))
    .toBe("6% · 1h 11m · 2 sessions");
  expect(formatWorkCardMeta({ category: "audiobook", units: 2, total_minutes: 71, consumption_progress: 0 }))
    .toBe("0% · 1h 11m · 2 sessions");
});
