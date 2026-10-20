import { describe, expect, test } from "bun:test";
import { parseEventBatch } from "../src/core/ingest-events.ts";
import { shortformDay } from "../src/core/shortform.ts";

describe("pushed ActivityWatch short-form days", () => {
  test("a short-form day record as the PC's sync builds it passes validation", () => {
    const day = shortformDay("2026-10-20", 3084, "youtube", "aw", "Europe/Bratislava");
    const nowMs = Date.parse("2026-10-20T18:00:00.000Z");
    const [parsed] = parseEventBatch({ events: [day] }, nowMs);
    expect(parsed?.source_kind).toBe("shortform_day");
    expect(parsed?.media_type).toBe("shortform");
    expect(parsed?.duration_seconds).toBe(3084);
  });

  test("other media types are still rejected for short-form days", () => {
    const day = { ...shortformDay("2026-10-20", 60, "youtube", "aw", "Europe/Bratislava"), media_type: "movie" };
    expect(() => parseEventBatch({ events: [day] }, Date.parse("2026-10-20T18:00:00.000Z"))).toThrow();
  });
});
