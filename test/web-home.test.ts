import { afterEach, describe, expect, test } from "bun:test";
import type {
  ArchiveEntrySummary,
  CalendarDay,
  CalendarItem,
  LibraryWork,
  ProgressItem,
} from "../web/src/api.ts";
import {
  buildArchiveEntryLookup,
  buildCalmCellLines,
  buildHomeCategoryChipTotals,
  buildHomeDayDetailModel,
  buildHomeHash,
  buildInProgressShelf,
  buildLibraryWorkLookup,
  buildMonthModels,
  buildWeekGraphModel,
  filterAndEnrichCalendarDays,
  formatCleanDayHeading,
  formatHomeWorkProgress,
  formatMonthHeading,
  formatWeekRangeHeading,
  getDaysInMonth,
  getRequiredMonthsForView,
  getTodayLocalDate,
  getWeekDatesForDay,
  isRateableCategory,
  isValidDateStr,
  isValidMonthStr,
  matchesHomeCategory,
  pickDefaultDayForMonth,
  resolveHomeSelection,
  shiftDateStr,
  stepCalendarDateByKey,
} from "../web/src/lib/home.ts";
import {
  fetchHomePageBundle,
  mergeCalendarMonthDays,
} from "../web/src/lib/home-data.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("home page date, week & month pure helpers (web/src/lib/home.ts)", () => {
  test("validates dates and months and formats plain headings", () => {
    expect(isValidDateStr("2026-10-18")).toBe(true);
    expect(isValidDateStr("2026-02-29")).toBe(false);
    expect(isValidDateStr("2024-02-29")).toBe(true);
    expect(isValidMonthStr("2026-10")).toBe(true);
    expect(isValidMonthStr("2026-13")).toBe(false);

    expect(formatMonthHeading("2026-10")).toBe("October 2026");
    expect(getDaysInMonth("2026-10")).toBe(31);
    expect(getDaysInMonth("2026-02")).toBe(28);
    expect(getDaysInMonth("2024-02")).toBe(29);

    expect(formatCleanDayHeading("2026-10-18", "2026-10-18")).toBe("Today");
    expect(formatCleanDayHeading("2026-10-17", "2026-10-18")).toBe("Yesterday");
    expect(formatCleanDayHeading("2026-10-16", "2026-10-18")).toBe(
      "Friday 16 October"
    );
    expect(formatCleanDayHeading("2025-10-16", "2026-10-18")).toBe(
      "Thursday 16 October 2025"
    );
  });

  test("getTodayLocalDate converts UTC timestamp to Europe/Bratislava local date", () => {
    // 2026-10-17T22:30:00.000Z is 2026-10-18 00:30 CEST in Europe/Bratislava
    const instant = new Date("2026-10-17T22:30:00.000Z");
    expect(getTodayLocalDate(instant, "Europe/Bratislava")).toBe("2026-10-18");
  });

  test("computes Monday–Sunday week dates and detects cross-month weeks", () => {
    // 2026-10-01 is a Thursday -> week is Mon 2026-09-28 .. Sun 2026-10-04
    const week = getWeekDatesForDay("2026-10-01");
    expect(week).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);

    const months = getRequiredMonthsForView("2026-10", "2026-10-01");
    expect(months).toEqual(["2026-10", "2026-09"]);

    expect(formatWeekRangeHeading(week, "2026-10-01")).toEqual({
      heading: "This week",
      isCurrentWeek: true,
    });
    expect(formatWeekRangeHeading(week, "2026-10-08")).toEqual({
      heading: "Last week",
      isCurrentWeek: false,
    });
    expect(formatWeekRangeHeading(week, "2026-10-18")).toEqual({
      heading: "28 Sep – 4 Oct",
      isCurrentWeek: false,
    });
  });

  test("resolves URL ?date= and ?month= props and builds canonical hash", () => {
    expect(resolveHomeSelection({}, "2026-10-18")).toEqual({
      month: "2026-10",
      selectedDate: "2026-10-18",
      explicitDate: false,
    });

    expect(
      resolveHomeSelection({ date: "2026-10-12" }, "2026-10-18")
    ).toEqual({
      month: "2026-10",
      selectedDate: "2026-10-12",
      explicitDate: true,
    });

    expect(
      resolveHomeSelection({ initialMonth: "2026-08" }, "2026-10-18")
    ).toEqual({
      month: "2026-08",
      selectedDate: "2026-08-01",
      explicitDate: false,
    });

    const days: CalendarDay[] = [
      { date: "2026-08-04", count: 1, minutes: 45, items: [] },
      { date: "2026-08-19", count: 2, minutes: 90, items: [] },
    ];
    expect(pickDefaultDayForMonth("2026-08", days, "2026-10-18")).toBe(
      "2026-08-19"
    );

    expect(
      buildHomeHash({
        selectedDate: "2026-10-18",
        currentMonth: "2026-10",
        todayStr: "2026-10-18",
        selectedCategories: [],
      })
    ).toBe("#/calendar");

    expect(
      buildHomeHash({
        selectedDate: "2026-10-14",
        currentMonth: "2026-10",
        todayStr: "2026-10-18",
        selectedCategories: ["anime", "audiobook"],
        explicitDate: true,
      })
    ).toBe("#/calendar?date=2026-10-14&cat=anime%2Caudiobook");
  });

  test("steps calendar selection by keyboard keys", () => {
    expect(stepCalendarDateByKey("2026-10-18", "ArrowLeft")).toBe("2026-10-17");
    expect(stepCalendarDateByKey("2026-10-18", "ArrowRight")).toBe("2026-10-19");
    expect(stepCalendarDateByKey("2026-10-18", "ArrowUp")).toBe("2026-10-11");
    expect(stepCalendarDateByKey("2026-10-18", "ArrowDown")).toBe("2026-10-25");
    expect(stepCalendarDateByKey("2026-10-15", "Home")).toBe("2026-10-12");
    expect(stepCalendarDateByKey("2026-10-15", "End")).toBe("2026-10-18");
    expect(stepCalendarDateByKey("2026-03-31", "PageUp")).toBe("2026-02-28");
    expect(stepCalendarDateByKey("2026-10-18", "Enter")).toBeNull();
  });
});

describe("v2.2 section 15: YouTube & music placement and rating rules", () => {
  test("Home 'All' includes YouTube and music; ratings are hidden for music", () => {
    expect(matchesHomeCategory("youtube", [])).toBe(true);
    expect(matchesHomeCategory("music", [])).toBe(true);
    expect(matchesHomeCategory("anime", [])).toBe(true);

    expect(matchesHomeCategory("youtube", ["anime"])).toBe(false);
    expect(matchesHomeCategory("music", ["music", "book"])).toBe(true);

    expect(isRateableCategory("music")).toBe(false);
    expect(isRateableCategory("anime")).toBe(true);
    expect(isRateableCategory("audiobook")).toBe(true);
    expect(isRateableCategory("youtube")).toBe(true);
  });
});

describe("home page graphs, 40-video YouTube days, and empty states", () => {
  test("handles an empty month cleanly with zero activity", () => {
    const { rhythm, weeks, availableCategories } = buildMonthModels({
      month: "2026-10",
      days: [],
      selectedDate: "2026-10-18",
      todayStr: "2026-10-18",
    });

    expect(rhythm.totalMinutes).toBe(0);
    expect(rhythm.activeDays).toBe(0);
    expect(rhythm.categoryShares).toEqual([]);
    expect(rhythm.skyline).toHaveLength(31);
    expect(availableCategories).toEqual([]);
    expect(weeks).toHaveLength(5);

    const emptyDetail = buildHomeDayDetailModel({
      date: "2026-10-18",
      todayStr: "2026-10-18",
      day: undefined,
    });
    expect(emptyDetail.isEmpty).toBe(true);
    expect(emptyDetail.heading).toBe("Today");
    expect(emptyDetail.works).toEqual([]);
    expect(emptyDetail.youtube).toBeNull();
    expect(emptyDetail.music).toBeNull();
  });

  test("collapses 40 YouTube videos and 15 music tracks on one day into calm lines", () => {
    const longVideoTitle =
      "Synthetic Deep-Dive Lecture on Northern Maritime History and Timber Architecture Part Forty-Two";

    const ytItems: CalendarItem[] = Array.from({ length: 40 }, (_, idx) => ({
      id: 1000 + idx,
      source: "youtube",
      media_type: "video",
      category: "youtube",
      title: `${longVideoTitle} #${idx + 1}`,
      parent_title: `Synthetic Channel ${(idx % 4) + 1}`,
      season: null,
      episode: null,
      started_at: "2026-10-17T14:00:00.000Z",
      local_time: "16:00",
      duration_seconds: 240, // 4 min each -> 160 min (2h 40m) total
      cover_url: null,
    }));

    const musicItems: CalendarItem[] = Array.from({ length: 15 }, (_, idx) => ({
      id: 2000 + idx,
      source: "youtube",
      media_type: "music",
      category: "music",
      title: `Synthetic Track #${idx + 1}`,
      parent_title: `Synthetic Artist ${(idx % 3) + 1}`,
      season: null,
      episode: null,
      started_at: "2026-10-17T10:00:00.000Z",
      local_time: "12:00",
      duration_seconds: 180, // 3 min each -> 45 min total
      cover_url: null,
    }));

    const animeItems: CalendarItem[] = [
      {
        id: 1,
        source: "simkl",
        media_type: "episode",
        category: "anime",
        title: "Episode 3",
        parent_title: "Synthetic Sky Chronicles",
        season: 1,
        episode: 3,
        started_at: "2026-10-17T19:00:00.000Z",
        local_time: "21:00",
        duration_seconds: 1440,
        cover_url: "/api/meta-cover/anilist/999",
      },
      {
        id: 2,
        source: "simkl",
        media_type: "episode",
        category: "anime",
        title: "Episode 4",
        parent_title: "Synthetic Sky Chronicles",
        season: 1,
        episode: 4,
        started_at: "2026-10-17T19:30:00.000Z",
        local_time: "21:30",
        duration_seconds: 1440,
        cover_url: "/api/meta-cover/anilist/999",
      },
    ];

    const allDayItems = [...animeItems, ...ytItems, ...musicItems];
    const day: CalendarDay = {
      date: "2026-10-17",
      count: allDayItems.length,
      minutes: 48 + 160 + 45,
      items: allDayItems,
    };

    // 1. Calendar cell lines: never floods with 40 video titles!
    const cellLines = buildCalmCellLines(allDayItems, 2);
    expect(cellLines.lines).toHaveLength(2);
    expect(cellLines.lines[0]?.label).toBe("Synthetic Sky Chronicles");
    expect(cellLines.lines[1]?.label).toBe("YouTube");
    expect(cellLines.overflowCount).toBe(1); // Music is the +1 overflow

    // 2. Day Detail Panel: 1 work row + 1 collapsed YouTube group + 1 collapsed Music group
    const detail = buildHomeDayDetailModel({
      date: "2026-10-17",
      todayStr: "2026-10-18",
      day,
    });

    expect(detail.heading).toBe("Yesterday");
    expect(detail.works).toHaveLength(1);
    expect(detail.works[0]?.title).toBe("Synthetic Sky Chronicles");
    expect(detail.works[0]?.subtitle).toBe("S01E03–E04 · 2 episodes");
    expect(detail.works[0]?.coverUrl).toBe("/api/meta-cover/anilist/999");
    expect(detail.works[0]?.canRate).toBe(true);

    expect(detail.youtube).not.toBeNull();
    expect(detail.youtube?.count).toBe(40);
    expect(detail.youtube?.totalMinutes).toBe(160);
    expect(detail.youtube?.summaryLabel).toBe("40 videos · 2h 40m");
    expect(detail.youtube?.channels).toHaveLength(4);
    expect(detail.youtube?.channelsPreview).toContain("Synthetic Channel 1");

    expect(detail.music).not.toBeNull();
    expect(detail.music?.count).toBe(15);
    expect(detail.music?.totalMinutes).toBe(45);
    expect(detail.music?.collapsedByDefault).toBe(true);
    expect(detail.music?.summaryLabel).toBe("15 plays · 45m");
  });

  test("builds 7-day week graph across a month boundary", () => {
    const sepDays: CalendarDay[] = [
      {
        date: "2026-09-29",
        count: 1,
        minutes: 60,
        items: [
          {
            id: 1,
            source: "audiobookshelf",
            media_type: "audiobook",
            category: "audiobook",
            title: "Synthetic Audiobook",
            parent_title: "Synthetic Author",
            season: null,
            episode: null,
            started_at: "2026-09-29T10:00:00.000Z",
            local_time: "12:00",
            duration_seconds: 3600,
            cover_url: null,
          },
        ],
      },
    ];
    const octDays: CalendarDay[] = [
      {
        date: "2026-10-01",
        count: 1,
        minutes: 90,
        items: [
          {
            id: 2,
            source: "simkl",
            media_type: "movie",
            category: "film",
            title: "Synthetic Film",
            parent_title: null,
            season: null,
            episode: null,
            started_at: "2026-10-01T18:00:00.000Z",
            local_time: "20:00",
            duration_seconds: 5400,
            cover_url: null,
          },
        ],
      },
    ];

    const merged = mergeCalendarMonthDays([octDays, sepDays]);
    const week = buildWeekGraphModel(
      merged,
      "2026-10-01",
      "2026-10-01",
      "2026-10"
    );

    expect(week.isCurrentWeek).toBe(true);
    expect(week.todayMinutes).toBe(90);
    expect(week.weekMinutes).toBe(150);
    expect(week.activeDays).toBe(2);
    expect(week.days).toHaveLength(7);
    expect(week.days[1]?.date).toBe("2026-09-29");
    expect(week.days[1]?.totalMinutes).toBe(60);
    expect(week.days[3]?.date).toBe("2026-10-01");
    expect(week.days[3]?.isSelected).toBe(true);
  });

  test("builds 'In the middle of' shelf with v2.2 progress and hides ratings for music", () => {
    const libraryWorks: LibraryWork[] = [
      {
        key: "series:synthetic-vikings",
        category: "series",
        title: "Synthetic Northern Kings",
        cover_url: "/api/meta-cover/tvmaze/29",
        total_minutes: 1200,
        units: 20,
        first_at: "2026-10-01T10:00:00.000Z",
        last_at: "2026-10-18T10:00:00.000Z",
        status: "in_progress",
        rating: 8.5,
        sources: ["manual"],
        edited: false,
        channel: null,
        topic: null,
        progress: {
          seasons_watched: 2,
          seasons_total: 6,
          episodes_watched: 20,
          episodes_total: 89,
        },
        creator: "Synthetic Studio",
      },
      {
        key: "audiobook:synthetic-dune",
        category: "audiobook",
        title: "Synthetic Desert Planet",
        cover_url: null,
        total_minutes: 420,
        units: 7,
        first_at: "2026-10-05T10:00:00.000Z",
        last_at: "2026-10-17T10:00:00.000Z",
        status: "in_progress",
        rating: null,
        sources: ["audiobookshelf"],
        edited: false,
        channel: null,
        topic: null,
        progress: null,
        creator: "Synthetic Novelist",
      },
      {
        key: "music:synthetic-album",
        category: "music",
        title: "Synthetic Symphony",
        cover_url: null,
        total_minutes: 50,
        units: 10,
        first_at: "2026-10-10T10:00:00.000Z",
        last_at: "2026-10-16T10:00:00.000Z",
        status: "in_progress",
        rating: null,
        sources: ["manual"],
        edited: false,
        channel: null,
        topic: null,
        progress: null,
        creator: "Synthetic Composer",
      },
      {
        key: "youtube:vid-1",
        category: "youtube",
        title: "Short Video",
        cover_url: null,
        total_minutes: 12,
        units: 1,
        first_at: "2026-10-18T10:00:00.000Z",
        last_at: "2026-10-18T10:00:00.000Z",
        status: "in_progress",
        rating: null,
        sources: ["youtube"],
        edited: false,
        channel: "Synthetic Channel",
        topic: null,
        progress: null,
        creator: "Synthetic Channel",
      },
    ];

    const progressItems: ProgressItem[] = [
      {
        id: 1,
        source: "audiobookshelf",
        title: "Synthetic Desert Planet",
        parent_title: "Synthetic Novelist",
        progress: 0.65,
        is_finished: false,
        last_update: "2026-10-17T10:00:00.000Z",
        finished_at: null,
        cover_url: null,
        rating: null,
        group_title: "Synthetic Desert Planet",
      },
    ];

    const shelf = buildInProgressShelf(libraryWorks, [], progressItems);
    // YouTube videos and music tracks are left out of the shelf; series and audiobook remain
    expect(shelf).toHaveLength(2);

    expect(shelf[0]?.title).toBe("Synthetic Northern Kings");
    expect(shelf[0]?.progressLabel).toBe("2 of 6 seasons · 20 of 89 ep");
    expect(shelf[0]?.progressPercent).toBe(22);
    expect(shelf[0]?.canRate).toBe(true);

    expect(shelf[1]?.title).toBe("Synthetic Desert Planet");
    expect(shelf[1]?.progressLabel).toBe("65% · 7h");
    expect(shelf[1]?.progressPercent).toBe(65);
    expect(shelf[1]?.coverUrl).toBeNull();

    expect(shelf.some((w) => w.title === "Synthetic Symphony")).toBe(false);
  });

  test("enriches day items with LibraryWork and ArchiveEntrySummary lookups and chip totals", () => {
    const works: LibraryWork[] = [
      {
        key: "book:synthetic-book",
        category: "book",
        title: "Synthetic Architecture",
        cover_url: "/api/meta-cover/openlibrary/OL1",
        total_minutes: 300,
        units: 1,
        first_at: "2026-10-17T12:00:00.000Z",
        last_at: "2026-10-17T12:00:00.000Z",
        status: "finished",
        rating: 9.0,
        sources: ["manual"],
        edited: false,
        channel: null,
        topic: null,
        progress: null,
        creator: "Synthetic Author",
      },
    ];
    const archives: ArchiveEntrySummary[] = [
      {
        entry_id: "arch-1",
        category: "book",
        title: "Synthetic Architecture",
        cover_url: "/api/meta-cover/openlibrary/OL1",
        when: { precision: "day", date: "2026-10-17" },
        consumed: { progress: 1 },
        total_minutes: 300,
        created_at: "2026-10-17T12:00:00.000Z",
        updated_at: "2026-10-17T12:00:00.000Z",
      },
    ];

    const libLookup = buildLibraryWorkLookup(works);
    const archLookup = buildArchiveEntryLookup(archives);

    const rawDays: CalendarDay[] = [
      {
        date: "2026-10-17",
        count: 1,
        minutes: 300,
        items: [
          {
            id: 50,
            source: "manual",
            media_type: "book",
            category: "book",
            title: "Synthetic Architecture",
            parent_title: null,
            season: null,
            episode: null,
            started_at: "2026-10-17T10:00:00.000Z",
            local_time: "12:00",
            duration_seconds: 18000,
            cover_url: null,
          },
        ],
      },
    ];

    const enriched = filterAndEnrichCalendarDays(rawDays, [], libLookup);
    const detail = buildHomeDayDetailModel({
      date: "2026-10-17",
      todayStr: "2026-10-18",
      day: enriched[0],
      libraryLookup: libLookup,
      archiveLookup: archLookup,
    });

    expect(detail.works[0]?.workKey).toBe("book:synthetic-book");
    expect(detail.works[0]?.entryId).toBe("arch-1");
    expect(detail.works[0]?.coverUrl).toBe("/api/meta-cover/openlibrary/OL1");
    expect(detail.works[0]?.rating).toBe(9.0);
    expect(detail.works[0]?.subtitle).toBe("Synthetic Author");

    const { rhythm } = buildMonthModels({
      month: "2026-10",
      days: enriched,
      selectedDate: "2026-10-17",
      todayStr: "2026-10-18",
      previousMonthMinutes: 200,
    });
    expect(rhythm.deltaLabel).toBe("+1.7h vs last month");

    const chipTotals = buildHomeCategoryChipTotals(rhythm.categoryShares, [
      { category: "anime", total_minutes: 500, works: 3, units: 24 },
    ]);
    expect(chipTotals.map((c) => c.category)).toEqual(["anime", "book"]);
  });

  test("fetchHomePageBundle fetches required months and library with mocked fetch", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.startsWith("/api/calendar?month=2026-10")) {
        return new Response(
          JSON.stringify({
            month: "2026-10",
            days: [{ date: "2026-10-01", count: 1, minutes: 45, items: [] }],
          }),
          { status: 200 }
        );
      }
      if (url.startsWith("/api/calendar?month=2026-09")) {
        return new Response(
          JSON.stringify({
            month: "2026-09",
            days: [{ date: "2026-09-29", count: 1, minutes: 30, items: [] }],
          }),
          { status: 200 }
        );
      }
      if (url.startsWith("/api/library")) {
        return new Response(
          JSON.stringify({ categories: [], works: [], total_minutes: 0 }),
          { status: 200 }
        );
      }
      if (url.startsWith("/api/progress")) {
        return new Response(
          JSON.stringify({ in_progress: [], finished: [] }),
          { status: 200 }
        );
      }
      if (url.startsWith("/api/series")) {
        return new Response(JSON.stringify({ bucket: "day", from: "2026-07-31", to: "2026-10-01", history_start: "2026-09-29", points: [] }));
      }
      if (url.startsWith("/api/archive")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.startsWith("/api/review/month")) {
        return new Response(
          JSON.stringify({
            month: "2026-10",
            total_minutes: 45,
            previous_month_minutes: 30,
            categories: [],
            days: [],
            hour_weekday: [],
            top_works: [],
            started_works: [],
            finished_works: [],
            active_days: 1,
            longest_streak_days: 1,
            undated_minutes: 0,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as typeof fetch;

    // 2026-10-01 is Thursday -> week spans 2026-09 and 2026-10
    const bundle = await fetchHomePageBundle("2026-10", "2026-10-01");
    expect(bundle.days.map((d) => d.date)).toEqual([
      "2026-09-29",
      "2026-10-01",
    ]);
    expect(calledUrls.some((u) => u.includes("month=2026-10"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("month=2026-09"))).toBe(true);
  });

  test("formatHomeWorkProgress covers season/episode combinations", () => {
    const baseWork: LibraryWork = {
      key: "anime:test",
      category: "anime",
      title: "Synthetic Anime",
      cover_url: null,
      total_minutes: 288,
      units: 12,
      first_at: null,
      last_at: null,
      status: "in_progress",
      rating: null,
      sources: ["manual"],
      edited: false,
      channel: null,
      topic: null,
      progress: {
        seasons_watched: 1,
        seasons_total: null,
        episodes_watched: 12,
        episodes_total: null,
      },
      creator: null,
    };

    expect(formatHomeWorkProgress(baseWork)).toEqual({
      label: "1 season · 12 ep",
      percent: null,
    });
  });
});
