import { describe, expect, test } from "bun:test";
import type { ConsumptionEvent } from "../src/server/aggregate.ts";
import { dropSupersededActivityWatchPlays } from "../src/server/youtube-filter.ts";

function play(id: number, video: string, start: string, end: string, seconds: number): ConsumptionEvent {
  return {
    id,
    source: "youtube",
    source_kind: "aw_play",
    source_id: `${video}:${start}`,
    external_ids: { youtube_video: video },
    media_type: "video",
    title: "Synthetic video",
    started_at: start,
    ended_at: end,
    duration_seconds: seconds,
  };
}

describe("dropSupersededActivityWatchPlays", () => {
  const tz = "Europe/Bratislava";

  test("a merged play hides the older separate rows it covers", () => {
    const merged = play(3, "AAAAAAAAAAA", "2026-10-18T08:00:00.000Z", "2026-10-18T09:10:00.000Z", 540);
    const second = play(2, "AAAAAAAAAAA", "2026-10-18T09:05:00.000Z", "2026-10-18T09:10:00.000Z", 300);
    const kept = dropSupersededActivityWatchPlays([merged, second], tz);
    expect(kept.map((e) => e.id)).toEqual([3]);
  });

  test("separate plays of one video that do not overlap all stay", () => {
    const a = play(1, "AAAAAAAAAAA", "2026-10-18T08:00:00.000Z", "2026-10-18T08:06:00.000Z", 360);
    const b = play(2, "AAAAAAAAAAA", "2026-10-18T09:00:00.000Z", "2026-10-18T09:06:00.000Z", 360);
    expect(dropSupersededActivityWatchPlays([a, b], tz)).toHaveLength(2);
  });

  test("other videos, other days and other sources are untouched", () => {
    const merged = play(1, "AAAAAAAAAAA", "2026-10-18T08:00:00.000Z", "2026-10-18T09:10:00.000Z", 540);
    const otherVideo = play(2, "BBBBBBBBBBB", "2026-10-18T08:30:00.000Z", "2026-10-18T08:40:00.000Z", 600);
    const phone = { ...play(3, "AAAAAAAAAAA", "2026-10-18T08:30:00.000Z", "2026-10-18T08:40:00.000Z", 600), source_kind: "phone_play" };
    expect(dropSupersededActivityWatchPlays([merged, otherVideo, phone], tz)).toHaveLength(3);
  });
});
