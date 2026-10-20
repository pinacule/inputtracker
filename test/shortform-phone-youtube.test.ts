import { describe, expect, test } from "bun:test";
import type { ConsumptionEvent } from "../src/server/aggregate.ts";
import { dedupeShortform } from "../src/server/shortform.ts";

const tz = "Europe/Bratislava";
let id = 0;
function ev(e: Partial<ConsumptionEvent>): ConsumptionEvent {
  return { id: ++id, source: "phone", source_kind: "shortform_day", media_type: "shortform", title: null,
    started_at: "2026-10-19T22:00:00.000Z", duration_seconds: 0, ...e } as ConsumptionEvent;
}

describe("phone YouTube app total minus recorded phone video plays", () => {
  test("the remainder is short-form; Instagram is untouched", () => {
    const out = dedupeShortform([
      ev({ source_id: "phone:youtube:2026-10-20", duration_seconds: 3600 }),
      ev({ source_id: "phone:instagram:2026-10-20", duration_seconds: 1800 }),
      ev({ source: "youtube", source_kind: "phone_play", media_type: "video", source_id: "p1",
        started_at: "2026-10-20T08:00:00.000Z", duration_seconds: 1500 }),
    ], tz);
    const yt = out.find((e) => e.source_id === "phone:youtube:2026-10-20");
    expect(yt?.duration_seconds).toBe(2100);
    expect(out.find((e) => e.source_id === "phone:instagram:2026-10-20")?.duration_seconds).toBe(1800);
  });

  test("plays covering the whole app time leave no short-form; other days unaffected", () => {
    const out = dedupeShortform([
      ev({ source_id: "phone:youtube:2026-10-20", duration_seconds: 600 }),
      ev({ source_id: "phone:youtube:2026-10-21", started_at: "2026-10-20T22:00:00.000Z", duration_seconds: 600 }),
      ev({ source: "youtube", source_kind: "phone_play", media_type: "video", source_id: "p2",
        started_at: "2026-10-20T09:00:00.000Z", duration_seconds: 900 }),
    ], tz);
    expect(out.some((e) => e.source_id === "phone:youtube:2026-10-20")).toBe(false);
    expect(out.find((e) => e.source_id === "phone:youtube:2026-10-21")?.duration_seconds).toBe(600);
  });

  test("music plays are not subtracted", () => {
    const out = dedupeShortform([
      ev({ source_id: "phone:youtube:2026-10-20", duration_seconds: 600 }),
      ev({ source: "youtube", source_kind: "phone_play", media_type: "music", source_id: "m1",
        started_at: "2026-10-20T09:00:00.000Z", duration_seconds: 500 }),
    ], tz);
    expect(out.find((e) => e.source_id === "phone:youtube:2026-10-20")?.duration_seconds).toBe(600);
  });
});
