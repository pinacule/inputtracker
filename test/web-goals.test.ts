import { describe, expect, test } from "bun:test";
import {
  buildGoalInput,
  formatGoalValue,
  metricLabel,
  statusLabel,
} from "../web/src/lib/goals.ts";

describe("web goals helpers (web/src/lib/goals.ts)", () => {
  describe("metricLabel", () => {
    test("returns human-readable labels for each metric", () => {
      expect(metricLabel("items")).toBe("Items");
      expect(metricLabel("hours")).toBe("Hours");
      expect(metricLabel("titles")).toBe("Titles");
      expect(metricLabel("active_days")).toBe("Active days");
    });
  });

  describe("formatGoalValue", () => {
    test("formats with current and target", () => {
      expect(formatGoalValue("items", 12, 30)).toBe("12 / 30 items");
      expect(formatGoalValue("hours", 48.5, 200)).toBe("48.5 / 200 h");
      expect(formatGoalValue("titles", 5, 20)).toBe("5 / 20 titles");
      expect(formatGoalValue("active_days", 50, 100)).toBe("50 / 100 days");
    });

    test("formats single value (target only or current only)", () => {
      expect(formatGoalValue("items", 30)).toBe("30 items");
      expect(formatGoalValue("hours", 200)).toBe("200 h");
      expect(formatGoalValue("titles", 15)).toBe("15 titles");
      expect(formatGoalValue("active_days", 100)).toBe("100 days");
    });
  });

  describe("statusLabel", () => {
    test("formats all status variations", () => {
      expect(statusLabel("on_track")).toBe("On track");
      expect(statusLabel("done")).toBe("Done");
      expect(statusLabel("missed")).toBe("Missed");
      expect(statusLabel("not_started")).toBe("Not started");

      // Behind with diff and metric
      expect(statusLabel("behind", 3, "items")).toBe("Behind by 3 items");
      expect(statusLabel("behind", 1, "items")).toBe("Behind by 1 item");
      expect(statusLabel("behind", 1.5, "hours")).toBe("Behind by 1.5 h");
      expect(statusLabel("behind", 2, "titles")).toBe("Behind by 2 titles");
      expect(statusLabel("behind", 1, "titles")).toBe("Behind by 1 title");
      expect(statusLabel("behind", 5, "active_days")).toBe("Behind by 5 days");
      expect(statusLabel("behind", 1, "active_days")).toBe("Behind by 1 day");

      // Behind from progress object
      expect(
        statusLabel({ status: "behind", expected: 15, current: 12 }, "items")
      ).toBe("Behind by 3 items");
      expect(
        statusLabel({ status: "on_track", expected: 10, current: 12 }, "items")
      ).toBe("On track");
    });
  });

  describe("buildGoalInput", () => {
    test("builds a valid SaveGoalInput payload", () => {
      const res = buildGoalInput({
        year: "2026",
        metric: "items",
        target: "30",
        source: "audiobookshelf",
        media_type: "audiobook",
      });

      expect(res.errors).toEqual([]);
      expect(res.input).toEqual({
        year: 2026,
        metric: "items",
        target: 30,
        source: "audiobookshelf",
        media_type: "audiobook",
        archived: 0,
      });
    });

    test("preserves goal_id and rev_id when provided", () => {
      const goal_id = "00000000-0000-0000-0000-000000000001";
      const rev_id = "00000000-0000-0000-0000-000000000002";
      const res = buildGoalInput({
        goal_id,
        rev_id,
        year: 2026,
        metric: "hours",
        target: 100,
      });

      expect(res.errors).toEqual([]);
      expect(res.input?.goal_id).toBe(goal_id);
      expect(res.input?.rev_id).toBe(rev_id);
    });

    test("normalizes empty source and media_type to null", () => {
      const res = buildGoalInput({
        year: 2026,
        metric: "titles",
        target: 10,
        source: "  ",
        media_type: "",
      });

      expect(res.errors).toEqual([]);
      expect(res.input?.source).toBeNull();
      expect(res.input?.media_type).toBeNull();
    });

    test("validates invalid fields and collects errors", () => {
      const res = buildGoalInput({
        year: 1990,
        metric: "unknown",
        target: -1,
        source: "x".repeat(65),
        media_type: "fake_type",
      });

      expect(res.input).toBeNull();
      expect(res.errors.length).toBeGreaterThanOrEqual(4);
      expect(res.errors.some((e) => e.includes("Year"))).toBe(true);
      expect(res.errors.some((e) => e.includes("Metric"))).toBe(true);
      expect(res.errors.some((e) => e.includes("Target"))).toBe(true);
      expect(res.errors.some((e) => e.includes("Source"))).toBe(true);
      expect(res.errors.some((e) => e.includes("media_type"))).toBe(true);
    });
  });
});
