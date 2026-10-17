import { describe, expect, test } from "bun:test";
import { HEATMAP_SOURCES } from "../web/src/lib/heatmap.ts";
import { STATS_SOURCES, sourceColor as statsSourceColor } from "../web/src/lib/stats.ts";
import {
  SOURCES,
  sourceColor,
  sourceEntry,
  sourceLabel,
  UNKNOWN_SOURCE_COLOR,
} from "../web/src/lib/sources.ts";

describe("SOURCES", () => {
  test("lists the known sources in order", () => {
    expect(SOURCES.map((s) => s.value)).toEqual([
      "audiobookshelf",
      "simkl",
      "manual",
    ]);
  });

  test("carries a label, icon and colour for each source", () => {
    const byValue = new Map(SOURCES.map((s) => [s.value, s]));
    expect(byValue.get("audiobookshelf")).toEqual({
      value: "audiobookshelf",
      label: "Audiobookshelf",
      icon: "🎧",
      color: "#8b5cf6",
    });
    expect(byValue.get("simkl")).toEqual({
      value: "simkl",
      label: "Simkl",
      icon: "🎬",
      color: "#f59e0b",
    });
    expect(byValue.get("manual")).toEqual({
      value: "manual",
      label: "Manual",
      icon: "📝",
      color: "#10b981",
    });
  });
});

describe("sourceLabel", () => {
  test("maps known sources, including the ABS alias", () => {
    expect(sourceLabel("audiobookshelf")).toBe("Audiobookshelf");
    expect(sourceLabel("abs")).toBe("Audiobookshelf");
    expect(sourceLabel("ABS")).toBe("Audiobookshelf");
    expect(sourceLabel("simkl")).toBe("Simkl");
    expect(sourceLabel("manual")).toBe("Manual");
  });

  test("falls back to the trimmed raw value for unknown sources", () => {
    expect(sourceLabel("youtube")).toBe("youtube");
    expect(sourceLabel("  custom  ")).toBe("custom");
    expect(sourceLabel("")).toBe("");
  });
});

describe("sourceColor", () => {
  test("returns the configured colour per source", () => {
    expect(sourceColor("audiobookshelf")).toBe("#8b5cf6");
    expect(sourceColor("abs")).toBe("#8b5cf6");
    expect(sourceColor("simkl")).toBe("#f59e0b");
    expect(sourceColor("manual")).toBe("#10b981");
  });

  test("falls back to blue for unknown sources", () => {
    expect(sourceColor("unknown")).toBe(UNKNOWN_SOURCE_COLOR);
    expect(UNKNOWN_SOURCE_COLOR).toBe("#3b82f6");
  });
});

describe("sourceEntry", () => {
  test("returns the entry for a known (or aliased) source", () => {
    expect(sourceEntry("simkl")?.label).toBe("Simkl");
    expect(sourceEntry("abs")?.value).toBe("audiobookshelf");
    expect(sourceEntry("unknown")).toBeUndefined();
  });
});

describe("source lists include Simkl", () => {
  test("HEATMAP_SOURCES derives from SOURCES", () => {
    const values = HEATMAP_SOURCES.map((s) => s.value);
    expect(values).toContain("audiobookshelf");
    expect(values).toContain("simkl");
    expect(values).toContain("manual");
    expect(HEATMAP_SOURCES.find((s) => s.value === "simkl")?.label).toBe("Simkl");
  });

  test("STATS_SOURCES has 'All sources' first, then every SOURCES entry", () => {
    expect(STATS_SOURCES[0]).toEqual({ value: "", label: "All sources" });
    const values = STATS_SOURCES.map((s) => s.value);
    expect(values).toContain("simkl");
    for (const source of SOURCES) {
      expect(values).toContain(source.value);
    }
  });

  test("stats.ts re-exports the shared sourceColor", () => {
    expect(statsSourceColor("simkl")).toBe("#f59e0b");
    expect(statsSourceColor("unknown")).toBe("#3b82f6");
  });
});
