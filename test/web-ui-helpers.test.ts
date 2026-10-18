import { describe, expect, test } from "bun:test";
import type { CalendarDay, CalendarItem } from "../web/src/api.ts";
import {
  ALL_ROUTES,
  MOBILE_MORE_ROUTES,
  MOBILE_PRIMARY_ROUTES,
  computeDayIntensity,
  extractInitials,
  formatMediaTypeLabel,
  parseHash,
  pickDayPreviewItems,
  resolveMediaKind,
  summarizeCalendarMonth,
} from "../web/src/lib/ui-helpers.ts";

function makeSyntheticItem(overrides: Partial<CalendarItem> = {}): CalendarItem {
  return {
    id: 1,
    source: "audiobookshelf",
    media_type: "audiobook",
    title: "Synthetic Audiobook One",
    parent_title: "Synthetic Author",
    season: null,
    episode: null,
    started_at: "2026-10-17T08:15:00.000Z",
    local_time: "10:15",
    duration_seconds: 1800,
    cover_url: "/api/cover/synthetic-1",
    ...overrides,
  };
}

describe("resolveMediaKind", () => {
  test("maps sources to their canonical media kind", () => {
    expect(resolveMediaKind("audiobookshelf", "audiobook")).toBe("audiobook");
    expect(resolveMediaKind("abs", "other")).toBe("audiobook");
    expect(resolveMediaKind("youtube", "video")).toBe("youtube");
    expect(resolveMediaKind("simkl", "movie")).toBe("film");
    expect(resolveMediaKind("simkl", "episode")).toBe("film");
    expect(resolveMediaKind("manual", "book")).toBe("manual");
  });

  test("falls back to media_type when source is manual or generic", () => {
    expect(resolveMediaKind("manual", "audiobook")).toBe("audiobook");
    expect(resolveMediaKind("manual", "podcast_episode")).toBe("audiobook");
    expect(resolveMediaKind("manual", "movie")).toBe("film");
    expect(resolveMediaKind("manual", "episode")).toBe("film");
    expect(resolveMediaKind("manual", "video")).toBe("manual");
    expect(resolveMediaKind("", "")).toBe("manual");
  });
});

describe("formatMediaTypeLabel", () => {
  test("returns clean labels for known media types", () => {
    expect(formatMediaTypeLabel("audiobook")).toBe("Audiobook");
    expect(formatMediaTypeLabel("podcast_episode")).toBe("Podcast");
    expect(formatMediaTypeLabel("movie")).toBe("Film");
    expect(formatMediaTypeLabel("episode")).toBe("Episode");
    expect(formatMediaTypeLabel("video")).toBe("Video");
    expect(formatMediaTypeLabel("book")).toBe("Book");
    expect(formatMediaTypeLabel("unknown")).toBe("Entry");
  });
});

describe("extractInitials", () => {
  test("extracts two initials from multi-word titles, skipping leading articles", () => {
    expect(extractInitials("The Synthetic Chronicle")).toBe("SC");
    expect(extractInitials("A Quiet Harbor")).toBe("QH");
    expect(extractInitials("Tales of the Northern Wind")).toBe("TN");
  });

  test("strips leading S01E02 prefixes before computing initials", () => {
    expect(extractInitials("S01E04 · Clockwork Horizon")).toBe("CH");
    expect(extractInitials("S02 · Glass Tower")).toBe("GT");
    expect(extractInitials("E09 - Midnight Train")).toBe("MT");
  });

  test("handles single-word and empty titles gracefully", () => {
    expect(extractInitials("Odyssey")).toBe("OD");
    expect(extractInitials("X")).toBe("X");
    expect(extractInitials(null)).toBe("IT");
    expect(extractInitials("   ", "NA")).toBe("NA");
  });
});

describe("computeDayIntensity", () => {
  test("returns 0 when both minutes and count are 0", () => {
    expect(computeDayIntensity(0, 0, 120)).toBe(0);
    expect(computeDayIntensity(-5, 0, 120)).toBe(0);
  });

  test("assigns non-zero intensity to count-only days (e.g. YouTube)", () => {
    expect(computeDayIntensity(0, 1, 120)).toBe(1);
    expect(computeDayIntensity(0, 5, 120)).toBe(2);
    expect(computeDayIntensity(0, 10, 120)).toBe(3);
  });

  test("scales timed days from 1 to 4", () => {
    expect(computeDayIntensity(15, 1, 180)).toBe(1);
    expect(computeDayIntensity(45, 2, 180)).toBe(2);
    expect(computeDayIntensity(100, 3, 180)).toBe(3);
    expect(computeDayIntensity(180, 4, 180)).toBe(4);
  });
});

describe("summarizeCalendarMonth and pickDayPreviewItems", () => {
  const sampleDays: CalendarDay[] = [
    {
      date: "2026-10-16",
      count: 2,
      minutes: 90,
      items: [
        makeSyntheticItem({
          id: 1,
          title: "Synthetic Book Alpha",
          duration_seconds: 3600,
          cover_url: "/api/cover/alpha",
        }),
        makeSyntheticItem({
          id: 2,
          source: "youtube",
          media_type: "video",
          title: "Synthetic Video Essay",
          parent_title: "Synthetic Channel",
          duration_seconds: 1800,
          cover_url: null,
        }),
      ],
    },
    {
      date: "2026-10-17",
      count: 1,
      minutes: 120,
      items: [
        makeSyntheticItem({
          id: 3,
          source: "simkl",
          media_type: "movie",
          title: "Synthetic Cinema Opus",
          parent_title: null,
          duration_seconds: 7200,
          cover_url: "/api/cover/opus",
        }),
      ],
    },
    // Outside current month: should be ignored by summarizeCalendarMonth
    {
      date: "2026-09-30",
      count: 5,
      minutes: 300,
      items: [makeSyntheticItem({ id: 99, duration_seconds: 18000 })],
    },
  ];

  test("aggregates totals, active days, busiest day, and kind counts for the target month", () => {
    const summary = summarizeCalendarMonth(sampleDays, "2026-10");

    expect(summary.totalMinutes).toBe(210);
    expect(summary.totalItems).toBe(3);
    expect(summary.activeDays).toBe(2);
    expect(summary.maxDayMinutes).toBe(120);
    expect(summary.busiestDay).toEqual({
      date: "2026-10-17",
      minutes: 120,
      count: 1,
    });

    expect(summary.byKind.audiobook.count).toBe(1);
    expect(summary.byKind.youtube.count).toBe(1);
    expect(summary.byKind.film.count).toBe(1);
    expect(summary.byKind.manual.count).toBe(0);

    // Featured items prioritize cover art and higher minutes
    expect(summary.featuredItems.length).toBe(3);
    expect(summary.featuredItems[0]?.title).toBe("Synthetic Cinema Opus");
    expect(summary.featuredItems[1]?.title).toBe("Synthetic Book Alpha");
  });

  test("pickDayPreviewItems deduplicates same-work sessions and prioritizes covers", () => {
    const items: CalendarItem[] = [
      makeSyntheticItem({
        id: 10,
        title: "No Cover Clip",
        cover_url: null,
        duration_seconds: 600,
      }),
      makeSyntheticItem({
        id: 11,
        title: "Synthetic Audiobook One",
        cover_url: "/api/cover/abs-1",
        duration_seconds: 1200,
      }),
      makeSyntheticItem({
        id: 12,
        title: "Synthetic Audiobook One",
        cover_url: "/api/cover/abs-1",
        duration_seconds: 900,
      }),
    ];

    const preview = pickDayPreviewItems(items, 3);
    expect(preview).toHaveLength(2);
    expect(preview[0]?.id).toBe(11);
    expect(preview[1]?.id).toBe(10);
  });
});

describe("parseHash and route constants", () => {
  test("parses routes and validated query parameters", () => {
    expect(parseHash("")).toEqual({
      route: "calendar",
      date: undefined,
      year: undefined,
      q: undefined,
      hitKey: undefined,
    });

    expect(parseHash("#/calendar?date=2026-10-17")).toEqual({
      route: "calendar",
      date: "2026-10-17",
      year: undefined,
      q: undefined,
      hitKey: undefined,
    });

    expect(parseHash("#/year?year=2026")).toEqual({
      route: "year",
      date: undefined,
      year: "2026",
      q: undefined,
      hitKey: undefined,
    });

    expect(parseHash("#/search?q=synthetic&key=abs%3Abook")).toEqual({
      route: "search",
      date: undefined,
      year: undefined,
      q: "synthetic",
      hitKey: "abs:book",
    });

    // Invalid date or unknown route falls back cleanly
    expect(parseHash("#/unknown?date=not-a-date")).toEqual({
      route: "calendar",
      date: undefined,
      year: undefined,
      q: undefined,
      hitKey: undefined,
    });
  });

  test("mobile primary and more routes cover all 8 routes without overlap", () => {
    const combined = [...MOBILE_PRIMARY_ROUTES, ...MOBILE_MORE_ROUTES];
    expect(combined.length).toBe(ALL_ROUTES.length);
    expect(new Set(combined).size).toBe(ALL_ROUTES.length);
  });
});
