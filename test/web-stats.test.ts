import { describe, expect, test } from "bun:test";
import {
  computeBarHeight,
  computeMaxMinutes,
  computeStackedSegments,
  formatHoursMinutes,
  formatMinutes,
  formatPeriodLabel,
  sourceColor,
  STATS_SOURCES,
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
