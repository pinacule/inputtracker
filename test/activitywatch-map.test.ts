import { describe, expect, test } from "bun:test";
import { recordHash } from "../src/core/events.ts";
import {
  cleanTitle,
  extractVideoId,
  mapBucketEvents,
  normalizeTimestamp,
} from "../src/sources/activitywatch/map.ts";
import type { AwRawEvent } from "../src/sources/activitywatch/types.ts";

const FAKE_VID_1 = "AAAAAAAAAA1";
const FAKE_VID_2 = "BBBBBBBBBB2";
const FAKE_VID_3 = "CCCCCCCCCC3";

describe("extractVideoId", () => {
  test("extracts 11-char video id from watch URLs", () => {
    expect(extractVideoId(`https://youtube.com/watch?v=${FAKE_VID_1}`)).toBe(FAKE_VID_1);
    expect(extractVideoId(`https://www.youtube.com/watch?v=${FAKE_VID_1}`)).toBe(FAKE_VID_1);
    expect(extractVideoId(`https://www.youtube.com/watch?v=${FAKE_VID_1}&t=42s`)).toBe(FAKE_VID_1);
    expect(extractVideoId(`https://m.youtube.com/watch?v=${FAKE_VID_1}`)).toBe(FAKE_VID_1);
    expect(extractVideoId(`https://www.youtube.com/watch/?v=${FAKE_VID_1}`)).toBe(FAKE_VID_1);
  });

  test("extracts video id from shorts URLs", () => {
    expect(extractVideoId(`https://www.youtube.com/shorts/${FAKE_VID_1}`)).toBe(FAKE_VID_1);
    expect(extractVideoId(`https://www.youtube.com/shorts/${FAKE_VID_1}/`)).toBe(FAKE_VID_1);
    expect(extractVideoId(`https://youtube.com/shorts/${FAKE_VID_1}?feature=share`)).toBe(FAKE_VID_1);
  });

  test("extracts video id from live URLs", () => {
    expect(extractVideoId(`https://www.youtube.com/live/${FAKE_VID_1}`)).toBe(FAKE_VID_1);
    expect(extractVideoId(`https://youtube.com/live/${FAKE_VID_1}?feature=share`)).toBe(FAKE_VID_1);
  });

  test("extracts video id from youtu.be shortlinks", () => {
    expect(extractVideoId(`https://youtu.be/${FAKE_VID_1}`)).toBe(FAKE_VID_1);
    expect(extractVideoId(`https://youtu.be/${FAKE_VID_1}?t=10`)).toBe(FAKE_VID_1);
  });

  test("handles music.youtube.com only when includeMusic is true", () => {
    const url = `https://music.youtube.com/watch?v=${FAKE_VID_1}`;
    expect(extractVideoId(url, false)).toBeNull();
    expect(extractVideoId(url, true)).toBe(FAKE_VID_1);
  });

  test("rejects non-video YouTube pages and other sites", () => {
    expect(extractVideoId("https://www.youtube.com/")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/results?search_query=foo")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/@somechannel")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/playlist?list=PL1234567890")).toBeNull();
    expect(extractVideoId(`https://example.com/watch?v=${FAKE_VID_1}`)).toBeNull();
    expect(extractVideoId("https://vimeo.com/123456789")).toBeNull();
    expect(extractVideoId("not-a-valid-url")).toBeNull();
    expect(extractVideoId("")).toBeNull();
    expect(extractVideoId(null)).toBeNull();
    expect(extractVideoId(undefined)).toBeNull();
  });

  test("rejects invalid video ids that do not match 11 chars", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/watch?v=toolongvideo123")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/watch?v=invalid$char")).toBeNull();
    expect(extractVideoId("https://youtu.be/")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/shorts/")).toBeNull();
  });
});

describe("cleanTitle", () => {
  test("strips leading notification counts", () => {
    expect(cleanTitle("(3) Synthetic Song - YouTube")).toBe("Synthetic Song");
    expect(cleanTitle("(99+) Breaking News - YouTube")).toBe("Breaking News");
    expect(cleanTitle("(1) Minimal - YouTube")).toBe("Minimal");
  });

  test("strips trailing - YouTube and - YouTube Music", () => {
    expect(cleanTitle("Clean Video - YouTube")).toBe("Clean Video");
    expect(cleanTitle("Ambient Album - YouTube Music")).toBe("Ambient Album");
    expect(cleanTitle("No Suffix Video")).toBe("No Suffix Video");
  });

  test("preserves parenthetical title info that is not a notification count", () => {
    expect(cleanTitle("Synthetic Song (Official Video) - YouTube")).toBe(
      "Synthetic Song (Official Video)"
    );
    expect(cleanTitle("Synthetic Episode (Part 2) - YouTube")).toBe(
      "Synthetic Episode (Part 2)"
    );
  });

  test("returns null when title is empty or only whitespace/suffix", () => {
    expect(cleanTitle("- YouTube")).toBeNull();
    expect(cleanTitle("(3) - YouTube")).toBeNull();
    expect(cleanTitle("(5) - YouTube Music")).toBeNull();
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    expect(cleanTitle(undefined)).toBeNull();
  });
});

describe("normalizeTimestamp", () => {
  test("normalizes microseconds and timezone offsets to standard UTC ISO", () => {
    expect(normalizeTimestamp("2026-10-17T18:02:11.123456+00:00")).toBe(
      "2026-10-17T18:02:11.123Z"
    );
    expect(normalizeTimestamp("2026-10-17T18:02:11+00:00")).toBe(
      "2026-10-17T18:02:11.000Z"
    );
    expect(normalizeTimestamp("2026-10-17T18:02:11.456Z")).toBe(
      "2026-10-17T18:02:11.456Z"
    );
  });
});

describe("mapBucketEvents", () => {
  const options = {
    bucketId: "aw-watcher-web-chrome_test",
    device: "pc",
    includeMusic: false,
  };

  test("skips incognito events entirely", () => {
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 120,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Public Video - YouTube",
          audible: true,
          incognito: false,
        },
      },
      {
        timestamp: "2026-10-17T18:05:00.000Z",
        duration: 300,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_2}`,
          title: "Synthetic Secret Video - YouTube",
          audible: true,
          incognito: true,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, options);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].external_ids).toEqual({ youtube_video: FAKE_VID_1 });
    expect(mapped[0].title).toBe("Synthetic Public Video");
  });

  test("play grouping: joins events with gap <= 10 minutes", () => {
    // Event 1: 18:00:00 to 18:05:00 (dur 300)
    // Event 2: 18:14:00 (gap = 9 min <= 10 min) to 18:19:00 (dur 300)
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 300,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "(1) Synthetic Part 1 - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:14:00.000Z",
        duration: 300,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Part 1 Final - YouTube",
          audible: true,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, options);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].source_id).toBe(`${FAKE_VID_1}:2026-10-17T18:00:00.000Z`);
    expect(mapped[0].started_at).toBe("2026-10-17T18:00:00.000Z");
    expect(mapped[0].ended_at).toBe("2026-10-17T18:19:00.000Z");
    expect(mapped[0].duration_seconds).toBe(600);
    expect(mapped[0].title).toBe("Synthetic Part 1 Final");
    expect(mapped[0].raw).toEqual({
      bucket: "aw-watcher-web-chrome_test",
      events: 2,
      audible_seconds: 600,
      total_seconds: 600,
    });
  });

  test("play grouping: splits events with gap > 10 minutes", () => {
    // Event 1: 18:00:00 to 18:05:00 (dur 300)
    // Event 2: 18:16:00 (gap = 11 min > 10 min) to 18:21:00 (dur 300)
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 300,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Run 1 - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:16:00.000Z",
        duration: 300,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Run 2 - YouTube",
          audible: true,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, options);
    expect(mapped).toHaveLength(2);
    expect(mapped[0].started_at).toBe("2026-10-17T18:00:00.000Z");
    expect(mapped[0].ended_at).toBe("2026-10-17T18:05:00.000Z");
    expect(mapped[0].duration_seconds).toBe(300);

    expect(mapped[1].started_at).toBe("2026-10-17T18:16:00.000Z");
    expect(mapped[1].ended_at).toBe("2026-10-17T18:21:00.000Z");
    expect(mapped[1].duration_seconds).toBe(300);
  });

  test("play grouping: different video id splits the play", () => {
    // Event 1: Video A (18:00:00 to 18:05:00)
    // Event 2: Video B (18:06:00 to 18:10:00)
    // Event 3: Video A (18:11:00 to 18:15:00)
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 300,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Video 1 - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:06:00.000Z",
        duration: 240,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_2}`,
          title: "Synthetic Video 2 - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:11:00.000Z",
        duration: 240,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Video 1 - YouTube",
          audible: true,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, options);
    expect(mapped).toHaveLength(3);
    expect(mapped[0].external_ids).toEqual({ youtube_video: FAKE_VID_1 });
    expect(mapped[0].started_at).toBe("2026-10-17T18:00:00.000Z");
    expect(mapped[1].external_ids).toEqual({ youtube_video: FAKE_VID_2 });
    expect(mapped[1].started_at).toBe("2026-10-17T18:06:00.000Z");
    expect(mapped[2].external_ids).toEqual({ youtube_video: FAKE_VID_1 });
    expect(mapped[2].started_at).toBe("2026-10-17T18:11:00.000Z");
  });

  test("play grouping: non-video events in between do not split the play", () => {
    // Event 1: Video A (18:00:00 to 18:03:00, dur 180)
    // Event 2: Non-video (Wikipedia browsing, 18:04:00 to 18:06:00)
    // Event 3: Video A (18:07:00 to 18:10:00, dur 180, gap from 18:03:00 is 4 min <= 10 min)
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 180,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Video 1 - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:04:00.000Z",
        duration: 120,
        data: {
          url: "https://en.wikipedia.org/wiki/Testing",
          title: "Testing - Wikipedia",
        },
      },
      {
        timestamp: "2026-10-17T18:07:00.000Z",
        duration: 180,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Video 1 - YouTube",
          audible: true,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, options);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].source_id).toBe(`${FAKE_VID_1}:2026-10-17T18:00:00.000Z`);
    expect(mapped[0].duration_seconds).toBe(360);
    expect(mapped[0].ended_at).toBe("2026-10-17T18:10:00.000Z");
  });

  test("audible counting: sums only audible events when audible key exists", () => {
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 40,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Video - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:01:00.000Z",
        duration: 50,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Video - YouTube",
          audible: false,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, options);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].duration_seconds).toBe(40);
    expect(mapped[0].raw).toEqual({
      bucket: "aw-watcher-web-chrome_test",
      events: 2,
      audible_seconds: 40,
      total_seconds: 90,
    });
  });

  test("audible counting: falls back to all durations when NO event has audible key", () => {
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 40,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Video - YouTube",
        },
      },
      {
        timestamp: "2026-10-17T18:01:00.000Z",
        duration: 50,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Video - YouTube",
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, options);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].duration_seconds).toBe(90);
    expect(mapped[0].raw).toEqual({
      bucket: "aw-watcher-web-chrome_test",
      events: 2,
      audible_seconds: 0,
      total_seconds: 90,
    });
  });

  test("drops plays with watched_seconds < 30", () => {
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 29.4,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Dropped Short Preview - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:15:00.000Z",
        duration: 30.0,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_2}`,
          title: "Kept Play - YouTube",
          audible: true,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, options);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].external_ids).toEqual({ youtube_video: FAKE_VID_2 });
    expect(mapped[0].duration_seconds).toBe(30);
  });

  test("deterministic raw and record hash across re-runs", () => {
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:02:11.123456+00:00",
        duration: 120.5,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "(2) Deterministic Test - YouTube",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:05:00.000000+00:00",
        duration: 60.5,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Deterministic Test - YouTube",
          audible: true,
        },
      },
    ];

    const run1 = mapBucketEvents(rawEvents, options);
    const run2 = mapBucketEvents(rawEvents, options);

    expect(run1).toEqual(run2);
    expect(recordHash(run1[0])).toBe(recordHash(run2[0]));
    expect(run1[0].source_id).toBe(`${FAKE_VID_1}:2026-10-17T18:02:11.123Z`);
    expect(run1[0].duration_seconds).toBe(181);
    expect(run1[0].raw).toEqual({
      bucket: "aw-watcher-web-chrome_test",
      events: 2,
      audible_seconds: 181,
      total_seconds: 181,
    });
  });

  test("music.youtube.com with includeMusic maps to music, www.youtube.com to video", () => {
    const rawEvents: AwRawEvent[] = [
      {
        timestamp: "2026-10-17T18:00:00.000Z",
        duration: 120,
        data: {
          url: `https://music.youtube.com/watch?v=${FAKE_VID_1}`,
          title: "Synthetic Song - YouTube Music",
          audible: true,
        },
      },
      {
        timestamp: "2026-10-17T18:05:00.000Z",
        duration: 120,
        data: {
          url: `https://www.youtube.com/watch?v=${FAKE_VID_2}`,
          title: "Synthetic Video - YouTube",
          audible: true,
        },
      },
    ];

    const mapped = mapBucketEvents(rawEvents, { ...options, includeMusic: true });
    expect(mapped).toHaveLength(2);
    expect(mapped[0].media_type).toBe("music");
    expect(mapped[0].title).toBe("Synthetic Song");
    expect(mapped[0].parent_title).toBeNull();

    expect(mapped[1].media_type).toBe("video");
    expect(mapped[1].title).toBe("Synthetic Video");
    expect(mapped[1].parent_title).toBeNull();
  });
});
