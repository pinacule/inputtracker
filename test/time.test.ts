import { describe, expect, test } from "bun:test";
import { localParts, toUtcIso } from "../src/core/time.ts";

describe("toUtcIso", () => {
  test("epoch milliseconds → UTC ISO with milliseconds", () => {
    // 2026-10-17T08:15:00.000Z
    expect(toUtcIso(1792224900000)).toBe("2026-10-17T08:15:00.000Z");
    expect(toUtcIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  test("string with +02:00 offset", () => {
    expect(toUtcIso("2026-10-17T10:15:00+02:00")).toBe("2026-10-17T08:15:00.000Z");
  });

  test("string with Z suffix", () => {
    expect(toUtcIso("2026-10-17T08:15:00Z")).toBe("2026-10-17T08:15:00.000Z");
  });

  test("Date object", () => {
    expect(toUtcIso(new Date("2026-10-17T08:15:00.000Z"))).toBe(
      "2026-10-17T08:15:00.000Z"
    );
  });

  test("date-only is treated as UTC midnight", () => {
    expect(toUtcIso("2026-10-17")).toBe("2026-10-17T00:00:00.000Z");
  });

  test("naive datetime without offset is treated as UTC", () => {
    expect(toUtcIso("2026-10-17T08:15:00")).toBe("2026-10-17T08:15:00.000Z");
    expect(toUtcIso("2026-10-17 08:15:00")).toBe("2026-10-17T08:15:00.000Z");
  });

  test("invalid input throws", () => {
    expect(() => toUtcIso("not-a-date")).toThrow();
    expect(() => toUtcIso("")).toThrow();
    expect(() => toUtcIso("   ")).toThrow();
    expect(() => toUtcIso("2026-13-45")).toThrow();
    expect(() => toUtcIso(Number.NaN)).toThrow();
    expect(() => toUtcIso(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => toUtcIso(new Date(Number.NaN))).toThrow();
  });
});

describe("localParts", () => {
  test("summer conversion (+02:00)", () => {
    const parts = localParts("2026-06-15T10:15:00.000Z");
    expect(parts.date).toBe("2026-06-15");
    expect(parts.hour).toBe(12);
  });

  test("winter conversion (+01:00)", () => {
    const parts = localParts("2026-01-15T10:15:00.000Z");
    expect(parts.date).toBe("2026-01-15");
    expect(parts.hour).toBe(11);
  });

  test("midnight boundary", () => {
    const justAfter = localParts("2026-10-16T22:00:00.000Z");
    expect(justAfter.date).toBe("2026-10-17");
    expect(justAfter.hour).toBe(0);

    const justBefore = localParts("2026-10-16T21:59:59.999Z");
    expect(justBefore.date).toBe("2026-10-16");
    expect(justBefore.hour).toBe(23);
  });

  test("spring forward on 2026-03-29", () => {
    // 00:30Z is still CET (+01:00) → 01:30 local.
    const before = localParts("2026-03-29T00:30:00.000Z");
    expect(before.date).toBe("2026-03-29");
    expect(before.hour).toBe(1);

    // 01:00Z is already CEST (+02:00) → 03:00 local.
    const after = localParts("2026-03-29T01:00:00.000Z");
    expect(after.date).toBe("2026-03-29");
    expect(after.hour).toBe(3);
  });

  test("fall back on 2026-10-25", () => {
    // 00:30Z is still CEST (+02:00) → 02:30 local.
    const before = localParts("2026-10-25T00:30:00.000Z");
    expect(before.date).toBe("2026-10-25");
    expect(before.hour).toBe(2);

    // 01:00Z is CET (+01:00) → 02:00 local.
    const after = localParts("2026-10-25T01:00:00.000Z");
    expect(after.date).toBe("2026-10-25");
    expect(after.hour).toBe(2);
  });

  test("ISO weekday: 1=Mon .. 7=Sun", () => {
    expect(localParts("2026-10-17T08:00:00.000Z").weekday).toBe(6); // Saturday
    expect(localParts("2026-10-18T08:00:00.000Z").weekday).toBe(7); // Sunday
    expect(localParts("2026-10-19T08:00:00.000Z").weekday).toBe(1); // Monday
  });

  test("timezone is a parameter", () => {
    const parts = localParts("2026-10-17T08:15:00.000Z", "UTC");
    expect(parts.date).toBe("2026-10-17");
    expect(parts.hour).toBe(8);
  });

  test("invalid iso throws", () => {
    expect(() => localParts("not-a-date")).toThrow();
  });
});
