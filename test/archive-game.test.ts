import { expect, test } from "bun:test";
import { openDb } from "../src/core/db.ts";
import { saveArchiveEntry } from "../src/server/archive.ts";
import { buildAllLibraryWorks } from "../src/server/library.ts";
import { buildManualWork } from "../web/src/lib/archive-form.ts";

test("a manual game archive entry is a Game in the library with its hours played", () => {
  const built = buildManualWork({ category: "game", title: "Synthetic Starfall Odyssey", year: "2024", runtime_minutes: "2700" });
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  const db = openDb(":memory:");
  saveArchiveEntry(db, {
    entry_id: "55555555-5555-4555-8555-555555555555",
    work: built.work,
    consumed: { progress: 1 },
    when: { precision: "year", date: "2025" },
  }, "Europe/Bratislava");
  const works = buildAllLibraryWorks(db);
  expect(works).toHaveLength(1);
  expect(works[0]!.work.category).toBe("game");
  expect(works[0]!.work.total_minutes).toBe(2700);
});
