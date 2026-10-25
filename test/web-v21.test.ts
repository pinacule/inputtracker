import { describe, expect, test } from "bun:test";
import type {
  CalendarDay,
  CalendarItem,
  LibraryWork,
  WorkDetails,
  YoutubeOverview,
  YoutubeVideo,
} from "../web/src/api.ts";
import {
  buildArchiveRequest,
  computeArchivePreview,
} from "../web/src/lib/archive-form.ts";
import {
  CATEGORIES,
  formatCompactSeasonRow,
  formatReadableHistoryItem,
  formatWorkCardMeta,
  formatWorkDetailProgress,
  formatWorkUnitLabel,
} from "../web/src/lib/categories.ts";
import {
  buildCategoryFilterParams,
  buildLibraryCategoryFilterParams,
  formatCategorySelectionParam,
  matchesCategorySelection,
  matchesLibraryCategorySelection,
  parseCategorySelection,
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
  canRateCategory,
  commitInlineRatingInput,
  formatRating10,
  nudgeRatingText,
  ratingToTenths,
  resolveRatingKeyAction,
  resolveRatingWheelDelta,
  stepRating10,
  tenthsToRating,
  validateRating10,
} from "../web/src/lib/rating.ts";
import { parseAppRoute, resolveLegacyRedirect } from "../web/src/lib/router.ts";
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
  groupYoutubeVideos,
  rankYoutubeChannels,
  sortLibraryWorks,
  sortYoutubeVideos,
} from "../web/src/lib/youtube.ts";

describe("themes & WCAG AA compliance (web/src/lib/theme.ts)", () => {
  test("keeps five palettes, adds five skins and rejects unnamed modes", () => {
    expect(DARK_THEMES.length).toBe(10);
    expect(DEFAULT_THEME).toBe("espresso");
    expect(isDarkThemeId("espresso")).toBe(true);
    expect(isDarkThemeId("midnight")).toBe(true);
    expect(isDarkThemeId("forest")).toBe(true);
    expect(isDarkThemeId("obsidian")).toBe(true);
    expect(isDarkThemeId("plum")).toBe(true);
    for (const id of ["hermes", "workbench", "cwm", "signal", "dot"]) {
      expect(isDarkThemeId(id)).toBe(true);
    }

    expect(isDarkThemeId("light")).toBe(false);
    expect(isDarkThemeId("system")).toBe(false);
    expect(isDarkThemeId("dark")).toBe(false);
  });

  test("every theme meets WCAG AA contrast (>= 4.5:1) for text and all 10 categories", () => {
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

describe("v2.2 in-place rating 0–10 helpers (web/src/lib/rating.ts)", () => {
  test("tenths conversion avoids floating-point drift", () => {
    expect(ratingToTenths(8.5)).toBe(85);
    expect(tenthsToRating(85)).toBe(8.5);
    expect(stepRating10(7.4, 0.1)).toBe(7.5);
    expect(stepRating10(7.5, -1.0)).toBe(6.5);
    expect(stepRating10(9.8, 1.0)).toBe(10);
    expect(stepRating10(0.2, -1.0)).toBe(0);
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

  test("formatRating10, resolveRatingKeyAction (±0.1, Shift ±1.0, Enter, Esc), and wheel nudging", () => {
    expect(formatRating10(8.5)).toBe("8.5");
    expect(formatRating10(10)).toBe("10");
    expect(formatRating10(0)).toBe("0");
    expect(formatRating10(8, { fixed: true })).toBe("8.0");
    expect(formatRating10(null)).toBe("—");

    // ArrowUp / ArrowDown: ±0.1, Shift: ±1.0
    expect(resolveRatingKeyAction("ArrowUp", false)).toEqual({
      type: "step",
      delta: 0.1,
    });
    expect(resolveRatingKeyAction("ArrowUp", true)).toEqual({
      type: "step",
      delta: 1.0,
    });
    expect(resolveRatingKeyAction("ArrowDown", false)).toEqual({
      type: "step",
      delta: -0.1,
    });
    expect(resolveRatingKeyAction("ArrowDown", true)).toEqual({
      type: "step",
      delta: -1.0,
    });
    expect(resolveRatingKeyAction("Enter", false)).toEqual({
      type: "commit",
    });
    expect(resolveRatingKeyAction("Escape", false)).toEqual({
      type: "cancel",
    });

    // Mouse wheel nudging: scroll up (<0) -> +0.1 (+1.0 with Shift), scroll down (>0) -> -0.1 (-1.0 with Shift)
    expect(resolveRatingWheelDelta(-100, false)).toBe(0.1);
    expect(resolveRatingWheelDelta(-100, true)).toBe(1.0);
    expect(resolveRatingWheelDelta(100, false)).toBe(-0.1);
    expect(resolveRatingWheelDelta(100, true)).toBe(-1.0);
    expect(resolveRatingWheelDelta(0, false)).toBe(0);

    // nudgeRatingText
    expect(nudgeRatingText("8.4", 8.0, 0.1)).toEqual({
      rating: 8.5,
      text: "8.5",
    });
    expect(nudgeRatingText("8.5", 8.5, -1.0)).toEqual({
      rating: 7.5,
      text: "7.5",
    });
    expect(nudgeRatingText("", null, 0.1)).toEqual({
      rating: 8.1,
      text: "8.1",
    });
  });

  test("commitInlineRatingInput handles save, clear, noop, and invalid input", () => {
    // Unchanged or empty when already unrated -> noop
    expect(commitInlineRatingInput("", null)).toEqual({ action: "noop" });
    expect(commitInlineRatingInput("8.5", 8.5)).toEqual({ action: "noop" });

    // Empty when previously rated -> save null (clear)
    expect(commitInlineRatingInput("", 8.5)).toEqual({
      action: "save",
      rating: null,
    });

    // Valid new rating -> save
    expect(commitInlineRatingInput("8.5", null)).toEqual({
      action: "save",
      rating: 8.5,
    });
    expect(commitInlineRatingInput("9", 8.5)).toEqual({
      action: "save",
      rating: 9,
    });

    // Invalid input -> invalid with short inline hint, does not save
    const bad = commitInlineRatingInput("12.5", 8.5);
    expect(bad.action).toBe("invalid");
    const twoDec = commitInlineRatingInput("8.55", 8.5);
    expect(twoDec.action).toBe("invalid");
  });

  test("canRateCategory hides ratings for music", () => {
    expect(canRateCategory("music")).toBe(false);
    expect(canRateCategory("MUSIC")).toBe(false);
    expect(canRateCategory("anime")).toBe(true);
    expect(canRateCategory("series")).toBe(true);
    expect(canRateCategory("film")).toBe(true);
    expect(canRateCategory("book")).toBe(true);
    expect(canRateCategory("audiobook")).toBe(true);
    expect(canRateCategory("youtube")).toBe(true);
    expect(canRateCategory(undefined)).toBe(true);
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

describe("v2.2 placement of YouTube & music and multi-select chips (web/src/lib/category-filter.ts)", () => {
  test("parses, toggles, formats, and updates hash URL for multi-select categories", () => {
    expect(parseCategorySelection("?cat=anime,film")).toEqual([
      "anime",
      "film",
    ]);
    expect(
      parseCategorySelection("#/library?cat=book,audiobook,invalid")
    ).toEqual(["book", "audiobook"]);

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

    const parsedRoute = parseAppRoute(
      "#/library?status=planned&cat=anime,film&sort=creator"
    );
    expect(parsedRoute.route).toBe("library");
    expect(parsedRoute.status).toBe("planned");
    expect(parsedRoute.categories).toEqual(["anime", "film"]);
    expect(parsedRoute.category).toBe("anime");
    expect(parsedRoute.sort).toBe("creator");

    // Clicking "all" clears selection
    sel = toggleCategoryChip(sel, "all");
    expect(sel).toEqual([]);
    expect(updateHashCategorySelection(hash, sel)).toBe(
      "#/library?status=finished"
    );
  });

  test("Library 'All' excludes YouTube and music, while Insights/Review/Search/Calendar include them", () => {
    // Library "All" excludes both youtube and music
    expect(buildLibraryCategoryFilterParams([])).toEqual({
      exclude: "youtube,music",
    });
    expect(buildCategoryFilterParams([], "library")).toEqual({
      exclude: "youtube,music",
    });
    expect(matchesLibraryCategorySelection("youtube", [])).toBe(false);
    expect(matchesLibraryCategorySelection("music", [])).toBe(false);
    expect(matchesLibraryCategorySelection("anime", [])).toBe(true);
    expect(matchesLibraryCategorySelection("series", [])).toBe(true);

    // Selecting YouTube or Music chip in Library includes them
    expect(buildLibraryCategoryFilterParams(["youtube"])).toEqual({
      category: "youtube",
    });
    expect(buildLibraryCategoryFilterParams(["music"])).toEqual({
      category: "music",
    });
    expect(matchesLibraryCategorySelection("youtube", ["youtube"])).toBe(true);
    expect(matchesLibraryCategorySelection("music", ["music"])).toBe(true);

    // Insights, Review, Search, Calendar "All" include YouTube and music
    expect(buildCategoryFilterParams([])).toEqual({});
    expect(buildCategoryFilterParams([], "all")).toEqual({});
    expect(matchesCategorySelection("youtube", [])).toBe(true);
    expect(matchesCategorySelection("music", [])).toBe(true);
    expect(matchesCategorySelection("anime", [])).toBe(true);
  });

  test("legacy #/youtube links redirect to #/library?cat=youtube", () => {
    expect(resolveLegacyRedirect("#/youtube")).toBe("#/library?cat=youtube");
    expect(
      resolveLegacyRedirect("#/youtube?channel=Synthetic+Lab&topic=History")
    ).toBe("#/library?cat=youtube&channel=Synthetic+Lab&topic=History");

    const parsed = parseAppRoute("#/youtube?topic=Science");
    expect(parsed.route).toBe("library");
    expect(parsed.categories).toEqual(["youtube"]);
    expect(parsed.topic).toBe("Science");
    expect(parsed.canonicalHash).toBe("#/library?cat=youtube&topic=Science");
  });
});

describe("v2.2 work progress, card/row labels, compact seasons & history (web/src/lib/categories.ts)", () => {
  test("never prints 'N episodes' from units for series/anime; uses progress or degrades gracefully", () => {
    // Series with explicit progress -> "3 seasons · 36 ep"
    expect(
      formatWorkUnitLabel({
        category: "series",
        status: "finished",
        units: 3,
        total_minutes: 1620,
        progress: {
          seasons_watched: 3,
          seasons_total: 3,
          episodes_watched: 36,
          episodes_total: 36,
        },
      })
    ).toBe("3 seasons · 36 ep");

    expect(
      formatWorkCardMeta({
        category: "series",
        status: "finished",
        units: 3,
        total_minutes: 1620,
        progress: {
          seasons_watched: 3,
          seasons_total: 3,
          episodes_watched: 36,
          episodes_total: 36,
        },
      })
    ).toBe("27h · 3 seasons · 36 ep");

    // Planned anime with 3 seasons on AniList -> "planned · 3 seasons" (never "1 episode")
    expect(
      formatWorkCardMeta({
        category: "anime",
        status: "planned",
        units: 1,
        total_minutes: 0,
        progress: {
          seasons_watched: 0,
          seasons_total: 3,
          episodes_watched: 0,
          episodes_total: 36,
        },
      })
    ).toBe("planned · 3 seasons");

    // Series when progress is null (before backend populates it) -> never prints "6 episodes"
    expect(
      formatWorkUnitLabel({
        category: "series",
        status: "finished",
        units: 6,
        total_minutes: 3960,
        progress: null,
      })
    ).toBeNull();
    expect(
      formatWorkCardMeta({
        category: "series",
        status: "finished",
        units: 6,
        total_minutes: 3960,
        progress: null,
      })
    ).toBe("66h");

    // Audiobooks -> sessions; Music & YouTube -> plays
    expect(
      formatWorkCardMeta({
        category: "audiobook",
        status: "in_progress",
        units: 14,
        total_minutes: 750,
        progress: null,
      })
    ).toBe("12h 30m · 14 sessions");

    expect(
      formatWorkCardMeta({
        category: "music",
        status: "finished",
        units: 5,
        total_minutes: 18,
        progress: null,
      })
    ).toBe("18m · 5 plays");

    expect(
      formatWorkCardMeta({
        category: "youtube",
        status: "finished",
        units: 2,
        total_minutes: 25,
        progress: null,
      })
    ).toBe("25m · 2 plays");
  });

  test("formatWorkDetailProgress formats full work page progress ('6 of 6 seasons · 65 of 65 episodes')", () => {
    expect(
      formatWorkDetailProgress({
        category: "series",
        status: "finished",
        progress: {
          seasons_watched: 6,
          seasons_total: 6,
          episodes_watched: 65,
          episodes_total: 65,
        },
      })
    ).toBe("6 of 6 seasons · 65 of 65 episodes");

    // Fallback from detail.seasons when progress is null
    expect(
      formatWorkDetailProgress({
        category: "series",
        status: "in_progress",
        progress: null,
        seasons: [
          { episodes: 10, watched_episodes: 10 },
          { episodes: 10, watched_episodes: 5 },
          { episodes: 10, watched_episodes: 0 },
        ],
      })
    ).toBe("2 of 3 seasons · 15 of 30 episodes");
  });

  test("formatCompactSeasonRow strips noisy provider titles ('Cobra Kaii (2019)' -> 'Season 2 · 2019 · 10 ep')", () => {
    const row = formatCompactSeasonRow({
      number: 2,
      title: "Cobra Kaii",
      year: 2019,
      episodes: 10,
      watched_episodes: 10,
      total_minutes: 300,
    });
    expect(row.heading).toBe("Season 2");
    expect(row.meta).toBe("2019 · 10 ep");
    expect(row.summary).toBe("Season 2 · 2019 · 10 ep");
    expect(row.summary).not.toContain("Cobra Kaii");
    expect(row.isFinished).toBe(true);
    expect(row.statusLabel).toBe("10 / 10 ep");
  });

  test("formatReadableHistoryItem never prints 'Undated · Manual (Archive)'", () => {
    const undatedArchive = formatReadableHistoryItem(
      {
        started_at: "2026-10-18T10:00:00.000Z",
        precision: "unknown",
        label: "Season 1 (10 ep)",
        minutes: 300,
        source: "manual",
        entry_id: "arch-1",
      },
      "Synthetic Karate Show"
    );
    expect(undatedArchive.label).toBe("Season 1 (10 ep)");
    expect(undatedArchive.dateLabel).toBeNull();
    expect(undatedArchive.metaText).toBe("Archive");
    expect(undatedArchive.metaText).not.toContain("Undated");
    expect(undatedArchive.metaText).not.toContain("Manual");

    const yearArchive = formatReadableHistoryItem(
      {
        started_at: "2021-01-01T12:00:00.000Z",
        precision: "year",
        label: "Season 2 (10 ep)",
        minutes: 300,
        source: "manual",
        entry_id: "arch-2",
      },
      "Synthetic Karate Show"
    );
    expect(yearArchive.metaText).toBe("2021 · Archive");

    const daySession = formatReadableHistoryItem(
      {
        started_at: "2026-10-17T18:00:00.000Z",
        precision: "day",
        label: "S01E03 · Episode Three",
        minutes: 24,
        source: "simkl",
        entry_id: null,
      },
      "Synthetic Northern Saga"
    );
    expect(daySession.dateHref).toBe("#/calendar?date=2026-10-17");
    expect(daySession.metaText).toBe("17.10.2026 · Simkl");
  });
});

describe("v2.2 Library sorts and YouTube video sorting & grouping (web/src/lib/youtube.ts)", () => {
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
        progress: null,
        creator: "Synthetic Academy",
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

  test("sortYoutubeVideos and groupYoutubeVideos sort by recent/time/topic and group by topic/channel", () => {
    const videos: YoutubeVideo[] = [
      {
        key: "youtube:v1",
        video_id: "v1",
        title: "Beta Video",
        channel: "Channel B",
        topic: "Science",
        watched_minutes: 20,
        plays: 1,
        first_at: "2026-10-15T10:00:00.000Z",
        last_at: "2026-10-15T10:00:00.000Z",
        thumbnail_url: null,
      },
      {
        key: "youtube:v2",
        video_id: "v2",
        title: "Alpha Video",
        channel: "Channel A",
        topic: "History",
        watched_minutes: 55,
        plays: 2,
        first_at: "2026-10-18T10:00:00.000Z",
        last_at: "2026-10-18T10:00:00.000Z",
        thumbnail_url: null,
      },
      {
        key: "youtube:v3",
        video_id: "v3",
        title: "Gamma Video",
        channel: "Channel A",
        topic: null,
        watched_minutes: 10,
        plays: 1,
        first_at: "2026-10-16T10:00:00.000Z",
        last_at: "2026-10-16T10:00:00.000Z",
        thumbnail_url: null,
      },
    ];

    expect(sortYoutubeVideos(videos, "recent").map((v) => v.video_id)).toEqual([
      "v2",
      "v3",
      "v1",
    ]);
    expect(sortYoutubeVideos(videos, "time").map((v) => v.video_id)).toEqual([
      "v2",
      "v1",
      "v3",
    ]);
    // Topic sort puts History before Science, and Uncategorised (null) last
    expect(sortYoutubeVideos(videos, "topic").map((v) => v.video_id)).toEqual([
      "v2",
      "v1",
      "v3",
    ]);

    const byTopic = groupYoutubeVideos(videos, "topic", "time");
    expect(byTopic.map((g) => g.label)).toEqual([
      "History",
      "Science",
      UNCATEGORISED_TOPIC,
    ]);

    const byChannel = groupYoutubeVideos(videos, "channel", "time");
    expect(byChannel.map((g) => g.label)).toEqual(["Channel A", "Channel B"]);
    expect(byChannel[0]?.totalMinutes).toBe(65);
    expect(byChannel[0]?.videosCount).toBe(2);
  });

  test("sortLibraryWorks supports recent, time, title, category, and creator", () => {
    const base: Omit<
      LibraryWork,
      "key" | "category" | "title" | "total_minutes" | "last_at" | "creator"
    > = {
      cover_url: null,
      units: 1,
      first_at: "2026-10-01T10:00:00.000Z",
      status: "finished",
      rating: null,
      sources: ["manual"],
      edited: false,
      channel: null,
      topic: null,
      progress: null,
    };
    const works: LibraryWork[] = [
      {
        ...base,
        key: "book:b1",
        category: "book",
        title: "Zeta Book",
        total_minutes: 300,
        last_at: "2026-10-10T10:00:00.000Z",
        creator: "Ursula Writer",
      },
      {
        ...base,
        key: "anime:a1",
        category: "anime",
        title: "Alpha Anime",
        total_minutes: 900,
        last_at: "2026-10-12T10:00:00.000Z",
        creator: "Beta Studio",
      },
      {
        ...base,
        key: "film:f1",
        category: "film",
        title: "Middle Film",
        total_minutes: 120,
        last_at: "2026-10-18T10:00:00.000Z",
        creator: null,
      },
    ];

    expect(sortLibraryWorks(works, "recent").map((w) => w.key)).toEqual([
      "film:f1",
      "anime:a1",
      "book:b1",
    ]);
    expect(sortLibraryWorks(works, "time").map((w) => w.key)).toEqual([
      "anime:a1",
      "book:b1",
      "film:f1",
    ]);
    expect(sortLibraryWorks(works, "title").map((w) => w.key)).toEqual([
      "anime:a1",
      "film:f1",
      "book:b1",
    ]);
    expect(sortLibraryWorks(works, "category").map((w) => w.key)).toEqual([
      "anime:a1",
      "film:f1",
      "book:b1",
    ]);
    // Creator sort places non-empty creators alphabetically, then null creators last
    expect(sortLibraryWorks(works, "creator").map((w) => w.key)).toEqual([
      "anime:a1",
      "book:b1",
      "film:f1",
    ]);
  });
});

describe("v2.1 & v2.2 context menu placement & actions (web/src/lib/context-menu.ts)", () => {
  test("clamps and flips menu inside 375px and 1440px viewports", () => {
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

    const desktopPlaced = computeContextMenuPlacement(
      { x: 400, y: 300 },
      { width: 260, height: 240 },
      { width: 1440, height: 900 },
      12
    );
    expect(desktopPlaced.left).toBe(400);
    expect(desktopPlaced.top).toBe(300);
  });

  test("builds contextual actions and hides 'rate' for music tracks", () => {
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

    // Music tracks have no rating action
    const musicActions = buildContextMenuActions({
      kind: "work",
      workKey: "music:synthetic-track",
      title: "Synthetic Track",
      category: "music",
      status: "finished",
    });
    expect(musicActions.map((a) => a.id)).not.toContain("rate");

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
        duration_seconds: 240,
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
      { date: "2026-10-12", count: 1, minutes: 60, items: [] },
      { date: "2026-10-14", count: 2, minutes: 90, items: [] },
      { date: "2026-10-18", count: 1, minutes: 45, items: [] },
    ];
    const week = summarizeCurrentWeek(days, "2026-10-18");
    expect(week.todayMinutes).toBe(45);
    expect(week.weekMinutes).toBe(195);
    expect(week.weekActiveDays).toBe(3);
    expect(week.weekDailyMinutes).toEqual([60, 0, 90, 0, 0, 0, 45]);
  });
});
