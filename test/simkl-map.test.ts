import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapAll, type SimklAllItems } from "../src/sources/simkl/map.ts";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "simkl", "all-items.json");

describe("Simkl mapping (src/sources/simkl/map.ts)", () => {
  test("maps movie from fixture correctly", () => {
    const data: SimklAllItems = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const events = mapAll(data);

    // Expect: 1 movie + 1 show ep + 1 anime ep + 1 anime movie = 4 events
    expect(events.length).toBe(4);

    const movieEvent = events.find((e) => e.source_id.startsWith("movie:900001:"));
    expect(movieEvent).toBeDefined();
    expect(movieEvent!.source).toBe("simkl");
    expect(movieEvent!.source_kind).toBe("watch");
    expect(movieEvent!.media_type).toBe("movie");
    expect(movieEvent!.title).toBe("Synthetic Movie 1");
    expect(movieEvent!.parent_title).toBeNull();
    expect(movieEvent!.season).toBeNull();
    expect(movieEvent!.episode).toBeNull();
    expect(movieEvent!.started_at).toBe("2026-05-01T20:15:00.000Z");
    expect(movieEvent!.source_id).toBe("movie:900001:2026-05-01T20:15:00.000Z");
    expect(movieEvent!.duration_seconds).toBe(148 * 60);
    expect(movieEvent!.ended_at).toBeNull();
    expect(movieEvent!.progress).toBeNull();
    expect(movieEvent!.device).toBeNull();
    expect(movieEvent!.external_ids).toEqual({
      simkl: 900001,
      slug: "synthetic-movie-1-2024",
      imdb: "tt9000001",
      tmdb: "9000001",
      simkl_poster: "74/74415673dcdc9cdd",
    });
    expect(movieEvent!.raw).toBeDefined();
    expect((movieEvent!.raw as Record<string, unknown>).status).toBe("completed");
  });

  test("plantowatch items without watch time produce no events", () => {
    const data: SimklAllItems = {
      movies: [
        {
          last_watched_at: null,
          status: "plantowatch",
          movie: {
            title: "Synthetic Unwatched Movie",
            ids: { simkl: 900002 },
          },
        },
      ],
      shows: [
        {
          show: {
            title: "Synthetic Unwatched Show",
            ids: { simkl: 900003 },
          },
          seasons: [
            {
              number: 1,
              episodes: [
                { number: 1, watched_at: null },
                { number: 2 },
              ],
            },
          ],
        },
      ],
    };

    const events = mapAll(data);
    expect(events.length).toBe(0);
  });

  test("maps show episode correctly with duration, season, episode, title, and raw without seasons", () => {
    const data: SimklAllItems = {
      shows: [
        {
          show: {
            title: "Synthetic Show 1",
            runtime: 45,
            poster: "12/12345678abcdef01",
            ids: { simkl: 900003, tvdb: 900003 },
          },
          seasons: [
            {
              number: 2,
              episodes: [
                {
                  number: 5,
                  watched_at: "2026-04-30T19:02:00Z",
                  title: "Synthetic Episode Title",
                },
              ],
            },
          ],
        },
      ],
    };

    const events = mapAll(data);
    expect(events.length).toBe(1);

    const epEvent = events[0]!;
    expect(epEvent.source).toBe("simkl");
    expect(epEvent.source_kind).toBe("watch");
    expect(epEvent.media_type).toBe("episode");
    expect(epEvent.title).toBe("Synthetic Show 1");
    expect(epEvent.season).toBe(2);
    expect(epEvent.episode).toBe(5);
    expect(epEvent.started_at).toBe("2026-04-30T19:02:00.000Z");
    expect(epEvent.source_id).toBe("ep:900003:2:5:2026-04-30T19:02:00.000Z");
    expect(epEvent.duration_seconds).toBe(45 * 60);
    expect(epEvent.external_ids).toEqual({
      simkl: 900003,
      tvdb: 900003,
      simkl_poster: "12/12345678abcdef01",
    });

    // Episode raw must include episode object + show title & ids, but NO seasons array
    const raw = epEvent.raw as Record<string, unknown>;
    expect(raw).toBeDefined();
    expect(raw.number).toBe(5);
    expect(raw.title).toBe("Synthetic Episode Title");
    expect(raw.seasons).toBeUndefined();
    expect(raw.show).toEqual({
      title: "Synthetic Show 1",
      ids: { simkl: 900003, tvdb: 900003 },
    });
  });

  test("maps anime TV episode as media_type episode", () => {
    const data: SimklAllItems = {
      anime: [
        {
          anime_type: "tv",
          show: {
            title: "Synthetic Anime Series",
            runtime: 24,
            ids: { simkl: 900004, mal: 900004 },
          },
          seasons: [
            {
              number: 1,
              episodes: [
                { number: 3, watched_at: "2026-05-02T15:00:00Z" },
              ],
            },
          ],
        },
      ],
    };

    const events = mapAll(data);
    expect(events.length).toBe(1);
    expect(events[0]!.media_type).toBe("episode");
    expect(events[0]!.source_id).toBe("ep:900004:1:3:2026-05-02T15:00:00.000Z");
    expect(events[0]!.duration_seconds).toBe(24 * 60);
  });

  test("maps anime movie (anime_type === 'movie') as media_type movie", () => {
    const data: SimklAllItems = {
      anime: [
        {
          anime_type: "movie",
          last_watched_at: "2026-05-03T18:30:00Z",
          anime: {
            title: "Synthetic Anime Movie",
            runtime: 115,
            poster: "56/56789012abcdef34",
            ids: { simkl: 900005, mal: 900005 },
          },
        },
      ],
    };

    const events = mapAll(data);
    expect(events.length).toBe(1);
    expect(events[0]!.media_type).toBe("movie");
    expect(events[0]!.source_id).toBe("movie:900005:2026-05-03T18:30:00.000Z");
    expect(events[0]!.title).toBe("Synthetic Anime Movie");
    expect(events[0]!.duration_seconds).toBe(115 * 60);
    expect(events[0]!.season).toBeNull();
    expect(events[0]!.episode).toBeNull();
    expect(events[0]!.external_ids).toEqual({
      simkl: 900005,
      mal: 900005,
      simkl_poster: "56/56789012abcdef34",
    });
  });

  test("rewatch (same episode, two watched_at) yields 2 distinct events", () => {
    const data: SimklAllItems = {
      shows: [
        {
          show: {
            title: "Synthetic Rewatch Show",
            ids: { simkl: 900006 },
          },
          seasons: [
            {
              number: 1,
              episodes: [
                {
                  number: 1,
                  watched_at: ["2026-04-10T12:00:00Z", "2026-05-10T14:30:00Z"],
                },
              ],
            },
          ],
        },
      ],
    };

    const events = mapAll(data);
    expect(events.length).toBe(2);
    expect(events[0]!.source_id).toBe("ep:900006:1:1:2026-04-10T12:00:00.000Z");
    expect(events[1]!.source_id).toBe("ep:900006:1:1:2026-05-10T14:30:00.000Z");
    expect(events[0]!.started_at).toBe("2026-04-10T12:00:00.000Z");
    expect(events[1]!.started_at).toBe("2026-05-10T14:30:00.000Z");
  });

  test("re-mapping the same data yields identical events", () => {
    const data: SimklAllItems = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const events1 = mapAll(data);
    const events2 = mapAll(data);
    expect(events1).toEqual(events2);
  });

  test("skips malformed entries without throwing", () => {
    const malformed: SimklAllItems = {
      movies: [
        null as unknown as any,
        {} as any,
        { movie: null } as any,
        { movie: { title: "" } } as any,
        { movie: { title: "No IDs" } } as any,
        { movie: { title: "Bad Timestamp", ids: { simkl: 1 } }, last_watched_at: "not-a-date" },
      ],
      shows: [
        null as unknown as any,
        { show: { ids: { simkl: 2 } } } as any, // missing title
        { show: { title: "Show Missing IDs" } } as any,
        { show: { title: "Show 1", ids: { simkl: 3 } }, seasons: "not-an-array" as any },
        {
          show: { title: "Show 2", ids: { simkl: 4 } },
          seasons: [{ number: "one" as any, episodes: [{ number: 1, watched_at: "2026-01-01T00:00:00Z" }] }],
        },
      ],
      anime: [
        null as unknown as any,
        { anime_type: "movie", anime: { ids: { simkl: 5 } } } as any, // missing title
      ],
    };

    expect(() => mapAll(malformed)).not.toThrow();
    const events = mapAll(malformed);
    expect(events).toEqual([]);
  });

  test("times are stored normalized with .000Z", () => {
    const data: SimklAllItems = {
      movies: [
        {
          last_watched_at: "2026-05-13T16:08:00Z",
          movie: {
            title: "Synthetic Movie Time Test",
            ids: { simkl: 900007 },
          },
        },
      ],
    };

    const events = mapAll(data);
    expect(events.length).toBe(1);
    expect(events[0]!.started_at).toBe("2026-05-13T16:08:00.000Z");
    expect(events[0]!.source_id).toContain(".000Z");
  });
});
