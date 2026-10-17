import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize, recordHash } from "../src/core/events.ts";
import {
  mapAll,
  mapListeningStats,
  mapMediaProgress,
  mapSession,
  removeIpAddress,
  type AbsListeningStats,
  type AbsMediaProgress,
  type AbsMeResponse,
  type AbsSession,
  type AbsSessionsEnvelope,
} from "../src/sources/audiobookshelf/map.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "abs");

function loadFixture<T>(filename: string): T {
  const content = readFileSync(join(FIXTURES_DIR, filename), "utf8");
  return JSON.parse(content) as T;
}

describe("Audiobookshelf pure mapping", () => {
  const sessionsEnvelope = loadFixture<AbsSessionsEnvelope>("sessions-page0.json");
  const meResponse = loadFixture<AbsMeResponse>("me.json");
  const statsData = loadFixture<AbsListeningStats>("listening-stats.json");

  describe("mapSession", () => {
    test("maps book session correctly", () => {
      const bookSession = sessionsEnvelope.sessions[0];
      const event = mapSession(bookSession);

      expect(event.source).toBe("audiobookshelf");
      expect(event.source_kind).toBe("listening_session");
      expect(event.source_id).toBe("session-fake-book-1");
      expect(event.media_type).toBe("audiobook");
      expect(event.title).toBe("The Synthetic Tale");
      expect(event.parent_title).toBe("Fake Author");
      expect(event.external_ids).toEqual({ abs_item: "item-fake-book-1" });
      expect(event.started_at).toBe("2025-10-17T08:15:00.000Z");
      expect(event.ended_at).toBe("2025-10-17T08:35:00.000Z");
      expect(event.duration_seconds).toBe(1200);
      expect(event.progress).toBe(0.5); // 1800 / 3600
      expect(event.device).toBe("Linux Laptop");
    });

    test("maps podcast session with episodeId correctly", () => {
      const podcastSession = sessionsEnvelope.sessions[1];
      const event = mapSession(podcastSession);

      expect(event.source).toBe("audiobookshelf");
      expect(event.source_kind).toBe("listening_session");
      expect(event.source_id).toBe("session-fake-podcast-1");
      expect(event.media_type).toBe("podcast_episode");
      expect(event.title).toBe("Episode 1: Pure Functions");
      expect(event.parent_title).toBe("Synthetic Tech Cast");
      expect(event.external_ids).toEqual({
        abs_item: "item-fake-podcast-1",
        abs_episode: "ep-fake-1",
      });
      expect(event.started_at).toBe("2025-10-17T09:06:40.000Z");
      expect(event.ended_at).toBe("2025-10-17T09:21:40.000Z");
      expect(event.duration_seconds).toBe(900);
      expect(event.progress).toBe(0.5); // 900 / 1800
      expect(event.device).toBe("ABS Mobile Android");
    });

    test("maps unknown mediaType to other", () => {
      const session: AbsSession = {
        ...sessionsEnvelope.sessions[0],
        id: "session-other",
        mediaType: "unknown_format",
      };
      const event = mapSession(session);
      expect(event.media_type).toBe("other");
    });

    test("clamps progress within 0..1 and returns null when duration is 0 or missing", () => {
      const base = sessionsEnvelope.sessions[0];

      // Over 1 clamped to 1
      const over = mapSession({ ...base, currentTime: 4000, duration: 3600 });
      expect(over.progress).toBe(1);

      // Negative clamped to 0
      const under = mapSession({ ...base, currentTime: -100, duration: 3600 });
      expect(under.progress).toBe(0);

      // Duration 0 -> null
      const zeroDuration = mapSession({ ...base, currentTime: 100, duration: 0 });
      expect(zeroDuration.progress).toBeNull();

      // Duration negative -> null
      const negDuration = mapSession({ ...base, currentTime: 100, duration: -3600 });
      expect(negDuration.progress).toBeNull();

      // Duration missing -> null
      const missingDuration = mapSession({ ...base, duration: null });
      expect(missingDuration.progress).toBeNull();

      // currentTime missing -> null
      const missingCurrent = mapSession({ ...base, currentTime: null });
      expect(missingCurrent.progress).toBeNull();
    });

    test("device fallbacks handle missing deviceName and various combinations", () => {
      const base = sessionsEnvelope.sessions[0];

      // deviceName takes precedence
      const withName = mapSession({
        ...base,
        deviceInfo: { deviceName: " Pixel 8 ", clientName: "ABS App", osName: "Android" },
      });
      expect(withName.device).toBe("Pixel 8");

      // Fallback: clientName + osName
      const fallbackBoth = mapSession({
        ...base,
        deviceInfo: { deviceName: "  ", clientName: "ABS Web", osName: "Linux" },
      });
      expect(fallbackBoth.device).toBe("ABS Web Linux");

      // Fallback: clientName only
      const clientOnly = mapSession({
        ...base,
        deviceInfo: { clientName: "ABS Web" },
      });
      expect(clientOnly.device).toBe("ABS Web");

      // Fallback: osName only
      const osOnly = mapSession({
        ...base,
        deviceInfo: { osName: "iOS" },
      });
      expect(osOnly.device).toBe("iOS");

      // Lacking all -> null
      const emptyInfo = mapSession({
        ...base,
        deviceInfo: { deviceName: "  ", clientName: "", osName: "  " },
      });
      expect(emptyInfo.device).toBeNull();

      // No deviceInfo -> null
      const noInfo = mapSession({ ...base, deviceInfo: null });
      expect(noInfo.device).toBeNull();
    });

    test("removes ipAddress recursively without mutating original input", () => {
      const originalSession = JSON.parse(JSON.stringify(sessionsEnvelope.sessions[0])) as AbsSession;
      expect(originalSession.deviceInfo?.ipAddress).toBe("203.0.113.7");

      const mapped = mapSession(originalSession);

      // Input was NOT mutated
      expect(originalSession.deviceInfo?.ipAddress).toBe("203.0.113.7");

      // Output does not contain ipAddress anywhere
      const serialized = JSON.stringify(mapped);
      expect(serialized).not.toContain("ipAddress");
      expect(serialized).not.toContain("203.0.113.7");

      // raw.deviceInfo has no ipAddress
      const rawDevice = (mapped.raw as AbsSession)?.deviceInfo;
      expect(rawDevice?.ipAddress).toBeUndefined();
    });
  });

  describe("mapMediaProgress", () => {
    const progressItems = meResponse.mediaProgress ?? [];

    test("maps in-progress book without episodeId", () => {
      const inProgressBook = progressItems[0];
      const event = mapMediaProgress(inProgressBook);

      expect(event.source).toBe("audiobookshelf");
      expect(event.source_kind).toBe("media_progress");
      expect(event.source_id).toBe("item-fake-book-1");
      expect(event.media_type).toBe("audiobook");
      expect(event.started_at).toBe("2025-10-17T08:35:00.000Z");
      expect(event.ended_at).toBeNull();
      expect(event.progress).toBe(0.5);
      expect(event.duration_seconds).toBeNull();
      expect(event.title).toBe("item-fake-book-1"); // default fallback to libraryItemId
    });

    test("maps finished book with finishedAt -> ended_at", () => {
      const finishedBook = progressItems[1];
      const event = mapMediaProgress(finishedBook);

      expect(event.source_id).toBe("item-fake-book-2");
      expect(event.media_type).toBe("audiobook");
      expect(event.started_at).toBe("2025-10-17T09:56:40.000Z");
      expect(event.ended_at).toBe("2025-10-17T09:56:40.000Z");
      expect(event.progress).toBe(1.0);
    });

    test("maps podcastEpisode with episodeId in source_id", () => {
      const podcastItem = progressItems[2];
      const event = mapMediaProgress(podcastItem);

      expect(event.source_id).toBe("item-fake-podcast-1:ep-fake-1");
      expect(event.media_type).toBe("podcast_episode");
      expect(event.started_at).toBe("2025-10-17T09:21:40.000Z");
      expect(event.ended_at).toBeNull();
      expect(event.progress).toBe(0.5);
    });

    test("titleLookup resolution and fallbacks", () => {
      const item = progressItems[0];

      // Custom title resolver returns a title
      const customTitle = mapMediaProgress(item, (id) => (id === item.libraryItemId ? "Custom Title" : undefined));
      expect(customTitle.title).toBe("Custom Title");

      // Custom resolver returns undefined -> falls back to libraryItemId
      const fallbackTitle = mapMediaProgress(item, () => undefined);
      expect(fallbackTitle.title).toBe("item-fake-book-1");

      // Custom resolver returns empty string -> falls back to libraryItemId
      const emptyLookup = mapMediaProgress(item, () => "   ");
      expect(emptyLookup.title).toBe("item-fake-book-1");
    });
  });

  describe("mapListeningStats", () => {
    test("maps daily stats entries to daily_stat snapshot rows", () => {
      const events = mapListeningStats(statsData);

      expect(events.length).toBe(2);

      const day1 = events[0];
      expect(day1.source).toBe("audiobookshelf");
      expect(day1.source_kind).toBe("daily_stat");
      expect(day1.source_id).toBe("2026-10-16");
      expect(day1.media_type).toBe("other");
      expect(day1.started_at).toBe("2026-10-16T00:00:00.000Z");
      expect(day1.ended_at).toBeNull();
      expect(day1.duration_seconds).toBe(900);
      expect(day1.title).toBeNull();
      expect(day1.raw).toEqual({ date: "2026-10-16", seconds: 900 });

      const day2 = events[1];
      expect(day2.source_id).toBe("2026-10-17");
      expect(day2.started_at).toBe("2026-10-17T00:00:00.000Z");
      expect(day2.duration_seconds).toBe(1200);
      expect(day2.raw).toEqual({ date: "2026-10-17", seconds: 1200 });
    });

    test("handles empty or missing days gracefully", () => {
      expect(mapListeningStats({} as AbsListeningStats)).toEqual([]);
      expect(mapListeningStats({ days: {} })).toEqual([]);
    });
  });

  describe("mapAll", () => {
    test("combines sessions, mediaProgress, and stats in deterministic order", () => {
      const allEvents = mapAll({
        sessions: sessionsEnvelope.sessions,
        me: meResponse,
        stats: statsData,
      });

      // 2 sessions + 3 progress items + 2 stats = 7 events
      expect(allEvents.length).toBe(7);

      expect(allEvents[0].source_kind).toBe("listening_session");
      expect(allEvents[1].source_kind).toBe("listening_session");
      expect(allEvents[2].source_kind).toBe("media_progress");
      expect(allEvents[3].source_kind).toBe("media_progress");
      expect(allEvents[4].source_kind).toBe("media_progress");
      expect(allEvents[5].source_kind).toBe("daily_stat");
      expect(allEvents[6].source_kind).toBe("daily_stat");
    });

    test("resolves mediaProgress titles via fallback chain: sessions -> stats items -> libraryItemId", () => {
      // Create a scenario testing all 3 branches:
      // 1. item-fake-book-1 is present in sessions -> gets session displayTitle "The Synthetic Tale"
      // 2. item-fake-book-2 is NOT in sessions, but in statsData.items -> gets "Synthetic Book From Stats"
      // 3. item-fake-unknown is NOT in sessions and NOT in stats -> gets "item-fake-unknown"
      const customMe: AbsMeResponse = {
        mediaProgress: [
          {
            ...meResponse.mediaProgress![0],
            libraryItemId: "item-fake-book-1",
          },
          {
            ...meResponse.mediaProgress![1],
            libraryItemId: "item-fake-book-2",
          },
          {
            ...meResponse.mediaProgress![2],
            libraryItemId: "item-fake-unknown",
            episodeId: null,
          },
        ],
      };

      const events = mapAll({
        sessions: sessionsEnvelope.sessions,
        me: customMe,
        stats: statsData,
      });

      const progressEvents = events.filter((e) => e.source_kind === "media_progress");
      expect(progressEvents[0].title).toBe("The Synthetic Tale"); // from session
      expect(progressEvents[1].title).toBe("Synthetic Book From Stats"); // from stats
      expect(progressEvents[2].title).toBe("item-fake-unknown"); // fallback
    });

    test("contains no ipAddress anywhere in output JSON", () => {
      const allEvents = mapAll({
        sessions: sessionsEnvelope.sessions,
        me: meResponse,
        stats: statsData,
      });

      const serialized = JSON.stringify(allEvents);
      expect(serialized).not.toContain("ipAddress");
      expect(serialized).not.toContain("203.0.113.7");
    });

    test("is deterministic across multiple runs", () => {
      const run1 = mapAll({
        sessions: sessionsEnvelope.sessions,
        me: meResponse,
        stats: statsData,
      });

      const run2 = mapAll({
        sessions: sessionsEnvelope.sessions,
        me: meResponse,
        stats: statsData,
      });

      expect(run1).toEqual(run2);

      const hashes1 = run1.map(recordHash);
      const hashes2 = run2.map(recordHash);
      expect(hashes1).toEqual(hashes2);
    });

    test("handles partial/null input arguments without error", () => {
      expect(mapAll({})).toEqual([]);
      expect(mapAll({ sessions: null, me: null, stats: null })).toEqual([]);
    });
  });

  describe("removeIpAddress helper", () => {
    test("strips ipAddress recursively at all nesting levels without modifying input", () => {
      const input = {
        name: "test",
        ipAddress: "192.168.1.1",
        nested: {
          ipAddress: "10.0.0.1",
          safe: "ok",
          arr: [
            { id: 1, ipAddress: "127.0.0.1" },
            { id: 2, text: "clear" },
          ],
        },
      };

      const cleaned = removeIpAddress(input) as unknown;

      expect(cleaned).toEqual({
        name: "test",
        nested: {
          safe: "ok",
          arr: [
            { id: 1 },
            { id: 2, text: "clear" },
          ],
        },
      });

      // Input was not modified
      expect(input.ipAddress).toBe("192.168.1.1");
      expect(input.nested.ipAddress).toBe("10.0.0.1");
      expect(input.nested.arr[0].ipAddress).toBe("127.0.0.1");
    });
  });

  describe("normalization and hash stability", () => {
    test("every mapped event passes normalize() without throwing", () => {
      const allEvents = mapAll({
        sessions: sessionsEnvelope.sessions,
        me: meResponse,
        stats: statsData,
      });

      expect(allEvents.length).toBeGreaterThan(0);

      for (const event of allEvents) {
        expect(() => {
          const norm = normalize(event);
          expect(norm.source).toBe("audiobookshelf");
          expect(norm.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          if (norm.ended_at !== null) {
            expect(norm.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          }
        }).not.toThrow();
      }
    });

    test("recordHash is stable across two successive calls for each mapped event", () => {
      const allEvents = mapAll({
        sessions: sessionsEnvelope.sessions,
        me: meResponse,
        stats: statsData,
      });

      for (const event of allEvents) {
        const hash1 = recordHash(event);
        const hash2 = recordHash(event);
        expect(hash1).toBe(hash2);
        expect(typeof hash1).toBe("string");
        expect(hash1.length).toBe(64); // sha256 hex
      }
    });
  });
});
