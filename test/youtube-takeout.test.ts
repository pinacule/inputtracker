import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import type { EventRow, IngestRunRow } from "../src/core/schema.ts";
import {
  extractVideoId,
  importYoutubeTakeout,
  looksLikeTakeout,
  mapTakeoutRecord,
  type TakeoutMapResult,
} from "../src/sources/youtube/takeout.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "youtube", "synthetic-takeout.json");
const FIXTURE_TEXT = readFileSync(FIXTURE, "utf8");
const FIXTURE_RECORDS = JSON.parse(FIXTURE_TEXT) as unknown[];

function recordAt(index: number): Record<string, unknown> {
  return FIXTURE_RECORDS[index] as Record<string, unknown>;
}

function asEvent(result: TakeoutMapResult): Extract<TakeoutMapResult, { kind: "event" }> {
  if (result.kind !== "event") {
    throw new Error(`expected an event, got skip: ${result.reason}`);
  }
  return result;
}

function freshDb(): Database {
  return openDb(":memory:");
}

function countEvents(db: Database): number {
  return db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
    .get()!.n;
}

function latestRun(db: Database): IngestRunRow {
  return db
    .query<IngestRunRow, []>("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1;")
    .get()!;
}

/** 2500 synthetic records; ids like `B0000000000` (11 chars). */
function generateRecords(count: number): unknown[] {
  const records: unknown[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `B${String(i).padStart(10, "0")}`;
    records.push({
      header: "YouTube",
      title: `Watched Generated Video ${i}`,
      titleUrl: `https://www.youtube.com/watch?v=${id}`,
      time: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      products: ["YouTube"],
    });
  }
  return records;
}

describe("extractVideoId", () => {
  test("reads v= from www, m and music YouTube hosts", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=AbCdEfGhIjK")).toBe(
      "AbCdEfGhIjK"
    );
    expect(extractVideoId("https://m.youtube.com/watch?v=AbCdEfGhIjK")).toBe(
      "AbCdEfGhIjK"
    );
    expect(
      extractVideoId("https://music.youtube.com/watch?v=AbCdEfGhIjK")
    ).toBe("AbCdEfGhIjK");
  });

  test("reads the first path segment of youtu.be links", () => {
    expect(extractVideoId("https://youtu.be/AbCdEfGhIjK")).toBe("AbCdEfGhIjK");
    expect(extractVideoId("https://youtu.be/AbCdEfGhIjK?t=10")).toBe(
      "AbCdEfGhIjK"
    );
  });

  test("rejects ids that are not exactly 11 valid characters", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=AbCdEfGhIj")).toBe(
      null
    ); // 10
    expect(extractVideoId("https://www.youtube.com/watch?v=AbCdEfGhIjKl")).toBe(
      null
    ); // 12
    expect(extractVideoId("https://www.youtube.com/watch?v=AbCdEfGhI!K")).toBe(
      null
    );
    expect(extractVideoId("https://youtu.be/AbCdEfGhIj")).toBe(null);
  });

  test("returns null for garbage, unknown hosts and missing ids", () => {
    expect(extractVideoId("not a url")).toBe(null);
    expect(extractVideoId("")).toBe(null);
    expect(extractVideoId("https://example.com/watch?v=AbCdEfGhIjK")).toBe(null);
    expect(extractVideoId("https://www.youtube.com/watch")).toBe(null);
  });
});

describe("mapTakeoutRecord", () => {
  test("maps a normal record to the exact NewEvent", () => {
    const record = recordAt(0);
    expect(mapTakeoutRecord(record)).toEqual({
      kind: "event",
      event: {
        source: "youtube",
        source_kind: "history_item",
        source_id: "AbCdEfGhIjK:2026-10-17T08:15:00.123Z",
        external_ids: {
          youtube_video: "AbCdEfGhIjK",
          youtube_channel: "UCsyntheticchannel000001",
        },
        media_type: "video",
        title: "Some Synthetic Video",
        parent_title: "Synthetic Channel",
        started_at: "2026-10-17T08:15:00.123Z",
        ended_at: null,
        duration_seconds: null,
        progress: null,
        raw: record,
      },
    });
  });

  test("sets youtube_music when the header is YouTube Music", () => {
    const event = asEvent(mapTakeoutRecord(recordAt(4))).event;
    expect(event.external_ids).toEqual({
      youtube_video: "MmMmMmMmMmM",
      youtube_channel: "UCsyntheticchannel000002",
      youtube_music: true,
    });
    expect(event.parent_title).toBe("Some Artist - Topic");
  });

  test("channel id and parent title are null when subtitles are missing", () => {
    const event = asEvent(mapTakeoutRecord(recordAt(6))).event;
    expect(event.parent_title).toBe(null);
    expect(event.external_ids).toEqual({
      youtube_video: "OoOoOoOoOoO",
      youtube_channel: null,
    });
  });

  test("strips only the exact English 'Watched ' prefix", () => {
    const normal = asEvent(mapTakeoutRecord(recordAt(0))).event;
    expect(normal.title).toBe("Some Synthetic Video");

    const foreign = asEvent(mapTakeoutRecord(recordAt(7))).event;
    expect(foreign.title).toBe("Visto Algo");
  });

  test("classifies ads, other products, missing video and invalid records", () => {
    expect(mapTakeoutRecord(recordAt(2))).toEqual({
      kind: "skip",
      reason: "ads",
    });
    expect(mapTakeoutRecord(recordAt(3))).toEqual({
      kind: "skip",
      reason: "no_video",
    });
    expect(mapTakeoutRecord(recordAt(8))).toEqual({
      kind: "skip",
      reason: "other",
    });
    expect(mapTakeoutRecord(recordAt(9))).toEqual({
      kind: "skip",
      reason: "invalid",
    });
    expect(mapTakeoutRecord(null)).toEqual({
      kind: "skip",
      reason: "invalid",
    });
    expect(mapTakeoutRecord("nope")).toEqual({
      kind: "skip",
      reason: "invalid",
    });
  });
});

describe("looksLikeTakeout", () => {
  test("is true only for text whose first non-whitespace character is '['", () => {
    expect(looksLikeTakeout(FIXTURE_TEXT)).toBe(true);
    expect(looksLikeTakeout("   \n [ ]")).toBe(true);
    expect(looksLikeTakeout('{"format":"inputtracker-export"}')).toBe(false);
    expect(looksLikeTakeout("record_hash,source\n")).toBe(false);
    expect(looksLikeTakeout("")).toBe(false);
  });
});

describe("importYoutubeTakeout", () => {
  test("imports the fixture and reports the counts", () => {
    const db = freshDb();

    const result = importYoutubeTakeout(db, FIXTURE_TEXT);

    expect(result.records).toBe(12);
    expect(result.seen).toBe(8);
    expect(result.inserted).toBe(8);
    expect(result.skipped).toEqual({
      ads: 1,
      no_video: 1,
      other: 1,
      invalid: 1,
    });
    expect(countEvents(db)).toBe(8);
    expect(result.records).toBe(
      result.seen +
        result.skipped.ads +
        result.skipped.no_video +
        result.skipped.other +
        result.skipped.invalid
    );

    const run = latestRun(db);
    expect(run.source).toBe("youtube-takeout");
    expect(run.status).toBe("ok");
    expect(run.rows_seen).toBe(8);
    expect(run.rows_inserted).toBe(8);
  });

  test("stores timestamps as UTC ISO with milliseconds", () => {
    const db = freshDb();
    importYoutubeTakeout(db, FIXTURE_TEXT);

    const row = db
      .query<EventRow, [string]>(
        "SELECT * FROM events WHERE source_id = ?;"
      )
      .get("BbCcDdEeFfG:2026-10-17T08:14:00.000Z");

    expect(row).not.toBeNull();
    expect(row?.started_at).toBe("2026-10-17T08:14:00.000Z");
    expect(row?.media_type).toBe("video");
    expect(row?.duration_seconds).toBe(null);
    expect(row?.raw).not.toBeNull();
  });

  test("re-importing the same file inserts nothing", () => {
    const db = freshDb();
    importYoutubeTakeout(db, FIXTURE_TEXT);

    const second = importYoutubeTakeout(db, FIXTURE_TEXT);

    expect(second.seen).toBe(8);
    expect(second.inserted).toBe(0);
    expect(countEvents(db)).toBe(8);
  });

  test("an overlapping file inserts only the new records", () => {
    const db = freshDb();
    importYoutubeTakeout(db, FIXTURE_TEXT);

    const overlapping = JSON.stringify([
      recordAt(0),
      {
        header: "YouTube",
        title: "Watched New Video One",
        titleUrl: "https://www.youtube.com/watch?v=TtTtTtTtTtT",
        time: "2026-10-19T09:00:00.000Z",
        products: ["YouTube"],
      },
      {
        header: "YouTube",
        title: "Watched New Video Two",
        titleUrl: "https://www.youtube.com/watch?v=UuUuUuUuUuU",
        time: "2026-10-19T10:00:00.000Z",
        products: ["YouTube"],
      },
    ]);

    const result = importYoutubeTakeout(db, overlapping);

    expect(result.seen).toBe(3);
    expect(result.inserted).toBe(2);
    expect(countEvents(db)).toBe(10);
  });

  test("a JSON object throws and records a failed run", () => {
    const db = freshDb();

    expect(() => importYoutubeTakeout(db, '{"format":"nope"}')).toThrow(
      /JSON array/
    );

    const run = latestRun(db);
    expect(run.source).toBe("youtube-takeout");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("JSON array");
  });

  test("invalid JSON throws and records a failed run", () => {
    const db = freshDb();

    expect(() => importYoutubeTakeout(db, "not json at all")).toThrow(
      /JSON array/
    );
    expect(latestRun(db).status).toBe("failed");
  });

  test("imports 2500 generated records in batches", () => {
    const db = freshDb();

    const result = importYoutubeTakeout(db, JSON.stringify(generateRecords(2500)));

    expect(result.records).toBe(2500);
    expect(result.seen).toBe(2500);
    expect(result.inserted).toBe(2500);
    expect(result.skipped).toEqual({
      ads: 0,
      no_video: 0,
      other: 0,
      invalid: 0,
    });
    expect(countEvents(db)).toBe(2500);
  });
});

describe("CLI: it import youtube-takeout <file>", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-yt-cli-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function cliDeps(dbPath: string): {
    loadConfig: () => Config;
    readFile: (path: string) => string;
    out: (line: string) => void;
    err: (line: string) => void;
    captured: { out: string; err: string };
  } {
    const captured = { out: "", err: "" };
    return {
      loadConfig: () => ({ storage: { db_path: dbPath } }) as unknown as Config,
      readFile: (path) => readFileSync(path, "utf8"),
      out: (line) => {
        captured.out += `${line}\n`;
      },
      err: (line) => {
        captured.err += `${line}\n`;
      },
      captured,
    };
  }

  test("prints one summary line and exits 0", async () => {
    const deps = cliDeps(join(tempDir, "ok.db"));

    const code = await runCli(["import", "youtube-takeout", FIXTURE], deps);

    expect(code).toBe(0);
    expect(deps.captured.err).toBe("");
    expect(deps.captured.out).toBe(
      "youtube-takeout: 12 records, 8 views, 8 new, skipped 1 ads, 1 without video, 1 other, 1 invalid\n"
    );

    const db = openDb(join(tempDir, "ok.db"));
    expect(countEvents(db)).toBe(8);
    db.close();
  });

  test("missing file argument exits 1", async () => {
    const deps = cliDeps(join(tempDir, "missing.db"));

    const code = await runCli(["import", "youtube-takeout"], deps);

    expect(code).toBe(1);
    expect(deps.captured.err).toContain("Missing <file>.");
    expect(deps.captured.err).toContain("Usage: it");
  });

  test("a bad file exits 2 with a clear, redacted message", async () => {
    const badPath = join(tempDir, "bad.json");
    writeFileSync(badPath, '{"format":"inputtracker-export"}', "utf8");
    const deps = cliDeps(join(tempDir, "bad.db"));

    const code = await runCli(["import", "youtube-takeout", badPath], deps);

    expect(code).toBe(2);
    expect(deps.captured.err).toContain("JSON array");
  });
});
