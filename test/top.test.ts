import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../src/core/config.ts";
import type { LibraryWork } from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import { insertEvents, type NewEvent } from "../src/core/events.ts";
import { aggregateTop, getTop } from "../src/server/top.ts";
import { registerV2Routes } from "../src/server/v2-routes.ts";
import { editLibraryWork, getLibrary } from "../src/server/library.ts";
import type { DedupedEvent } from "../src/server/dedup.ts";

function work(key: string, title: string, creator: string, durations: number[], category: "music" | "youtube" = "music") {
  return {
    work: { key, title, creator, channel: creator, category, status: "finished" } as LibraryWork,
    events: durations.map((duration_seconds, i): DedupedEvent => ({ id: i, source: "youtube", source_kind: "phone_play", media_type: category === "music" ? "music" : "video", title, duration_seconds, started_at: `2026-10-${String(17 + i).padStart(2, "0")}T10:00:00Z` })),
  };
}

test("pure top lists clean artists, sum sources, distinguish songs and sort deterministic ties", () => {
  const works = [work("a", "Alpha", "Fake Artist - Topic", [60, 60]), work("b", "Beta", "Fake Artist", [180]), work("c", "Gamma", "Other Artist", [600]), work("z", "Zeta", "Other Artist", [60, 60]), work("v", "Video", "Synthetic Channel", [900], "youtube")];
  works[0]!.events[1]!.source = "phone";
  expect(aggregateTop(works, { kind: "artists" }).entries).toEqual([
    { key: "other artist", title: "Other Artist", creator: null, plays: 3, total_minutes: 12 },
    { key: "fake artist", title: "Fake Artist", creator: null, plays: 3, total_minutes: 5 },
  ]);
  expect(aggregateTop(works, { kind: "songs", by: "plays" }).entries.map((e) => e.title)).toEqual(["Alpha", "Zeta", "Gamma", "Beta"]);
  expect(aggregateTop(works, { kind: "songs", by: "time", limit: 2 }).entries.map((e) => e.title)).toEqual(["Gamma", "Beta"]);
  expect(aggregateTop(works, { kind: "channels" }).entries[0]).toEqual({ key: "synthetic channel", title: "Synthetic Channel", creator: null, plays: 1, total_minutes: 15 });
});

test("range bounds use local days, exclude undated events, and support arbitrary review ranges", () => {
  const song = work("a", "Alpha", "Fake Artist", [60, 60]);
  song.events[0]!.started_at = "2026-09-30T22:30:00Z"; // October locally
  song.events[1]!.started_at = "2026-10-31T23:30:00Z"; // November locally
  expect(aggregateTop([song], { kind: "songs", from: "2026-10-01", to: "2026-10-31" }).entries[0]?.plays).toBe(1);
  expect(aggregateTop([song], { kind: "songs", from: "2026-11-01", to: "2026-11-01" }).entries[0]?.plays).toBe(1);
  expect(aggregateTop([song], { kind: "songs", from: "2025-01-01", to: "2025-12-31" }).entries).toEqual([]);
  song.events[0]!.source_kind = "archive";
  song.events[0]!.raw = { when: { precision: "unknown" } };
  expect(aggregateTop([song], { kind: "songs", from: "2026-10-01", to: "2026-10-31" }).entries).toEqual([]);
  expect(aggregateTop([song], { kind: "songs" }).entries[0]?.plays).toBe(2);
});

test("top HTTP validates query, and library-derived rankings use latest revisions and hidden overrides", async () => {
  const db = openDb(":memory:");
  const app = new Hono();
  registerV2Routes(app, { db, config: { timezone: "Europe/Bratislava" } as Config });
  const music: NewEvent = { source: "youtube", source_kind: "phone_play", source_id: "fake-play", media_type: "music", title: "Fake Song", parent_title: "Fake Artist - Topic", started_at: "2026-10-17T10:00:00Z", duration_seconds: 60, external_ids: { youtube_video: "FakeSong001" } };
  insertEvents(db, null, [music, { ...music, duration_seconds: 120 }]);
  expect(getTop(db, { kind: "songs" }).entries[0]?.plays).toBe(1);
  expect(getTop(db, { kind: "songs" }).entries[0]?.total_minutes).toBe(2);
  expect(getTop(db, { kind: "artists" }).entries[0]?.title).toBe("Fake Artist");
  expect((await app.request("/api/top?kind=songs&by=time&from=2026-10-01&to=2026-10-31&limit=1")).status).toBe(200);
  for (const query of ["", "kind=bad", "kind=songs&by=bad", "kind=songs&from=2026-02-30", "kind=songs&from=2026-11-01&to=2026-10-01", "kind=songs&limit=0", "kind=songs&limit=201", "kind=songs&limit=1.5", "kind=songs&unknown=1"]) expect((await app.request(`/api/top?${query}`)).status).toBe(400);
  const key = getLibrary(db).works[0]!.key;
  await editLibraryWork(db, key, { hidden: true });
  expect(getTop(db, { kind: "songs" }).entries).toEqual([]);
  db.close();
});

test("rankings join music sources, dedupe Takeout against measured plays, and follow work edits", async () => {
  const db = openDb(":memory:");
  const song: NewEvent = { source: "youtube", source_kind: "phone_play", source_id: "phone-song", media_type: "music", title: "Synthetic Song", parent_title: "Synthetic Artist - Topic", started_at: "2026-10-17T10:00:00Z", duration_seconds: 60, external_ids: { youtube_video: "FakeSong001" } };
  insertEvents(db, null, [
    song,
    { ...song, source_kind: "history_item", source_id: "covered-takeout", duration_seconds: 240 },
    { ...song, source_kind: "aw_play", source_id: "aw-song", started_at: "2026-10-18T10:00:00Z", duration_seconds: 120 },
    { ...song, source_kind: "history_item", source_id: "older-takeout", started_at: "2026-10-16T10:00:00Z", duration_seconds: 180 },
    { ...song, source: "phone", source_id: "phone-music", started_at: "2026-10-19T10:00:00Z", duration_seconds: 240 },
    { ...song, source_kind: "phone_play", source_id: "video", media_type: "video", title: "Synthetic Video", parent_title: "Synthetic Channel", duration_seconds: 600, external_ids: { youtube_video: "FakeVideo01" } },
  ]);
  expect(getTop(db, { kind: "songs" }).entries).toHaveLength(1);
  expect(getTop(db, { kind: "songs" }).entries[0]).toMatchObject({ title: "Synthetic Song", plays: 4, total_minutes: 10 });
  expect(getTop(db, { kind: "artists" }).entries[0]).toMatchObject({ title: "Synthetic Artist", plays: 4, total_minutes: 10 });
  expect(getTop(db, { kind: "channels" }).entries[0]).toMatchObject({ title: "Synthetic Channel", plays: 1, total_minutes: 10 });
  const library = getLibrary(db, { category: "music", sort: "plays" });
  const key = library.works[0]!.key;
  await editLibraryWork(db, key, { title: "Renamed Synthetic Song" });
  expect(getTop(db, { kind: "songs", from: "2026-10-18", to: "2026-10-19" }).entries[0]).toMatchObject({ title: "Renamed Synthetic Song", plays: 2, total_minutes: 6 });
  await editLibraryWork(db, key, { category: "other" });
  expect(getTop(db, { kind: "songs" }).entries).toEqual([]);
  db.close();
});

test("ranking ties use title and key, and missing creators do not invent artists or channels", () => {
  const works = [work("b", "Same", "", [60]), work("a", "Same", "", [60]), work("v", "Video", "", [600], "youtube")];
  expect(aggregateTop(works, { kind: "songs" }).entries.map((e) => e.key)).toEqual(["a", "b"]);
  expect(aggregateTop(works, { kind: "artists" }).entries).toEqual([]);
  expect(aggregateTop(works, { kind: "channels" }).entries).toEqual([]);
});
