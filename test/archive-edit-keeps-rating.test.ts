import { describe, expect, test } from "bun:test";
import { openDb } from "../src/core/db.ts";
import { getArchiveEntry, saveArchiveEntry } from "../src/server/archive.ts";

describe("reading an entry for editing keeps its rating", () => {
  test("a rated, linked entry comes back with its rating and note", () => {
    const db = openDb(":memory:");
    const entry_id = "44444444-4444-4444-8444-444444444444";
    saveArchiveEntry(db, {
      entry_id,
      work: {
        provider: "tvmaze", provider_id: "9001", category: "series", title: "Synthetic Saga",
        original_title: null, year: 2015, cover_url: "/api/meta-cover/tvmaze/9001", creators: [],
        genres: [], description: null,
        seasons: [1, 2].map((n) => ({ number: n, title: null, year: 2015, episodes: 10, episode_minutes: 30, total_minutes: 300, provider_id: null })),
        runtime_minutes: null, pages: null, external_ids: { tvmaze: "9001" },
      },
      consumed: { seasons: [{ number: 1 }, { number: 2 }] },
      when: { precision: "unknown" },
      rating: 8.5,
      note: "synthetic note",
    }, "Europe/Bratislava");
    const read = getArchiveEntry(db, entry_id);
    expect(read.rating).toBe(8.5);
    expect(read.note).toBe("synthetic note");
    expect(read.work.provider).toBe("tvmaze");
  });
});
