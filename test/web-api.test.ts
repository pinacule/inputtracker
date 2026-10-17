import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addEvent,
  getCalendar,
  getHeatmapDays,
  getHeatmapHours,
  getInProgress,
  getJson,
  getStats,
  importFile,
  postJson,
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
    await getInProgress();

    expect(calls[0]?.url).toBe("/api/stats");
    expect(calls[1]?.url).toBe("/api/stats?source=manual");
    expect(calls[2]?.url).toBe("/api/in-progress");
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
});
