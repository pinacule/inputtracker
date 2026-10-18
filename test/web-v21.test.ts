import { describe, expect, test } from "bun:test";
import type {
  CalendarDay,
  CalendarItem,
  LibraryWork,
  WorkDetails,
  YoutubeOverview,
} from "../web/src/api.ts";
import {
  buildArchiveRequest,
  computeArchivePreview,
} from "../web/src/lib/archive-form.ts";
import { CATEGORIES } from "../web/src/lib/categories.ts";
import {
  buildCategoryFilterParams,
  formatCategorySelectionParam,
  matchesCategorySelection,
  parseCategorySelection,
  readIncludeYoutubeInAll,
  saveIncludeYoutubeInAll,
  toggleCategoryChip,
  updateHashCategorySelection,
} from "../web/src/lib/category-filter.ts";
import {
  buildContextMenuActions,
  computeContextMenuPlacement,
  nextMenuFocusIndex,
} from "../web/src/lib/context-menu.ts";
import { formatCleanDayHeading } from "../web/src/lib/format-date.ts";
import {
  formatRating10,
  ratingToTenths,
  resolveRatingKeyAction,
  stepRating10,
  tenthsToRating,
  validateRating10,
} from "../web/src/lib/rating.ts";
import { parseAppRoute } from "../web/src/lib/router.ts";
import {
  DARK_THEMES,
  DEFAULT_THEME,
  THEME_REGISTRY,
  contrastRatio,
  isDarkThemeId,
  readThemePreference,
  saveThemePreference,
  type ThemeStorageLike,
} from "../web/src/lib/theme.ts";
import {
  groupDayPanelItems,
  summarizeCurrentWeek,
} from "../web/src/lib/ui-helpers.ts";
import {
  UNCATEGORISED_TOPIC,
  buildYoutubeOverviewFromWorks,
  buildYoutubeVideosFromWorks,
  groupYoutubeByTopic,
  rankYoutubeChannels,
} from "../web/src/lib/youtube.ts";

describe("v2.1 dark-only themes & WCAG AA compliance (web/src/lib/theme.ts)", () => {
  test("offers 5 named dark themes and rejects light/system modes", () => {
    expect(DARK_THEMES.length).toBe(5);
    expect(DEFAULT_THEME).toBe("espresso");
    expect(isDarkThemeId("espresso")).toBe(true);
    expect(isDarkThemeId("midnight")).toBe(true);
    expect(isDarkThemeId("forest")).toBe(true);
    expect(isDarkThemeId("obsidian")).toBe(true);
    expect(isDarkThemeId("plum")).toBe(true);

    expect(isDarkThemeId("light")).toBe(false);
    expect(isDarkThemeId("system")).toBe(false);
    expect(isDarkThemeId("dark")).toBe(false);
  });

  test("every theme meets WCAG AA contrast (>= 4.5:1) for text and all 9 categories", () => {
    for (const theme of DARK_THEMES) {
      expect(THEME_REGISTRY[theme.id]).toBe(theme);

      // Text primary & secondary on canvas and surface
      expect(
        contrastRatio(theme.swatches.textPrimary, theme.swatches.canvas)
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.swatches.textPrimary, theme.swatches.surface)
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.swatches.textSecondary, theme.swatches.canvas)
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.swatches.textSecondary, theme.swatches.surface)
      ).toBeGreaterThanOrEqual(4.5);

      // Category colours distinct and WCAG AA on both category badge bg and theme surface
      const solids = new Set<string>();
      for (const cat of CATEGORIES) {
        const c = theme.categories[cat];
        solids.add(c.solid);
        expect(contrastRatio(c.fg, c.bg)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(c.fg, theme.swatches.surface)
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(solids.size).toBe(CATEGORIES.length);
    }
  });

  test("persists theme selection in storage and falls back to espresso", () => {
    const store = new Map<string, string>();
    const storage: ThemeStorageLike = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
    };
    expect(readThemePreference(storage)).toBe("espresso");
    expect(saveThemePreference("forest", storage)).toBe("forest");
    expect(readThemePreference(storage)).toBe("forest");
    expect(saveThemePreference("invalid-theme", storage)).toBe("espresso");
  });
});

describe("v2.1 ratings 0–10 with one decimal (web/src/lib/rating.ts)", () => {
  test("tenths conversion avoids floating-point drift", () => {
    expect(ratingToTenths(8.5)).toBe(85);
    expect(tenthsToRating(85)).toBe(8.5);
    expect(stepRating10(7.4, 0.1)).toBe(7.5);
    expect(stepRating10(7.5, -0.5)).toBe(7);
    expect(stepRating10(9.8, 0.5)).toBe(10);
    expect(stepRating10(0.2, -0.5)).toBe(0);
  });

  test("validateRating10 accepts 0..10 with at most one decimal and rejects invalid values", () => {
    expect(validateRating10(null)).toEqual({ ok: true, rating: null });
    expect(validateRating10("")).toEqual({ ok: true, rating: null });
    expect(validateRating10(0)).toEqual({ ok: true, rating: 0 });
    expect(validateRating10(10)).toEqual({ ok: true, rating: 10 });
    expect(validateRating10(8.5)).toEqual({ ok: true, rating: 8.5 });
    expect(validateRating10("7.3")).toEqual({ ok: true, rating: 7.3 });

    expect(validateRating10(-0.1).ok).toBe(false);
    expect(validateRating10(10.1).ok).toBe(false);
    expect(validateRating10(7.25).ok).toBe(false);
    expect(validateRating10("7.25").ok).toBe(false);
    expect(validateRating10(Number.NaN).ok).toBe(false);
  });

  test("formatRating10 and resolveRatingKeyAction", () => {
    expect(formatRating10(8.5)).toBe("8.5");
    expect(formatRating10(10)).toBe("10");
    expect(formatRating10(0)).toBe("0");
    expect(formatRating10(8, { fixed: true })).toBe("8.0");
    expect(formatRating10(null)).toBe("—");

    expect(resolveRatingKeyAction("ArrowUp", false)).toEqual({
      type: "step",
      delta: 0.1,
    });
    expect(resolveRatingKeyAction("ArrowUp", true)).toEqual({
      type: "step",
      delta: 0.5,
    });
    expect(resolveRatingKeyAction("ArrowDown", false)).toEqual({
      type: "step",
      delta: -0.1,
    });
    expect(resolveRatingKeyAction("Backspace", false)).toEqual({
      type: "clear",
    });
  });

  test("buildArchiveRequest supports one-decimal ratings and planned watchlist status", () => {
    const work: WorkDetails = {
      provider: "anilist",
      provider_id: "101",
      category: "anime",
      title: "Synthetic Sky Saga",
      original_title: null,
      year: 2024,
      cover_url: null,
      creators: [],
      genres: [],
      description: null,
      seasons: [
        {
          number: 1,
          title: "Season 1",
          year: 2024,
          episodes: 12,
          episode_minutes: 24,
          total_minutes: 288,
          provider_id: "101",
        },
      ],
      runtime_minutes: null,
      pages: null,
      external_ids: {},
    };

    const plannedPreview = computeArchivePreview(work, {}, "planned");
    expect(plannedPreview.totalMinutes).toBe(0);
    expect(plannedPreview.summaryText).toContain("Planned");

    const builtPlanned = buildArchiveRequest({
      entry_id: "planned-1",
      work,
      consumed: {},
      when: { precision: "unknown" },
      rating: 8.5,
      status: "planned",
    });
    expect(builtPlanned.ok).toBe(true);
    if (builtPlanned.ok) {
      expect(builtPlanned.request.status).toBe("planned");
      expect(builtPlanned.request.rating).toBe(8.5);
    }
  });
});

describe("v2.1 multi-select category chips & URL sync (web/src/lib/category-filter.ts)", () => {
  test("parses, toggles, formats, and updates hash URL for multi-select categories", () => {
    expect(parseCategorySelection("?cat=anime,film")).toEqual([
      "anime",
      "film",
    ]);
    expect(parseCategorySelection("#/library?cat=book,audiobook,invalid")).toEqual([
      "book",
      "audiobook",
    ]);

    let sel = toggleCategoryChip([], "anime");
    expect(sel).toEqual(["anime"]);
    sel = toggleCategoryChip(sel, "film");
    expect(sel).toEqual(["anime", "film"]);
    expect(formatCategorySelectionParam(sel)).toBe("anime,film");

    const hash = updateHashCategorySelection(
      "#/library?status=finished&category=anime",
      sel
    );
    expect(hash).toBe("#/library?status=finished&cat=anime%2Cfilm");

    const parsedRoute = parseAppRoute("#/library?status=planned&cat=anime,film");
    expect(parsedRoute.route).toBe("library");
    expect(parsedRoute.status).toBe("planned");
    expect(parsedRoute.categories).toEqual(["anime", "film"]);
    expect(parsedRoute.category).toBe("anime");

    // Clicking "all" clears selection
    sel = toggleCategoryChip(sel, "all");
    expect(sel).toEqual([]);
    expect(updateHashCategorySelection(hash, sel)).toBe(
      "#/library?status=finished"
    );
  });

  test("excludes YouTube from All by default unless includeYoutubeInAll is enabled", () => {
    expect(buildCategoryFilterParams([], false)).toEqual({
      exclude: "youtube",
    });
    expect(buildCategoryFilterParams([], true)).toEqual({});
    expect(buildCategoryFilterParams(["anime", "film"], false)).toEqual({
      category: "anime,film",
    });

    expect(matchesCategorySelection("youtube", [], false)).toBe(false);
    expect(matchesCategorySelection("youtube", [], true)).toBe(true);
    expect(matchesCategorySelection("youtube", ["youtube"], false)).toBe(true);
    expect(matchesCategorySelection("anime", ["anime", "film"], false)).toBe(
      true
    );
    expect(matchesCategorySelection("book", ["anime", "film"], false)).toBe(
      false
    );

    const store = new Map<string, string>();
    const storage: ThemeStorageLike = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v);
      },
    };
    expect(readIncludeYoutubeInAll(storage)).toBe(false);
    saveIncludeYoutubeInAll(true, storage);
    expect(readIncludeYoutubeInAll(storage)).toBe(true);
  });
});

describe("v2.1 YouTube topic & channel grouping (web/src/lib/youtube.ts)", () => {
  const syntheticOverview: YoutubeOverview = {
    from: null,
    to: null,
    total_minutes: 300,
    videos: 15,
    topics: [
      {
        topic: "Science & Technology",
        channels: 2,
        videos: 10,
        total_minutes: 210,
      },
      {
        topic: "History",
        channels: 1,
        videos: 3,
        total_minutes: 60,
      },
    ],
    channels: [
      {
        channel: "Synthetic Optics Lab",
        channel_id: "ch-1",
        topic: "Science & Technology",
        videos: 6,
        total_minutes: 140,
        last_at: "2026-10-17T12:00:00.000Z",
      },
      {
        channel: "Synthetic Circuitry",
        channel_id: "ch-2",
        topic: "Science & Technology",
        videos: 4,
        total_minutes: 70,
        last_at: "2026-10-16T12:00:00.000Z",
      },
      {
        channel: "Synthetic Antiquity",
        channel_id: "ch-3",
        topic: "History",
        videos: 3,
        total_minutes: 60,
        last_at: "2026-10-15T12:00:00.000Z",
      },
      {
        channel: "Synthetic Vlog",
        channel_id: "ch-4",
        topic: null,
        videos: 2,
        total_minutes: 30,
        last_at: "2026-10-14T12:00:00.000Z",
      },
    ],
    days: [],
    short_plays_hidden: 4,
    min_watch_minutes: 5,
  };

  test("groups channels under topics, places Uncategorised last, and computes bar ratios", () => {
    const groups = groupYoutubeByTopic(syntheticOverview);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.topic).toBe("Science & Technology");
    expect(groups[0]?.totalMinutes).toBe(210);
    expect(groups[0]?.barRatio).toBe(1);
    expect(groups[0]?.channels).toHaveLength(2);
    expect(groups[0]?.channels[0]?.channel).toBe("Synthetic Optics Lab");

    expect(groups[1]?.topic).toBe("History");
    expect(groups[2]?.topic).toBe(UNCATEGORISED_TOPIC);
    expect(groups[2]?.isUncategorised).toBe(true);

    // Search filtering within YouTube
    const filtered = groupYoutubeByTopic(syntheticOverview, "optics");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.channels[0]?.channel).toBe("Synthetic Optics Lab");
  });

  test("rankYoutubeChannels and 404 fallback synthesis from LibraryWork[]", () => {
    const ranked = rankYoutubeChannels(syntheticOverview.channels, {
      topic: "Science & Technology",
    });
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.barRatio).toBe(1);
    expect(ranked[1]?.barRatio).toBe(0.5);

    const works: LibraryWork[] = [
      {
        key: "youtube:vid-1",
        category: "youtube",
        title: "Synthetic Lecture One",
        cover_url: null,
        total_minutes: 45,
        units: 1,
        first_at: "2026-10-17T10:00:00.000Z",
        last_at: "2026-10-17T10:00:00.000Z",
        status: "finished",
        rating: null,
        sources: ["youtube"],
        edited: false,
        channel: "Synthetic Academy",
        topic: "Education",
      },
    ];
    const fbOverview = buildYoutubeOverviewFromWorks(works);
    expect(fbOverview.total_minutes).toBe(45);
    expect(fbOverview.channels[0]?.channel).toBe("Synthetic Academy");

    const fbVideos = buildYoutubeVideosFromWorks(works, {
      channel: "Synthetic Academy",
    });
    expect(fbVideos.total).toBe(1);
    expect(fbVideos.videos[0]?.title).toBe("Synthetic Lecture One");
  });
});

describe("v2.1 context menu placement & actions (web/src/lib/context-menu.ts)", () => {
  test("clamps and flips menu inside 375px and 1440px viewports", () => {
    // Near bottom-right corner on a 375x667 phone
    const phonePlaced = computeContextMenuPlacement(
      { x: 350, y: 620 },
      { width: 260, height: 240 },
      { width: 375, height: 667 },
      12
    );
    expect(phonePlaced.left).toBeGreaterThanOrEqual(12);
    expect(phonePlaced.left + 260).toBeLessThanOrEqual(375 - 12);
    expect(phonePlaced.top).toBeGreaterThanOrEqual(12);
    expect(phonePlaced.top + 240).toBeLessThanOrEqual(667 - 12);

    // Inside a 1440x900 desktop
    const desktopPlaced = computeContextMenuPlacement(
      { x: 400, y: 300 },
      { width: 260, height: 240 },
      { width: 1440, height: 900 },
      12
    );
    expect(desktopPlaced.left).toBe(400);
    expect(desktopPlaced.top).toBe(300);
  });

  test("builds contextual actions for works, YouTube videos, channels, and archive entries", () => {
    const workActions = buildContextMenuActions({
      kind: "work",
      workKey: "anime:synthetic",
      title: "Synthetic Anime",
      category: "anime",
      status: "in_progress",
      rating: 8.5,
    });
    const ids = workActions.map((a) => a.id);
    expect(ids).toContain("rate");
    expect(ids).toContain("edit");
    expect(ids).toContain("category");
    expect(ids).toContain("add_more");
    expect(ids).toContain("mark_finished");
    expect(ids).toContain("mark_planned");
    expect(ids).toContain("hide");
    expect(ids).not.toContain("delete_entry");
    expect(ids).not.toContain("topic");

    // Archive entry includes edit_entry and delete_entry
    const archiveActions = buildContextMenuActions({
      kind: "archive-entry",
      workKey: "film:synthetic",
      title: "Synthetic Film",
      category: "film",
      entryId: "entry-123",
    });
    expect(archiveActions.map((a) => a.id)).toContain("edit_entry");
    expect(archiveActions.map((a) => a.id)).toContain("delete_entry");

    // YouTube video includes Set topic
    const ytActions = buildContextMenuActions({
      kind: "youtube-video",
      workKey: "youtube:v1",
      title: "Synthetic Video",
      category: "youtube",
      topic: "Science",
    });
    expect(ytActions.map((a) => a.id)).toContain("topic");

    // Keyboard index stepping
    expect(nextMenuFocusIndex(0, 5, "ArrowDown")).toBe(1);
    expect(nextMenuFocusIndex(0, 5, "ArrowUp")).toBe(4);
    expect(nextMenuFocusIndex(3, 5, "Home")).toBe(0);
    expect(nextMenuFocusIndex(1, 5, "End")).toBe(4);
  });
});

describe("v2.1 home page clarity & day panel grouping", () => {
  test("formatCleanDayHeading produces one clean line without duplicate numeric dates", () => {
    expect(formatCleanDayHeading("2026-10-18", "2026-10-18")).toBe("Today");
    expect(formatCleanDayHeading("2026-10-17", "2026-10-18")).toBe("Yesterday");
    expect(formatCleanDayHeading("2026-10-16", "2026-10-18")).toBe(
      "Friday 16 October"
    );
    expect(formatCleanDayHeading("2025-05-03", "2026-10-18")).toBe(
      "Saturday 3 May 2025"
    );
  });

  test("groupDayPanelItems groups episodes by work and collapses YouTube to one expandable line", () => {
    const items: CalendarItem[] = [
      {
        id: 1,
        source: "simkl",
        media_type: "episode",
        category: "anime",
        title: "Episode One",
        parent_title: "Synthetic Northern Saga",
        season: 1,
        episode: 3,
        started_at: "2026-10-17T18:00:00.000Z",
        local_time: "20:00",
        duration_seconds: 1440,
        cover_url: "/api/cover/saga",
      },
      {
        id: 2,
        source: "simkl",
        media_type: "episode",
        category: "anime",
        title: "Episode Two",
        parent_title: "Synthetic Northern Saga",
        season: 1,
        episode: 4,
        started_at: "2026-10-17T18:30:00.000Z",
        local_time: "20:30",
        duration_seconds: 1440,
        cover_url: "/api/cover/saga",
      },
      ...Array.from({ length: 12 }, (_, idx) => ({
        id: 100 + idx,
        source: "youtube",
        media_type: "video",
        category: "youtube" as const,
        title: `Synthetic Video #${idx + 1}`,
        parent_title: "Synthetic Channel",
        season: null,
        episode: null,
        started_at: "2026-10-17T12:00:00.000Z",
        local_time: "14:00",
        duration_seconds: 240, // 4 min each -> 48 min total
        cover_url: null,
      })),
    ];

    const grouped = groupDayPanelItems(items);
    expect(grouped.workGroups).toHaveLength(1);
    expect(grouped.workGroups[0]?.workTitle).toBe("Synthetic Northern Saga");
    expect(grouped.workGroups[0]?.totalMinutes).toBe(48);
    expect(grouped.workGroups[0]?.detailLabel).toBe(
      "S01E03–E04 (2 episodes)"
    );

    expect(grouped.youtubeSummary).not.toBeNull();
    expect(grouped.youtubeSummary?.count).toBe(12);
    expect(grouped.youtubeSummary?.totalMinutes).toBe(48);
    expect(grouped.youtubeSummary?.summaryLabel).toBe("12 videos · 48 min");
  });

  test("summarizeCurrentWeek computes today and Monday-Sunday week totals", () => {
    const days: CalendarDay[] = [
      { date: "2026-10-12", count: 1, minutes: 60, items: [] }, // Mon
      { date: "2026-10-14", count: 2, minutes: 90, items: [] }, // Wed
      { date: "2026-10-18", count: 1, minutes: 45, items: [] }, // Sun (today)
    ];
    const week = summarizeCurrentWeek(days, "2026-10-18");
    expect(week.todayMinutes).toBe(45);
    expect(week.weekMinutes).toBe(195);
    expect(week.weekActiveDays).toBe(3);
    expect(week.weekDailyMinutes).toEqual([60, 0, 90, 0, 0, 0, 45]);
  });
});
