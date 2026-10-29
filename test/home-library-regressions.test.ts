import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import { buildAllLibraryWorks, editLibraryWork } from "../src/server/library.ts";
import { getProgressLists } from "../src/server/aggregate.ts";
import { isIgnoredNonAuthor, parseBookAuthors } from "../src/server/covers.ts";
import { getSeries } from "../src/server/review.ts";
import { formatHomeWorkProgress, buildHomeDayDetailModel, buildLibraryWorkLookup } from "../web/src/lib/home.ts";
import { formatWorkCardMeta } from "../web/src/lib/categories.ts";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });
function seed(events: NewEvent[]) {
  db ??= openDb(":memory:");
  insertEvents(db, startRun(db, "synthetic"), events);
  return db;
}
function session(overrides: Partial<NewEvent> = {}): NewEvent {
  return { source: "audiobookshelf", source_kind: "listening_session", source_id: "synthetic-session",
    media_type: "audiobook", title: "Synthetic River Journey", parent_title: "Synthetic Author",
    external_ids: { abs_item: "synthetic-item" }, started_at: "2026-10-19T10:00:00Z",
    duration_seconds: 4260, progress: 0.06, ...overrides };
}

describe("shared creator junk filter", () => {
  test("folder/publisher placeholders disappear, valid authors survive mixed lists", () => {
    for (const junk of ["Downloads", "GraphicAudio", "Graphic Audio LLC", "Audible Studios", "Unknown", "  UNKNOWN AUTHOR  ", "BBC Audio"]) {
      expect(isIgnoredNonAuthor(junk)).toBe(true);
      expect(parseBookAuthors(junk)).toEqual([]);
      const database = seed([session({ parent_title: junk, raw: { mediaMetadata: { authorName: junk } } })]);
      expect(buildAllLibraryWorks(database)[0]?.work.creator).toBeNull();
      database.close(); db = undefined;
    }
    expect(parseBookAuthors("Downloads; Synthetic Novelist; Audible Studios")).toEqual(["Synthetic Novelist"]);
  });
  test("junk primary metadata falls through to a valid display author", () => {
    const database = seed([session({ parent_title: "Downloads", raw: {
      mediaMetadata: { authorName: "GraphicAudio" }, displayAuthor: "Synthetic Novelist",
    } })]);
    const work = buildAllLibraryWorks(database)[0]!;
    expect(work.work.creator).toBe("Synthetic Novelist");
    expect(work.detail.creator).toBe("Synthetic Novelist");
  });
});

describe("position versus listening time", () => {
  test("latest snapshot wins over old session positions, and reset is not lost", () => {
    const database = seed([session({ progress: 0.9 }), session({ source_kind: "media_progress",
      source_id: "synthetic-item", duration_seconds: null, progress: 0.06, started_at: "2026-10-20T10:00:00Z" })]);
    let work = buildAllLibraryWorks(database)[0]!.work;
    expect(work.consumption_progress).toBe(getProgressLists(database).in_progress[0]?.progress);
    expect(work.total_minutes).toBe(71);
    expect(formatHomeWorkProgress(work)).toEqual({ label: "6% · 1h 11m", percent: 6 });
    expect(formatWorkCardMeta(work)).toBe("6% · 1h 11m · 1 session");
    const detail = buildHomeDayDetailModel({ date: "2026-10-19", todayStr: "2026-10-20", libraryLookup: buildLibraryWorkLookup([work]), day: {
      date: "2026-10-19", minutes: 71, count: 1, items: [{ id: 1, source: "audiobookshelf", media_type: "audiobook", title: work.title,
        parent_title: null, season: null, episode: null, started_at: "2026-10-19T10:00:00Z", local_time: "12:00", duration_seconds: 4260, cover_url: null }],
    } });
    expect(detail.works[0]?.subtitle).toBe("6% · Synthetic Author");
    seed([session({ source_kind: "media_progress", source_id: "synthetic-item", duration_seconds: null,
      progress: 0, started_at: "2026-10-20T11:00:00Z" })]);
    work = buildAllLibraryWorks(database)[0]!.work;
    expect(work.consumption_progress).toBe(0);
    expect(formatHomeWorkProgress(work, 0.9)).toEqual({ label: "0% · 1h 11m", percent: 0 });
    expect(database.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 3 });
  });
  test("without a snapshot use latest session position, never max or accumulated time", () => {
    const database = seed([session({ progress: 0.8 }), session({ source_id: "synthetic-later-session", progress: 0.06, started_at: "2026-10-20T10:00:00Z" })]);
    const work = buildAllLibraryWorks(database)[0]!.work;
    expect(work.consumption_progress).toBe(0.06);
    expect(work.total_minutes).toBe(142);
  });
});

test("series norm-history boundary is before range/category filtering; hidden/planned don't count", async () => {
  const database = seed([
    session({ title: "Synthetic Hidden Book", source_id: "hidden", external_ids: { abs_item: "hidden-item" }, started_at: "2026-01-01T10:00:00Z" }),
    session({ title: "Synthetic Planned Book", source_id: "planned", external_ids: { abs_item: "planned-item" }, started_at: "2026-02-01T10:00:00Z" }),
    session({ started_at: "2026-03-28T23:30:00Z" }), // Bratislava March 29, DST day.
    session({ source: "youtube", source_kind: "phone_play", source_id: "synthetic-phone-play", media_type: "video",
      title: "Synthetic Video", parent_title: "Synthetic Channel", external_ids: {}, started_at: "2026-10-19T22:00:00Z", duration_seconds: 2820 }),
  ]);
  const works = buildAllLibraryWorks(database);
  await editLibraryWork(database, works.find((w) => w.work.title === "Synthetic Hidden Book")!.work.key, { hidden: true });
  await editLibraryWork(database, works.find((w) => w.work.title === "Synthetic Planned Book")!.work.key, { status: "planned" });
  const result = getSeries(database, { bucket: "day", from: "2026-10-19", to: "2026-10-20", category: "youtube" });
  expect(result.history_start).toBe("2026-03-29");
  expect(result.points[0]?.minutes_by_category).toEqual({});
  expect(result.points[1]?.minutes_by_category).toEqual({ youtube: 47 });
});
