import { describe, expect, test } from "bun:test";
import {
  buildShareLines,
  formatChange,
  formatHours,
  isMilestoneCategory,
  isYoutubeOnly,
  monthLabel,
  weekdayLabel,
} from "../web/src/lib/year-review.ts";
import type { YearReview } from "../web/src/api.ts";

/** A minimal valid YearReview, overridden per test. */
function review(overrides: Partial<YearReview> = {}): YearReview {
  return {
    year: 2025,
    partial: false,
    days_in_range: 365,
    available_years: [2025],
    totals: { items: 0, minutes: 0, active_days: 0, titles: 0 },
    previous: null,
    by_source: {},
    by_media_type: {},
    by_month: [],
    by_weekday: [],
    top_titles: [],
    top_channels: [],
    busiest_day: null,
    busiest_month: null,
    longest_streak: { days: 0, start: null, end: null },
    first: null,
    last: null,
    ...overrides,
  };
}

describe("formatHours", () => {
  test("zero and invalid input", () => {
    expect(formatHours(0)).toBe("0 h");
    expect(formatHours(-5)).toBe("0 h");
    expect(formatHours(Number.NaN)).toBe("0 h");
  });

  test("one decimal below 10 h, trailing .0 dropped", () => {
    expect(formatHours(60)).toBe("1 h");
    expect(formatHours(90)).toBe("1.5 h");
    expect(formatHours(540)).toBe("9 h");
    expect(formatHours(570)).toBe("9.5 h");
  });

  test("whole hours at 10 and above", () => {
    expect(formatHours(600)).toBe("10 h");
    expect(formatHours(7380)).toBe("123 h");
    expect(formatHours(7410)).toBe("124 h");
  });
});

describe("formatChange", () => {
  test("positive, negative and zero change", () => {
    expect(formatChange(120, 100)).toBe("+20 %");
    expect(formatChange(88, 100)).toBe("−12 %");
    expect(formatChange(100, 100)).toBe("±0 %");
    expect(formatChange(100.4, 100)).toBe("±0 %");
  });

  test("previous 0 or missing counts as new", () => {
    expect(formatChange(50, null)).toBe("new");
    expect(formatChange(50, 0)).toBe("new");
    expect(formatChange(50, undefined)).toBe("new");
  });
});

describe("monthLabel and weekdayLabel", () => {
  test("month keys map to short names", () => {
    expect(monthLabel("2026-03")).toBe("Mar");
    expect(monthLabel("2026-01")).toBe("Jan");
    expect(monthLabel("2026-12")).toBe("Dec");
  });

  test("invalid month passes through", () => {
    expect(monthLabel("oops")).toBe("oops");
  });

  test("ISO weekdays: 1 = Monday .. 7 = Sunday", () => {
    expect(weekdayLabel(1)).toBe("Mon");
    expect(weekdayLabel(7)).toBe("Sun");
    expect(weekdayLabel(0)).toBe("");
    expect(weekdayLabel(9)).toBe("");
  });
});

describe("isYoutubeOnly", () => {
  test("true only for a single youtube source", () => {
    const totals = { items: 3, minutes: 0, active_days: 2, titles: 3 };
    expect(isYoutubeOnly(review({ by_source: { youtube: totals } }))).toBe(true);
    expect(
      isYoutubeOnly(review({ by_source: { youtube: totals, manual: totals } }))
    ).toBe(false);
    expect(isYoutubeOnly(review({ by_source: {} }))).toBe(false);
  });
});

describe("buildShareLines", () => {
  test("a YouTube-only review counts views, not hours", () => {
    const ytReview = review({
      year: 2025,
      totals: { items: 120, minutes: 0, active_days: 80, titles: 10 },
      by_source: {
        youtube: { items: 120, minutes: 0, active_days: 80, titles: 10 },
      },
      longest_streak: { days: 4, start: "2025-03-01", end: "2025-03-04" },
      top_titles: [
        {
          title: "Fake Video A",
          source: "youtube",
          media_type: "video",
          minutes: 0,
          count: 30,
          cover_url: null,
          rating: null,
        },
        {
          title: "Fake Video B",
          source: "youtube",
          media_type: "video",
          minutes: 0,
          count: 20,
          cover_url: null,
          rating: null,
        },
      ],
      busiest_month: { month: "2025-05", minutes: 0, count: 40 },
    });

    const lines = buildShareLines(ytReview, "YouTube");
    expect(lines[0]).toBe("InputTracker — Year in review");
    expect(lines[1]).toBe("2025 · YouTube");
    expect(lines).toContain("120 views");
    expect(lines).not.toContain("0 h");
    expect(lines).toContain("80 active days");
    expect(lines).toContain("Longest streak: 4 days");
    expect(lines).toContain("1. Fake Video A — 30 views");
    expect(lines).toContain("2. Fake Video B — 20 views");
    expect(lines).toContain("Busiest month: May — 40 views");
  });

  test("a mixed review shows hours, items and the source scope", () => {
    const totals = { items: 3, minutes: 10, active_days: 3, titles: 3 };
    const mixed = review({
      year: 2024,
      totals: { items: 50, minutes: 450, active_days: 30, titles: 8 },
      by_source: { manual: totals, audiobookshelf: totals },
      top_titles: [
        {
          title: "Fake Book",
          source: "audiobookshelf",
          media_type: "audiobook",
          minutes: 300,
          count: 5,
          cover_url: null,
          rating: null,
        },
      ],
      busiest_month: { month: "2024-02", minutes: 300, count: 10 },
    });

    const lines = buildShareLines(mixed, "All sources");
    expect(lines[1]).toBe("2024 · All sources");
    expect(lines).toContain("7.5 h");
    expect(lines).toContain("50 items");
    expect(lines).toContain("30 active days");
    expect(lines).toContain("1. Fake Book — 5 h");
    expect(lines).toContain("Busiest month: Feb — 5 h");
  });

  test("partial years are marked in the scope line", () => {
    const lines = buildShareLines(review({ partial: true }), "All sources");
    expect(lines[1]).toBe("2025 · All sources · so far");
  });

  test("an empty review has no title or busiest-month lines", () => {
    const lines = buildShareLines(review(), "All sources");
    expect(lines[0]).toBe("InputTracker — Year in review");
    expect(lines).toContain("0 h");
    expect(lines).toContain("0 items");
    expect(lines).toContain("0 active days");
    expect(lines).toContain("Longest streak: none");
    expect(lines).toHaveLength(6);
  });
});

describe("isMilestoneCategory", () => {
  test("books, films, series, anime and audiobooks have a start and finish", () => {
    for (const c of ["book", "film", "series", "anime", "audiobook"] as const) {
      expect(isMilestoneCategory(c)).toBe(true);
    }
  });
  test("music, YouTube and other plays stay out of Finished/Started", () => {
    for (const c of ["music", "youtube", "podcast", "shortform", "other"] as const) {
      expect(isMilestoneCategory(c)).toBe(false);
    }
  });
});
