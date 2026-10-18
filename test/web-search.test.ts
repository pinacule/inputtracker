import { describe, expect, test } from "bun:test";
import {
  MIN_QUERY_LENGTH,
  SEARCH_MEDIA_TYPES,
  countLabel,
  formatHitMeta,
  highlightParts,
  normalizeForSearch,
} from "../web/src/lib/search.ts";
import type { SearchHit } from "../web/src/api.ts";

describe("normalizeForSearch (web twin of the server function)", () => {
  test("lowercase, diacritics, whitespace collapse, trim", () => {
    expect(normalizeForSearch("Šťastný  Deň")).toBe("stastny den");
    expect(normalizeForSearch("  Mixed   CASE ")).toBe("mixed case");
    expect(normalizeForSearch("")).toBe("");
  });
});

describe("highlightParts", () => {
  test("case-insensitive match keeps the original characters", () => {
    const parts = highlightParts("Fake Book", "book");
    expect(parts).toEqual([
      { text: "Fake ", match: false },
      { text: "Book", match: true },
    ]);
  });

  test("diacritics-insensitive match highlights the accented original", () => {
    const parts = highlightParts("Šťastný deň", "stastny");
    expect(parts).toEqual([
      { text: "Šťastný", match: true },
      { text: " deň", match: false },
    ]);
    // The original characters survive byte for byte.
    expect(parts.map((p) => p.text).join("")).toBe("Šťastný deň");
  });

  test("repeated matches are highlighted individually", () => {
    const parts = highlightParts("ab ab", "ab");
    expect(parts).toEqual([
      { text: "ab", match: true },
      { text: " ", match: false },
      { text: "ab", match: true },
    ]);
  });

  test("overlapping matches are merged", () => {
    const parts = highlightParts("aaa", "aa");
    expect(parts).toEqual([{ text: "aaa", match: true }]);
  });

  test("no match yields one non-matching part", () => {
    expect(highlightParts("Hello", "xyz")).toEqual([
      { text: "Hello", match: false },
    ]);
  });

  test("an empty query or text yields no highlights", () => {
    expect(highlightParts("Hello", "")).toEqual([{ text: "Hello", match: false }]);
    expect(highlightParts("", "query")).toEqual([]);
  });

  test("multi-word queries highlight words in any order", () => {
    const parts = highlightParts("Book Two Fake", "two fake");
    expect(parts).toEqual([
      { text: "Book ", match: false },
      { text: "Two", match: true },
      { text: " ", match: false },
      { text: "Fake", match: true },
    ]);
  });

  test("collapsed whitespace matches across extra spaces, original spacing kept", () => {
    const parts = highlightParts("Fake  Book", "fake book");
    expect(parts).toEqual([
      { text: "Fake", match: true },
      { text: "  ", match: false },
      { text: "Book", match: true },
    ]);
    // The original characters survive byte for byte.
    expect(parts.map((p) => p.text).join("")).toBe("Fake  Book");
  });
});

describe("countLabel", () => {
  test("plays for regular sources, views for YouTube", () => {
    expect(countLabel("manual", 1)).toBe("1 play");
    expect(countLabel("manual", 12)).toBe("12 plays");
    expect(countLabel("youtube", 1)).toBe("1 view");
    expect(countLabel("youtube", 12)).toBe("12 views");
  });
});

describe("formatHitMeta", () => {
  function hit(overrides: Partial<SearchHit> = {}): SearchHit {
    return {
      key: "manual\u0000Fake Movie",
      title: "Fake Movie",
      source: "manual",
      media_type: "movie",
      matched: ["title"],
      subtitle: null,
      count: 12,
      minutes: 2040,
      first_date: "2026-05-03",
      last_date: "2026-10-17",
      cover_url: null,
      ...overrides,
    };
  }

  test("regular sources use plays and a date range", () => {
    expect(formatHitMeta(hit())).toBe(
      "12 plays · 34 h · 03.05.2026 – 17.10.2026"
    );
  });

  test("YouTube uses views", () => {
    expect(formatHitMeta(hit({ source: "youtube", minutes: 0 }))).toBe(
      "12 views · 0 h · 03.05.2026 – 17.10.2026"
    );
  });

  test("a single date is shown when first = last", () => {
    expect(
      formatHitMeta(hit({ count: 1, minutes: 90, first_date: "2026-05-03", last_date: "2026-05-03" }))
    ).toBe("1 play · 1.5 h · 03.05.2026");
  });
});

describe("constants", () => {
  test("MIN_QUERY_LENGTH is 2 and the media types match the server", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(SEARCH_MEDIA_TYPES).toEqual([
      "audiobook",
      "podcast_episode",
      "movie",
      "episode",
      "video",
      "music",
      "book",
      "other",
    ]);
  });
});
