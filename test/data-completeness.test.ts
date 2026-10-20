import { describe, expect, test } from "bun:test";
import { COMPLETE_FROM, completeHistoryStart, rangeIsComplete } from "../web/src/lib/data-completeness";
import { buildRollingGraphModel } from "../web/src/lib/home-norm";

describe("data completeness", () => {
  test("history is treated as incomplete for now", () => {
    expect(COMPLETE_FROM).toBeNull();
    expect(completeHistoryStart("2025-01-01")).toBeNull();
    expect(rangeIsComplete("2026-10-01")).toBe(false);
  });

  test("once set, averages start at the later of history start and the complete date", () => {
    expect(completeHistoryStart("2025-01-01", "2026-01-01")).toBe("2026-01-01");
    expect(completeHistoryStart("2026-03-01", "2026-01-01")).toBe("2026-03-01");
    expect(completeHistoryStart(null, "2026-01-01")).toBe("2026-01-01");
    expect(rangeIsComplete("2025-12-31", "2026-01-01")).toBe(false);
    expect(rangeIsComplete("2026-01-01", "2026-01-01")).toBe(true);
  });

  test("the home graph has no norms without complete history", () => {
    const points = [{ bucket: "2026-10-01", minutes_by_category: { film: 90 } }];
    const off = buildRollingGraphModel([], "2026-10-20", "2026-10-20", "2026-10-20", points as any, completeHistoryStart("2026-09-01"));
    expect(off.hasNorms).toBe(false);
    expect([...off.norms.values()].every((m) => m === 0)).toBe(true);
    const on = buildRollingGraphModel([], "2026-10-20", "2026-10-20", "2026-10-20", points as any, "2026-09-01");
    expect(on.hasNorms).toBe(true);
  });
});
