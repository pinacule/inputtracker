import { describe, expect, test } from "bun:test";
import {
  CHANNEL_KEY_PREFIX,
  normalizeForSearch,
  searchEvents,
  titleHistory,
} from "../src/server/search.ts";
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

describe("normalizeForSearch", () => {
  test("lowercase, diacritics, whitespace collapse, trim", () => {
    expect(normalizeForSearch("Šťastný  Deň")).toBe("stastny den");
    expect(normalizeForSearch("  Mixed   CASE ")).toBe("mixed case");
    expect(normalizeForSearch("ÉÀÖ")).toBe("eao");
    expect(normalizeForSearch("")).toBe("");
  });
});

describe("searchEvents grouping", () => {
  test("ten listening sessions of one book are one hit", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      ev(`2026-01-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`, {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        duration_seconds: 600,
      })
    );
    const result = searchEvents(events, TZ, {
      q: "book",
      limit: 30,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.query).toBe("book");
    const hit = result.hits[0]!;
    expect(hit.key).toBe(`audiobookshelf\u0000Fake Book`);
    expect(hit.title).toBe("Fake Book");
    expect(hit.source).toBe("audiobookshelf");
    expect(hit.media_type).toBe("audiobook");
    expect(hit.count).toBe(10);
    expect(hit.minutes).toBe(100);
    expect(hit.matched).toEqual(["title"]);
    expect(hit.first_date).toBe("2026-01-01");
    expect(hit.last_date).toBe("2026-01-10");
    expect(hit.subtitle).toBeNull();
  });

  test("every episode of a show is one hit titled with the series", () => {
    const events = [1, 2, 3].map((e) =>
      ev(`2026-02-0${e}T12:00:00.000Z`, {
        source: "simkl",
        media_type: "episode",
        title: `Episode ${e}`,
        parent_title: "Fake Show",
        season: 1,
        episode: e,
        duration_seconds: 1500,
      })
    );
    const result = searchEvents(events, TZ, { q: "show", limit: 30, offset: 0 });

    expect(result.total).toBe(1);
    const hit = result.hits[0]!;
    expect(hit.title).toBe("Fake Show");
    expect(hit.count).toBe(3);
    expect(hit.minutes).toBe(75);
    // The series name is both the group title and the series field.
    expect(hit.matched).toEqual(["title", "series"]);
    expect(hit.subtitle).toBe("Fake Show");
  });

  test("music events keep parentField -> channel and group by title like videos", () => {
    const events = [
      ev("2026-03-01T12:00:00.000Z", {
        source: "youtube",
        source_kind: "phone_play",
        media_type: "music",
        title: "Fake Song",
        parent_title: "Fake Channel",
      }),
      ev("2026-03-02T12:00:00.000Z", {
        source: "youtube",
        source_kind: "phone_play",
        media_type: "music",
        title: "Fake Song",
        parent_title: "Fake Channel",
      }),
    ];

    const resChannel = searchEvents(events, TZ, { q: "Fake Channel", limit: 30, offset: 0 });
    expect(resChannel.total).toBe(2);
    const songHit = resChannel.hits.find((h) => h.title === "Fake Song");
    expect(songHit).toBeDefined();
    expect(songHit!.matched).toContain("channel");
    expect(songHit!.media_type).toBe("music");
    expect(songHit!.count).toBe(2);

    const resTitle = searchEvents(events, TZ, { q: "Fake Song", limit: 30, offset: 0 });
    expect(resTitle.total).toBe(1);
    expect(resTitle.hits[0]!.title).toBe("Fake Song");
    expect(resTitle.hits[0]!.matched).toContain("title");
  });
});

describe("searchEvents matching", () => {
  test("multi-word AND in any order", () => {
    const events = [ev("2026-03-01T12:00:00.000Z", { title: "Fake Book" })];

    expect(
      searchEvents(events, TZ, { q: "book fake", limit: 30, offset: 0 }).total
    ).toBe(1);
    expect(
      searchEvents(events, TZ, { q: "fake   book", limit: 30, offset: 0 }).total
    ).toBe(1);
    expect(
      searchEvents(events, TZ, { q: "fake missing", limit: 30, offset: 0 }).total
    ).toBe(0);
  });

  test("author (parent) match on a non-series event", () => {
    const events = [
      ev("2026-03-01T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        parent_title: "Fake Author",
      }),
    ];

    const result = searchEvents(events, TZ, {
      q: "author",
      limit: 30,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.hits[0]!.matched).toEqual(["parent"]);
    expect(result.hits[0]!.subtitle).toBe("Fake Author");
  });

  test("words split across fields still match, matched lists both", () => {
    const events = [
      ev("2026-03-01T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        parent_title: "Nice Author",
      }),
    ];

    const result = searchEvents(events, TZ, {
      q: "book nice",
      limit: 30,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.hits[0]!.matched).toEqual(["title", "parent"]);
  });

  test("matched lists fields in canonical order, deduped", () => {
    const events = [
      ev("2026-03-01T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        parent_title: "Fake Author",
      }),
    ];

    // "fake" matches both the title and the author.
    const result = searchEvents(events, TZ, { q: "fake", limit: 30, offset: 0 });
    expect(result.hits[0]!.matched).toEqual(["title", "parent"]);
  });
});

describe("searchEvents youtube", () => {
  function youtubeEvents(): ConsumptionEvent[] {
    return [
      ev("2026-04-01T10:00:00.000Z", {
        source: "youtube",
        source_kind: "watch",
        media_type: "video",
        title: "Video One",
        parent_title: "Fake Channel",
      }),
      ev("2026-04-02T10:00:00.000Z", {
        source: "youtube",
        source_kind: "watch",
        media_type: "video",
        title: "Video Two",
        parent_title: "Fake Channel",
      }),
      ev("2026-04-03T10:00:00.000Z", {
        source: "youtube",
        source_kind: "watch",
        media_type: "video",
        title: "Video Three",
        parent_title: "Fake Channel",
        external_ids: { youtube_video: "abc12345678" },
      }),
    ];
  }

  test("a channel match returns the channel as its own hit over all views", () => {
    const result = searchEvents(youtubeEvents(), TZ, {
      q: "fake channel",
      limit: 30,
      offset: 0,
    });

    // The channel hit plus the three matching video groups.
    expect(result.total).toBe(4);
    // The channel title starts with the query, so it ranks first.
    const channel = result.hits[0]!;
    expect(channel.key).toBe(`${CHANNEL_KEY_PREFIX}Fake Channel`);
    expect(channel.title).toBe("Fake Channel");
    expect(channel.subtitle).toBe("YouTube channel");
    expect(channel.matched).toEqual(["channel"]);
    expect(channel.count).toBe(3);
    expect(channel.minutes).toBe(0);
    expect(channel.media_type).toBe("video");
    expect(channel.first_date).toBe("2026-04-01");
    expect(channel.last_date).toBe("2026-04-03");
    // Cover from the most recent event that has one.
    expect(channel.cover_url).toBe("/api/thumb/youtube/abc12345678");
  });

  test("video groups match via the channel field", () => {
    const result = searchEvents(youtubeEvents(), TZ, {
      q: "fake channel",
      limit: 30,
      offset: 0,
    });
    const videos = result.hits.filter((h) => h.key.startsWith("youtube\u0000"));
    expect(videos).toHaveLength(3);
    for (const video of videos) {
      expect(video.matched).toEqual(["channel"]);
    }
  });

  test("a video title match does not create a channel hit", () => {
    const result = searchEvents(youtubeEvents(), TZ, {
      q: "video two",
      limit: 30,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.hits[0]!.title).toBe("Video Two");
    expect(result.hits[0]!.matched).toEqual(["title"]);
  });
});

describe("searchEvents ranking", () => {
  test("tiers by title prefix/contains, then last_date desc, count desc, title asc", () => {
    const events = [
      ev("2026-01-10T12:00:00.000Z", { title: "Alpha Fake", duration_seconds: 60 }),
      ev("2026-01-09T12:00:00.000Z", { title: "Alpha Fake", duration_seconds: 60 }),
      // Tier 1, last_date 2026-03-01, one event.
      ev("2026-03-01T12:00:00.000Z", { title: "Bravo Fake" }),
      // Tier 1, same last_date and count as Bravo -> title asc.
      ev("2026-03-01T12:00:00.000Z", { title: "Charlie Fake" }),
      // Tier 1, same last_date as Bravo but two events -> count desc wins.
      ev("2026-03-01T12:00:00.000Z", { title: "Echo Fake" }),
      ev("2026-02-01T12:00:00.000Z", { title: "Echo Fake" }),
      // Tier 0: title starts with the query, despite being the oldest.
      ev("2020-01-01T12:00:00.000Z", { title: "Fake One" }),
    ];

    const result = searchEvents(events, TZ, { q: "fake", limit: 30, offset: 0 });
    expect(result.total).toBe(5);
    expect(result.hits.map((h) => h.title)).toEqual([
      "Fake One",
      "Echo Fake",
      "Bravo Fake",
      "Charlie Fake",
      "Alpha Fake",
    ]);
  });
});

describe("searchEvents filters, limit, offset", () => {
  function mixedEvents(): ConsumptionEvent[] {
    return [
      ev("2026-05-01T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
      }),
      ev("2026-05-02T12:00:00.000Z", {
        source: "manual",
        media_type: "movie",
        title: "Fake Movie",
      }),
      ev("2026-05-03T12:00:00.000Z", {
        source: "manual",
        media_type: "book",
        title: "Fake Novel",
      }),
    ];
  }

  test("source filter applies before matching", () => {
    const result = searchEvents(mixedEvents(), TZ, {
      q: "fake",
      source: "manual",
      limit: 30,
      offset: 0,
    });
    expect(result.total).toBe(2);
    expect(result.hits.map((h) => h.title).sort()).toEqual([
      "Fake Movie",
      "Fake Novel",
    ]);
  });

  test("media_type filter applies before matching", () => {
    const result = searchEvents(mixedEvents(), TZ, {
      q: "fake",
      media_type: "audiobook",
      limit: 30,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.hits[0]!.title).toBe("Fake Book");
  });

  test("limit and offset paginate, total counts all hits", () => {
    expect(
      searchEvents(mixedEvents(), TZ, { q: "fake", limit: 2, offset: 0 }).hits
    ).toHaveLength(2);
    const page2 = searchEvents(mixedEvents(), TZ, {
      q: "fake",
      limit: 2,
      offset: 2,
    });
    expect(page2.total).toBe(3);
    expect(page2.hits).toHaveLength(1);
    const beyond = searchEvents(mixedEvents(), TZ, {
      q: "fake",
      limit: 2,
      offset: 10,
    });
    expect(beyond.total).toBe(3);
    expect(beyond.hits).toEqual([]);
  });
});

describe("searchEvents short queries", () => {
  test("empty and 1-character queries return an empty result, not an error", () => {
    const events = [ev("2026-03-01T12:00:00.000Z", { title: "Fake Book" })];
    for (const q of ["", "a", "   "]) {
      const result = searchEvents(events, TZ, { q, limit: 30, offset: 0 });
      expect(result).toEqual({ query: q, total: 0, hits: [] });
    }
  });
});

describe("searchEvents local dates", () => {
  test("23:30Z in summer is the next local day in Europe/Bratislava", () => {
    const events = [
      ev("2026-07-15T23:30:00.000Z", { title: "Fake Late Movie" }),
    ];
    const result = searchEvents(events, TZ, {
      q: "late",
      limit: 30,
      offset: 0,
    });
    expect(result.hits[0]!.first_date).toBe("2026-07-16");
    expect(result.hits[0]!.last_date).toBe("2026-07-16");
  });
});

describe("titleHistory", () => {
  test("items newest first with local date/time and minutes", () => {
    const events = [
      ev("2026-06-01T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        parent_title: "Fake Author",
        duration_seconds: 600,
      }),
      ev("2026-06-03T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        parent_title: "Fake Author",
        duration_seconds: 1200,
      }),
      ev("2026-06-02T12:00:00.000Z", {
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Fake Book",
        parent_title: "Fake Author",
        duration_seconds: 300,
      }),
    ];

    const history = titleHistory(events, TZ, `audiobookshelf\u0000Fake Book`);
    expect(history).not.toBeNull();
    expect(history!.key).toBe(`audiobookshelf\u0000Fake Book`);
    expect(history!.title).toBe("Fake Book");
    expect(history!.source).toBe("audiobookshelf");
    expect(history!.subtitle).toBe("Fake Author");
    expect(history!.count).toBe(3);
    expect(history!.minutes).toBe(35);
    expect(history!.items.map((i) => i.started_at)).toEqual([
      "2026-06-03T12:00:00.000Z",
      "2026-06-02T12:00:00.000Z",
      "2026-06-01T12:00:00.000Z",
    ]);
    expect(history!.items[0]).toEqual({
      id: events[1]!.id,
      started_at: "2026-06-03T12:00:00.000Z",
      local_date: "2026-06-03",
      local_time: "14:00",
      media_type: "audiobook",
      season: null,
      episode: null,
      minutes: 20,
      event_title: "Fake Book",
    });
  });

  test("items are capped at 500 while count/minutes cover all events", () => {
    const events = Array.from({ length: 600 }, () =>
      ev("2026-01-01T12:00:00.000Z", {
        source: "manual",
        media_type: "movie",
        title: "Fake Many",
        duration_seconds: 60,
      })
    );
    const history = titleHistory(events, TZ, `manual\u0000Fake Many`);
    expect(history).not.toBeNull();
    expect(history!.items).toHaveLength(500);
    expect(history!.count).toBe(600);
    expect(history!.minutes).toBe(600);
    // Same timestamp for all: newest-first falls back to the highest id.
    expect(history!.items[0]!.id).toBe(events[599]!.id);
  });

  test("youtube channel key lists the channel's views with video titles", () => {
    const events = [
      ev("2026-04-01T10:00:00.000Z", {
        source: "youtube",
        source_kind: "watch",
        media_type: "video",
        title: "Video One",
        parent_title: "Fake Channel",
      }),
      ev("2026-04-02T10:00:00.000Z", {
        source: "youtube",
        source_kind: "watch",
        media_type: "video",
        title: "Video Two",
        parent_title: "Fake Channel",
      }),
    ];

    const history = titleHistory(
      events,
      TZ,
      `${CHANNEL_KEY_PREFIX}Fake Channel`
    );
    expect(history).not.toBeNull();
    expect(history!.title).toBe("Fake Channel");
    expect(history!.source).toBe("youtube");
    expect(history!.subtitle).toBe("YouTube channel");
    expect(history!.count).toBe(2);
    expect(history!.items.map((i) => i.event_title)).toEqual([
      "Video Two",
      "Video One",
    ]);
  });

  test("unknown or malformed keys return null", () => {
    const events = [ev("2026-03-01T12:00:00.000Z", { title: "Fake Book" })];
    expect(titleHistory(events, TZ, `manual\u0000No Such Title`)).toBeNull();
    expect(titleHistory(events, TZ, `youtube\u0000Fake Book`)).toBeNull();
    expect(titleHistory(events, TZ, "no-separator")).toBeNull();
    expect(titleHistory(events, TZ, "")).toBeNull();
  });

  test("local date crosses the day boundary in summer (23:30Z -> next day)", () => {
    const events = [
      ev("2026-07-15T23:30:00.000Z", {
        source: "manual",
        media_type: "movie",
        title: "Fake Late Movie",
      }),
    ];
    const history = titleHistory(events, TZ, `manual\u0000Fake Late Movie`);
    expect(history!.items[0]!.local_date).toBe("2026-07-16");
    expect(history!.items[0]!.local_time).toBe("01:30");
  });
});

describe("searchEvents performance", () => {
  test("a 50 000-event synthetic set searches in well under 1 s", () => {
    const events: ConsumptionEvent[] = [];
    // 200 channels x 250 videos = 50 000 youtube views.
    for (let c = 0; c < 200; c++) {
      for (let v = 0; v < 250; v++) {
        events.push(
          ev("2026-06-15T10:00:00.000Z", {
            source: "youtube",
            source_kind: "watch",
            media_type: "video",
            title: `Fake Video ${c} ${v}`,
            parent_title: `Fake Channel ${c}`,
            external_ids: { youtube_video: `vid${c}_${v}xxxxx` },
          })
        );
      }
    }
    expect(events).toHaveLength(50_000);

    const started = performance.now();
    const result = searchEvents(events, TZ, {
      q: "fake video 12",
      limit: 30,
      offset: 0,
    });
    const elapsed = performance.now() - started;

    expect(result.total).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});
