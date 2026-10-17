import { describe, expect, test } from "bun:test";
import {
  computeYearReview,
  type YearReview,
} from "../src/server/year-review.ts";
import type { ConsumptionEvent } from "../src/server/aggregate.ts";

const TZ = "Europe/Bratislava";

let nextId = 1;

interface EvOptions {
  source?: string;
  source_kind?: string;
  media_type?: string;
  title?: string | null;
  parent_title?: string | null;
  season?: number | null;
  episode?: number | null;
  duration_seconds?: number | null;
  external_ids?: Record<string, unknown> | null;
}

/** Synthetic consumption event (fake titles only). */
function ev(started_at: string, opts: EvOptions = {}): ConsumptionEvent {
  return {
    id: nextId++,
    source: opts.source ?? "manual",
    source_kind: opts.source_kind ?? "history_item",
    media_type: opts.media_type ?? "movie",
    title: opts.title !== undefined ? opts.title : "Fake Movie",
    parent_title: opts.parent_title ?? null,
    season: opts.season ?? null,
    episode: opts.episode ?? null,
    duration_seconds: opts.duration_seconds ?? null,
    external_ids: opts.external_ids ?? null,
    started_at,
  };
}

describe("computeYearReview local-year boundaries", () => {
  test("2025-12-31T23:30Z counts for 2026, 2026-12-31T23:30Z does not", () => {
    const events = [
      ev("2025-12-31T23:30:00.000Z", {
        title: "New Year Eve Movie",
        duration_seconds: 1800,
      }),
      ev("2026-12-31T23:30:00.000Z", {
        title: "Next New Year Movie",
        duration_seconds: 600,
      }),
    ];
    // `today` in 2027 so neither year is partial.
    const review = computeYearReview(events, TZ, 2026, "2027-06-01");

    expect(review.totals.items).toBe(1);
    expect(review.totals.minutes).toBe(30);
    expect(review.totals.active_days).toBe(1);
    // Both local years exist across the whole set, newest first.
    expect(review.available_years).toEqual([2027, 2026]);
  });
});

describe("computeYearReview buckets", () => {
  test("by_month always has 12 entries, zeros filled", () => {
    const events = [
      ev("2026-10-17T12:00:00.000Z", { duration_seconds: 3600 }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");

    expect(review.by_month).toHaveLength(12);
    expect(review.by_month[0]).toEqual({ month: "2026-01", minutes: 0, count: 0 });
    expect(review.by_month[9]).toEqual({ month: "2026-10", minutes: 60, count: 1 });
    expect(review.by_month[11]).toEqual({ month: "2026-12", minutes: 0, count: 0 });
  });

  test("by_weekday always has 7 entries with Monday = 1 (2026-10-17 is a Saturday)", () => {
    const events = [
      ev("2026-10-17T12:00:00.000Z", { duration_seconds: 3600 }),
      ev("2026-10-12T12:00:00.000Z", { duration_seconds: 600 }), // Monday
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");

    expect(review.by_weekday).toHaveLength(7);
    expect(review.by_weekday.map((w) => w.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(review.by_weekday[0]).toEqual({ weekday: 1, minutes: 10, count: 1 });
    expect(review.by_weekday[5]).toEqual({ weekday: 6, minutes: 60, count: 1 });
    expect(review.by_weekday[6]).toEqual({ weekday: 7, minutes: 0, count: 0 });
  });
});

describe("computeYearReview totals", () => {
  test("items, minutes, active days, distinct titles, by_source, by_media_type", () => {
    const events = [
      ev("2026-03-01T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        duration_seconds: 3600,
      }),
      ev("2026-03-02T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        duration_seconds: 1800,
      }),
      ev("2026-03-03T12:00:00.000Z", {
        source: "youtube",
        source_kind: "watch",
        media_type: "video",
        title: "Fake Video",
        parent_title: "Fake Channel",
      }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");

    // The two sessions merge into one title; the YouTube row adds 0 minutes
    // but still 1 item.
    expect(review.totals).toEqual({
      items: 3,
      minutes: 90,
      active_days: 3,
      titles: 2,
    });
    expect(review.by_source["audiobookshelf"]).toEqual({
      items: 2,
      minutes: 90,
      active_days: 2,
      titles: 1,
    });
    expect(review.by_source["youtube"]).toEqual({
      items: 1,
      minutes: 0,
      active_days: 1,
      titles: 1,
    });
    expect(review.by_media_type).toEqual({
      audiobook: { items: 2, minutes: 90 },
      video: { items: 1, minutes: 0 },
    });
  });

  test("episodes merge under their series title for the distinct count", () => {
    const events = [
      ev("2026-01-01T12:00:00.000Z", {
        source: "simkl",
        source_kind: "watch",
        media_type: "episode",
        title: "Episode 1",
        parent_title: "Fake Series",
        season: 1,
        episode: 1,
        duration_seconds: 1500,
      }),
      ev("2026-01-02T12:00:00.000Z", {
        source: "simkl",
        source_kind: "watch",
        media_type: "episode",
        title: "Episode 2",
        parent_title: "Fake Series",
        season: 1,
        episode: 2,
        duration_seconds: 1500,
      }),
      ev("2026-01-03T12:00:00.000Z", { title: "Fake Movie", duration_seconds: 600 }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");
    expect(review.totals.items).toBe(3);
    expect(review.totals.titles).toBe(2); // Fake Series + Fake Movie
  });

  test("non-consumption kinds never count", () => {
    const events = [
      ev("2026-05-01T12:00:00.000Z", {
        source_kind: "media_progress",
        media_type: "audiobook",
        title: "Fake Progress Row",
        duration_seconds: 600,
      }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");
    expect(review.totals.items).toBe(0);
    expect(review.available_years).toEqual([]);
  });
});

describe("computeYearReview top lists", () => {
  test("top_titles: minutes desc, then count desc, then title asc", () => {
    const events = [
      ev("2026-01-01T10:00:00.000Z", { title: "Alpha", duration_seconds: 3600 }),
      ev("2026-01-02T10:00:00.000Z", { title: "Bravo", duration_seconds: 1800 }),
      ev("2026-01-03T10:00:00.000Z", { title: "Charlie", duration_seconds: 900 }),
      ev("2026-01-04T10:00:00.000Z", { title: "Charlie", duration_seconds: 900 }),
      // Same minutes and count as Delta: title asc puts Delta first.
      ev("2026-01-05T10:00:00.000Z", { title: "Echo", duration_seconds: 900 }),
      ev("2026-01-06T10:00:00.000Z", { title: "Delta", duration_seconds: 900 }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");
    expect(review.top_titles.map((t) => t.title)).toEqual([
      "Alpha", // 60 min
      "Charlie", // 30 min, 2 entries
      "Bravo", // 30 min, 1 entry
      "Delta", // 15 min, ties broken by title
      "Echo",
    ]);
  });

  test("top_titles caps at 10", () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      ev(`2026-02-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`, {
        title: `Fake Title ${String(i).padStart(2, "0")}`,
        duration_seconds: (100 - i) * 60,
      })
    );
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");
    expect(review.top_titles).toHaveLength(10);
    expect(review.top_titles[0]?.title).toBe("Fake Title 00");
    expect(review.top_titles[9]?.title).toBe("Fake Title 09");
  });

  test("top_titles carries covers", () => {
    const events = [
      ev("2026-04-01T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        duration_seconds: 600,
        external_ids: { abs_item: "fakeAbsItem123" },
      }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");
    expect(review.top_titles).toHaveLength(1);
    expect(review.top_titles[0]?.cover_url).toBe("/api/cover/fakeAbsItem123");
    expect(review.top_titles[0]?.media_type).toBe("audiobook");
  });

  test("top_channels: YouTube only, skips null channels, count desc then name asc, cap 10", () => {
    const yt = (day: number, parent: string | null) =>
      ev(`2026-06-${String(day).padStart(2, "0")}T12:00:00.000Z`, {
        source: "youtube",
        source_kind: "watch",
        media_type: "video",
        title: `Fake Video ${day}`,
        parent_title: parent,
      });
    const events = [
      yt(1, "Alpha Channel"),
      yt(2, "Alpha Channel"),
      yt(3, "Alpha Channel"),
      yt(4, "Beta Channel"),
      yt(5, "Beta Channel"),
      yt(6, null), // no parent_title: never grouped
      yt(7, "  "), // blank parent_title: skipped too
      // 12 one-off channels to exercise the cap.
      ...Array.from({ length: 12 }, (_, i) => yt(10 + i, `Channel ${String(i).padStart(2, "0")}`)),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");

    expect(review.top_channels).toHaveLength(10);
    expect(review.top_channels[0]).toEqual({ name: "Alpha Channel", count: 3 });
    expect(review.top_channels[1]).toEqual({ name: "Beta Channel", count: 2 });
    // The remaining slots are the one-off channels in name order.
    expect(review.top_channels[2]).toEqual({ name: "Channel 00", count: 1 });
    expect(review.top_channels.map((c) => c.name)).not.toContain(null);
  });
});

describe("computeYearReview highlights", () => {
  test("busiest_day and busiest_month break ties by earliest", () => {
    const events = [
      ev("2026-05-10T12:00:00.000Z", { title: "A", duration_seconds: 600 }),
      ev("2026-08-20T12:00:00.000Z", { title: "B", duration_seconds: 600 }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");
    expect(review.busiest_day).toEqual({
      date: "2026-05-10",
      minutes: 10,
      count: 1,
    });
    expect(review.busiest_month).toEqual({
      month: "2026-05",
      minutes: 10,
      count: 1,
    });
  });

  test("busiest_day is chosen by minutes first, then count", () => {
    const events = [
      // Two entries, 5 minutes total.
      ev("2026-05-10T12:00:00.000Z", { title: "A", duration_seconds: 180 }),
      ev("2026-05-10T13:00:00.000Z", { title: "B", duration_seconds: 120 }),
      // One entry, 20 minutes: wins on minutes despite fewer entries.
      ev("2026-05-11T12:00:00.000Z", { title: "C", duration_seconds: 1200 }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");
    expect(review.busiest_day?.date).toBe("2026-05-11");
    expect(review.busiest_day?.minutes).toBe(20);
    expect(review.busiest_day?.count).toBe(1);
  });

  test("longest_streak only counts days inside the year", () => {
    const events = [
      ev("2025-12-30T12:00:00.000Z", { title: "End of 2025", duration_seconds: 600 }),
      ev("2025-12-31T12:00:00.000Z", { title: "New Year Eve", duration_seconds: 600 }),
      ev("2026-01-01T12:00:00.000Z", { title: "New Year", duration_seconds: 600 }),
      ev("2026-01-02T12:00:00.000Z", { title: "Still January", duration_seconds: 600 }),
    ];
    // Together the run is 4 days, but each year sees only its own half.
    const review2026 = computeYearReview(events, TZ, 2026, "2026-06-01");
    expect(review2026.longest_streak).toEqual({
      days: 2,
      start: "2026-01-01",
      end: "2026-01-02",
    });
    const review2025 = computeYearReview(events, TZ, 2025, "2026-06-01");
    expect(review2025.longest_streak).toEqual({
      days: 2,
      start: "2025-12-30",
      end: "2025-12-31",
    });
  });

  test("first and last events of the year (series titles via getSeriesOrTitle)", () => {
    const events = [
      ev("2026-03-05T12:00:00.000Z", { title: "Middle Movie", duration_seconds: 600 }),
      ev("2026-01-02T12:00:00.000Z", { title: "First Movie", duration_seconds: 600 }),
      ev("2026-06-01T12:00:00.000Z", { title: "Last Movie", duration_seconds: 600 }),
      // Earliest of the year: an episode shows under its series title.
      ev("2026-01-01T10:00:00.000Z", {
        source: "simkl",
        source_kind: "watch",
        media_type: "episode",
        title: "Episode 1",
        parent_title: "Fake Series",
        season: 1,
        episode: 1,
        duration_seconds: 1500,
      }),
    ];
    const review = computeYearReview(events, TZ, 2026, "2027-01-01");
    expect(review.first?.title).toBe("Fake Series");
    expect(review.first?.source).toBe("simkl");
    expect(review.first?.started_at).toBe("2026-01-01T10:00:00.000Z");
    expect(review.last?.title).toBe("Last Movie");
    expect(review.last?.started_at).toBe("2026-06-01T12:00:00.000Z");
  });
});

describe("computeYearReview previous and available_years", () => {
  test("previous is null when the year before has no events, else totals", () => {
    const only2025 = [ev("2025-06-01T12:00:00.000Z", { duration_seconds: 600 })];
    // Requested year 2025: the year before (2024) has no events.
    const review = computeYearReview(only2025, TZ, 2025, "2026-10-17");
    expect(review.previous).toBeNull();
    expect(review.available_years).toEqual([2025]);

    const both = [
      ...only2025,
      ev("2026-01-05T12:00:00.000Z", { duration_seconds: 1200 }),
    ];
    // Requested year 2026: 2025 has events, so previous is filled.
    const review2 = computeYearReview(both, TZ, 2026, "2026-10-17");
    expect(review2.previous).toEqual({
      items: 1,
      minutes: 10,
      active_days: 1,
      titles: 1,
    });
    expect(review2.available_years).toEqual([2026, 2025]);
  });
});

describe("computeYearReview partial, days_in_range and empty years", () => {
  test("current year runs Jan 1..today (290 days for 2026-10-17)", () => {
    const review = computeYearReview([], TZ, 2026, "2026-10-17");
    expect(review.partial).toBe(true);
    expect(review.days_in_range).toBe(290);
  });

  test("past leap year 366, past normal year 365", () => {
    expect(computeYearReview([], TZ, 2024, "2026-10-17").days_in_range).toBe(366);
    expect(computeYearReview([], TZ, 2025, "2026-10-17").days_in_range).toBe(365);
    expect(computeYearReview([], TZ, 2024, "2026-10-17").partial).toBe(false);
  });

  test("future year: empty result, partial false, days_in_range 0", () => {
    // Even if a future-dated row existed, the future year stays empty.
    const events = [
      ev("2027-05-01T12:00:00.000Z", { title: "Future Movie", duration_seconds: 600 }),
    ];
    const review: YearReview = computeYearReview(events, TZ, 2027, "2026-10-17");
    expect(review.partial).toBe(false);
    expect(review.days_in_range).toBe(0);
    expect(review.totals).toEqual({
      items: 0,
      minutes: 0,
      active_days: 0,
      titles: 0,
    });
    expect(review.top_titles).toEqual([]);
    expect(review.top_channels).toEqual([]);
    expect(review.busiest_day).toBeNull();
    expect(review.busiest_month).toBeNull();
    expect(review.longest_streak).toEqual({ days: 0, start: null, end: null });
    expect(review.first).toBeNull();
    expect(review.last).toBeNull();
    // available_years still reflects all events, and the year before (2026)
    // is empty too.
    expect(review.available_years).toEqual([2027]);
    expect(review.previous).toBeNull();
  });

  test("empty requested year returns zeros without throwing", () => {
    const review = computeYearReview([], TZ, 1999, "2026-10-17");
    expect(review.year).toBe(1999);
    expect(review.partial).toBe(false);
    expect(review.days_in_range).toBe(365);
    expect(review.totals).toEqual({
      items: 0,
      minutes: 0,
      active_days: 0,
      titles: 0,
    });
    expect(review.by_month).toHaveLength(12);
    expect(review.by_weekday).toHaveLength(7);
    expect(review.by_source).toEqual({});
    expect(review.by_media_type).toEqual({});
    expect(review.previous).toBeNull();
  });
});
