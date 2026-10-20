import { describe, expect, test } from "bun:test";
import { previousMonthName } from "../web/src/lib/format-date";

describe("previousMonthName", () => {
  test("names the month before, across a year boundary", () => {
    expect(previousMonthName("2026-09")).toBe("August");
    expect(previousMonthName("2026-01")).toBe("December");
  });
  test("falls back on bad input", () => {
    expect(previousMonthName("nope")).toBe("previous month");
  });
});
