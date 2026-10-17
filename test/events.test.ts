import { beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/core/db.ts";
import {
  finishRun,
  insertEvents,
  normalize,
  recordHash,
  startRun,
  type NewEvent,
} from "../src/core/events.ts";
import type { EventRow, IngestRunRow } from "../src/core/schema.ts";

describe("events core", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  describe("normalize", () => {
    test("omitted optionals → null", () => {
      const minimal: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-001",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00Z",
      };

      const norm = normalize(minimal);

      expect(norm.source).toBe("audiobookshelf");
      expect(norm.source_kind).toBe("session");
      expect(norm.source_id).toBe("fake-001");
      expect(norm.media_type).toBe("audiobook");
      expect(norm.started_at).toBe("2026-10-17T08:15:00.000Z");

      expect(norm.external_ids).toBeNull();
      expect(norm.title).toBeNull();
      expect(norm.parent_title).toBeNull();
      expect(norm.season).toBeNull();
      expect(norm.episode).toBeNull();
      expect(norm.ended_at).toBeNull();
      expect(norm.duration_seconds).toBeNull();
      expect(norm.progress).toBeNull();
      expect(norm.device).toBeNull();
      expect(norm.raw).toBeNull();
    });

    test("empty strings in title/parent_title/device → null", () => {
      const event: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-002",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00Z",
        title: "   ",
        parent_title: "",
        device: "   ",
      };

      const norm = normalize(event);
      expect(norm.title).toBeNull();
      expect(norm.parent_title).toBeNull();
      expect(norm.device).toBeNull();
    });

    test("trims non-empty strings", () => {
      const event: NewEvent = {
        source: "  audiobookshelf  ",
        source_kind: "  session  ",
        source_id: "  fake-003  ",
        media_type: "audiobook",
        started_at: "  2026-10-17T08:15:00Z  ",
        title: "  Fake Book One  ",
        parent_title: "  Fake Author  ",
        device: "  Fake Mobile  ",
      };

      const norm = normalize(event);
      expect(norm.source).toBe("audiobookshelf");
      expect(norm.source_kind).toBe("session");
      expect(norm.source_id).toBe("fake-003");
      expect(norm.title).toBe("Fake Book One");
      expect(norm.parent_title).toBe("Fake Author");
      expect(norm.device).toBe("Fake Mobile");
    });

    test("invalid date throws", () => {
      expect(() => {
        normalize({
          source: "audiobookshelf",
          source_kind: "session",
          source_id: "fake-004",
          media_type: "audiobook",
          started_at: "not-a-valid-date",
        });
      }).toThrow(/invalid timestamp/i);

      expect(() => {
        normalize({
          source: "audiobookshelf",
          source_kind: "session",
          source_id: "fake-004",
          media_type: "audiobook",
          started_at: "2026-10-17T08:15:00Z",
          ended_at: "invalid-date",
        });
      }).toThrow(/invalid timestamp/i);
    });

    test("naive timestamp without timezone parsed deterministically as UTC", () => {
      const norm = normalize({
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-004-tz",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00",
      });
      expect(norm.started_at).toBe("2026-10-17T08:15:00.000Z");
    });

    test("progress validation: 1.5 throws, negative throws, 0..1 succeeds", () => {
      const base: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-005",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00Z",
      };

      expect(() => normalize({ ...base, progress: 1.5 })).toThrow(/between 0 and 1/i);
      expect(() => normalize({ ...base, progress: -0.1 })).toThrow(/between 0 and 1/i);
      expect(() => normalize({ ...base, progress: NaN })).toThrow(/finite number/i);

      expect(normalize({ ...base, progress: 0 }).progress).toBe(0);
      expect(normalize({ ...base, progress: 0.5 }).progress).toBe(0.5);
      expect(normalize({ ...base, progress: 1 }).progress).toBe(1);
    });

    test("missing source_id throws", () => {
      expect(() => {
        normalize({
          source: "audiobookshelf",
          source_kind: "session",
          source_id: "",
          media_type: "audiobook",
          started_at: "2026-10-17T08:15:00Z",
        });
      }).toThrow(/source_id/i);

      expect(() => {
        normalize({
          source: "audiobookshelf",
          source_kind: "session",
          source_id: "   ",
          media_type: "audiobook",
          started_at: "2026-10-17T08:15:00Z",
        });
      }).toThrow(/source_id/i);
    });

    test("other required fields missing or empty throw", () => {
      const valid: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-006",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00Z",
      };

      expect(() => normalize({ ...valid, source: "" })).toThrow(/source/i);
      expect(() => normalize({ ...valid, source_kind: "" })).toThrow(/source_kind/i);
      expect(() => normalize({ ...valid, media_type: "" as any })).toThrow(/media_type/i);
      expect(() => normalize({ ...valid, media_type: "unknown_type" as any })).toThrow(/invalid media_type/i);
      expect(() => normalize({ ...valid, started_at: "" })).toThrow(/started_at/i);
    });

    test("non-object event throws", () => {
      expect(() => normalize(null as any)).toThrow(/Event must be an object/i);
      expect(() => normalize(undefined as any)).toThrow(/Event must be an object/i);
      expect(() => normalize("not-an-object" as any)).toThrow(/Event must be an object/i);
    });

    test("external_ids keys are sorted and preserved, including nested arrays/objects", () => {
      const norm = normalize({
        source: "simkl",
        source_kind: "history_item",
        source_id: "fake-007",
        media_type: "movie",
        started_at: "2026-10-17T08:15:00Z",
        external_ids: {
          tmdb: "987",
          imdb: "tt123456",
          anidb: 543,
          nested: { z: 1, a: 2 },
          list: [{ y: "val1", x: "val2" }],
        },
      });

      expect(norm.external_ids).not.toBeNull();
      expect(Object.keys(norm.external_ids!)).toEqual(["anidb", "imdb", "list", "nested", "tmdb"]);
      expect(Object.keys((norm.external_ids as any).nested)).toEqual(["a", "z"]);
      expect(Object.keys((norm.external_ids as any).list[0])).toEqual(["x", "y"]);
    });

    test("numeric validation: non-finite season/episode/duration_seconds throw", () => {
      const base: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-008",
        media_type: "episode",
        started_at: "2026-10-17T08:15:00Z",
      };

      expect(() => normalize({ ...base, season: Infinity })).toThrow(/season.*finite number/i);
      expect(() => normalize({ ...base, episode: NaN })).toThrow(/episode.*finite number/i);
      expect(() => normalize({ ...base, duration_seconds: -Infinity })).toThrow(/duration_seconds.*finite number/i);
    });
  });

  describe("recordHash", () => {
    test("hash identical for different key order of input and of external_ids", () => {
      const inputA: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-010",
        external_ids: { z_id: "999", a_id: "111" },
        media_type: "audiobook",
        title: "Fake Book One",
        parent_title: "Fake Author",
        started_at: "2026-10-17T08:15:00.000Z",
        duration_seconds: 1800,
        progress: 0.5,
      };

      const inputB: NewEvent = {
        progress: 0.5,
        title: "Fake Book One",
        started_at: "2026-10-17T08:15:00.000Z",
        source_id: "fake-010",
        media_type: "audiobook",
        external_ids: { a_id: "111", z_id: "999" },
        duration_seconds: 1800,
        source_kind: "session",
        parent_title: "Fake Author",
        source: "audiobookshelf",
      };

      expect(recordHash(inputA)).toBe(recordHash(inputB));
    });

    test("hash identical when optional fields are omitted vs explicitly set to null", () => {
      const eOmitted: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-010-opt",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00.000Z",
      };

      const eExplicitNull: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-010-opt",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00.000Z",
        title: null,
        parent_title: null,
        external_ids: null,
        season: null,
        episode: null,
        ended_at: null,
        duration_seconds: null,
        progress: null,
        device: null,
        raw: null,
      };

      expect(recordHash(eOmitted)).toBe(recordHash(eExplicitNull));
    });

    test("hash identical for +02:00 vs Z spelling of the same instant", () => {
      const eUtc: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-011",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00.000Z",
      };

      const eOffset: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-011",
        media_type: "audiobook",
        started_at: "2026-10-17T10:15:00+02:00",
      };

      const eNoMs: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-011",
        media_type: "audiobook",
        started_at: "2026-10-17T08:15:00Z",
      };

      const hUtc = recordHash(eUtc);
      expect(recordHash(eOffset)).toBe(hUtc);
      expect(recordHash(eNoMs)).toBe(hUtc);
    });

    test("hash different when title / progress / started_at differ", () => {
      const base: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-012",
        media_type: "audiobook",
        title: "Fake Book One",
        started_at: "2026-10-17T08:15:00.000Z",
        progress: 0.25,
      };

      const baseHash = recordHash(base);

      const diffTitle: NewEvent = { ...base, title: "Fake Book Two" };
      expect(recordHash(diffTitle)).not.toBe(baseHash);

      const diffProgress: NewEvent = { ...base, progress: 0.75 };
      expect(recordHash(diffProgress)).not.toBe(baseHash);

      const diffStartedAt: NewEvent = { ...base, started_at: "2026-10-17T08:16:00.000Z" };
      expect(recordHash(diffStartedAt)).not.toBe(baseHash);
    });

    test("raw, ingested_at, and id do not affect hash", () => {
      const base: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-013",
        media_type: "audiobook",
        title: "Fake Book One",
        started_at: "2026-10-17T08:15:00.000Z",
        raw: { original_payload: "synthetic payload 1" },
      };

      const baseHash = recordHash(base);

      const withDiffRaw: NewEvent = {
        ...base,
        raw: { different: "synthetic payload 2", extra: 123 },
      };
      expect(recordHash(withDiffRaw)).toBe(baseHash);

      const withNullRaw: NewEvent = {
        ...base,
        raw: null,
      };
      expect(recordHash(withNullRaw)).toBe(baseHash);

      const withExtraProps = {
        ...base,
        id: 999,
        ingested_at: "2026-10-17T12:00:00.000Z",
        ingest_run_id: 42,
      };
      expect(recordHash(withExtraProps)).toBe(baseHash);
    });
  });

  describe("insertEvents", () => {
    test("empty iterable returns seen: 0, inserted: 0", () => {
      const runId = startRun(db, "audiobookshelf", "sync");
      const res = insertEvents(db, runId, []);
      expect(res).toEqual({ seen: 0, inserted: 0 });
    });

    test("same input inserted twice → second call inserted: 0, table row count unchanged", () => {
      const runId = startRun(db, "audiobookshelf", "sync");

      const event: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-020",
        media_type: "audiobook",
        title: "Fake Book One",
        started_at: "2026-10-17T08:15:00.000Z",
        progress: 0.1,
      };

      const firstRes = insertEvents(db, runId, [event]);
      expect(firstRes).toEqual({ seen: 1, inserted: 1 });

      const count1 = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;")
        .get();
      expect(count1?.count).toBe(1);

      // Repeat insert of identical event
      const secondRes = insertEvents(db, runId, [event]);
      expect(secondRes).toEqual({ seen: 1, inserted: 0 });

      const count2 = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;")
        .get();
      expect(count2?.count).toBe(1);
    });

    test("changed progress → new row; events_latest shows only the new one for that key", () => {
      const runId = startRun(db, "audiobookshelf", "sync");

      const event1: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-021",
        media_type: "audiobook",
        title: "Fake Book One",
        started_at: "2026-10-17T08:00:00.000Z",
        progress: 0.2,
        duration_seconds: 120,
      };

      insertEvents(db, runId, [event1]);

      const initialLatest = db
        .query<EventRow, []>(
          "SELECT * FROM events_latest WHERE source = 'audiobookshelf' AND source_id = 'fake-021';"
        )
        .get();
      expect(initialLatest?.progress).toBe(0.2);
      expect(initialLatest?.duration_seconds).toBe(120);

      const event2: NewEvent = {
        ...event1,
        progress: 0.75,
        duration_seconds: 450,
      };

      const res2 = insertEvents(db, runId, [event2]);
      expect(res2).toEqual({ seen: 1, inserted: 1 });

      const totalCount = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;")
        .get();
      expect(totalCount?.count).toBe(2);

      const latestRows = db
        .query<EventRow, []>(
          "SELECT * FROM events_latest WHERE source = 'audiobookshelf' AND source_id = 'fake-021';"
        )
        .all();
      expect(latestRows).toHaveLength(1);
      expect(latestRows[0]?.progress).toBe(0.75);
      expect(latestRows[0]?.duration_seconds).toBe(450);
      expect(latestRows[0]?.id).toBe(2);
    });

    test("batch insert: multiple items, partial duplicates, and null runId", () => {
      const e1: NewEvent = {
        source: "manual",
        source_kind: "session",
        source_id: "fake-030",
        media_type: "book",
        title: "Fake Manual Book 1",
        started_at: "2026-10-17T07:00:00Z",
      };
      const e2: NewEvent = {
        source: "manual",
        source_kind: "session",
        source_id: "fake-031",
        media_type: "book",
        title: "Fake Manual Book 2",
        started_at: "2026-10-17T08:00:00Z",
      };

      const res1 = insertEvents(db, null, [e1]);
      expect(res1).toEqual({ seen: 1, inserted: 1 });

      // In second batch, provide e1 (duplicate), e2 (new), and e2 again (duplicate within same batch)
      const res2 = insertEvents(db, null, [e1, e2, e2]);
      expect(res2).toEqual({ seen: 3, inserted: 1 });

      const count = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;")
        .get();
      expect(count?.count).toBe(2);
    });

    test("atomic rollback: if any event in batch is invalid, transaction rolls back completely", () => {
      const runId = startRun(db, "audiobookshelf", "sync");

      const validEvent: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-040",
        media_type: "audiobook",
        started_at: "2026-10-17T08:00:00Z",
      };

      const invalidEvent: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-041",
        media_type: "audiobook",
        started_at: "invalid-timestamp",
      };

      expect(() => {
        insertEvents(db, runId, [validEvent, invalidEvent]);
      }).toThrow(/invalid timestamp/i);

      const count = db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM events;")
        .get();
      expect(count?.count).toBe(0);
    });

    test("stores JSON text for external_ids and raw", () => {
      const runId = startRun(db, "audiobookshelf", "sync");

      const event: NewEvent = {
        source: "audiobookshelf",
        source_kind: "session",
        source_id: "fake-050",
        media_type: "audiobook",
        started_at: "2026-10-17T08:00:00Z",
        external_ids: { asin: "B000FAKE", isbn: "9780000000000" },
        raw: { server_id: "abs-srv-01", extra: 42 },
      };

      insertEvents(db, runId, [event]);

      const row = db
        .query<EventRow, []>("SELECT * FROM events WHERE source_id = 'fake-050';")
        .get();

      expect(row).not.toBeNull();
      expect(row?.external_ids).toBe('{"asin":"B000FAKE","isbn":"9780000000000"}');
      expect(row?.raw).toBe('{"server_id":"abs-srv-01","extra":42}');
    });
  });

  describe("startRun / finishRun", () => {
    test("startRun throws on empty source", () => {
      expect(() => startRun(db, "")).toThrow(/source/i);
      expect(() => startRun(db, "   ")).toThrow(/source/i);
    });

    test("row goes running → ok with counts", () => {
      const runId = startRun(db, "audiobookshelf", "sync");
      expect(runId).toBeGreaterThan(0);

      const runningRow = db
        .query<IngestRunRow, [number]>("SELECT * FROM ingest_runs WHERE id = ?;")
        .get(runId);

      expect(runningRow).not.toBeNull();
      expect(runningRow?.status).toBe("running");
      expect(runningRow?.source).toBe("audiobookshelf");
      expect(runningRow?.kind).toBe("sync");
      expect(runningRow?.finished_at).toBeNull();
      expect(runningRow?.rows_seen).toBe(0);
      expect(runningRow?.rows_inserted).toBe(0);
      expect(runningRow?.error).toBeNull();

      finishRun(db, runId, {
        status: "ok",
        rowsSeen: 12,
        rowsInserted: 8,
      });

      const finishedRow = db
        .query<IngestRunRow, [number]>("SELECT * FROM ingest_runs WHERE id = ?;")
        .get(runId);

      expect(finishedRow).not.toBeNull();
      expect(finishedRow?.status).toBe("ok");
      expect(finishedRow?.rows_seen).toBe(12);
      expect(finishedRow?.rows_inserted).toBe(8);
      expect(typeof finishedRow?.finished_at).toBe("string");
      expect(finishedRow?.finished_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
      expect(finishedRow?.error).toBeNull();
    });

    test("failed with error text stored", () => {
      const runId = startRun(db, "simkl");

      finishRun(db, runId, {
        status: "failed",
        rowsSeen: 4,
        rowsInserted: 1,
        error: "Synthetic network error: connection timeout to fake host",
      });

      const failedRow = db
        .query<IngestRunRow, [number]>("SELECT * FROM ingest_runs WHERE id = ?;")
        .get(runId);

      expect(failedRow).not.toBeNull();
      expect(failedRow?.status).toBe("failed");
      expect(failedRow?.rows_seen).toBe(4);
      expect(failedRow?.rows_inserted).toBe(1);
      expect(failedRow?.error).toBe(
        "Synthetic network error: connection timeout to fake host"
      );
      expect(typeof failedRow?.finished_at).toBe("string");
    });

    test("finishRun throws on invalid status or non-existent runId", () => {
      const runId = startRun(db, "audiobookshelf");

      expect(() => {
        finishRun(db, runId, { status: "running" as any });
      }).toThrow(/Invalid status/i);

      expect(() => {
        finishRun(db, 999999, { status: "ok" });
      }).toThrow(/Ingest run with id 999999 not found/i);
    });
  });
});
