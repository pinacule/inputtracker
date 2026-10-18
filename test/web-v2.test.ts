import { describe, expect, test } from "bun:test";
import type {
  CalendarDay,
  CategoryTotal,
  SeriesPoint,
  WorkDetails,
} from "../web/src/api.ts";
import {
  buildArchiveRequest,
  buildManualWork,
  computeArchivePreview,
  formatArchiveWhen,
  formatHistoryPrecisionDate,
} from "../web/src/lib/archive-form.ts";
import {
  CATEGORIES,
  CATEGORY_META,
  categoryColor,
  categoryLabel,
  categoryPluralLabel,
  formatCategoryUnits,
  resolveItemCategory,
} from "../web/src/lib/categories.ts";
import {
  buildCategoryShare,
  buildPunchCardSummary,
  buildSparklineGeometry,
  buildStackedSeriesLayout,
  computeChartTicks,
  resolveInsightsRange,
} from "../web/src/lib/charts.ts";
import {
  parseAppRoute,
  resolveLegacyRedirect,
} from "../web/src/lib/router.ts";
import {
  readThemePreference,
  saveThemePreference,
  type ThemeStorageLike,
} from "../web/src/lib/theme.ts";
import {
  summarizeCalendarMonthV2,
  summarizeDayCellV2,
} from "../web/src/lib/ui-helpers.ts";

describe("v2 categories (web/src/lib/categories.ts)", () => {
  test("every Category has distinct metadata and colour", () => {
    const colors = new Set<string>();
    for (const cat of CATEGORIES) {
      const meta = CATEGORY_META[cat];
      expect(meta).toBeDefined();
      expect(meta.category).toBe(cat);
      expect(categoryLabel(cat)).toBe(meta.label);
      expect(categoryPluralLabel(cat)).toBe(meta.pluralLabel);
      expect(categoryColor(cat)).toMatch(/^#[0-9a-f]{6}$/i);
      colors.add(meta.color);
    }
    expect(colors.size).toBe(CATEGORIES.length);
  });

  test("resolveItemCategory resolves explicit category, external anime ids, media_type, and source fallbacks", () => {
    expect(resolveItemCategory({ category: "anime", media_type: "episode" })).toBe("anime");
    expect(
      resolveItemCategory({
        media_type: "episode",
        external_ids: { anilist: "101348" },
      })
    ).toBe("anime");
    expect(resolveItemCategory({ media_type: "episode" })).toBe("series");
    expect(resolveItemCategory({ media_type: "movie" })).toBe("film");
    expect(resolveItemCategory({ media_type: "audiobook" })).toBe("audiobook");
    expect(resolveItemCategory({ media_type: "book" })).toBe("book");
    expect(resolveItemCategory({ media_type: "video" })).toBe("youtube");
    expect(resolveItemCategory({ media_type: "podcast_episode" })).toBe("podcast");
    expect(resolveItemCategory({ media_type: "music" })).toBe("music");
    expect(resolveItemCategory({ source: "audiobookshelf" })).toBe("audiobook");
    expect(resolveItemCategory({ source: "youtube" })).toBe("youtube");
  });

  test("formatCategoryUnits formats singular and plural units", () => {
    expect(formatCategoryUnits("anime", 1)).toBe("1 episode");
    expect(formatCategoryUnits("anime", 48)).toBe("48 episodes");
    expect(formatCategoryUnits("film", 2)).toBe("2 viewings");
    expect(formatCategoryUnits("youtube", 40)).toBe("40 videos");
  });
});

describe("v2 archive form helpers (web/src/lib/archive-form.ts)", () => {
  const syntheticAnime: WorkDetails = {
    provider: "anilist",
    provider_id: "101348",
    category: "anime",
    title: "Synthetic Northern Saga",
    original_title: null,
    year: 2019,
    cover_url: "/api/meta-cover/anilist/101348",
    creators: ["Synthetic Studio"],
    genres: ["Adventure", "History"],
    description: "A synthetic two-season anime epic.",
    seasons: [
      {
        number: 1,
        title: "Season 1",
        year: 2019,
        episodes: 24,
        episode_minutes: 24,
        total_minutes: 576,
        provider_id: "101348",
      },
      {
        number: 2,
        title: "Season 2",
        year: 2023,
        episodes: 24,
        episode_minutes: 24,
        total_minutes: 576,
        provider_id: "136430",
      },
    ],
    runtime_minutes: null,
    pages: null,
    external_ids: { anilist: "101348" },
  };

  test("computes time preview for full and partial anime seasons", () => {
    const fullBoth = computeArchivePreview(syntheticAnime, {
      seasons: [{ number: 1 }, { number: 2 }],
    });
    expect(fullBoth.seasonsCount).toBe(2);
    expect(fullBoth.episodesCount).toBe(48);
    expect(fullBoth.totalMinutes).toBe(1152); // 19.2 h -> ≈ 19 h
    expect(fullBoth.estimated).toBe(true);
    expect(fullBoth.summaryText).toBe("2 seasons · 48 episodes · ≈ 19 h");

    const partial = computeArchivePreview(syntheticAnime, {
      seasons: [{ number: 1 }, { number: 2, episodes: 10 }],
    });
    expect(partial.seasonsCount).toBe(2);
    expect(partial.episodesCount).toBe(34);
    expect(partial.totalMinutes).toBe(576 + 240);
  });

  test("computes time preview for films, books, and manual overrides", () => {
    const filmWork: WorkDetails = {
      ...syntheticAnime,
      category: "film",
      seasons: [],
      runtime_minutes: 140,
    };
    const filmPreview = computeArchivePreview(filmWork, { times: 2 });
    expect(filmPreview.totalMinutes).toBe(280);
    expect(filmPreview.units).toBe(2);
    expect(filmPreview.summaryText).toContain("2 viewings");

    const bookWork: WorkDetails = {
      ...syntheticAnime,
      category: "book",
      seasons: [],
      pages: 320,
    };
    const bookPreview = computeArchivePreview(bookWork, { progress: 1 });
    expect(bookPreview.totalMinutes).toBe(480); // 320 * 1.5 = 480 min = 8 h
    expect(bookPreview.summaryText).toBe("Finished · 320 pages · ≈ 8 h");

    // minutes_override always wins
    const overridden = computeArchivePreview(bookWork, {
      progress: 1,
      minutes_override: 600,
    });
    expect(overridden.totalMinutes).toBe(600);
    expect(overridden.estimated).toBe(false);
    expect(overridden.summaryText).toBe("Finished · 320 pages · 10h");
  });

  test("formats ArchiveWhen precisions and ranges", () => {
    expect(formatArchiveWhen({ precision: "day", date: "2026-10-17" })).toBe(
      "17.10.2026"
    );
    expect(
      formatArchiveWhen({
        precision: "month",
        date: "2021-03",
        end_date: "2021-05",
      })
    ).toBe("Mar 2021 – May 2021");
    expect(formatArchiveWhen({ precision: "year", date: "2021" })).toBe("2021");
    expect(formatArchiveWhen({ precision: "unknown" })).toBe("Date unknown");

    expect(
      formatHistoryPrecisionDate("2021-05-01T10:00:00.000Z", "month")
    ).toBe("May 2021");
    expect(formatHistoryPrecisionDate("2021-01-01T10:00:00.000Z", "year")).toBe(
      "2021"
    );
  });

  test("buildManualWork and buildArchiveRequest validate and construct payloads", () => {
    const manualRes = buildManualWork({
      category: "series",
      title: "Synthetic Mystery Series",
      year: "2020",
      creators: "Synthetic Creator",
      seasons_count: "2",
      episodes_per_season: "10",
      episode_minutes: "45",
    });
    expect(manualRes.ok).toBe(true);
    if (!manualRes.ok) return;
    expect(manualRes.work.seasons).toHaveLength(2);
    expect(manualRes.work.seasons[0]?.total_minutes).toBe(450);

    const reqRes = buildArchiveRequest({
      entry_id: "fixed-entry-id",
      work: syntheticAnime,
      consumed: {
        seasons: [
          { number: 1, episodes: 24 }, // full season -> episodes omitted
          { number: 2, episodes: 12 }, // partial season -> episodes kept
        ],
      },
      when: { precision: "year", date: "2022" },
      rating: 9,
      note: "Synthetic note",
    });
    expect(reqRes.ok).toBe(true);
    if (!reqRes.ok) return;
    expect(reqRes.request.entry_id).toBe("fixed-entry-id");
    expect(reqRes.request.consumed.seasons).toEqual([
      { number: 1 },
      { number: 2, episodes: 12 },
    ]);
    expect(reqRes.request.rating).toBe(9);
  });
});

describe("v2 chart geometry & scales (web/src/lib/charts.ts)", () => {
  test("computeChartTicks produces clean monotonic steps", () => {
    const ticks = computeChartTicks(195, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(195);
  });

  test("buildStackedSeriesLayout computes bar segments and active categories", () => {
    const points: SeriesPoint[] = [
      {
        bucket: "2026-10-16",
        minutes_by_category: { anime: 48, audiobook: 60 },
      },
      {
        bucket: "2026-10-17",
        minutes_by_category: { film: 120 },
      },
    ];
    const layout = buildStackedSeriesLayout(points, "day");
    expect(layout.totalMinutes).toBe(228);
    expect(layout.maxMinutes).toBe(120);
    expect(layout.activeCategories).toEqual(["anime", "film", "audiobook"]);
    expect(layout.bars[0]?.segments).toHaveLength(2);
    expect(layout.bars[0]?.label).toBe("16");
  });

  test("buildCategoryShare sorts by minutes and computes percentages", () => {
    const cats: CategoryTotal[] = [
      { category: "book", total_minutes: 120, works: 1, units: 1 },
      { category: "anime", total_minutes: 360, works: 2, units: 15 },
    ];
    const share = buildCategoryShare(cats);
    expect(share.totalMinutes).toBe(480);
    expect(share.slices[0]?.category).toBe("anime");
    expect(share.slices[0]?.sharePct).toBe(75);
    expect(share.slices[1]?.category).toBe("book");
    expect(share.slices[1]?.sharePct).toBe(25);
  });

  test("buildPunchCardSummary normalizes both 24x7 and 7x24 matrices and finds peaks", () => {
    // 24 hours x 7 weekdays
    const matrix24x7 = Array.from({ length: 24 }, (_, h) =>
      Array.from({ length: 7 }, (__, wd) => (h === 21 && wd === 5 ? 90 : 0))
    );
    const summary1 = buildPunchCardSummary(matrix24x7);
    expect(summary1.totalMinutes).toBe(90);
    expect(summary1.peakWeekday?.label).toBe("Sat");
    expect(summary1.peakHour?.hour).toBe(21);

    // 7 weekdays x 24 hours
    const matrix7x24 = Array.from({ length: 7 }, (_, wd) =>
      Array.from({ length: 24 }, (__, h) => (wd === 1 && h === 8 ? 45 : 0))
    );
    const summary2 = buildPunchCardSummary(matrix7x24);
    expect(summary2.totalMinutes).toBe(45);
    expect(summary2.peakWeekday?.label).toBe("Tue");
    expect(summary2.peakHour?.hour).toBe(8);
  });

  test("buildSparklineGeometry generates valid SVG path strings", () => {
    const geom = buildSparklineGeometry([10, 40, 20, 80], 100, 30, 2);
    expect(geom.linePath).toContain("M");
    expect(geom.areaPath).toContain("Z");
    expect(geom.max).toBe(80);
    expect(geom.lastPoint).not.toBeNull();
  });

  test("resolveInsightsRange resolves presets relative to today", () => {
    const r30 = resolveInsightsRange("30d", "2026-10-17");
    expect(r30.bucket).toBe("day");
    expect(r30.from).toBe("2026-09-18");
    expect(r30.to).toBe("2026-10-17");

    const r12w = resolveInsightsRange("12w", "2026-10-17");
    expect(r12w.bucket).toBe("week");
  });
});

describe("v2 router & legacy redirects (web/src/lib/router.ts)", () => {
  test("redirects legacy routes to canonical v2 destinations", () => {
    expect(resolveLegacyRedirect("#/stats")).toBe("#/insights");
    expect(resolveLegacyRedirect("#/heatmap")).toBe("#/insights");
    expect(resolveLegacyRedirect("#/year")).toBe("#/review?view=year");
    expect(resolveLegacyRedirect("#/year?year=2025")).toBe(
      "#/review?view=year&year=2025"
    );
    expect(resolveLegacyRedirect("#/progress")).toBe(
      "#/library?status=in_progress"
    );
    expect(resolveLegacyRedirect("#/importexport")).toBe("#/settings");
    expect(resolveLegacyRedirect("#/library")).toBeNull();
  });

  test("parseAppRoute parses v2 routes and resolves redirects", () => {
    const lib = parseAppRoute(
      "#/library?category=anime&status=finished&sort=time&work=anime%3Asaga"
    );
    expect(lib.route).toBe("library");
    expect(lib.category).toBe("anime");
    expect(lib.status).toBe("finished");
    expect(lib.sort).toBe("time");
    expect(lib.workKey).toBe("anime:saga");

    const redirected = parseAppRoute("#/year?year=2025");
    expect(redirected.route).toBe("review");
    expect(redirected.reviewView).toBe("year");
    expect(redirected.year).toBe("2025");
    expect(redirected.canonicalHash).toBe("#/review?view=year&year=2025");
  });
});

describe("v2 theme storage & calendar cell summaries", () => {
  test("readThemePreference and saveThemePreference persist dark theme ids and fallback on legacy values", () => {
    const map = new Map<string, string>();
    const storage: ThemeStorageLike = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, v);
      },
    };

    expect(readThemePreference(storage)).toBe("espresso");
    saveThemePreference("midnight", storage);
    expect(readThemePreference(storage)).toBe("midnight");
    // Legacy "light" or "system" falls back to "espresso"
    saveThemePreference("light", storage);
    expect(readThemePreference(storage)).toBe("espresso");
  });

  test("summarizeDayCellV2 handles a day with 40 YouTube videos and 120-char titles without bloat", () => {
    const longTitle =
      "Synthetic Deep-Dive Lecture on Ancient Architecture and Maritime Trade Across the Northern Seas Part One Hundred Twenty";
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      source: "youtube",
      media_type: "video",
      category: "youtube" as const,
      title: `${longTitle} #${i + 1}`,
      parent_title: `Synthetic Channel ${(i % 4) + 1}`,
      season: null,
      episode: null,
      started_at: "2026-10-17T12:00:00.000Z",
      local_time: "14:00",
      duration_seconds: null,
      cover_url: null,
    }));

    const day: CalendarDay = {
      date: "2026-10-17",
      count: 40,
      minutes: 0,
      items,
    };

    const summary = summarizeDayCellV2(day, 120, 2);
    expect(summary.count).toBe(40);
    expect(summary.intensity).toBeGreaterThan(0);
    expect(summary.workTitles).toHaveLength(2);
    expect(summary.overflowWorks).toBe(2); // 4 channels total -> 2 shown + 2 overflow
    expect(summary.categorySegments).toEqual([
      { category: "youtube", minutes: 0, count: 40, sharePct: 100 },
    ]);

    const monthSummary = summarizeCalendarMonthV2([day], "2026-10");
    expect(monthSummary.activeDays).toBe(1);
    expect(monthSummary.dailyMinutesSeries).toHaveLength(31);
  });
});
