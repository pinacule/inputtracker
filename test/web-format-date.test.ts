import { describe, expect, test } from "bun:test";
import { formatDateTime } from "../web/src/lib/format-date.ts";

const BRATISLAVA = "Europe/Bratislava";

describe("formatDateTime", () => {
  test("formats a UTC timestamp in Europe/Bratislava (winter, UTC+1)", () => {
    // 2026-01-15T10:15:00Z -> 11:15 CET
    expect(formatDateTime("2026-01-15T10:15:00.000Z", BRATISLAVA)).toBe(
      "15.01.2026 11:15"
    );
  });

  test("formats a UTC timestamp in Europe/Bratislava (summer, UTC+2)", () => {
    // 2026-06-15T10:15:00Z -> 12:15 CEST
    expect(formatDateTime("2026-06-15T10:15:00.000Z", BRATISLAVA)).toBe(
      "15.06.2026 12:15"
    );
  });

  test("produces the requested 24-hour Import/Export format", () => {
    // 2026-10-17T13:59:56Z -> 15:59 CEST, i.e. "17.10.2026 15:59".
    expect(formatDateTime("2026-10-17T13:59:56.000Z", BRATISLAVA)).toBe(
      "17.10.2026 15:59"
    );
  });

  test("zero-pads day, month, hour and minute", () => {
    // 2026-01-05T08:05:00Z -> 09:05 CET
    expect(formatDateTime("2026-01-05T08:05:00.000Z", BRATISLAVA)).toBe(
      "05.01.2026 09:05"
    );
  });

  test("uses the given timezone, not the host timezone", () => {
    expect(formatDateTime("2026-06-15T10:15:00.000Z", "UTC")).toBe(
      "15.06.2026 10:15"
    );
    expect(formatDateTime("2026-06-15T10:15:00.000Z", "America/New_York")).toBe(
      "15.06.2026 06:15"
    );
  });

  test("midnight in UTC rolls to the next local day", () => {
    // 2026-10-16T22:00:00Z -> 2026-10-17 00:00 CEST
    expect(formatDateTime("2026-10-16T22:00:00.000Z", BRATISLAVA)).toBe(
      "17.10.2026 00:00"
    );
    // 2026-06-15T23:30:00Z -> 2026-06-16 01:30 CEST
    expect(formatDateTime("2026-06-15T23:30:00.000Z", BRATISLAVA)).toBe(
      "16.06.2026 01:30"
    );
  });

  test("handles the spring DST start (2026-03-29, 01:00 UTC jump)", () => {
    // Before the jump: 00:30Z is 01:30 CET.
    expect(formatDateTime("2026-03-29T00:30:00.000Z", BRATISLAVA)).toBe(
      "29.03.2026 01:30"
    );
    // After the jump: 01:30Z is 03:30 CEST (02:xx never happens locally).
    expect(formatDateTime("2026-03-29T01:30:00.000Z", BRATISLAVA)).toBe(
      "29.03.2026 03:30"
    );
  });

  test("handles the autumn DST end (2026-10-25, 01:00 UTC fall-back)", () => {
    // Before the fall-back: 00:30Z is 02:30 CEST.
    expect(formatDateTime("2026-10-25T00:30:00.000Z", BRATISLAVA)).toBe(
      "25.10.2026 02:30"
    );
    // After the fall-back: 01:30Z is again 02:30, now CET.
    expect(formatDateTime("2026-10-25T01:30:00.000Z", BRATISLAVA)).toBe(
      "25.10.2026 02:30"
    );
  });

  test("returns invalid input unchanged", () => {
    expect(formatDateTime("not-a-date", BRATISLAVA)).toBe("not-a-date");
    expect(formatDateTime("", BRATISLAVA)).toBe("");
    expect(formatDateTime("2026-13-45", BRATISLAVA)).toBe("2026-13-45");
  });
});
