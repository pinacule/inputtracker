import { describe, expect, test } from "bun:test";
import { openDb } from "../src/core/db.ts";
import { insertEvents, type NewEvent } from "../src/core/events.ts";
import {
  CONSUMPTION_KINDS,
  getLatestConsumptionEvents,
} from "../src/server/aggregate.ts";

function video(kind: string, id: string): NewEvent {
  return {
    source: "youtube",
    source_kind: kind,
    source_id: `${id}:2026-10-10T18:00:00.000Z`,
    media_type: "video",
    title: `Synthetic video ${id}`,
    started_at: "2026-10-10T18:00:00.000Z",
    ended_at: "2026-10-10T18:10:00.000Z",
    duration_seconds: 600,
  };
}

describe("consumption kinds", () => {
  test("ActivityWatch and phone plays count as consumption", () => {
    expect(CONSUMPTION_KINDS.has("aw_play")).toBe(true);
    expect(CONSUMPTION_KINDS.has("phone_play")).toBe(true);
  });

  test("the SQL reads return every consumption kind and nothing else", () => {
    const db = openDb(":memory:");
    insertEvents(db, null, [
      video("aw_play", "AAAAAAAAAA1"),
      video("phone_play", "AAAAAAAAAA2"),
      video("history_item", "AAAAAAAAAA3"),
      video("media_progress", "AAAAAAAAAA4"),
    ]);
    for (const events of [
      getLatestConsumptionEvents(db),
      getLatestConsumptionEvents(db, "youtube"),
    ]) {
      expect(events.map((e) => e.source_kind).sort()).toEqual([
        "aw_play",
        "history_item",
        "phone_play",
      ]);
    }
    db.close();
  });
});
