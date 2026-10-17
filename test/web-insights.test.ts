import { describe, expect, test } from "bun:test";
import {
  describeCurrentStreak,
  formatDayCount,
  formatOnThisDayHeading,
  formatStreakRange,
  formatYearsAgo,
} from "../web/src/lib/insights.ts";
import { formatLocalDay } from "../web/src/lib/format-date.ts";

describe("formatDayCount", () => {
  test("singular for 1", () => {
    expect(formatDayCount(1)).toBe("1 day");
  });

  test("plural otherwise", () => {
    expect(formatDayCount(0)).toBe("0 days");
    expect(formatDayCount(3)).toBe("3 days");
    expect(formatDayCount(365)).toBe("365 days");
  });

  test("floors and clamps bad input", () => {
    expect(formatDayCount(2.9)).toBe("2 days");
    expect(formatDayCount(-5)).toBe("0 days");
    expect(formatDayCount(Number.NaN)).toBe("0 days");
  });
});

describe("formatYearsAgo", () => {
  test("singular for 1", () => {
    expect(formatYearsAgo(1)).toBe("1 year ago");
  });

  test("plural otherwise", () => {
    expect(formatYearsAgo(0)).toBe("0 years ago");
    expect(formatYearsAgo(4)).toBe("4 years ago");
  });
});

describe("formatStreakRange", () => {
  test("null bounds give null", () => {
    expect(formatStreakRange(null, null)).toBeNull();
    expect(formatStreakRange("2026-10-01", null)).toBeNull();
    expect(formatStreakRange(null, "2026-10-09")).toBeNull();
  });

  test("a single-day streak shows just the day", () => {
    expect(formatStreakRange("2026-10-09", "2026-10-09")).toBe("09.10.2026");
  });

  test("a range shows start – end in local display order", () => {
    expect(formatStreakRange("2026-01-05", "2026-01-09")).toBe(
      "05.01.2026 – 09.01.2026"
    );
  });

  test("invalid input passes through unchanged", () => {
    expect(formatStreakRange("oops", "2026-10-09")).toBe("oops – 09.10.2026");
  });
});

describe("formatOnThisDayHeading", () => {
  test("formats years ago and the year", () => {
    expect(formatOnThisDayHeading(2024, 2)).toBe("2 years ago · 2024");
    expect(formatOnThisDayHeading(2025, 1)).toBe("1 year ago · 2025");
  });
});

describe("describeCurrentStreak", () => {
  test("no active streak at 0", () => {
    expect(describeCurrentStreak(0, null, "2026-10-17")).toBe(
      "No active streak"
    );
    expect(describeCurrentStreak(0, "2026-10-10", "2026-10-17")).toBe(
      "No active streak"
    );
  });

  test("active today when the last active day is today", () => {
    expect(
      describeCurrentStreak(3, "2026-10-17", "2026-10-17")
    ).toBe("Active today");
  });

  test("active yesterday when the streak is only alive via yesterday", () => {
    expect(
      describeCurrentStreak(2, "2026-10-16", "2026-10-17")
    ).toBe("Active yesterday");
  });
});

describe("formatLocalDay", () => {
  test("reorders YYYY-MM-DD to DD.MM.YYYY without timezone conversion", () => {
    expect(formatLocalDay("2026-10-17")).toBe("17.10.2026");
    expect(formatLocalDay("2026-01-05")).toBe("05.01.2026");
  });

  test("invalid input passes through unchanged", () => {
    expect(formatLocalDay("oops")).toBe("oops");
    expect(formatLocalDay("")).toBe("");
    expect(formatLocalDay("2026-10")).toBe("2026-10");
  });
});
