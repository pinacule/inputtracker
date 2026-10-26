import { describe, expect, test } from "bun:test";
import { COUNTER_MS, LOCK_MS, TRACKING_MS, digitDelay, digitFrames, mergeBounds, overlaps, sliceShift } from "../web/src/skins/rewind/mechanics.ts";

describe("Rewind motion rules", () => {
  test("counter columns cross only three glyphs and finish on the exact digit", () => {
    for (let digit = 0; digit < 10; digit++) {
      const frames = digitFrames(digit);
      expect(frames).toHaveLength(4);
      expect(frames.at(-1)).toBe(digit);
      expect(frames.every((value) => value >= 0 && value <= 9)).toBe(true);
    }
    expect(digitFrames(9)).toEqual([2, 1, 0, 9]);
  });
  test("rightmost columns start first; arbitrarily long totals still lock within 360ms", () => {
    expect([0, 1, 2, 3].map((i) => digitDelay(i, 4))).toEqual([42, 28, 14, 0]);
    expect(digitDelay(0, 80) + 220).toBeLessThan(COUNTER_MS);
    expect(COUNTER_MS).toBeLessThanOrEqual(360);
    expect(TRACKING_MS).toBeLessThanOrEqual(240);
    expect(LOCK_MS).toBeLessThanOrEqual(620);
  });
  test("tracking alternates signs and scales down to six pixels on phones", () => {
    expect([0, 1, 2].map((i) => sliceShift("week-change", false, i))).toEqual([12, -12, 12]);
    expect([0, 1].map((i) => sliceShift("day-change", true, i))).toEqual([6, -6]);
  });
  test("free effects respect the inflated exclusion on every edge", () => {
    const text = { left: 20, top: 20, right: 40, bottom: 40 };
    expect(overlaps({ left: 4, top: 20, right: 6, bottom: 22 }, text, 12)).toBe(false);
    expect(overlaps({ left: 8, top: 20, right: 10, bottom: 22 }, text, 12)).toBe(true);
    expect(overlaps({ left: 22, top: 41, right: 24, bottom: 42 }, text)).toBe(false);
    expect(overlaps({ left: 22, top: 41, right: 24, bottom: 42 }, text, 12)).toBe(true);
  });
  test("overlapping control and focus holes cannot reopen each other in an even-odd mask", () => {
    expect(mergeBounds([
      { left: 10, top: 10, right: 20, bottom: 20 },
      { left: 30, top: 10, right: 40, bottom: 20 },
      { left: 15, top: 5, right: 35, bottom: 25 },
      { left: 60, top: 10, right: 70, bottom: 20 },
    ])).toEqual([
      { left: 10, top: 5, right: 40, bottom: 25 },
      { left: 60, top: 10, right: 70, bottom: 20 },
    ]);
  });
});
