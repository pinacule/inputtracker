import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import type { LibraryResult, YoutubeOverview } from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun, type NewEvent } from "../src/core/events.ts";
import type { EventRow, IngestRunRow } from "../src/core/schema.ts";
import { createZip } from "../src/io/zip.ts";
import { getCalendar, getStats } from "../src/server/aggregate.ts";
import { createApp } from "../src/server/app.ts";
import { dedupeConsumption } from "../src/server/dedup.ts";
import {
  enrichYoutubeVideos,
  getYoutubeVideoEnrichmentMap,
  parseWatchPageLengthSeconds,
} from "../src/sources/youtube/enrich.ts";
import {
  applyTakeoutGapRule,
  extractVideoId,
  getFavoriteVideoIds,
  getYoutubeSubscriptions,
  importFavoriteSongsCsv,
  importSubscriptionsCsv,
  importYoutubeTakeout,
  looksLikeTakeout,
  mapTakeoutHtmlBlock,
  mapTakeoutRecord,
  parseTakeoutHtml,
  parseTakeoutHtmlTimestamp,
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

function countLatestEvents(db: Database): number {
  return db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events_latest;")
    .get()!.n;
}

function latestRun(db: Database): IngestRunRow {
  return db
    .query<IngestRunRow, []>("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1;")
    .get()!;
}

/** 2500 synthetic records spaced 6 minutes apart; ids like `B0000000000` (11 chars). */
function generateRecords(count: number): unknown[] {
  const records: unknown[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `B${String(i).padStart(10, "0")}`;
    records.push({
      header: "YouTube",
      title: `Watched Generated Video ${i}`,
      titleUrl: `https://www.youtube.com/watch?v=${id}`,
      time: new Date(Date.UTC(2025, 0, 1) + i * 360 * 1000).toISOString(),
      products: ["YouTube"],
    });
  }
  return records;
}

function makeHtmlCard(opts: {
  header?: string;
  bodyHtml: string;
  captionHtml?: string;
}): string {
  const header = opts.header ?? "YouTube";
  const caption =
    opts.captionHtml ?? "<b>Products:</b><br>&emsp;YouTube<br>";
  return `<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">
  <div class="mdl-grid">
    <div class="header-cell mdl-cell mdl-cell--12-col">
      <p class="mdl-typography--title">${header}<br></p>
    </div>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${opts.bodyHtml}</div>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div>
    <div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption">${caption}</div>
  </div>
</div>`;
}

function mockConfig(dbPath = ":memory:"): Config {
  return {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: dbPath,
      backup_dir: "/tmp/backups",
      backup_keep: 14,
    },
    audiobookshelf: {
      url: "http://abs.test:13378",
      token: "abs-tok",
      timeout_s: 20,
    },
    simkl: {
      client_id: "simkl_client_synth",
      base_url: "https://api.simkl.com",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: {
      thumb_base_url: "https://i.ytimg.com/vi",
      min_watch_minutes: 5,
      enrich_per_sync: 50,
    },
    activitywatch: {
      url: "http://127.0.0.1:5600",
      timeout_s: 20,
      device: "pc",
      include_music: false,
    },
    notify: {
      desktop: false,
      ntfy_url: "",
      ntfy_token: "",
      app_url: "",
      weekly_summary: false,
    },
    toJSON: () => ({}),
    toString: () => "{}",
  } as Config;
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
  test("is true for JSON array or Takeout HTML, false for native JSON/CSV", () => {
    expect(looksLikeTakeout(FIXTURE_TEXT)).toBe(true);
    expect(looksLikeTakeout("   \n [ ]")).toBe(true);
    expect(
      looksLikeTakeout(
        '<!DOCTYPE html><html><body><div class="outer-cell"></div></body></html>'
      )
    ).toBe(true);
    expect(looksLikeTakeout('{"format":"inputtracker-export"}')).toBe(false);
    expect(looksLikeTakeout("record_hash,source\n")).toBe(false);
    expect(looksLikeTakeout("")).toBe(false);
  });
});

describe("HTML Takeout parsing (snippets, entities, U+202F, CET/CEST/unknown TZ)", () => {
  test("parses timestamps with regular space, U+202F, CET, CEST, UTC, US zones, and rejects unknown TZ", () => {
    // CEST is UTC+2 -> 3:25:57 AM CEST = 01:25:57Z
    expect(parseTakeoutHtmlTimestamp("Oct 18, 2026, 3:25:57 AM CEST")).toBe(
      "2026-10-18T01:25:57.000Z"
    );
    // U+202F narrow no-break space before AM/PM
    expect(
      parseTakeoutHtmlTimestamp("Oct 18, 2026, 3:25:57\u202FAM CEST")
    ).toBe("2026-10-18T01:25:57.000Z");
    // CET is UTC+1 -> 1:15:00 PM CET = 12:15:00Z
    expect(parseTakeoutHtmlTimestamp("Mar 5, 2025, 1:15:00 PM CET")).toBe(
      "2025-03-05T12:15:00.000Z"
    );
    // 12:00:00 AM UTC -> 00:00:00Z; 12:00:00 PM UTC -> 12:00:00Z
    expect(parseTakeoutHtmlTimestamp("Jan 1, 2026, 12:00:00 AM UTC")).toBe(
      "2026-01-01T00:00:00.000Z"
    );
    expect(parseTakeoutHtmlTimestamp("Jan 1, 2026, 12:00:00 PM GMT")).toBe(
      "2026-01-01T12:00:00.000Z"
    );
    // EDT is UTC-4
    expect(parseTakeoutHtmlTimestamp("Jul 4, 2026, 8:00:00 PM EDT")).toBe(
      "2026-07-05T00:00:00.000Z"
    );
    // Unknown timezone abbreviation -> null
    expect(parseTakeoutHtmlTimestamp("Oct 18, 2026, 3:25:57 AM MARS")).toBeNull();
    expect(parseTakeoutHtmlTimestamp("Oct 18, 2026, 3:25:57 AM XYZ")).toBeNull();
    // Impossible calendar date -> null
    expect(parseTakeoutHtmlTimestamp("Feb 30, 2026, 3:25:57 AM CEST")).toBeNull();
  });

  test("parses normal video, removed video (with and without link), ad, post, visited, music, escaped titles, U+202F, and unknown TZ", () => {
    const html = [
      // 1. Normal video with HTML-escaped title & channel and U+202F before AM
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=NormalVid01">Rust &amp; C++: &quot;Zero-Cost&quot; &#39;Abstractions&#39; &lt;2026&gt;</a><br><a href="https://www.youtube.com/channel/UCnormchan000000000001">Systems &amp; Co.</a><br>Oct 18, 2026, 3:25:57\u202FAM CEST<br>',
      }),
      // 2. Removed video that still has a watch?v= link (no channel line)
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=RemovedUrl1">https://www.youtube.com/watch?v=RemovedUrl1</a><br>Oct 18, 2026, 2:00:00 AM CEST<br>',
      }),
      // 3. Removed video with NO watch?v= link -> skipped as no_video
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          "Watched a video that has been removed<br>Oct 18, 2026, 1:50:00 AM CEST<br>",
      }),
      // 4. Ad ("Details: From Google Ads") -> skipped as ads
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=AdVideo0001">Sponsor Ad</a><br>Oct 18, 2026, 1:40:00 AM CEST<br>',
        captionHtml:
          "<b>Products:</b><br>&emsp;YouTube<br><b>Details:</b><br>&emsp;From Google Ads<br>",
      }),
      // 5. Post ("Viewed …") -> skipped as other
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Viewed <a href="https://www.youtube.com/post/UgkxSyntheticPost">Community post</a><br><a href="https://www.youtube.com/channel/UCnormchan000000000001">Systems &amp; Co.</a><br>Oct 18, 2026, 1:30:00 AM CEST<br>',
      }),
      // 6. Visited ("Visited …") -> skipped as other
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Visited <a href="https://www.youtube.com/@systemsco">Systems &amp; Co.</a><br>Oct 18, 2026, 1:20:00 AM CEST<br>',
      }),
      // 7. YouTube Music entry with music.youtube.com link and CET timezone
      makeHtmlCard({
        header: "YouTube Music",
        bodyHtml:
          'Watched <a href="https://music.youtube.com/watch?v=MusicTrack1">Synthetic Nocturne &amp; Fugue</a><br><a href="https://www.youtube.com/channel/UCmusicartist000000001">Synth Composer - Topic</a><br>Mar 5, 2025, 8:00:00 PM CET<br>',
      }),
      // 8. Unknown timezone abbreviation -> skipped as invalid
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=BadTzVideo1">Unknown TZ Clip</a><br>Oct 18, 2026, 1:00:00 AM UNKNOWNTZ<br>',
      }),
    ].join("\n");

    const parsed = parseTakeoutHtml(html);
    expect(parsed.records).toBe(8);
    expect(parsed.skipped).toEqual({
      ads: 1,
      no_video: 1,
      other: 2,
      invalid: 1,
    });
    expect(parsed.events).toHaveLength(3);

    const [normalEv, removedUrlEv, musicEv] = parsed.events;
    expect(normalEv?.title).toBe('Rust & C++: "Zero-Cost" \'Abstractions\' <2026>');
    expect(normalEv?.parent_title).toBe("Systems & Co.");
    expect(normalEv?.started_at).toBe("2026-10-18T01:25:57.000Z");
    expect(normalEv?.media_type).toBe("video");
    expect(normalEv?.external_ids).toEqual({
      youtube_video: "NormalVid01",
      youtube_channel: "UCnormchan000000000001",
    });

    expect(removedUrlEv?.title).toBe("https://www.youtube.com/watch?v=RemovedUrl1");
    expect(removedUrlEv?.parent_title).toBeNull();
    expect(removedUrlEv?.external_ids).toEqual({
      youtube_video: "RemovedUrl1",
      youtube_channel: null,
    });

    expect(musicEv?.title).toBe("Synthetic Nocturne & Fugue");
    expect(musicEv?.parent_title).toBe("Synth Composer - Topic");
    expect(musicEv?.media_type).toBe("music");
    expect(musicEv?.started_at).toBe("2025-03-05T19:00:00.000Z");
    expect(musicEv?.external_ids).toEqual({
      youtube_video: "MusicTrack1",
      youtube_channel: "UCmusicartist000000001",
      youtube_music: true,
    });
  });
});

describe("Gap rule: boundary, caps, music exemption, and length capping", () => {
  test("boundary: 4:59 (299s) video gap is skipped, 5:00 (300s) is kept, music is exempt from 5m rule", () => {
    const rawViews: NewEvent[] = [
      // 1. Video with 299s gap (10:00:00 -> 10:04:59) -> skipped!
      {
        source: "youtube",
        source_kind: "history_item",
        source_id: "VidUnder5m0:2026-10-18T10:00:00.000Z",
        external_ids: { youtube_video: "VidUnder5m0", youtube_channel: "UC1" },
        media_type: "video",
        title: "Under 5 Min Video",
        parent_title: "Chan",
        started_at: "2026-10-18T10:00:00.000Z",
      },
      // 2. Video with exact 300s gap (10:04:59 -> 10:09:59) -> kept with duration_seconds = 300!
      {
        source: "youtube",
        source_kind: "history_item",
        source_id: "VidExact5m0:2026-10-18T10:04:59.000Z",
        external_ids: { youtube_video: "VidExact5m0", youtube_channel: "UC1" },
        media_type: "video",
        title: "Exact 5 Min Video",
        parent_title: "Chan",
        started_at: "2026-10-18T10:04:59.000Z",
      },
      // 3. Music track with 150s (2m30s < 5m) gap (10:09:59 -> 10:12:29) -> exempt from 5m rule, kept with 150s!
      {
        source: "youtube",
        source_kind: "history_item",
        source_id: "MusShort150:2026-10-18T10:09:59.000Z",
        external_ids: {
          youtube_video: "MusShort150",
          youtube_channel: "UC2",
          youtube_music: true,
        },
        media_type: "music",
        title: "Short Song",
        parent_title: "Artist",
        started_at: "2026-10-18T10:09:59.000Z",
      },
      // 4. Music track with 600s (10m) gap and unknown length (10:12:29 -> 10:22:29) -> capped at 4m (240s)!
      {
        source: "youtube",
        source_kind: "history_item",
        source_id: "MusCapped4m:2026-10-18T10:12:29.000Z",
        external_ids: {
          youtube_video: "MusCapped4m",
          youtube_channel: "UC2",
          youtube_music: true,
        },
        media_type: "music",
        title: "Capped Song",
        parent_title: "Artist",
        started_at: "2026-10-18T10:12:29.000Z",
      },
      // 5. Video with 5-hour gap and unknown length (10:22:29 -> 15:22:29) -> capped at 3h (10800s)!
      {
        source: "youtube",
        source_kind: "history_item",
        source_id: "VidLongGap0:2026-10-18T10:22:29.000Z",
        external_ids: { youtube_video: "VidLongGap0", youtube_channel: "UC1" },
        media_type: "video",
        title: "Long Gap Video",
        parent_title: "Chan",
        started_at: "2026-10-18T10:22:29.000Z",
      },
      // 6. Newest video view (no next view, unknown length) -> gets 30m (1800s)!
      {
        source: "youtube",
        source_kind: "history_item",
        source_id: "VidNewest00:2026-10-18T15:22:29.000Z",
        external_ids: { youtube_video: "VidNewest00", youtube_channel: "UC1" },
        media_type: "video",
        title: "Newest Video",
        parent_title: "Chan",
        started_at: "2026-10-18T15:22:29.000Z",
      },
    ];

    const res = applyTakeoutGapRule(rawViews, { minWatchMinutes: 5 });
    expect(res.gapSkipped).toBe(1);
    expect(res.musicCount).toBe(2);
    expect(res.kept).toHaveLength(5);

    expect(
      res.kept.map((e) => [
        (e.external_ids as Record<string, unknown>).youtube_video,
        e.media_type,
        e.duration_seconds,
        (e.raw as Record<string, unknown>).estimated,
      ])
    ).toEqual([
      ["VidExact5m0", "video", 300, "gap"],
      ["MusShort150", "music", 150, "gap"],
      ["MusCapped4m", "music", 240, "gap"],
      ["VidLongGap0", "video", 10800, "gap"],
      ["VidNewest00", "video", 1800, "gap"],
    ]);
  });
});

describe("Length parsing, enrichment, and later re-save as revision", () => {
  test("parseWatchPageLengthSeconds extracts lengthSeconds from player JSON or ISO duration from meta tag", () => {
    expect(
      parseWatchPageLengthSeconds(
        '<html><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc","lengthSeconds":"723"}};</script></html>'
      )
    ).toBe(723);

    expect(
      parseWatchPageLengthSeconds(
        '<html><head><meta itemprop="duration" content="PT12M3S"></head></html>'
      )
    ).toBe(723);

    expect(
      parseWatchPageLengthSeconds(
        "<html><head><meta content='PT1H2M3S' itemprop='duration'></head></html>"
      )
    ).toBe(3723);

    expect(
      parseWatchPageLengthSeconds("<html><head><title>No length</title></head></html>")
    ).toBeNull();
  });

  test("re-saves takeout views as new revisions when video/track length becomes known via youtube enrich --takeout", async () => {
    const db = freshDb();
    const html = [
      // Video 1 at 10:00 CEST (08:00Z), gap to Video 2 is 1 hour (3600s)
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=CapVideo001">Video To Cap</a><br><a href="https://www.youtube.com/channel/UCcap1">Cap Channel</a><br>Oct 18, 2026, 10:00:00 AM CEST<br>',
      }),
      // Music Track 2 at 11:00 CEST (09:00Z), newest view (initially 4 min = 240s)
      makeHtmlCard({
        header: "YouTube Music",
        bodyHtml:
          'Watched <a href="https://music.youtube.com/watch?v=CapMusic002">Song To Cap</a><br><a href="https://www.youtube.com/channel/UCcap2">Cap Artist - Topic</a><br>Oct 18, 2026, 11:00:00 AM CEST<br>',
      }),
    ].join("\n");

    const imp = importYoutubeTakeout(db, html);
    expect(imp.stored).toBe(2);
    expect(imp.inserted).toBe(2);
    expect(countEvents(db)).toBe(2);

    // Before enrichment: CapVideo001 has duration 3600s (gap), CapMusic002 has 240s (4m default)
    const beforeRows = db
      .query<EventRow, []>("SELECT * FROM events_latest ORDER BY started_at ASC;")
      .all();
    expect(beforeRows.map((r) => [r.source_id, r.duration_seconds])).toEqual([
      ["CapVideo001:2026-10-18T08:00:00.000Z", 3600],
      ["CapMusic002:2026-10-18T09:00:00.000Z", 240],
    ]);

    // Mock fetch for `it youtube enrich --takeout`:
    // CapVideo001 has lengthSeconds = 900 (15m < 60m gap -> capped to 900s)
    // CapMusic002 has meta duration PT3M15S = 195s -> updated to 195s
    const sleepDelays: number[] = [];
    const fakeFetch: typeof fetch = (async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : String(input));
      if (u.pathname === "/oembed") {
        const target = new URL(u.searchParams.get("url")!).searchParams.get("v");
        return new Response(
          JSON.stringify({
            title: `Title ${target}`,
            author_name: `Channel ${target}`,
          }),
          { status: 200 }
        );
      }
      const vid = u.searchParams.get("v");
      if (vid === "CapVideo001") {
        return new Response(
          '<html><meta itemprop="genre" content="Education"><script>{"lengthSeconds":"900"}</script></html>',
          { status: 200 }
        );
      }
      return new Response(
        '<html><meta itemprop="genre" content="Music"><meta itemprop="duration" content="PT3M15S"></html>',
        { status: 200 }
      );
    }) as typeof fetch;

    let cliOut = "";
    const code = await runCli(["youtube", "enrich", "--takeout", "--limit", "10"], {
      loadConfig: () => mockConfig(),
      openDb: () => {
        // Return a wrapper that no-ops close() so our in-memory `db` stays open for assertions
        return new Proxy(db, {
          get(target, prop) {
            if (prop === "close") return () => {};
            const val = Reflect.get(target, prop);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      },
      fetch: fakeFetch,
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
      out: (line) => {
        cliOut += `${line}\n`;
      },
      err: () => {},
    });

    expect(code).toBe(0);
    expect(cliOut).toContain("youtube enrich: 2 attempted, 2 enriched, 0 not found, 0 failed, 2 re-saved");
    // Polite default delay of 1000ms between videos on --takeout
    expect(sleepDelays).toEqual([1000]);

    // Enriched lengths are stored in youtube_videos_latest
    const enrMap = getYoutubeVideoEnrichmentMap(db);
    expect(enrMap.get("CapVideo001")?.length_seconds).toBe(900);
    expect(enrMap.get("CapMusic002")?.length_seconds).toBe(195);

    // Append-only: `events` now has 4 rows (2 original + 2 new revisions),
    // and `events_latest` returns the 2 capped revisions with the same source_id!
    expect(countEvents(db)).toBe(4);
    expect(countLatestEvents(db)).toBe(2);

    const afterRows = db
      .query<EventRow, []>("SELECT * FROM events_latest ORDER BY started_at ASC;")
      .all();
    expect(afterRows.map((r) => [r.source_id, r.duration_seconds])).toEqual([
      ["CapVideo001:2026-10-18T08:00:00.000Z", 900],
      ["CapMusic002:2026-10-18T09:00:00.000Z", 195],
    ]);

    // Running enrich again is a no-op (0 attempted, 0 re-saved)
    const secondEnrich = await enrichYoutubeVideos(db, {
      takeout: true,
      fetch: fakeFetch,
      sleep: async () => {},
    });
    expect(secondEnrich).toEqual({
      attempted: 0,
      enriched: 0,
      failed: 0,
      notFound: 0,
      resaved: 0,
    });
    expect(countEvents(db)).toBe(4);
  });
});

describe("Deduplication against measured plays (import and read)", () => {
  test("skips takeout view at import when an aw_play or phone_play of the same video exists on the same local day", () => {
    const db = freshDb();
    const runId = startRun(db, "activitywatch");
    insertEvents(db, runId, [
      {
        source: "youtube",
        source_kind: "aw_play",
        source_id: "MeasuredV01:2026-10-18T07:30:00.000Z",
        external_ids: { youtube_video: "MeasuredV01" },
        media_type: "video",
        title: "Measured Video",
        started_at: "2026-10-18T07:30:00.000Z",
        ended_at: "2026-10-18T07:45:00.000Z",
        duration_seconds: 900,
      },
    ]);
    finishRun(db, runId, { status: "ok", rowsSeen: 1, rowsInserted: 1 });

    // Import Takeout with MeasuredV01 on the same local day (2026-10-18) plus AnotherV002
    const html = [
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=MeasuredV01">Measured Video</a><br><a href="https://www.youtube.com/channel/UC1">Chan 1</a><br>Oct 18, 2026, 10:00:00 AM CEST<br>',
      }),
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=AnotherV002">Another Video</a><br><a href="https://www.youtube.com/channel/UC2">Chan 2</a><br>Oct 18, 2026, 10:20:00 AM CEST<br>',
      }),
    ].join("\n");

    const res = importYoutubeTakeout(db, html);
    expect(res.seen).toBe(2);
    expect(res.dedup_skipped).toBe(1);
    expect(res.stored).toBe(1);
    expect(res.inserted).toBe(1);

    const latest = db
      .query<EventRow, []>("SELECT * FROM events_latest ORDER BY started_at ASC;")
      .all();
    expect(latest.map((r) => [r.source_kind, r.source_id])).toEqual([
      ["aw_play", "MeasuredV01:2026-10-18T07:30:00.000Z"],
      ["history_item", "AnotherV002:2026-10-18T08:20:00.000Z"],
    ]);
  });

  test("read path drops takeout view when a measured play is synced later on the same local day", async () => {
    const db = freshDb();
    const config = mockConfig();

    // 1. Import Takeout first: Video SharedVid01 watched for 20m (1200s) on 2026-10-18
    const html = [
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=SharedVid01">Shared Essay</a><br><a href="https://www.youtube.com/channel/UCshared">Shared Channel</a><br>Oct 18, 2026, 10:00:00 AM CEST<br>',
      }),
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=SecondVid02">Second Essay</a><br><a href="https://www.youtube.com/channel/UCshared">Shared Channel</a><br>Oct 18, 2026, 10:20:00 AM CEST<br>',
      }),
    ].join("\n");

    importYoutubeTakeout(db, html);

    // 2. Later, a phone_play (or aw_play) for SharedVid01 on 2026-10-18 arrives with 600s (10m)
    const runId = startRun(db, "youtube", "phone");
    insertEvents(db, runId, [
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "phone-shared-1",
        external_ids: { youtube_video: "SharedVid01" },
        media_type: "video",
        title: "Shared Essay",
        parent_title: null, // Missing channel on play -> inherited from Takeout!
        started_at: "2026-10-18T14:00:00.000Z",
        ended_at: "2026-10-18T14:10:00.000Z",
        duration_seconds: 600,
      },
    ]);
    finishRun(db, runId, { status: "ok", rowsSeen: 1, rowsInserted: 1 });

    // Direct dedupeConsumption check: drops the history_item for SharedVid01, keeps phone_play (10m) + SecondVid02 (30m)
    const rawLatest = db.query<EventRow, []>("SELECT * FROM events_latest;").all();
    expect(rawLatest).toHaveLength(3);
    const deduped = dedupeConsumption(rawLatest, "Europe/Bratislava");
    expect(deduped).toHaveLength(2);
    expect(deduped.find((e) => e.source_id === "phone-shared-1")?.parent_title).toBe(
      "Shared Channel"
    );

    // Check across HTTP endpoints: total is 10m + 30m = 40m (never 10m + 20m + 30m = 60m)
    const app = createApp({ db, config });
    const ytRes = await app.request("/api/youtube");
    const yt = (await ytRes.json()) as YoutubeOverview;
    expect(yt.total_minutes).toBe(40);
    expect(yt.videos).toBe(2);

    const stats = getStats(db, { tz: "Europe/Bratislava" });
    expect(stats.total_minutes).toBe(40);
    expect(stats.total_items).toBe(2);

    const cal = getCalendar(db, "2026-10", "Europe/Bratislava");
    expect(cal.days).toHaveLength(1);
    expect(cal.days[0]?.minutes).toBe(40);
    expect(cal.days[0]?.count).toBe(2);
  });
});

describe("Favourites, subscriptions, folder/zip input, and dry-run", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "inputtracker-takeout-v8-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const FAVORITES_CSV = [
    "Video ID,Playlist Video Creation Timestamp",
    "MmMmMmMmMmM,2026-05-01T10:00:00+00:00",
    "FavSong0002,2026-06-15T12:30:00Z",
    "",
  ].join("\n");

  const SUBSCRIPTIONS_CSV = [
    "Channel Id,Channel Url,Channel Title",
    "UCsyntheticchannel000001,http://www.youtube.com/channel/UCsyntheticchannel000001,Synthetic Channel",
    "UCsubscribed000000000002,http://www.youtube.com/channel/UCsubscribed000000000002,Second Subscribed Channel",
    "",
  ].join("\n");

  test("youtube_favorites and youtube_subscriptions tables are append-only (reject UPDATE and DELETE)", () => {
    const db = freshDb();
    importFavoriteSongsCsv(db, FAVORITES_CSV);
    importSubscriptionsCsv(db, SUBSCRIPTIONS_CSV);

    expect(getFavoriteVideoIds(db)).toEqual(new Set(["MmMmMmMmMmM", "FavSong0002"]));
    expect(getYoutubeSubscriptions(db)).toHaveLength(2);

    expect(() => {
      db.run("UPDATE youtube_favorites SET added_at = NULL;");
    }).toThrow(/youtube_favorites is append-only/);
    expect(() => {
      db.run("DELETE FROM youtube_favorites;");
    }).toThrow(/youtube_favorites is append-only/);

    expect(() => {
      db.run("UPDATE youtube_subscriptions SET channel_title = 'X';");
    }).toThrow(/youtube_subscriptions is append-only/);
    expect(() => {
      db.run("DELETE FROM youtube_subscriptions;");
    }).toThrow(/youtube_subscriptions is append-only/);
  });

  test("exposes favorite on LibraryWork and subscribed on YoutubeChannel, and re-import is idempotent", async () => {
    const db = freshDb();
    const config = mockConfig();

    const first = importYoutubeTakeout(db, {
      historyText: FIXTURE_TEXT,
      favoritesCsv: FAVORITES_CSV,
      subscriptionsCsv: SUBSCRIPTIONS_CSV,
    });
    expect(first.favorites).toBe(2);
    expect(first.favorites_inserted).toBe(2);
    expect(first.subscriptions).toBe(2);
    expect(first.subscriptions_inserted).toBe(2);

    // Repeat import inserts 0 new events, 0 new favourites, 0 new subscriptions
    const second = importYoutubeTakeout(db, {
      historyText: FIXTURE_TEXT,
      favoritesCsv: FAVORITES_CSV,
      subscriptionsCsv: SUBSCRIPTIONS_CSV,
    });
    expect(second.inserted).toBe(0);
    expect(second.favorites_inserted).toBe(0);
    expect(second.subscriptions_inserted).toBe(0);

    const app = createApp({ db, config });

    // Check LibraryWork.favorite on music track MmMmMmMmMmM
    const libRes = await app.request("/api/library?category=music");
    expect(libRes.status).toBe(200);
    const lib = (await libRes.json()) as LibraryResult;
    expect(lib.works).toHaveLength(1);
    expect(lib.works[0]?.title).toBe("Some Song");
    expect(lib.works[0]?.favorite).toBe(true);

    // Check YoutubeChannel.subscribed on /api/youtube
    const ytRes = await app.request("/api/youtube");
    expect(ytRes.status).toBe(200);
    const yt = (await ytRes.json()) as YoutubeOverview;
    const synthChan = yt.channels.find((c) => c.channel === "Synthetic Channel");
    const unsubChan = yt.channels.find((c) => c.channel === "Synthetic Channel Two");
    expect(synthChan?.subscribed).toBe(true);
    expect(unsubChan?.subscribed).toBe(false);
  });

  test("imports from a YouTube and YouTube Music folder and from a Takeout zip, and supports --dry-run without writing", async () => {
    const htmlHistory = [
      makeHtmlCard({
        header: "YouTube",
        bodyHtml:
          'Watched <a href="https://www.youtube.com/watch?v=FolderVid01">Folder Video</a><br><a href="https://www.youtube.com/channel/UCsyntheticchannel000001">Synthetic Channel</a><br>Oct 18, 2026, 9:00:00 AM CEST<br>',
      }),
      makeHtmlCard({
        header: "YouTube Music",
        bodyHtml:
          'Watched <a href="https://music.youtube.com/watch?v=MmMmMmMmMmM">Folder Song</a><br><a href="https://www.youtube.com/channel/UCartist">Artist - Topic</a><br>Oct 18, 2026, 9:20:00 AM CEST<br>',
      }),
    ].join("\n");

    // 1. Create folder structure: YouTube and YouTube Music/{history,playlists,subscriptions}
    const ytFolder = join(tempDir, "YouTube and YouTube Music");
    mkdirSync(join(ytFolder, "history"), { recursive: true });
    mkdirSync(join(ytFolder, "playlists"), { recursive: true });
    mkdirSync(join(ytFolder, "subscriptions"), { recursive: true });
    writeFileSync(join(ytFolder, "history", "watch-history.html"), htmlHistory, "utf8");
    writeFileSync(
      join(ytFolder, "playlists", "Favorite Songs-videos.csv"),
      FAVORITES_CSV,
      "utf8"
    );
    writeFileSync(
      join(ytFolder, "playlists", "Other Playlist-videos.csv"),
      "Video ID,Playlist Video Creation Timestamp\nOutScopeVid,2026-01-01T00:00:00Z\n",
      "utf8"
    );
    writeFileSync(
      join(ytFolder, "subscriptions", "subscriptions.csv"),
      SUBSCRIPTIONS_CSV,
      "utf8"
    );

    const dbPath = join(tempDir, "folder.db");
    let dryOut = "";
    const dryCode = await runCli(
      ["import", "youtube-takeout", ytFolder, "--dry-run"],
      {
        loadConfig: () => mockConfig(dbPath),
        out: (l) => {
          dryOut += `${l}\n`;
        },
        err: () => {},
      }
    );
    expect(dryCode).toBe(0);
    expect(dryOut).toContain("youtube-takeout (dry-run): 2 records, 2 views, 2 stored, 0 new, 1 music, 0.4 h");
    expect(dryOut).toContain("2 favourites, 2 subscriptions");

    // Verify dry-run wrote nothing to DB
    const dbAfterDry = openDb(dbPath);
    expect(countEvents(dbAfterDry)).toBe(0);
    expect(getFavoriteVideoIds(dbAfterDry).size).toBe(0);
    expect(getYoutubeSubscriptions(dbAfterDry)).toHaveLength(0);
    dbAfterDry.close();

    // Real import from folder
    let realOut = "";
    const realCode = await runCli(["import", "youtube-takeout", ytFolder], {
      loadConfig: () => mockConfig(dbPath),
      out: (l) => {
        realOut += `${l}\n`;
      },
      err: () => {},
    });
    expect(realCode).toBe(0);
    expect(realOut).toContain("2 stored, 2 new, 1 music, 0.4 h");
    expect(realOut).toContain("2 favourites, 2 subscriptions");

    const dbAfterFolder = openDb(dbPath);
    expect(countEvents(dbAfterFolder)).toBe(2);
    expect(getFavoriteVideoIds(dbAfterFolder)).toEqual(
      new Set(["MmMmMmMmMmM", "FavSong0002"])
    );
    expect(getYoutubeSubscriptions(dbAfterFolder)).toHaveLength(2);
    dbAfterFolder.close();

    // 2. Test Takeout .zip archive (including out-of-scope files that must be ignored)
    const zipBytes = createZip([
      {
        name: "Takeout/YouTube and YouTube Music/history/watch-history.html",
        data: htmlHistory,
      },
      {
        name: "Takeout/YouTube and YouTube Music/history/search-history.html",
        data: "<html>Search history</html>",
      },
      {
        name: "Takeout/YouTube and YouTube Music/playlists/Favorite Songs-videos.csv",
        data: FAVORITES_CSV,
      },
      {
        name: "Takeout/YouTube and YouTube Music/subscriptions/subscriptions.csv",
        data: SUBSCRIPTIONS_CSV,
      },
    ]);
    const zipPath = join(tempDir, "takeout.zip");
    writeFileSync(zipPath, zipBytes);

    const zipDb = freshDb();
    const zipRes = importYoutubeTakeout(zipDb, zipPath);
    expect(zipRes.records).toBe(2);
    expect(zipRes.stored).toBe(2);
    expect(zipRes.inserted).toBe(2);
    expect(zipRes.music).toBe(1);
    expect(zipRes.favorites).toBe(2);
    expect(zipRes.subscriptions).toBe(2);
    zipDb.close();
  });
});

describe("importYoutubeTakeout (JSON fixture)", () => {
  test("imports the fixture with the gap rule and reports the counts", () => {
    const db = freshDb();

    const result = importYoutubeTakeout(db, FIXTURE_TEXT);

    expect(result.records).toBe(12);
    expect(result.seen).toBe(8);
    expect(result.gap_skipped).toBe(1); // BbCcDdEeFfG has 1m gap before AbCdEfGhIjK
    expect(result.stored).toBe(8); // seven views plus one time-only day
    expect(result.inserted).toBe(8);
    expect(result.music).toBe(1);
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

  test("stores timestamps as UTC ISO with milliseconds and estimated gap duration", () => {
    const db = freshDb();
    importYoutubeTakeout(db, FIXTURE_TEXT);

    const row = db
      .query<EventRow, [string]>(
        "SELECT * FROM events WHERE source_id = ?;"
      )
      .get("AbCdEfGhIjK:2026-10-17T08:15:00.123Z");

    expect(row).not.toBeNull();
    expect(row?.started_at).toBe("2026-10-17T08:15:00.123Z");
    expect(row?.media_type).toBe("video");
    expect(row?.duration_seconds).toBe(10800); // Capped at 3h
    expect(JSON.parse(row?.raw ?? "{}").estimated).toBe("gap");
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
      "youtube-takeout: 12 records, 8 views, 8 stored, 8 new, 1 music, 7.6 h, skipped 1 ads, 1 without video, 1 other, 1 invalid, 1 gap-skipped, 0 favourites, 0 subscriptions\n"
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
