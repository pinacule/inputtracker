import { describe, expect, test } from "bun:test";
import type { ConsumptionEvent } from "../src/server/aggregate.ts";
import { dedupeConsumption } from "../src/server/dedup.ts";

const TZ = "Europe/Bratislava";

describe("dedupeConsumption (pure)", () => {
  test("movie pair merged", () => {
    const simklMovie: ConsumptionEvent = {
      id: 1,
      source: "simkl",
      source_kind: "watch",
      source_id: "simkl-101",
      external_ids: { simkl_poster: "movies/12/34.jpg" },
      media_type: "movie",
      title: "Synthetic Movie",
      started_at: "2026-10-17T18:00:00.000Z",
      duration_seconds: 7200,
    };
    const manualMovie: ConsumptionEvent = {
      id: 2,
      source: "manual",
      source_kind: "history_item",
      source_id: "man-101",
      media_type: "movie",
      title: "Synthetic Movie",
      started_at: "2026-10-17T18:05:00.000Z",
      duration_seconds: 7200,
    };

    const result = dedupeConsumption([simklMovie, manualMovie], TZ);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
    expect(result[0]?.source).toBe("simkl");
    expect(result[0]?.also_from).toEqual(["manual"]);
    expect(result[0]?.external_ids).toEqual({ simkl_poster: "movies/12/34.jpg" });
    expect(result[0]?.duration_seconds).toBe(7200);
  });

  test("episode pair merged (same S/E)", () => {
    const simklEp: ConsumptionEvent = {
      id: 10,
      source: "simkl",
      source_kind: "watch",
      media_type: "episode",
      title: "Episode One",
      parent_title: "Synthetic Show",
      season: 2,
      episode: 5,
      started_at: "2026-10-17T19:00:00.000Z",
      duration_seconds: 2400,
    };
    const manualEp: ConsumptionEvent = {
      id: 11,
      source: "manual",
      source_kind: "history_item",
      media_type: "episode",
      title: "Episode One",
      parent_title: "Synthetic Show",
      season: 2,
      episode: 5,
      started_at: "2026-10-17T19:10:00.000Z",
      duration_seconds: 2400,
    };

    const result = dedupeConsumption([simklEp, manualEp], TZ);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(10);
    expect(result[0]?.source).toBe("simkl");
    expect(result[0]?.also_from).toEqual(["manual"]);
  });

  test("different local day not merged (use 23:30Z in summer vs 00:30Z to prove local-date logic in Europe/Bratislava)", () => {
    // In Europe/Bratislava (CEST = UTC+2 in July):
    // 2026-07-15T23:30:00.000Z -> 2026-07-16 01:30 (local date 2026-07-16)
    // 2026-07-15T00:30:00.000Z -> 2026-07-15 02:30 (local date 2026-07-15)
    const simklLate: ConsumptionEvent = {
      id: 20,
      source: "simkl",
      source_kind: "watch",
      media_type: "movie",
      title: "Summer Night",
      started_at: "2026-07-15T23:30:00.000Z",
      duration_seconds: 5400,
    };
    const manualEarly: ConsumptionEvent = {
      id: 21,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Summer Night",
      started_at: "2026-07-15T00:30:00.000Z",
      duration_seconds: 5400,
    };

    const notMerged = dedupeConsumption([simklLate, manualEarly], TZ);
    expect(notMerged).toHaveLength(2);
    expect(notMerged[0]?.also_from).toBeUndefined();
    expect(notMerged[1]?.also_from).toBeUndefined();

    // But if manual was logged at 2026-07-16T00:30:00.000Z (local date 2026-07-16, 1 hour apart),
    // they share the same local date in Bratislava and merge:
    const manualNextMorning: ConsumptionEvent = {
      id: 22,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Summer Night",
      started_at: "2026-07-16T00:30:00.000Z",
      duration_seconds: 5400,
    };
    const merged = dedupeConsumption([simklLate, manualNextMorning], TZ);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(20);
    expect(merged[0]?.also_from).toEqual(["manual"]);
  });

  test("different episode / different title / different media type not merged", () => {
    const base: ConsumptionEvent = {
      id: 30,
      source: "simkl",
      source_kind: "watch",
      media_type: "episode",
      title: "Pilot",
      parent_title: "Synthetic Series",
      season: 1,
      episode: 1,
      started_at: "2026-10-17T12:00:00.000Z",
      duration_seconds: 3000,
    };

    // Different episode
    const diffEp: ConsumptionEvent = {
      ...base,
      id: 31,
      source: "manual",
      episode: 2,
    };
    expect(dedupeConsumption([base, diffEp], TZ)).toHaveLength(2);

    // Different title
    const diffTitle: ConsumptionEvent = {
      ...base,
      id: 32,
      source: "manual",
      parent_title: "Other Series",
    };
    expect(dedupeConsumption([base, diffTitle], TZ)).toHaveLength(2);

    // Different media type
    const diffMedia: ConsumptionEvent = {
      id: 33,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Synthetic Series",
      started_at: "2026-10-17T12:00:00.000Z",
      duration_seconds: 3000,
    };
    expect(dedupeConsumption([base, diffMedia], TZ)).toHaveLength(2);

    // Episode with null season / episode
    const nullSeason: ConsumptionEvent = {
      ...base,
      id: 34,
      source: "manual",
      season: null,
    };
    expect(dedupeConsumption([base, nullSeason], TZ)).toHaveLength(2);
  });

  test("two manual rows not merged", () => {
    const man1: ConsumptionEvent = {
      id: 40,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Rewatched Film",
      started_at: "2026-10-17T10:00:00.000Z",
      duration_seconds: 6000,
    };
    const man2: ConsumptionEvent = {
      id: 41,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Rewatched Film",
      started_at: "2026-10-17T16:00:00.000Z",
      duration_seconds: 6000,
    };

    const res = dedupeConsumption([man1, man2], TZ);
    expect(res).toHaveLength(2);
    expect(res[0]?.id).toBe(40);
    expect(res[1]?.id).toBe(41);
    expect(res[0]?.also_from).toBeUndefined();
    expect(res[1]?.also_from).toBeUndefined();
  });

  test("Simkl + YouTube not merged", () => {
    const simkl: ConsumptionEvent = {
      id: 50,
      source: "simkl",
      source_kind: "watch",
      media_type: "movie",
      title: "Shared Title Video",
      started_at: "2026-10-17T14:00:00.000Z",
      duration_seconds: 1200,
    };
    const yt: ConsumptionEvent = {
      id: 51,
      source: "youtube",
      source_kind: "history_item",
      media_type: "movie",
      title: "Shared Title Video",
      started_at: "2026-10-17T14:05:00.000Z",
      duration_seconds: 1200,
    };

    const res = dedupeConsumption([simkl, yt], TZ);
    expect(res).toHaveLength(2);
    expect(res[0]?.also_from).toBeUndefined();
    expect(res[1]?.also_from).toBeUndefined();
  });

  test("ABS untouched", () => {
    const abs: ConsumptionEvent = {
      id: 60,
      source: "audiobookshelf",
      source_kind: "listening_session",
      media_type: "audiobook",
      title: "Audiobook Title",
      started_at: "2026-10-17T09:00:00.000Z",
      duration_seconds: 3600,
    };
    const manual: ConsumptionEvent = {
      id: 61,
      source: "manual",
      source_kind: "history_item",
      media_type: "audiobook",
      title: "Audiobook Title",
      started_at: "2026-10-17T09:00:00.000Z",
      duration_seconds: 3600,
    };

    const res = dedupeConsumption([abs, manual], TZ);
    expect(res).toHaveLength(2);
    expect(res[0]?.also_from).toBeUndefined();
    expect(res[1]?.also_from).toBeUndefined();
  });

  test("duration taken from manual when Simkl's is null", () => {
    const simklNullDur: ConsumptionEvent = {
      id: 70,
      source: "simkl",
      source_kind: "watch",
      media_type: "movie",
      title: "Indie Movie",
      started_at: "2026-10-17T15:00:00.000Z",
      duration_seconds: null,
    };
    const manualWithDur: ConsumptionEvent = {
      id: 71,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Indie Movie",
      started_at: "2026-10-17T15:02:00.000Z",
      duration_seconds: 5400,
    };

    const res = dedupeConsumption([simklNullDur, manualWithDur], TZ);
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe(70);
    expect(res[0]?.duration_seconds).toBe(5400);
    expect(res[0]?.also_from).toEqual(["manual"]);

    // When Simkl already has a duration, its own duration is kept:
    const simklWithDur: ConsumptionEvent = {
      ...simklNullDur,
      duration_seconds: 3600,
    };
    const res2 = dedupeConsumption([simklWithDur, manualWithDur], TZ);
    expect(res2).toHaveLength(1);
    expect(res2[0]?.duration_seconds).toBe(3600);
  });

  test("one manual vs two Simkl rewatches the same day -> merges with the closest only", () => {
    const simklMorning: ConsumptionEvent = {
      id: 80,
      source: "simkl",
      source_kind: "watch",
      media_type: "movie",
      title: "Favorite Movie",
      started_at: "2026-10-17T10:00:00.000Z",
      duration_seconds: 6000,
    };
    const simklEvening: ConsumptionEvent = {
      id: 81,
      source: "simkl",
      source_kind: "watch",
      media_type: "movie",
      title: "Favorite Movie",
      started_at: "2026-10-17T20:00:00.000Z",
      duration_seconds: 6000,
    };
    const manualMorning: ConsumptionEvent = {
      id: 82,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Favorite Movie",
      started_at: "2026-10-17T10:15:00.000Z", // 15 min from morning, 9h45m from evening
      duration_seconds: 6000,
    };

    const res = dedupeConsumption([simklMorning, simklEvening, manualMorning], TZ);
    expect(res).toHaveLength(2);
    // Simkl morning absorbed manual
    expect(res[0]?.id).toBe(80);
    expect(res[0]?.also_from).toEqual(["manual"]);
    // Simkl evening is untouched
    expect(res[1]?.id).toBe(81);
    expect(res[1]?.also_from).toBeUndefined();
  });

  test("tie in distance breaks to lower non-manual id", () => {
    const simklA: ConsumptionEvent = {
      id: 91,
      source: "simkl",
      source_kind: "watch",
      media_type: "movie",
      title: "Tied Movie",
      started_at: "2026-10-17T11:00:00.000Z", // 1 hour earlier
    };
    const simklB: ConsumptionEvent = {
      id: 90,
      source: "simkl",
      source_kind: "watch",
      media_type: "movie",
      title: "Tied Movie",
      started_at: "2026-10-17T13:00:00.000Z", // 1 hour later
    };
    const manual: ConsumptionEvent = {
      id: 92,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Tied Movie",
      started_at: "2026-10-17T12:00:00.000Z",
    };

    const res = dedupeConsumption([simklA, simklB, manual], TZ);
    expect(res).toHaveLength(2);
    // Lower non-manual id is simklB (90) vs simklA (91)
    const absorbed = res.find((r) => r.id === 90);
    const unabsorbed = res.find((r) => r.id === 91);
    expect(absorbed?.also_from).toEqual(["manual"]);
    expect(unabsorbed?.also_from).toBeUndefined();
  });

  test("idempotent", () => {
    const events: ConsumptionEvent[] = [
      {
        id: 101,
        source: "simkl",
        source_kind: "watch",
        media_type: "movie",
        title: "Idempotent Movie",
        started_at: "2026-10-17T12:00:00.000Z",
      },
      {
        id: 102,
        source: "manual",
        source_kind: "history_item",
        media_type: "movie",
        title: "Idempotent Movie",
        started_at: "2026-10-17T12:05:00.000Z",
      },
      {
        id: 103,
        source: "manual",
        source_kind: "history_item",
        media_type: "movie",
        title: "Unmatched Movie",
        started_at: "2026-10-17T15:00:00.000Z",
      },
    ];

    const once = dedupeConsumption(events, TZ);
    expect(once).toHaveLength(2);
    expect(once[0]?.id).toBe(101);
    expect(once[0]?.also_from).toEqual(["manual"]);
    expect(once[1]?.id).toBe(103);

    const twice = dedupeConsumption(once, TZ);
    expect(twice).toEqual(once);
  });

  test("title normalisation ('Šťastný Deň' vs 'stastny den')", () => {
    const simklSlovak: ConsumptionEvent = {
      id: 110,
      source: "simkl",
      source_kind: "watch",
      media_type: "movie",
      title: "Šťastný Deň",
      started_at: "2026-10-17T17:00:00.000Z",
      duration_seconds: 5400,
    };
    const manualAscii: ConsumptionEvent = {
      id: 111,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "stastny den",
      started_at: "2026-10-17T17:03:00.000Z",
      duration_seconds: 5400,
    };

    const res = dedupeConsumption([simklSlovak, manualAscii], TZ);
    expect(res).toHaveLength(1);
    expect(res[0]?.id).toBe(110);
    expect(res[0]?.title).toBe("Šťastný Deň");
    expect(res[0]?.also_from).toEqual(["manual"]);
  });
});
