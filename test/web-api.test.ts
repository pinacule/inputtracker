import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addEvent,
  deleteArchiveEntry,
  getCalendar,
  getHeatmapDays,
  getHeatmapHours,
  getInProgress,
  getJson,
  getLibrary,
  getLibraryWork,
  getMonthReview,
  getSeries,
  getSettings,
  getStats,
  getYearReviewV2,
  importFile,
  listArchive,
  lookupSearch,
  lookupWork,
  postJson,
  saveArchiveEntry,
} from "../web/src/api.ts";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>
): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const call: FetchCall = { url, init };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("api.ts URL building and JSON parsing", () => {
  test("getCalendar builds the month query and parses the response", async () => {
    mockFetch(() => jsonResponse({ month: "2026-10", days: [] }));

    const result = await getCalendar("2026-10");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/calendar?month=2026-10");
    expect(calls[0]?.init).toBeUndefined();
    expect(result).toEqual({ month: "2026-10", days: [] });
  });

  test("getCalendar appends the optional source filter", async () => {
    mockFetch(() => jsonResponse({ month: "2026-10", days: [] }));

    await getCalendar("2026-10", "audiobookshelf");

    expect(calls[0]?.url).toBe(
      "/api/calendar?month=2026-10&source=audiobookshelf"
    );
  });

  test("getHeatmapDays includes the required year and optional source", async () => {
    mockFetch(() => jsonResponse({ year: "2026", days: [] }));

    await getHeatmapDays("2026");
    await getHeatmapDays("2026", "manual");

    expect(calls[0]?.url).toBe("/api/heatmap/days?year=2026");
    expect(calls[1]?.url).toBe("/api/heatmap/days?year=2026&source=manual");
  });

  test("getHeatmapHours omits year when not supplied", async () => {
    mockFetch(() => jsonResponse({ cells: [] }));

    await getHeatmapHours();
    await getHeatmapHours("2026");
    await getHeatmapHours("2026", "simkl");

    expect(calls[0]?.url).toBe("/api/heatmap/hours");
    expect(calls[1]?.url).toBe("/api/heatmap/hours?year=2026");
    expect(calls[2]?.url).toBe("/api/heatmap/hours?year=2026&source=simkl");
  });

  test("getStats and getInProgress hit the right paths", async () => {
    mockFetch(() => jsonResponse({}));

    await getStats();
    await getStats("manual");
    await getStats({ from: "2026-10-01", to: "2026-10-31", source: "audiobookshelf" });
    await getInProgress();

    expect(calls[0]?.url).toBe("/api/stats");
    expect(calls[1]?.url).toBe("/api/stats?source=manual");
    expect(calls[2]?.url).toBe(
      "/api/stats?from=2026-10-01&to=2026-10-31&source=audiobookshelf"
    );
    expect(calls[3]?.url).toBe("/api/in-progress");
  });

  test("getJson is a thin typed GET wrapper", async () => {
    mockFetch(() => jsonResponse({ ok: true }));

    const result = await getJson<{ ok: boolean }>("/api/health");

    expect(calls[0]?.url).toBe("/api/health");
    expect(result).toEqual({ ok: true });
  });
});

describe("api.ts error handling", () => {
  test("throws the server's {error} message on a non-2xx response", async () => {
    mockFetch(() => jsonResponse({ error: "Invalid month format: 'bad'" }, 400));

    await expect(getCalendar("bad")).rejects.toThrow(
      "Invalid month format: 'bad'"
    );
  });

  test("falls back to a status message for a non-JSON error body", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));

    await expect(getStats()).rejects.toThrow("500");
  });
});

describe("api.ts write helpers", () => {
  test("postJson sends a JSON body with the correct headers", async () => {
    mockFetch(() => jsonResponse({ id: "abc", inserted: 1 }, 201));

    const result = await postJson<{ id: string; inserted: number }>(
      "/api/events",
      { media_type: "movie", title: "Sample Movie" }
    );

    const init = calls[0]?.init;
    expect(calls[0]?.url).toBe("/api/events");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(init?.body).toBe(
      JSON.stringify({ media_type: "movie", title: "Sample Movie" })
    );
    expect(result).toEqual({ id: "abc", inserted: 1 });
  });

  test("addEvent posts the manual entry body to /api/events", async () => {
    mockFetch(() => jsonResponse({ id: "evt-1", inserted: 1 }, 201));

    const body = {
      media_type: "movie",
      title: "Sample Movie",
      started_at: "2026-10-17 21:30",
      duration_seconds: 7200,
    };
    const result = await addEvent(body);

    const init = calls[0]?.init;
    expect(calls[0]?.url).toBe("/api/events");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(body));
    expect(result).toEqual({ id: "evt-1", inserted: 1 });
  });

  test("importFile sends multipart FormData with the file field", async () => {
    mockFetch(() => jsonResponse({ seen: 1, inserted: 1, runId: 7 }));

    const file = new File(["{}"], "export.json", {
      type: "application/json",
    });
    const result = await importFile(file);

    const init = calls[0]?.init;
    expect(calls[0]?.url).toBe("/api/import");
    expect(init?.method).toBe("POST");
    // Content-Type must be left unset so the browser adds the multipart boundary.
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);

    const form = init?.body as FormData;
    const sent = form.get("file");
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe("export.json");
    expect(result).toEqual({ seen: 1, inserted: 1, runId: 7 });
  });

  test("importFile throws the server error on a rejected upload", async () => {
    mockFetch(() =>
      jsonResponse({ error: "Could not infer format (expected json or csv)" }, 400)
    );

    const file = new File(["not-valid"], "bad.txt", { type: "text/plain" });
    await expect(importFile(file)).rejects.toThrow(
      "Could not infer format (expected json or csv)"
    );
  });

  test("importFile turns a 413 into a CLI hint for large Takeout files", async () => {
    mockFetch(() => new Response(null, { status: 413 }));

    const file = new File(["[{}]"], "watch-history.json", {
      type: "application/json",
    });
    await expect(importFile(file)).rejects.toThrow(
      /File too large for upload\. On the server run: bun run it import youtube-takeout <file>/
    );
  });
});

describe("api.ts v2 endpoints (lookup, archive, library, series, review, settings)", () => {
  test("lookupSearch and lookupWork hit the metadata lookup endpoints", async () => {
    mockFetch(() =>
      jsonResponse({
        query: "synthetic saga",
        category: "anime",
        results: [],
        failed_providers: [],
      })
    );

    await lookupSearch("synthetic saga", "anime");
    await lookupSearch({ q: "synthetic novel", category: "any" });

    expect(calls[0]?.url).toBe(
      "/api/lookup/search?q=synthetic+saga&category=anime"
    );
    expect(calls[1]?.url).toBe(
      "/api/lookup/search?q=synthetic+novel&category=any"
    );

    mockFetch(() =>
      jsonResponse({
        provider: "anilist",
        provider_id: "101348",
        category: "anime",
        title: "Synthetic Saga",
        original_title: null,
        year: 2019,
        cover_url: "/api/meta-cover/anilist/101348",
        creators: ["Synthetic Studio"],
        genres: ["Adventure"],
        description: "Synthetic description.",
        seasons: [],
        runtime_minutes: null,
        pages: null,
        external_ids: { anilist: "101348" },
      })
    );

    const work = await lookupWork("anilist", "101348");
    expect(calls[2]?.url).toBe("/api/lookup/work/anilist/101348");
    expect(work.title).toBe("Synthetic Saga");
  });

  test("saveArchiveEntry, deleteArchiveEntry, and listArchive use /api/archive", async () => {
    mockFetch(() =>
      jsonResponse({
        entry_id: "entry-1",
        inserted: 2,
        units: 2,
        total_minutes: 1152,
        estimated: true,
      })
    );

    const saveRes = await saveArchiveEntry({
      entry_id: "entry-1",
      work: {
        provider: "manual",
        category: "anime",
        title: "Synthetic Saga",
        year: 2019,
        creators: [],
        seasons: [],
        runtime_minutes: null,
        pages: null,
      },
      consumed: { seasons: [{ number: 1 }, { number: 2 }] },
      when: { precision: "year", date: "2021" },
      rating: 9,
      note: "Great synthetic anime",
    });

    expect(calls[0]?.url).toBe("/api/archive");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(saveRes.total_minutes).toBe(1152);

    mockFetch(() => jsonResponse({ deleted: 2, entry_id: "entry-1" }));
    await deleteArchiveEntry("entry-1");
    expect(calls[1]?.url).toBe("/api/archive/entry-1/delete");
    expect(calls[1]?.init?.method).toBe("POST");

    mockFetch(() => jsonResponse([]));
    await listArchive();
    await listArchive("anime");
    expect(calls[2]?.url).toBe("/api/archive");
    expect(calls[3]?.url).toBe("/api/archive?category=anime");
  });

  test("getLibrary and getLibraryWork hit /api/library and /api/library/work", async () => {
    mockFetch(() =>
      jsonResponse({ categories: [], works: [], total_minutes: 0 })
    );

    await getLibrary();
    await getLibrary({ category: "anime", q: "saga", sort: "time" });

    expect(calls[0]?.url).toBe("/api/library");
    expect(calls[1]?.url).toBe(
      "/api/library?category=anime&q=saga&sort=time"
    );

    mockFetch(() =>
      jsonResponse({
        key: "anime:synthetic-saga",
        category: "anime",
        title: "Synthetic Saga",
        cover_url: null,
        total_minutes: 1152,
        units: 2,
        first_at: "2021-01-01T12:00:00.000Z",
        last_at: "2021-12-01T12:00:00.000Z",
        status: "finished",
        rating: 9,
        sources: ["manual"],
        seasons: [],
        history: [],
        note: null,
      })
    );

    const detail = await getLibraryWork("anime:synthetic-saga");
    expect(calls[2]?.url).toBe(
      "/api/library/work?key=anime%3Asynthetic-saga"
    );
    expect(detail.title).toBe("Synthetic Saga");
  });

  test("getSeries, getMonthReview, getYearReviewV2, and getSettings build exact URLs", async () => {
    mockFetch(() => jsonResponse({}));

    await getSeries({
      bucket: "day",
      from: "2026-09-18",
      to: "2026-10-17",
      category: "anime",
    });
    await getMonthReview("2026-10");
    await getYearReviewV2(2026);
    await getSettings();

    expect(calls[0]?.url).toBe(
      "/api/series?bucket=day&from=2026-09-18&to=2026-10-17&category=anime"
    );
    expect(calls[1]?.url).toBe("/api/review/month?month=2026-10");
    expect(calls[2]?.url).toBe("/api/review/year?year=2026");
    expect(calls[3]?.url).toBe("/api/settings");
  });
});
