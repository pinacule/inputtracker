import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import {
  aggregateCalendar,
  aggregateHeatmapDays,
  aggregateHeatmapHours,
  aggregateStats,
  filterInProgress,
  formatLocalParts,
  getCalendar,
  getHeatmapDays,
  getHeatmapHours,
  getInProgress,
  getStats,
  isTimeUncertain,
  UNCERTAIN_SLACK_SECONDS,
  type ConsumptionEvent,
} from "../src/server/aggregate.ts";

const TZ = "Europe/Bratislava";

describe("formatLocalParts", () => {
  test("summer wall-clock time (CEST, UTC+2)", () => {
    const parts = formatLocalParts("2026-10-17T08:15:00.000Z", TZ);
    expect(parts.date).toBe("2026-10-17");
    expect(parts.hour).toBe(10);
    expect(parts.localTime).toBe("10:15");
    expect(parts.weekday).toBe(6); // Saturday
  });

  test("winter wall-clock time (CET, UTC+1)", () => {
    const parts = formatLocalParts("2026-01-15T20:30:00.000Z", TZ);
    expect(parts.date).toBe("2026-01-15");
    expect(parts.hour).toBe(21);
    expect(parts.localTime).toBe("21:30");
    expect(parts.weekday).toBe(4); // Thursday
  });

  test("day boundary (23:30 UTC on CEST day lands on next local day)", () => {
    const parts = formatLocalParts("2026-06-01T23:30:00.000Z", TZ);
    expect(parts.date).toBe("2026-06-02");
    expect(parts.hour).toBe(1);
    expect(parts.localTime).toBe("01:30");
    expect(parts.weekday).toBe(2); // Tuesday
  });

  test("spring-forward DST change (2026-03-29: 02:00 CET -> 03:00 CEST)", () => {
    // 00:30 UTC is 01:30 CET (hour 1)
    const before = formatLocalParts("2026-03-29T00:30:00.000Z", TZ);
    expect(before.date).toBe("2026-03-29");
    expect(before.hour).toBe(1);
    expect(before.localTime).toBe("01:30");

    // 01:30 UTC is 03:30 CEST (hour 3, hour 2 was skipped)
    const after = formatLocalParts("2026-03-29T01:30:00.000Z", TZ);
    expect(after.date).toBe("2026-03-29");
    expect(after.hour).toBe(3);
    expect(after.localTime).toBe("03:30");
  });

  test("fall-back DST change (2026-10-25: 03:00 CEST -> 02:00 CET)", () => {
    // 00:30 UTC is 02:30 CEST (hour 2)
    const before = formatLocalParts("2026-10-25T00:30:00.000Z", TZ);
    expect(before.date).toBe("2026-10-25");
    expect(before.hour).toBe(2);
    expect(before.localTime).toBe("02:30");

    // 01:30 UTC is 02:30 CET (hour 2 again)
    const after = formatLocalParts("2026-10-25T01:30:00.000Z", TZ);
    expect(after.date).toBe("2026-10-25");
    expect(after.hour).toBe(2);
    expect(after.localTime).toBe("02:30");
  });
});

describe("aggregateCalendar", () => {
  const events: ConsumptionEvent[] = [
    {
      id: 1,
      source: "audiobookshelf",
      source_kind: "listening_session",
      media_type: "audiobook",
      title: "Book Alpha",
      parent_title: "Author One",
      started_at: "2026-10-05T08:00:00.000Z",
      duration_seconds: 1800,
    },
    {
      id: 2,
      source: "manual",
      source_kind: "history_item",
      media_type: "movie",
      title: "Movie Beta",
      started_at: "2026-10-05T18:30:00.000Z",
      duration_seconds: 7200,
    },
    {
      id: 3,
      source: "simkl",
      source_kind: "watch",
      media_type: "episode",
      title: "Episode 1",
      parent_title: "Show Gamma",
      season: 1,
      episode: 1,
      started_at: "2026-10-12T12:00:00.000Z",
      duration_seconds: null, // null duration -> 0 minutes, 1 item
    },
    {
      id: 4,
      source: "audiobookshelf",
      source_kind: "media_progress", // non-consumption kind: should be ignored!
      media_type: "audiobook",
      title: "Book Delta",
      started_at: "2026-10-15T10:00:00.000Z",
      duration_seconds: 3600,
    },
    {
      id: 5,
      source: "manual",
      source_kind: "history_item",
      media_type: "book",
      title: "Book Epsilon",
      started_at: "2026-11-01T08:00:00.000Z", // different month
      duration_seconds: 3600,
    },
  ];

  test("buckets items into days and calculates count and minutes", () => {
    const res = aggregateCalendar(events, "2026-10", TZ);
    expect(res.month).toBe("2026-10");
    expect(res.days).toHaveLength(2); // 2026-10-05 and 2026-10-12

    const day1 = res.days[0]!;
    expect(day1.date).toBe("2026-10-05");
    expect(day1.count).toBe(2);
    expect(day1.minutes).toBe(150); // (1800 + 7200) / 60
    expect(day1.items).toHaveLength(2);
    expect(day1.items[0]?.title).toBe("Book Alpha");
    expect(day1.items[0]?.local_time).toBe("10:00");
    expect(day1.items[1]?.title).toBe("Movie Beta");
    expect(day1.items[1]?.local_time).toBe("20:30");

    const day2 = res.days[1]!;
    expect(day2.date).toBe("2026-10-12");
    expect(day2.count).toBe(1);
    expect(day2.minutes).toBe(0); // null duration_seconds -> 0 minutes
    expect(day2.items[0]?.duration_seconds).toBeNull();
  });

  test("month boundary respect local day", () => {
    const boundaryEvents: ConsumptionEvent[] = [
      {
        id: 10,
        source: "manual",
        source_kind: "history_item",
        media_type: "movie",
        title: "Late Night Movie",
        // 2026-05-31 23:30 UTC -> 2026-06-01 01:30 CEST local
        started_at: "2026-05-31T23:30:00.000Z",
        duration_seconds: 3600,
      },
    ];

    const mayRes = aggregateCalendar(boundaryEvents, "2026-05", TZ);
    expect(mayRes.days).toHaveLength(0);

    const junRes = aggregateCalendar(boundaryEvents, "2026-06", TZ);
    expect(junRes.days).toHaveLength(1);
    expect(junRes.days[0]?.date).toBe("2026-06-01");
    expect(junRes.days[0]?.items[0]?.local_time).toBe("01:30");
  });
});

describe("aggregateHeatmapDays", () => {
  test("aggregates counts and minutes per day across DST", () => {
    const events: ConsumptionEvent[] = [
      // Spring forward day: 2026-03-29
      {
        id: 1,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Session 1",
        started_at: "2026-03-29T00:30:00.000Z", // 01:30 local
        duration_seconds: 1800,
      },
      {
        id: 2,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Session 2",
        started_at: "2026-03-29T01:30:00.000Z", // 03:30 local
        duration_seconds: 2400,
      },
      // Fall back day: 2026-10-25
      {
        id: 3,
        source: "manual",
        source_kind: "history_item",
        media_type: "movie",
        title: "Fall Back Movie",
        started_at: "2026-10-25T01:30:00.000Z", // 02:30 local
        duration_seconds: 6000,
      },
      // Other year: 2025
      {
        id: 4,
        source: "manual",
        source_kind: "history_item",
        media_type: "book",
        title: "Old Book",
        started_at: "2025-10-25T10:00:00.000Z",
        duration_seconds: 3000,
      },
      // Non-consumption event: media_progress
      {
        id: 5,
        source: "audiobookshelf",
        source_kind: "media_progress",
        media_type: "audiobook",
        title: "Progress Event",
        started_at: "2026-03-29T12:00:00.000Z",
        duration_seconds: 1200,
      },
    ];

    const res = aggregateHeatmapDays(events, "2026", TZ);
    expect(res.year).toBe("2026");
    expect(res.days).toHaveLength(2);

    expect(res.days[0]).toEqual({
      date: "2026-03-29",
      count: 2,
      minutes: 70, // (1800 + 2400) / 60
    });

    expect(res.days[1]).toEqual({
      date: "2026-10-25",
      count: 1,
      minutes: 100, // 6000 / 60
    });
  });
});

describe("aggregateHeatmapHours", () => {
  test("aggregates by local weekday (0=Mon) and hour (0-23)", () => {
    const events: ConsumptionEvent[] = [
      // 2026-10-17 is Saturday (ISO weekday 6 -> cell weekday 5)
      // 08:15 UTC is 10:15 CEST (hour 10)
      {
        id: 1,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "Sat Morning",
        started_at: "2026-10-17T08:15:00.000Z",
        duration_seconds: 1800,
      },
      {
        id: 2,
        source: "manual",
        source_kind: "history_item",
        media_type: "podcast_episode",
        title: "Sat Morning 2",
        started_at: "2026-10-17T08:45:00.000Z",
        duration_seconds: 1200,
      },
      // 2026-10-18 is Sunday (ISO weekday 7 -> cell weekday 6)
      // 20:00 UTC is 22:00 CEST (hour 22)
      {
        id: 3,
        source: "simkl",
        source_kind: "watch",
        media_type: "movie",
        title: "Sun Night",
        started_at: "2026-10-18T20:00:00.000Z",
        duration_seconds: 7200,
      },
    ];

    const res = aggregateHeatmapHours(events, undefined, TZ);
    expect(res.cells).toHaveLength(2);

    expect(res.cells[0]).toEqual({
      weekday: 5, // Saturday (0=Mon, 5=Sat)
      hour: 10,
      count: 2,
      minutes: 50, // (1800 + 1200) / 60
    });

    expect(res.cells[1]).toEqual({
      weekday: 6, // Sunday (6=Sun)
      hour: 22,
      count: 1,
      minutes: 120, // 7200 / 60
    });
  });
});

describe("aggregateStats", () => {
  test("calculates totals and breakdowns by source and media_type", () => {
    const events: ConsumptionEvent[] = [
      {
        id: 1,
        source: "audiobookshelf",
        source_kind: "listening_session",
        media_type: "audiobook",
        title: "ABS Book",
        started_at: "2026-10-01T10:00:00.000Z",
        duration_seconds: 3600,
      },
      {
        id: 2,
        source: "manual",
        source_kind: "history_item",
        media_type: "movie",
        title: "Manual Movie",
        started_at: "2026-10-02T10:00:00.000Z",
        duration_seconds: 7200,
      },
      {
        id: 3,
        source: "manual",
        source_kind: "history_item",
        media_type: "audiobook",
        title: "Manual Audiobook",
        started_at: "2026-10-03T10:00:00.000Z",
        duration_seconds: 1800,
      },
      {
        id: 4,
        source: "audiobookshelf",
        source_kind: "daily_stat", // ignored
        media_type: "audiobook",
        title: "Daily Stat",
        started_at: "2026-10-04T10:00:00.000Z",
        duration_seconds: 9999,
      },
    ];

    const stats = aggregateStats(events);
    expect(stats.total_items).toBe(3);
    expect(stats.total_minutes).toBe(210); // (3600 + 7200 + 1800) / 60

    expect(stats.by_source["audiobookshelf"]).toEqual({
      count: 1,
      items: 1,
      minutes: 60,
    });
    expect(stats.by_source["manual"]).toEqual({
      count: 2,
      items: 2,
      minutes: 150,
    });

    expect(stats.by_media_type["audiobook"]).toEqual({
      count: 2,
      items: 2,
      minutes: 90,
    });
    expect(stats.by_media_type["movie"]).toEqual({
      count: 1,
      items: 1,
      minutes: 120,
    });
  });
});

describe("filterInProgress", () => {
  test("includes only media_progress with 0 < progress < 1", () => {
    const rawEvents = [
      {
        id: 1,
        source: "audiobookshelf",
        source_kind: "media_progress",
        title: "Half Finished",
        progress: 0.5,
        started_at: "2026-10-10T10:00:00.000Z",
      },
      {
        id: 2,
        source: "audiobookshelf",
        source_kind: "media_progress",
        title: "Not Started",
        progress: 0,
        started_at: "2026-10-10T11:00:00.000Z",
      },
      {
        id: 3,
        source: "audiobookshelf",
        source_kind: "media_progress",
        title: "Finished",
        progress: 1,
        started_at: "2026-10-10T12:00:00.000Z",
      },
      {
        id: 4,
        source: "audiobookshelf",
        source_kind: "listening_session", // not media_progress
        title: "Session",
        progress: 0.5,
        started_at: "2026-10-10T13:00:00.000Z",
      },
    ];

    const inProgress = filterInProgress(rawEvents);
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]?.title).toBe("Half Finished");
    expect(inProgress[0]?.progress).toBe(0.5);
  });
});

describe("database integration: reading events_latest only", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  function seedRun(eventsToInsert: NewEvent[]): void {
    const runId = startRun(db, "test-sync");
    insertEvents(db, runId, eventsToInsert);
    finishRun(db, runId, {
      status: "ok",
      rowsSeen: eventsToInsert.length,
      rowsInserted: eventsToInsert.length,
    });
  }

  test("a session synced three times with growing duration is counted once with its latest duration", () => {
    // 3 syncs of the same session: same source, source_kind, source_id
    const baseEvent = {
      source: "audiobookshelf",
      source_kind: "listening_session",
      source_id: "abs-session-999",
      media_type: "audiobook" as const,
      title: "Growing Book",
      started_at: "2026-10-17T08:00:00.000Z",
    };

    seedRun([{ ...baseEvent, duration_seconds: 600 }]);
    seedRun([{ ...baseEvent, duration_seconds: 1200 }]);
    seedRun([{ ...baseEvent, duration_seconds: 1800 }]);

    // Calendar
    const cal = getCalendar(db, "2026-10", TZ);
    expect(cal.days).toHaveLength(1);
    const calDay = cal.days[0]!;
    expect(calDay.count).toBe(1);
    expect(calDay.minutes).toBe(30); // 1800 / 60
    expect(calDay.items).toHaveLength(1);
    expect(calDay.items[0]?.duration_seconds).toBe(1800);

    // Heatmap days
    const hmDays = getHeatmapDays(db, "2026", TZ);
    expect(hmDays.days).toHaveLength(1);
    expect(hmDays.days[0]).toEqual({
      date: "2026-10-17",
      count: 1,
      minutes: 30,
    });

    // Heatmap hours
    const hmHours = getHeatmapHours(db, "2026", TZ);
    expect(hmHours.cells).toHaveLength(1);
    expect(hmHours.cells[0]?.count).toBe(1);
    expect(hmHours.cells[0]?.minutes).toBe(30);

    // Stats
    const stats = getStats(db);
    expect(stats.total_items).toBe(1);
    expect(stats.total_minutes).toBe(30);
    expect(stats.by_source["audiobookshelf"]?.count).toBe(1);
    expect(stats.by_source["audiobookshelf"]?.minutes).toBe(30);
  });

  test("media_progress and daily_stat never appear in calendar, heatmap or stats", () => {
    seedRun([
      {
        source: "audiobookshelf",
        source_kind: "media_progress",
        source_id: "item-progress-1",
        media_type: "audiobook",
        title: "Audiobook In Progress",
        started_at: "2026-10-17T08:00:00.000Z",
        duration_seconds: 3600,
        progress: 0.45,
      },
      {
        source: "audiobookshelf",
        source_kind: "daily_stat",
        source_id: "stat-2026-10-17",
        media_type: "audiobook",
        title: "Daily Stat",
        started_at: "2026-10-17T00:00:00.000Z",
        duration_seconds: 7200,
      },
    ]);

    expect(getCalendar(db, "2026-10", TZ).days).toHaveLength(0);
    expect(getHeatmapDays(db, "2026", TZ).days).toHaveLength(0);
    expect(getHeatmapHours(db, "2026", TZ).cells).toHaveLength(0);
    expect(getStats(db).total_items).toBe(0);

    // But media_progress appears in getInProgress!
    const inProgress = getInProgress(db);
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]?.title).toBe("Audiobook In Progress");
    expect(inProgress[0]?.progress).toBe(0.45);
  });

  test("source filter isolates data", () => {
    seedRun([
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        media_type: "audiobook",
        title: "ABS Session",
        started_at: "2026-10-17T08:00:00.000Z",
        duration_seconds: 600,
      },
      {
        source: "manual",
        source_kind: "history_item",
        source_id: "man-1",
        media_type: "movie",
        title: "Manual Movie",
        started_at: "2026-10-17T12:00:00.000Z",
        duration_seconds: 7200,
      },
    ]);

    const calAll = getCalendar(db, "2026-10", TZ);
    expect(calAll.days[0]?.count).toBe(2);

    const calAbs = getCalendar(db, "2026-10", TZ, "audiobookshelf");
    expect(calAbs.days[0]?.count).toBe(1);
    expect(calAbs.days[0]?.items[0]?.title).toBe("ABS Session");

    const calManual = getCalendar(db, "2026-10", TZ, "manual");
    expect(calManual.days[0]?.count).toBe(1);
    expect(calManual.days[0]?.items[0]?.title).toBe("Manual Movie");

    const calEmpty = getCalendar(db, "2026-10", TZ, "nonexistent");
    expect(calEmpty.days).toHaveLength(0);
  });
});

describe("offline-synced sessions (time of day unknown)", () => {
  // Synthetic: an Android offline session the server stamps at sync time
  // (start == end) with 3 h of listening that happened earlier.
  const offline: ConsumptionEvent = {
    id: 10,
    source: "audiobookshelf",
    source_kind: "listening_session",
    media_type: "audiobook",
    title: "Offline Book",
    started_at: "2026-07-12T11:31:46.350Z",
    ended_at: "2026-07-12T11:31:46.462Z",
    duration_seconds: 10800,
  };
  // A normal browser session: 2 h of listening inside a 2.5 h span (pauses).
  const normal: ConsumptionEvent = {
    id: 11,
    source: "audiobookshelf",
    source_kind: "listening_session",
    media_type: "audiobook",
    title: "Desk Book",
    started_at: "2026-07-12T15:00:00.000Z",
    ended_at: "2026-07-12T17:30:00.000Z",
    duration_seconds: 7200,
  };

  test("isTimeUncertain flags only listening longer than the wall-clock span", () => {
    expect(isTimeUncertain(offline)).toBe(true);
    expect(isTimeUncertain(normal)).toBe(false);
    // Within the slack (rounding) is not uncertain.
    expect(
      isTimeUncertain({ ...normal, duration_seconds: 9000 + UNCERTAIN_SLACK_SECONDS })
    ).toBe(false);
    expect(
      isTimeUncertain({ ...normal, duration_seconds: 9001 + UNCERTAIN_SLACK_SECONDS })
    ).toBe(true);
    // No end or no duration (e.g. watches, manual entries): never uncertain.
    expect(isTimeUncertain({ ...offline, ended_at: null })).toBe(false);
    expect(isTimeUncertain({ ...offline, ended_at: undefined })).toBe(false);
    expect(isTimeUncertain({ ...offline, duration_seconds: null })).toBe(false);
  });

  test("calendar keeps the session on its sync day and marks it", () => {
    const cal = aggregateCalendar([offline, normal], "2026-07", TZ);
    expect(cal.days).toHaveLength(1);
    const day = cal.days[0]!;
    expect(day.date).toBe("2026-07-12");
    expect(day.minutes).toBe(300); // both count toward the day
    expect(day.items.map((i) => [i.title, i.time_uncertain])).toEqual([
      ["Offline Book", true],
      ["Desk Book", false],
    ]);
  });

  test("heat map days count it; the hour grid leaves it out and reports it", () => {
    const days = aggregateHeatmapDays([offline, normal], "2026", TZ);
    expect(days.days[0]?.minutes).toBe(300);

    const hours = aggregateHeatmapHours([offline, normal], "2026", TZ);
    expect(hours.cells).toEqual([
      { weekday: 6, hour: 17, count: 1, minutes: 120 }, // Sun 17:00 CEST
    ]);
    expect(hours.unplaced_count).toBe(1);
    expect(hours.unplaced_minutes).toBe(180);
  });

  test("the DB path reads ended_at from events_latest", () => {
    const db = openDb(":memory:");
    const runId = startRun(db, "test-sync");
    insertEvents(db, runId, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-offline-1",
        media_type: "audiobook",
        title: "Offline Book",
        started_at: offline.started_at,
        ended_at: offline.ended_at,
        duration_seconds: 10800,
      },
    ]);
    finishRun(db, runId, { status: "ok", rowsSeen: 1, rowsInserted: 1 });

    expect(getCalendar(db, "2026-07", TZ).days[0]?.items[0]?.time_uncertain).toBe(true);
    const hours = getHeatmapHours(db, "2026", TZ);
    expect(hours.cells).toEqual([]);
    expect(hours.unplaced_count).toBe(1);
  });
});
