import { describe, expect, test } from "bun:test";
import {
  computeBarHeight,
  computeMaxMinutes,
  computeStackedSegments,
  fillMonthGaps,
  fillWeekGaps,
  formatHoursMinutes,
  formatMinutes,
  formatMinutesShort,
  formatPeriodLabel,
  sourceColor,
  STATS_SOURCES,
} from "../web/src/lib/stats.ts";
import type {
  MonthBucketLike,
  WeekBucketLike,
} from "../web/src/lib/stats.ts";

describe("formatMinutes and formatHoursMinutes", () => {
  test("formats 0, undefined, null, negative, NaN as 0m", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(null)).toBe("0m");
    expect(formatMinutes(undefined)).toBe("0m");
    expect(formatMinutes(-10)).toBe("0m");
    expect(formatMinutes(Number.NaN)).toBe("0m");
    expect(formatHoursMinutes(0)).toBe("0m");
  });

  test("formats sub-hour durations in minutes", () => {
    expect(formatMinutes(1)).toBe("1m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(59.4)).toBe("59m");
  });

  test("formats exact hours", () => {
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(600)).toBe("10h");
  });

  test("formats hours and remaining minutes", () => {
    expect(formatMinutes(65)).toBe("1h 5m");
    expect(formatMinutes(125)).toBe("2h 5m");
    expect(formatMinutes(150)).toBe("2h 30m");
    expect(formatHoursMinutes(210)).toBe("3h 30m");
  });
});

describe("computeMaxMinutes", () => {
  test("returns 0 for empty array", () => {
    expect(computeMaxMinutes([])).toBe(0);
  });

  test("finds the maximum minutes among buckets", () => {
    const buckets = [{ minutes: 30 }, { minutes: 120 }, { minutes: 45 }];
    expect(computeMaxMinutes(buckets)).toBe(120);
  });
});

describe("computeBarHeight", () => {
  test("returns 0 when maxMinutes is 0 or minutes <= 0", () => {
    expect(computeBarHeight(50, 0)).toBe(0);
    expect(computeBarHeight(0, 100)).toBe(0);
    expect(computeBarHeight(-10, 100)).toBe(0);
  });

  test("scales height proportionally to maxMinutes", () => {
    expect(computeBarHeight(50, 100)).toBe(50);
    expect(computeBarHeight(100, 100)).toBe(100);
    expect(computeBarHeight(25, 100)).toBe(25);
  });

  test("respects minPercent floor", () => {
    expect(computeBarHeight(1, 1000, 4)).toBe(4);
    expect(computeBarHeight(50, 100, 4)).toBe(50);
  });
});

describe("computeStackedSegments", () => {
  test("returns empty array for zero or negative total minutes", () => {
    expect(computeStackedSegments({ manual: 0 }, 0)).toEqual([]);
    expect(computeStackedSegments({ manual: 50 }, -1)).toEqual([]);
  });

  test("computes percentage shares per source", () => {
    const bySource = {
      audiobookshelf: 30,
      manual: 90,
    };
    const segments = computeStackedSegments(bySource, 120);
    expect(segments).toHaveLength(2);

    expect(segments[0]).toEqual({
      source: "audiobookshelf",
      minutes: 30,
      percentage: 25,
    });
    expect(segments[1]).toEqual({
      source: "manual",
      minutes: 90,
      percentage: 75,
    });
  });

  test("filters out sources with 0 minutes", () => {
    const bySource = {
      audiobookshelf: 60,
      manual: 0,
    };
    const segments = computeStackedSegments(bySource, 60);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.source).toBe("audiobookshelf");
    expect(segments[0]?.percentage).toBe(100);
  });
});

describe("formatPeriodLabel", () => {
  test("formats week string", () => {
    expect(formatPeriodLabel("2026-W42", "week")).toBe("W42");
    expect(formatPeriodLabel("2026-W01", "week")).toBe("W01");
    expect(formatPeriodLabel("invalid", "week")).toBe("invalid");
  });

  test("formats month string", () => {
    expect(formatPeriodLabel("2026-10", "month")).toBe("Oct 2026");
    expect(formatPeriodLabel("2026-01", "month")).toBe("Jan 2026");
    expect(formatPeriodLabel("invalid", "month")).toBe("invalid");
  });
});

describe("sourceColor and STATS_SOURCES", () => {
  test("returns expected colors for known and fallback sources", () => {
    expect(sourceColor("audiobookshelf")).toBe("#8b5cf6");
    expect(sourceColor("manual")).toBe("#10b981");
    expect(sourceColor("simkl")).toBe("#f59e0b");
    expect(sourceColor("unknown")).toBe("#3b82f6");
  });

  test("provides expected options in STATS_SOURCES", () => {
    expect(STATS_SOURCES.length).toBeGreaterThanOrEqual(3);
    expect(STATS_SOURCES[0]?.value).toBe("");
  });
});

describe("formatMinutesShort", () => {
  test("returns 0m for zero, null, NaN and negative", () => {
    expect(formatMinutesShort(0)).toBe("0m");
    expect(formatMinutesShort(null)).toBe("0m");
    expect(formatMinutesShort(undefined)).toBe("0m");
    expect(formatMinutesShort(Number.NaN)).toBe("0m");
    expect(formatMinutesShort(-10)).toBe("0m");
  });

  test("formats sub-hour values as whole minutes", () => {
    expect(formatMinutesShort(45)).toBe("45m");
  });

  test("formats hours under 10 with an optional decimal", () => {
    expect(formatMinutesShort(60)).toBe("1h");
    expect(formatMinutesShort(90)).toBe("1.5h");
    expect(formatMinutesShort(599)).toBe("10h");
  });

  test("formats 10h and above as whole hours", () => {
    expect(formatMinutesShort(600)).toBe("10h");
    expect(formatMinutesShort(2895)).toBe("48h");
    expect(formatMinutesShort(6000)).toBe("100h");
  });
});

describe("fillWeekGaps", () => {
  test("fills missing weeks with empty zero-minute buckets", () => {
    const filled = fillWeekGaps<WeekBucketLike>([
      { week: "2026-W33", by_source: { manual: 30 }, minutes: 30 },
      { week: "2026-W30", by_source: { manual: 60 }, minutes: 60 },
    ]);
    expect(filled.map((b) => b.week)).toEqual([
      "2026-W30",
      "2026-W31",
      "2026-W32",
      "2026-W33",
    ]);
    expect(filled[1]).toEqual({ week: "2026-W31", by_source: {}, minutes: 0 });
    expect(filled[2]).toEqual({ week: "2026-W32", by_source: {}, minutes: 0 });
  });

  test("sorts unsorted input", () => {
    const filled = fillWeekGaps([
      { week: "2026-W32", by_source: {}, minutes: 0 },
      { week: "2026-W30", by_source: {}, minutes: 0 },
      { week: "2026-W31", by_source: {}, minutes: 0 },
    ]);
    expect(filled.map((b) => b.week)).toEqual([
      "2026-W30",
      "2026-W31",
      "2026-W32",
    ]);
  });

  test("handles a year boundary across a 53-week ISO year", () => {
    const filled = fillWeekGaps([
      { week: "2026-W52", by_source: {}, minutes: 0 },
      { week: "2027-W02", by_source: {}, minutes: 0 },
    ]);
    expect(filled.map((b) => b.week)).toEqual([
      "2026-W52",
      "2026-W53",
      "2027-W01",
      "2027-W02",
    ]);
  });

  test("handles a year boundary across a 52-week ISO year", () => {
    const filled = fillWeekGaps([
      { week: "2025-W51", by_source: {}, minutes: 0 },
      { week: "2026-W01", by_source: {}, minutes: 0 },
    ]);
    expect(filled.map((b) => b.week)).toEqual([
      "2025-W51",
      "2025-W52",
      "2026-W01",
    ]);
  });

  test("preserves original bucket values", () => {
    const input: WeekBucketLike[] = [
      { week: "2026-W30", by_source: { simkl: 120 }, minutes: 120 },
      { week: "2026-W33", by_source: { manual: 45 }, minutes: 45 },
    ];
    const filled = fillWeekGaps(input);
    expect(filled[0]).toEqual(input[0]);
    expect(filled[3]).toEqual(input[1]);
    expect(filled[1]?.minutes).toBe(0);
    expect(filled[1]?.by_source).toEqual({});
  });

  test("returns empty for empty input and unchanged single bucket", () => {
    expect(fillWeekGaps([])).toEqual([]);
    const single = { week: "2026-W10", by_source: { manual: 5 }, minutes: 5 };
    expect(fillWeekGaps([single])).toEqual([single]);
  });
});

describe("fillMonthGaps", () => {
  test("fills missing months across a year boundary", () => {
    const filled = fillMonthGaps<MonthBucketLike>([
      { month: "2026-02", by_source: {}, minutes: 0 },
      { month: "2025-11", by_source: { manual: 10 }, minutes: 10 },
    ]);
    expect(filled.map((b) => b.month)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    expect(filled[1]).toEqual({ month: "2025-12", by_source: {}, minutes: 0 });
    expect(filled[2]).toEqual({ month: "2026-01", by_source: {}, minutes: 0 });
    expect(filled[0]).toEqual({
      month: "2025-11",
      by_source: { manual: 10 },
      minutes: 10,
    });
  });

  test("returns empty for empty input and unchanged single bucket", () => {
    expect(fillMonthGaps([])).toEqual([]);
    const single = { month: "2026-07", by_source: { simkl: 9 }, minutes: 9 };
    expect(fillMonthGaps([single])).toEqual([single]);
  });
});
