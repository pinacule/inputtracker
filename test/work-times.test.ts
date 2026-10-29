import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/core/db.ts";
import { insertEvents, startRun } from "../src/core/events.ts";
import { buildAllLibraryWorks, editLibraryWork } from "../src/server/library.ts";
import { parseWorkEdit, WorkOverrideValidationError } from "../src/server/overrides.ts";
import { timesLabel } from "../web/src/lib/categories.ts";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

test("times watched is saved, survives other edits, clears with null, and adds no time", async () => {
  db = openDb(":memory:");
  insertEvents(db, startRun(db, "synthetic"), [{
    source: "manual", source_kind: "history_item", source_id: "synthetic-film-1", media_type: "movie",
    title: "Synthetic Film", started_at: "2026-10-01T18:00:00Z", duration_seconds: 6000,
  }]);
  const key = buildAllLibraryWorks(db)[0]!.work.key;
  expect(buildAllLibraryWorks(db)[0]!.work.times).toBeUndefined();

  await editLibraryWork(db, key, { times: 3 });
  await editLibraryWork(db, key, { rating: 8.4 });
  let work = buildAllLibraryWorks(db)[0]!.work;
  expect(work.times).toBe(3);
  expect(work.rating).toBe(8.4);
  expect(work.total_minutes).toBe(100);
  expect(work.edited).toBe(true);

  await editLibraryWork(db, key, { times: null });
  work = buildAllLibraryWorks(db)[0]!.work;
  expect(work.times).toBeUndefined();
  expect(work.rating).toBe(8.4);
});

test("times must be a whole number from 0 to 999", () => {
  expect(parseWorkEdit({ times: 0 }).times).toBe(0);
  for (const bad of [-1, 1000, 2.5, "3"]) {
    expect(() => parseWorkEdit({ times: bad })).toThrow(WorkOverrideValidationError);
  }
});

test("label follows the category", () => {
  expect(timesLabel("film")).toBe("Times watched");
  expect(timesLabel("book")).toBe("Times read");
  expect(timesLabel("audiobook")).toBe("Times listened");
  expect(timesLabel("game")).toBe("Times played");
  expect(timesLabel("other")).toBe("Times completed");
});
