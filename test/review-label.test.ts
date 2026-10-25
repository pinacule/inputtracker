import { describe, expect, test } from "bun:test";
import { formatShortDate, previousMonthName } from "../web/src/lib/format-date";

describe("previousMonthName", () => {
  test("names the month before, across a year boundary", () => {
    expect(previousMonthName("2026-09")).toBe("August");
    expect(previousMonthName("2026-01")).toBe("December");
  });
  test("falls back on bad input", () => {
    expect(previousMonthName("nope")).toBe("previous month");
  });
});

describe("formatShortDate", () => {
  test("uses the local day, not the UTC one", () => {
    // 22:30 UTC on 21 Oct is already 22 Oct in Bratislava (UTC+2 in summer time).
    expect(formatShortDate("2026-10-21T22:30:00.000Z")).toBe("22 Oct");
    expect(formatShortDate("2026-10-21T10:00:00.000Z")).toBe("21 Oct");
  });
  test("returns invalid input unchanged", () => {
    expect(formatShortDate("not a date")).toBe("not a date");
  });
});
