import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { insertEvents, type NewEvent } from "../src/core/events.ts";
import { getDisplayConsumptionEvents } from "../src/server/aggregate.ts";

const TZ = "Europe/Bratislava";
const book = (id: string, title: string): NewEvent => ({
  source: "audiobookshelf",
  source_kind: "listening_session",
  source_id: id,
  media_type: "audiobook",
  title,
  started_at: "2026-07-01T10:00:00.000Z",
  ended_at: "2026-07-01T11:00:00.000Z",
  duration_seconds: 3600,
});

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("display events cache", () => {
  test("is reused until this connection writes", () => {
    const db = openDb(":memory:");
    insertEvents(db, null, [book("s1", "Synthetic Book One")]);
    const first = getDisplayConsumptionEvents(db, undefined, TZ);
    expect(first.map((e) => e.title)).toEqual(["Synthetic Book One"]);
    expect(getDisplayConsumptionEvents(db, undefined, TZ)[0]).toBe(first[0]!);

    insertEvents(db, null, [book("s2", "Synthetic Book Two")]);
    expect(getDisplayConsumptionEvents(db, undefined, TZ).map((e) => e.title).sort())
      .toEqual(["Synthetic Book One", "Synthetic Book Two"]);
  });

  test("sees commits from another connection (a sync run in another process)", () => {
    dir = mkdtempSync(join(tmpdir(), "it-display-cache-"));
    const path = join(dir, "a.db");
    const server = openDb(path);
    insertEvents(server, null, [book("s1", "Synthetic Book One")]);
    expect(getDisplayConsumptionEvents(server, undefined, TZ)).toHaveLength(1);

    const sync = openDb(path);
    insertEvents(sync, null, [book("s2", "Synthetic Book Two")]);
    sync.close();
    expect(getDisplayConsumptionEvents(server, undefined, TZ)).toHaveLength(2);
    server.close();
  });

  test("callers get their own array and cannot change cached events", () => {
    const db = openDb(":memory:");
    insertEvents(db, null, [book("s1", "Synthetic Book One")]);
    const a = getDisplayConsumptionEvents(db, undefined, TZ);
    a.pop();
    expect(getDisplayConsumptionEvents(db, undefined, TZ)).toHaveLength(1);
    expect(() => { (getDisplayConsumptionEvents(db, undefined, TZ)[0] as { title: string }).title = "x"; }).toThrow();
  });
});
