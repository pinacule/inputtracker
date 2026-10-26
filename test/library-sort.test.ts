import { describe, expect, test } from "bun:test";
import type { LibraryWork } from "../src/core/contract";
import { libraryWorkProgress } from "../src/core/library-sort";
import { isValidLibrarySort } from "../src/server/library";
import { sortLibraryWorks } from "../web/src/lib/youtube";

function work(overrides: Partial<LibraryWork> & { key: string; title: string }): LibraryWork {
  return {
    category: "series",
    cover_url: null,
    total_minutes: 60,
    units: 1,
    first_at: "2026-10-01T10:00:00.000Z",
    last_at: "2026-10-01T10:00:00.000Z",
    status: "in_progress",
    rating: null,
    sources: ["manual"],
    edited: false,
    channel: null,
    topic: null,
    progress: null,
    creator: null,
    ...overrides,
  };
}

describe("Library rating / progress sorts and direction flip", () => {
  test("server accepts rating and progress sorts", () => {
    expect(isValidLibrarySort("rating")).toBe(true);
    expect(isValidLibrarySort("progress")).toBe(true);
    expect(isValidLibrarySort("bogus")).toBe(false);
  });

  test("libraryWorkProgress reads book position, episodes, seasons and status", () => {
    expect(libraryWorkProgress(work({ key: "a", title: "A", category: "book", consumption_progress: 0.42 }))).toBe(0.42);
    expect(
      libraryWorkProgress(
        work({
          key: "b",
          title: "B",
          progress: { seasons_watched: 1, seasons_total: 2, episodes_watched: 3, episodes_total: 12 },
        })
      )
    ).toBe(0.25);
    expect(
      libraryWorkProgress(
        work({
          key: "c",
          title: "C",
          progress: { seasons_watched: 1, seasons_total: 4, episodes_watched: 5, episodes_total: null },
        })
      )
    ).toBe(0.25);
    expect(libraryWorkProgress(work({ key: "d", title: "D", status: "finished" }))).toBe(1);
    expect(libraryWorkProgress(work({ key: "e", title: "E", status: "planned", consumption_progress: 0.5 }))).toBeNull();
    expect(libraryWorkProgress(work({ key: "f", title: "F" }))).toBeNull();
  });

  test("rating sort puts highest first, unrated last, and flips without moving unrated", () => {
    const works = [
      work({ key: "low", title: "Low", rating: 4 }),
      work({ key: "none", title: "None", rating: null }),
      work({ key: "high", title: "High", rating: 9.5 }),
      work({ key: "mid", title: "Mid", rating: 7 }),
    ];
    expect(sortLibraryWorks(works, "rating").map((w) => w.key)).toEqual(["high", "mid", "low", "none"]);
    expect(sortLibraryWorks(works, "rating", true).map((w) => w.key)).toEqual(["low", "mid", "high", "none"]);
  });

  test("progress sort starts closest to 100% (not 100%), then finished, then unknown", () => {
    const works = [
      work({ key: "done", title: "Done", status: "finished" }),
      work({ key: "half", title: "Half", category: "book", consumption_progress: 0.5 }),
      work({ key: "unknown", title: "Unknown" }),
      work({ key: "almost", title: "Almost", category: "audiobook", consumption_progress: 0.95 }),
      work({
        key: "start",
        title: "Start",
        progress: { seasons_watched: 1, seasons_total: 3, episodes_watched: 1, episodes_total: 20 },
      }),
    ];
    expect(sortLibraryWorks(works, "progress").map((w) => w.key)).toEqual([
      "almost",
      "half",
      "start",
      "done",
      "unknown",
    ]);
    expect(sortLibraryWorks(works, "progress", true).map((w) => w.key)).toEqual([
      "start",
      "half",
      "almost",
      "done",
      "unknown",
    ]);
  });

  test("reversed flips recent and time", () => {
    const works = [
      work({ key: "old", title: "Old", last_at: "2026-09-01T10:00:00.000Z", total_minutes: 500 }),
      work({ key: "new", title: "New", last_at: "2026-10-20T10:00:00.000Z", total_minutes: 30 }),
    ];
    expect(sortLibraryWorks(works, "recent").map((w) => w.key)).toEqual(["new", "old"]);
    expect(sortLibraryWorks(works, "recent", true).map((w) => w.key)).toEqual(["old", "new"]);
    expect(sortLibraryWorks(works, "time", true).map((w) => w.key)).toEqual(["new", "old"]);
  });
});
