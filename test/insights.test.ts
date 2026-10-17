import { describe, expect, test } from "bun:test";
import {
  computeOnThisDay,
  computeStreaks,
  ON_THIS_DAY_MAX_PER_YEAR,
  type OnThisDayResult,
  type StreaksResult,
} from "../src/server/insights.ts";
import { getSeriesOrTitle, type ConsumptionEvent } from "../src/server/aggregate.ts";

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
    external_ids: opts.external_ids ?? null,
    started_at,
  };
}

describe("computeStreaks day boundaries", () => {
  test("an event at 23:30Z in summer belongs to the next local day", () => {
    // Europe/Bratislava is UTC+2 in July: 23:30Z -> 01:30 next day local.
    const events = [ev("2026-07-15T23:30:00.000Z")];
    const res = computeStreaks(events, TZ, "2026-07-16");

    expect(res.overall.current).toBe(1);
    expect(res.overall.longest).toBe(1);
    expect(res.overall.longest_start).toBe("2026-07-16");
    expect(res.overall.longest_end).toBe("2026-07-16");
    expect(res.overall.last_active).toBe("2026-07-16");

    // The previous UTC day has no local activity on 2026-07-15.
    const prev = computeStreaks(events, TZ, "2026-07-15");
    expect(prev.overall.current).toBe(0);
  });

  test("DST spring forward (last Sunday of March) does not break a streak", () => {
    // 2026-03-29 is the spring-forward day (02:00 CET -> 03:00 CEST).
    // Local noons map to shifting UTC hours across the change.
    const events = [
      ev("2026-03-28T11:00:00.000Z"), // Sat 28.03. 12:00 local (CET)
      ev("2026-03-29T10:00:00.000Z"), // Sun 29.03. 12:00 local (CEST)
      ev("2026-03-30T10:00:00.000Z"), // Mon 30.03. 12:00 local (CEST)
      ev("2026-03-31T10:00:00.000Z"), // Tue 31.03. 12:00 local (CEST)
    ];
    const res = computeStreaks(events, TZ, "2026-03-31");

    expect(res.overall.current).toBe(4);
    expect(res.overall.longest).toBe(4);
    expect(res.overall.longest_start).toBe("2026-03-28");
    expect(res.overall.longest_end).toBe("2026-03-31");
  });

  test("DST fall back (last Sunday of October) does not break a streak", () => {
    // 2026-10-25 is the fall-back day (03:00 CEST -> 02:00 CET).
    const events = [
      ev("2026-10-24T10:00:00.000Z"), // Sat 24.10. 12:00 local (CEST)
      ev("2026-10-25T11:00:00.000Z"), // Sun 25.10. 12:00 local (CET)
      ev("2026-10-26T11:00:00.000Z"), // Mon 26.10. 12:00 local (CET)
    ];
    const res = computeStreaks(events, TZ, "2026-10-26");

    expect(res.overall.current).toBe(3);
    expect(res.overall.longest).toBe(3);
    expect(res.overall.longest_start).toBe("2026-10-24");
    expect(res.overall.longest_end).toBe("2026-10-26");
  });
});

describe("computeStreaks current streak", () => {
  test("stays alive via yesterday when today has no event yet", () => {
    // Today empty, yesterday and the day before active -> counts back from yesterday.
    const events = [
      ev("2026-10-15T12:00:00.000Z"),
      ev("2026-10-16T12:00:00.000Z"),
    ];
    const res = computeStreaks(events, TZ, "2026-10-17");
    expect(res.overall.current).toBe(2);
    expect(res.overall.last_active).toBe("2026-10-16");
  });

  test("today's event counts, not just yesterday", () => {
    const events = [
      ev("2026-10-15T12:00:00.000Z"),
      ev("2026-10-16T12:00:00.000Z"),
      ev("2026-10-17T12:00:00.000Z"),
    ];
    const res = computeStreaks(events, TZ, "2026-10-17");
    expect(res.overall.current).toBe(3);
  });

  test("is dead after a gap", () => {
    // Active Oct 13-14, then a gap; today Oct 17 -> yesterday (16) is empty.
    const events = [
      ev("2026-10-13T12:00:00.000Z"),
      ev("2026-10-14T12:00:00.000Z"),
    ];
    const res = computeStreaks(events, TZ, "2026-10-17");
    expect(res.overall.current).toBe(0);
    // Longest is unaffected.
    expect(res.overall.longest).toBe(2);
    expect(res.overall.longest_start).toBe("2026-10-13");
    expect(res.overall.longest_end).toBe("2026-10-14");
  });

  test("is 0 with no events and longest fields are null", () => {
    const res: StreaksResult = computeStreaks([], TZ, "2026-10-17");
    expect(res.today).toBe("2026-10-17");
    expect(res.overall.current).toBe(0);
    expect(res.overall.longest).toBe(0);
    expect(res.overall.longest_start).toBeNull();
    expect(res.overall.longest_end).toBeNull();
    expect(res.overall.last_active).toBeNull();
    expect(res.by_source).toEqual({});
  });
});

describe("computeStreaks longest streak", () => {
  test("tie goes to the most recent run", () => {
    // Two runs of length 2: Oct 1-2 and Oct 8-9. The later one wins.
    const events = [
      ev("2026-10-01T12:00:00.000Z"),
      ev("2026-10-02T12:00:00.000Z"),
      ev("2026-10-08T12:00:00.000Z"),
      ev("2026-10-09T12:00:00.000Z"),
    ];
    const res = computeStreaks(events, TZ, "2026-10-09");
    expect(res.overall.longest).toBe(2);
    expect(res.overall.longest_start).toBe("2026-10-08");
    expect(res.overall.longest_end).toBe("2026-10-09");
  });

  test("a longer earlier run beats a shorter recent one", () => {
    const events = [
      ev("2026-10-01T12:00:00.000Z"),
      ev("2026-10-02T12:00:00.000Z"),
      ev("2026-10-03T12:00:00.000Z"),
      ev("2026-10-08T12:00:00.000Z"),
      ev("2026-10-09T12:00:00.000Z"),
    ];
    const res = computeStreaks(events, TZ, "2026-10-09");
    expect(res.overall.longest).toBe(3);
    expect(res.overall.longest_start).toBe("2026-10-01");
    expect(res.overall.longest_end).toBe("2026-10-03");
  });

  test("a single event yields a 1-day streak", () => {
    const events = [ev("2026-10-01T12:00:00.000Z")];
    const res = computeStreaks(events, TZ, "2026-10-09");
    expect(res.overall.longest).toBe(1);
    expect(res.overall.longest_start).toBe("2026-10-01");
    expect(res.overall.longest_end).toBe("2026-10-01");
  });
});

describe("computeStreaks per source", () => {
  test("per-source streaks are independent and only present sources appear", () => {
    const events = [
      // audiobookshelf: Oct 15, 16, 17 -> current 3
      ev("2026-10-15T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
      }),
      ev("2026-10-16T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
      }),
      ev("2026-10-17T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
      }),
      // manual: Oct 17 only -> current 1
      ev("2026-10-17T18:00:00.000Z"),
    ];
    const res = computeStreaks(events, TZ, "2026-10-17");

    expect(Object.keys(res.by_source).sort()).toEqual([
      "audiobookshelf",
      "manual",
    ]);
    expect(res.by_source["audiobookshelf"]?.current).toBe(3);
    expect(res.by_source["audiobookshelf"]?.longest).toBe(3);
    expect(res.by_source["manual"]?.current).toBe(1);
    expect(res.by_source["manual"]?.longest).toBe(1);

    // Overall merges both sources' days.
    expect(res.overall.current).toBe(3);
    expect(res.overall.longest).toBe(3);
  });

  test("a source inactive while another is active keeps its own last_active", () => {
    const events = [
      ev("2026-10-01T12:00:00.000Z", { source: "youtube", source_kind: "watch" }),
      ev("2026-10-17T12:00:00.000Z", { source: "manual" }),
    ];
    const res = computeStreaks(events, TZ, "2026-10-17");

    expect(res.by_source["youtube"]?.current).toBe(0);
    expect(res.by_source["youtube"]?.last_active).toBe("2026-10-01");
    expect(res.by_source["manual"]?.current).toBe(1);
    expect(res.by_source["manual"]?.last_active).toBe("2026-10-17");
  });

  test("non-consumption kinds never count", () => {
    const events = [
      ev("2026-10-17T12:00:00.000Z", {
        source_kind: "media_progress",
        media_type: "audiobook",
        title: "Fake Progress Row",
      }),
    ];
    const res = computeStreaks(events, TZ, "2026-10-17");
    expect(res.overall.current).toBe(0);
    expect(res.overall.longest).toBe(0);
    expect(res.overall.longest_start).toBeNull();
    expect(res.overall.last_active).toBeNull();
  });
});

describe("computeOnThisDay", () => {
  test("excludes the current year and orders years newest first", () => {
    const events = [
      ev("2023-10-17T09:00:00.000Z", { title: "Old Movie" }),
      ev("2024-10-17T10:00:00.000Z", { title: "Mid Movie" }),
      ev("2025-10-17T11:00:00.000Z", { title: "New Movie" }),
      ev("2026-10-17T12:00:00.000Z", { title: "Today Movie" }), // current year
      ev("2024-10-18T10:00:00.000Z", { title: "Wrong Day" }), // other day
      ev("2024-11-17T10:00:00.000Z", { title: "Wrong Month" }), // other month
    ];
    const res: OnThisDayResult = computeOnThisDay(events, TZ, "2026-10-17");

    expect(res.date).toBe("2026-10-17");
    expect(res.years.map((y) => y.year)).toEqual([2025, 2024, 2023]);
    expect(res.years.map((y) => y.years_ago)).toEqual([1, 2, 3]);
    expect(res.years[0]?.items[0]?.title).toBe("New Movie");
    expect(res.years[1]?.items[0]?.title).toBe("Mid Movie");
    expect(res.years[2]?.items[0]?.title).toBe("Old Movie");
  });

  test("orders items within a year by started_at ascending", () => {
    const events = [
      ev("2024-10-17T15:00:00.000Z", { title: "Later Session" }),
      ev("2024-10-17T08:00:00.000Z", { title: "Earlier Session" }),
    ];
    const res = computeOnThisDay(events, TZ, "2026-10-17");
    expect(res.years[0]?.items.map((i) => i.title)).toEqual([
      "Earlier Session",
      "Later Session",
    ]);
  });

  test("merges rows with the same title and source into one item", () => {
    const events = [
      // Ten listening sessions of one audiobook on the same local day.
      ...Array.from({ length: 10 }, (_, i) =>
        ev(`2025-10-17T0${i}:00:00.000Z`, {
          source: "audiobookshelf",
          source_kind: "listening_session",
          media_type: "audiobook",
          title: "Fake Book",
        })
      ),
      // A different title does not merge.
      ev("2025-10-17T20:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Other Book",
      }),
      // Same title, different source does not merge.
      ev("2025-10-17T21:00:00.000Z", { title: "Fake Book" }),
    ];
    const res = computeOnThisDay(events, TZ, "2026-10-17");

    expect(res.years).toHaveLength(1);
    const items = res.years[0]!.items;
    expect(items).toHaveLength(3);
    const merged = items.find((i) => i.title === "Fake Book" && i.source === "audiobookshelf");
    expect(merged?.started_at).toBe("2025-10-17T00:00:00.000Z"); // first kept
  });

  test("merges episodes under their series title", () => {
    const events = [
      ev("2024-10-17T10:00:00.000Z", {
        source: "simkl",
        source_kind: "watch",
        media_type: "episode",
        title: "Episode 1",
        parent_title: "Fake Series",
        season: 1,
        episode: 1,
      }),
      ev("2024-10-17T11:00:00.000Z", {
        source: "simkl",
        source_kind: "watch",
        media_type: "episode",
        title: "Episode 2",
        parent_title: "Fake Series",
        season: 1,
        episode: 2,
      }),
    ];
    const res = computeOnThisDay(events, TZ, "2026-10-17");
    expect(res.years[0]?.items).toHaveLength(1);
    expect(res.years[0]?.items[0]?.title).toBe("Fake Series");
  });

  test("caps at 20 items per year", () => {
    const events = Array.from({ length: ON_THIS_DAY_MAX_PER_YEAR + 5 }, (_, i) =>
      ev(`2025-10-17T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24) * 10).padStart(2, "0")}:00.000Z`, {
        title: `Fake Movie ${i}`,
      })
    );
    const res = computeOnThisDay(events, TZ, "2026-10-17");
    expect(res.years[0]?.items).toHaveLength(ON_THIS_DAY_MAX_PER_YEAR);
    // The cap keeps the earliest items (ordered by started_at before slicing).
    expect(res.years[0]?.items[0]?.title).toBe("Fake Movie 0");
  });

  test("leap day: Feb 28 in a non-leap year includes Feb 29 of earlier leap years", () => {
    // 2026 is not a leap year, 2024 is.
    const events = [
      ev("2025-02-28T12:00:00.000Z", { title: "Feb 28 Last Year" }),
      ev("2024-02-29T12:00:00.000Z", { title: "Leap Day Item" }),
      ev("2024-02-28T12:00:00.000Z", { title: "Feb 28 Leap Year" }),
      ev("2023-03-01T12:00:00.000Z", { title: "March Day" }),
    ];
    const res = computeOnThisDay(events, TZ, "2026-02-28");

    const titles = res.years.flatMap((y) => y.items.map((i) => i.title));
    expect(titles).toContain("Feb 28 Last Year");
    expect(titles).toContain("Leap Day Item");
    expect(titles).toContain("Feb 28 Leap Year");
    expect(titles).not.toContain("March Day");
  });

  test("leap day: Feb 29 includes only Feb 29", () => {
    // 2028 is a leap year.
    const events = [
      ev("2024-02-29T12:00:00.000Z", { title: "Leap Day Item" }),
      ev("2027-02-28T12:00:00.000Z", { title: "Feb 28 Last Year" }),
      ev("2027-03-01T12:00:00.000Z", { title: "March Day" }),
    ];
    const res = computeOnThisDay(events, TZ, "2028-02-29");

    const titles = res.years.flatMap((y) => y.items.map((i) => i.title));
    expect(titles).toEqual(["Leap Day Item"]);
  });

  test("non-leap Feb 28 in a leap year does NOT include Feb 29 (rule is about today's year)", () => {
    // Today 2024-02-28 in a leap year: Feb 29 is tomorrow, not "on this day".
    const events = [
      ev("2024-02-29T12:00:00.000Z", { title: "Leap Day Same Year" }),
      ev("2020-02-29T12:00:00.000Z", { title: "Leap Day 2020" }),
      ev("2023-02-28T12:00:00.000Z", { title: "Feb 28 Last Year" }),
    ];
    const res = computeOnThisDay(events, TZ, "2024-02-28");

    const titles = res.years.flatMap((y) => y.items.map((i) => i.title));
    expect(titles).toContain("Feb 28 Last Year");
    expect(titles).not.toContain("Leap Day 2020");
    expect(titles).not.toContain("Leap Day Same Year"); // current year excluded anyway
  });

  test("covers and media types are carried through", () => {
    const events = [
      ev("2025-10-17T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        external_ids: { abs_item: "fakeAbsItem123" },
      }),
      ev("2025-10-17T13:00:00.000Z", { title: "No Cover" }),
    ];
    const res = computeOnThisDay(events, TZ, "2026-10-17");
    expect(res.years[0]?.items[0]?.cover_url).toBe("/api/cover/fakeAbsItem123");
    expect(res.years[0]?.items[0]?.media_type).toBe("audiobook");
    expect(res.years[0]?.items[1]?.cover_url).toBeNull();
  });

  test("empty result when there are no earlier years", () => {
    const res = computeOnThisDay([], TZ, "2026-10-17");
    expect(res.date).toBe("2026-10-17");
    expect(res.years).toEqual([]);
  });

  test("uses getSeriesOrTitle for titles", () => {
    // Sanity: the same helper the server uses everywhere.
    const events = [
      ev("2025-10-17T12:00:00.000Z", {
        media_type: "episode",
        title: "Episode 3",
        parent_title: "Fake Series",
      }),
    ];
    const res = computeOnThisDay(events, TZ, "2026-10-17");
    expect(res.years[0]?.items[0]?.title).toBe(getSeriesOrTitle(events[0]!));
  });
});
