import { describe, expect, test } from "bun:test";
import {
  buildMonthGrid,
  formatDuration,
  formatItemTitle,
  formatLocalTime,
  formatSeasonEpisode,
  shiftMonth,
  sourceIcon,
} from "../web/src/lib/calendar.ts";

describe("buildMonthGrid", () => {
  test("builds correct grid for 2026-10", () => {
    const weeks = buildMonthGrid("2026-10");

    // October 2026: 1st is Thursday -> 3 leading days (Sep 28, 29, 30).
    // 31st is Saturday -> 1 trailing day (Nov 1).
    // Total 35 days = 5 weeks of 7 days.
    expect(weeks).toHaveLength(5);
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }

    // First week begins on Monday 2026-09-28
    expect(weeks[0]?.[0]).toBe("2026-09-28");
    expect(weeks[0]?.[3]).toBe("2026-10-01"); // Thursday

    // Last week ends on Sunday 2026-11-01
    expect(weeks[4]?.[5]).toBe("2026-10-31"); // Saturday
    expect(weeks[4]?.[6]).toBe("2026-11-01"); // Sunday
  });

  test("builds grid for a month starting on Monday (2021-02)", () => {
    const weeks = buildMonthGrid("2021-02");

    // Feb 2021: non-leap year (28 days). Starts Monday Feb 1, ends Sunday Feb 28.
    // Exactly 4 weeks, no leading or trailing days.
    expect(weeks).toHaveLength(4);
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }
    expect(weeks[0]?.[0]).toBe("2021-02-01");
    expect(weeks[3]?.[6]).toBe("2021-02-28");
  });

  test("builds grid for February in a leap year (2024-02)", () => {
    const weeks = buildMonthGrid("2024-02");

    // Feb 2024: 29 days.
    // Feb 1 is Thursday -> 3 leading days (Jan 29, 30, 31).
    // Feb 29 is Thursday -> 3 trailing days (Mar 1, 2, 3).
    // Total 35 days = 5 weeks.
    expect(weeks).toHaveLength(5);
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }

    expect(weeks[0]?.[0]).toBe("2024-01-29");
    expect(weeks[0]?.[3]).toBe("2024-02-01");

    // Feb 29 is present
    const flattened = weeks.flat();
    expect(flattened).toContain("2024-02-29");
    expect(weeks[4]?.[3]).toBe("2024-02-29"); // Thursday
    expect(weeks[4]?.[6]).toBe("2024-03-03"); // Sunday
  });

  test("throws on invalid month strings", () => {
    expect(() => buildMonthGrid("invalid")).toThrow(/Invalid month format/);
    expect(() => buildMonthGrid("2026-13")).toThrow(/Invalid month value/);
    expect(() => buildMonthGrid("2026-00")).toThrow(/Invalid month value/);
  });
});

describe("shiftMonth", () => {
  test("shifts across year boundaries forward and backward", () => {
    // 1 month forward across year boundary
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");

    // 1 month backward across year boundary
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");

    // Multi-month jump forward across year boundaries
    expect(shiftMonth("2026-10", 15)).toBe("2028-01");

    // Multi-month jump backward across year boundaries
    expect(shiftMonth("2026-03", -5)).toBe("2025-10");

    // Within same year
    expect(shiftMonth("2026-05", 2)).toBe("2026-07");
    expect(shiftMonth("2026-05", -2)).toBe("2026-03");

    // Zero delta
    expect(shiftMonth("2026-10", 0)).toBe("2026-10");
  });

  test("throws on invalid month format", () => {
    expect(() => shiftMonth("bad", 1)).toThrow(/Invalid month format/);
    expect(() => shiftMonth("2026-14", 1)).toThrow(/Invalid month value/);
  });
});

describe("formatDuration", () => {
  test("handles null, undefined, NaN, and negative values", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(-10)).toBe("—");
  });

  test("formats durations under 60 seconds", () => {
    expect(formatDuration(0)).toBe("<1 min");
    expect(formatDuration(1)).toBe("<1 min");
    expect(formatDuration(30)).toBe("<1 min");
    expect(formatDuration(59)).toBe("<1 min");
  });

  test("formats minutes (< 1 hour)", () => {
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(90)).toBe("2 min");
    expect(formatDuration(2520)).toBe("42 min");
    expect(formatDuration(3540)).toBe("59 min");
  });

  test("formats hours and hours with remaining minutes", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(7260)).toBe("2h 1m");
    expect(formatDuration(86400)).toBe("24h");
  });
});

describe("formatLocalTime", () => {
  test("passes through already formatted HH:MM", () => {
    expect(formatLocalTime("14:30")).toBe("14:30");
    expect(formatLocalTime("08:05")).toBe("08:05");
  });

  test("extracts HH:MM from timestamps with seconds", () => {
    expect(formatLocalTime("14:30:45")).toBe("14:30");
    expect(formatLocalTime("09:00:00")).toBe("09:00");
  });

  test("extracts HH:MM from datetime strings", () => {
    expect(formatLocalTime("2026-10-17 21:30:00")).toBe("21:30");
    expect(formatLocalTime("2026-10-17T08:15:00.000Z")).toBe("08:15");
  });

  test("handles empty string gracefully", () => {
    expect(formatLocalTime("")).toBe("");
  });
});

describe("sourceIcon", () => {
  test("maps audiobookshelf (abs) correctly", () => {
    expect(sourceIcon("abs")).toBe("🎧");
    expect(sourceIcon("ABS")).toBe("🎧");
    expect(sourceIcon("audiobookshelf")).toBe("🎧");
    expect(sourceIcon("audiobookshelf", "other")).toBe("🎧");
  });

  test("maps media types correctly", () => {
    expect(sourceIcon("other", "audiobook")).toBe("🎧");
    expect(sourceIcon("other", "podcast_episode")).toBe("🎙️");
    expect(sourceIcon("other", "podcast")).toBe("🎙️");
    expect(sourceIcon("other", "movie")).toBe("🎬");
    expect(sourceIcon("other", "episode")).toBe("📺");
    expect(sourceIcon("other", "tv")).toBe("📺");
    expect(sourceIcon("other", "video")).toBe("📹");
    expect(sourceIcon("other", "book")).toBe("📖");
  });

  test("maps known sources", () => {
    expect(sourceIcon("youtube")).toBe("▶️");
    expect(sourceIcon("simkl")).toBe("🎬");
    expect(sourceIcon("manual")).toBe("📝");
  });

  test("falls back to generic icon for unknown sources and types", () => {
    expect(sourceIcon("unknown_source", "unknown_type")).toBe("📌");
    expect(sourceIcon("custom")).toBe("📌");
    expect(sourceIcon("")).toBe("📌");
  });
});

describe("formatSeasonEpisode and formatItemTitle", () => {
  test("formats S/E indicators", () => {
    expect(formatSeasonEpisode(1, 2)).toBe("S1E2");
    expect(formatSeasonEpisode(3, null)).toBe("S3");
    expect(formatSeasonEpisode(null, 5)).toBe("E5");
    expect(formatSeasonEpisode(null, null)).toBe("");
  });

  test("formats item title with S/E", () => {
    expect(
      formatItemTitle({
        title: "Pilot",
        season: 1,
        episode: 1,
      })
    ).toBe("S1E1 · Pilot");

    expect(
      formatItemTitle({
        title: "Special",
        season: 2,
        episode: null,
      })
    ).toBe("S2 · Special");

    expect(
      formatItemTitle({
        title: "Standalone Movie",
        season: null,
        episode: null,
      })
    ).toBe("Standalone Movie");

    expect(
      formatItemTitle({
        title: null,
        season: 1,
        episode: 4,
      })
    ).toBe("S1E4 · Untitled");
  });
});
