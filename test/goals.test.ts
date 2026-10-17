import { describe, expect, test } from "bun:test";
import type { ConsumptionEvent } from "../src/server/aggregate.ts";
import { computeGoalProgress } from "../src/server/goals.ts";

const TZ = "Europe/Bratislava";

function makeEvent(overrides: Partial<ConsumptionEvent>): ConsumptionEvent {
  return {
    id: 1,
    source: "audiobookshelf",
    source_kind: "listening_session",
    media_type: "audiobook",
    title: "Synthetic Title",
    started_at: "2026-03-01T12:00:00.000Z",
    duration_seconds: 3600,
    ...overrides,
  };
}

describe("pure goal progress (computeGoalProgress)", () => {
  test("computes progress for 'items' metric", () => {
    const events: ConsumptionEvent[] = [
      makeEvent({ id: 1, started_at: "2026-01-10T10:00:00.000Z" }),
      makeEvent({ id: 2, started_at: "2026-01-15T10:00:00.000Z" }),
      makeEvent({ id: 3, started_at: "2026-02-01T10:00:00.000Z" }),
    ];

    const progress = computeGoalProgress(
      { year: 2026, metric: "items", target: 10 },
      events,
      TZ,
      "2026-01-01" // day 1 of 365, expected = 10 * 1 / 365 ~ 0.027
    );

    expect(progress.current).toBe(3);
    expect(progress.target).toBe(10);
    expect(progress.percent).toBe(30);
    expect(progress.status).toBe("on_track");
  });

  test("computes progress for 'hours' metric (minutes / 60)", () => {
    const events: ConsumptionEvent[] = [
      makeEvent({ id: 1, duration_seconds: 3600, started_at: "2026-02-10T10:00:00.000Z" }), // 1 h
      makeEvent({ id: 2, duration_seconds: 5400, started_at: "2026-02-11T10:00:00.000Z" }), // 1.5 h
    ];

    const progress = computeGoalProgress(
      { year: 2026, metric: "hours", target: 10 },
      events,
      TZ,
      "2026-01-01"
    );

    expect(progress.current).toBe(2.5);
    expect(progress.target).toBe(10);
    expect(progress.percent).toBe(25);
    expect(progress.status).toBe("on_track");
  });

  test("computes progress for 'titles' metric", () => {
    const events: ConsumptionEvent[] = [
      makeEvent({ id: 1, title: "Book A", started_at: "2026-03-01T10:00:00.000Z" }),
      makeEvent({ id: 2, title: "Book A", started_at: "2026-03-02T10:00:00.000Z" }), // same title
      makeEvent({ id: 3, title: "Book B", started_at: "2026-03-03T10:00:00.000Z" }),
    ];

    const progress = computeGoalProgress(
      { year: 2026, metric: "titles", target: 4 },
      events,
      TZ,
      "2026-01-01"
    );

    expect(progress.current).toBe(2);
    expect(progress.target).toBe(4);
    expect(progress.percent).toBe(50);
  });

  test("computes progress for 'active_days' metric", () => {
    const events: ConsumptionEvent[] = [
      makeEvent({ id: 1, started_at: "2026-03-01T10:00:00.000Z" }),
      makeEvent({ id: 2, started_at: "2026-03-01T15:00:00.000Z" }), // same day
      makeEvent({ id: 3, started_at: "2026-03-05T10:00:00.000Z" }),
    ];

    const progress = computeGoalProgress(
      { year: 2026, metric: "active_days", target: 100 },
      events,
      TZ,
      "2026-01-01"
    );

    expect(progress.current).toBe(2);
    expect(progress.target).toBe(100);
    expect(progress.percent).toBe(2);
  });

  test("filters events by source and media_type", () => {
    const events: ConsumptionEvent[] = [
      makeEvent({
        id: 1,
        source: "audiobookshelf",
        media_type: "audiobook",
        started_at: "2026-04-01T10:00:00.000Z",
      }),
      makeEvent({
        id: 2,
        source: "simkl",
        media_type: "movie",
        started_at: "2026-04-02T10:00:00.000Z",
      }),
      makeEvent({
        id: 3,
        source: "audiobookshelf",
        media_type: "podcast_episode",
        started_at: "2026-04-03T10:00:00.000Z",
      }),
    ];

    // Filter by source
    const absProgress = computeGoalProgress(
      { year: 2026, metric: "items", source: "audiobookshelf", target: 10 },
      events,
      TZ,
      "2026-01-01"
    );
    expect(absProgress.current).toBe(2);

    // Filter by media_type
    const movieProgress = computeGoalProgress(
      { year: 2026, metric: "items", media_type: "movie", target: 10 },
      events,
      TZ,
      "2026-01-01"
    );
    expect(movieProgress.current).toBe(1);

    // Filter by both source and media_type
    const absAudiobookProgress = computeGoalProgress(
      {
        year: 2026,
        metric: "items",
        source: "audiobookshelf",
        media_type: "audiobook",
        target: 10,
      },
      events,
      TZ,
      "2026-01-01"
    );
    expect(absAudiobookProgress.current).toBe(1);
  });

  test("calculates pace on a normal year (365 days)", () => {
    // 2025 is not a leap year: 365 days
    // Day 73 is March 14 (31 + 28 + 14 = 73 days)
    // 73 / 365 = 0.2 (exactly 20% of the year)
    const target = 100;
    const today = "2025-03-14";

    // Expected = 100 * 73 / 365 = 20
    const progressExpected = computeGoalProgress(
      { year: 2025, metric: "items", target },
      [],
      TZ,
      today
    );
    expect(progressExpected.expected).toBe(20);
    expect(progressExpected.status).toBe("behind");

    // Current = 20 -> on_track
    const onTrack = computeGoalProgress(
      { year: 2025, metric: "items", target },
      Array.from({ length: 20 }, (_, i) =>
        makeEvent({ id: i + 1, started_at: "2025-01-02T10:00:00.000Z" })
      ),
      TZ,
      today
    );
    expect(onTrack.current).toBe(20);
    expect(onTrack.status).toBe("on_track");

    // Current = 100 -> done
    const done = computeGoalProgress(
      { year: 2025, metric: "items", target },
      Array.from({ length: 100 }, (_, i) =>
        makeEvent({ id: i + 1, started_at: "2025-01-02T10:00:00.000Z" })
      ),
      TZ,
      today
    );
    expect(done.current).toBe(100);
    expect(done.status).toBe("done");
  });

  test("calculates pace on a leap year (366 days)", () => {
    // 2024 is a leap year (Feb 29 exists)
    // 2024-02-29 is day 60 of 366 (31 + 29 = 60)
    // Target 366 -> expected should be exactly 60
    const target = 366;
    const today = "2024-02-29";

    const p = computeGoalProgress(
      { year: 2024, metric: "items", target },
      [],
      TZ,
      today
    );
    expect(p.expected).toBe(60);
    expect(p.status).toBe("behind");

    // 2024-12-31 is day 366 of 366
    const endOfYear = computeGoalProgress(
      { year: 2024, metric: "items", target },
      [],
      TZ,
      "2024-12-31"
    );
    expect(endOfYear.expected).toBe(366);
  });

  test("handles past year: done or missed", () => {
    // Past year (2024 evaluated at today 2026-10-17)
    const target = 10;
    const today = "2026-10-17";

    // Missed
    const missed = computeGoalProgress(
      { year: 2024, metric: "items", target },
      [makeEvent({ id: 1, started_at: "2024-06-01T10:00:00.000Z" })],
      TZ,
      today
    );
    expect(missed.expected).toBe(target);
    expect(missed.status).toBe("missed");

    // Done
    const done = computeGoalProgress(
      { year: 2024, metric: "items", target },
      Array.from({ length: 12 }, (_, i) =>
        makeEvent({ id: i + 1, started_at: "2024-06-01T10:00:00.000Z" })
      ),
      TZ,
      today
    );
    expect(done.expected).toBe(target);
    expect(done.status).toBe("done");
  });

  test("handles future year: expected 0 and not_started", () => {
    // Future year 2028 evaluated at today 2026-10-17
    const target = 50;
    const progress = computeGoalProgress(
      { year: 2028, metric: "items", target },
      [],
      TZ,
      "2026-10-17"
    );

    expect(progress.expected).toBe(0);
    expect(progress.status).toBe("not_started");
  });

  test("handles empty data cleanly", () => {
    // Current year empty data
    const current = computeGoalProgress(
      { year: 2026, metric: "items", target: 30 },
      [],
      TZ,
      "2026-06-01"
    );
    expect(current.current).toBe(0);
    expect(current.percent).toBe(0);
    expect(current.status).toBe("behind");

    // Past year empty data
    const past = computeGoalProgress(
      { year: 2024, metric: "items", target: 30 },
      [],
      TZ,
      "2026-10-17"
    );
    expect(past.current).toBe(0);
    expect(past.percent).toBe(0);
    expect(past.expected).toBe(30);
    expect(past.status).toBe("missed");

    // Future year empty data
    const future = computeGoalProgress(
      { year: 2030, metric: "hours", target: 100 },
      [],
      TZ,
      "2026-10-17"
    );
    expect(future.current).toBe(0);
    expect(future.percent).toBe(0);
    expect(future.expected).toBe(0);
    expect(future.status).toBe("not_started");
  });
});
