import { describe, expect, test } from "bun:test";
import {
  buildHourGrid,
  buildYearGrid,
  describeDay,
  HEATMAP_SOURCES,
  levelFor,
  monthLabels,
} from "../web/src/lib/heatmap.ts";
import type { HeatmapDay, HeatmapHourCell } from "../web/src/api.ts";

describe("buildYearGrid", () => {
  test("builds correct grid for a normal year (2026)", () => {
    // Synthetic sample days
    const days: HeatmapDay[] = [
      { date: "2026-01-01", count: 2, minutes: 45 },
      { date: "2026-10-17", count: 3, minutes: 85 },
      { date: "2026-12-31", count: 1, minutes: 20 },
    ];

    const weeks = buildYearGrid(2026, days);

    // 2026 starts on Thursday (3 leading padding days: Mon, Tue, Wed)
    // 365 days in 2026. 3 + 365 = 368.
    // Ends on Thursday (3 trailing padding days: Fri, Sat, Sun)
    // Total cells = 371 = 53 weeks.
    expect(weeks).toHaveLength(53);

    // Every week must have exactly 7 cells (Monday to Sunday)
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }

    // First week: Monday, Tuesday, Wednesday are null
    expect(weeks[0]?.[0]).toBeNull(); // Monday
    expect(weeks[0]?.[1]).toBeNull(); // Tuesday
    expect(weeks[0]?.[2]).toBeNull(); // Wednesday

    // Thursday is Jan 1 with populated data
    const jan1 = weeks[0]?.[3];
    expect(jan1).not.toBeNull();
    expect(jan1?.date).toBe("2026-01-01");
    expect(jan1?.count).toBe(2);
    expect(jan1?.minutes).toBe(45);

    // Friday Jan 2 has 0 count / 0 minutes
    const jan2 = weeks[0]?.[4];
    expect(jan2?.date).toBe("2026-01-02");
    expect(jan2?.count).toBe(0);
    expect(jan2?.minutes).toBe(0);

    // Last week (week 52): 2026-12-31 is Thursday (index 3)
    const dec31 = weeks[52]?.[3];
    expect(dec31?.date).toBe("2026-12-31");
    expect(dec31?.count).toBe(1);
    expect(dec31?.minutes).toBe(20);

    // Trailing days are null (Fri, Sat, Sun)
    expect(weeks[52]?.[4]).toBeNull();
    expect(weeks[52]?.[5]).toBeNull();
    expect(weeks[52]?.[6]).toBeNull();

    // Specific day placement check for 2026-10-17 (Saturday)
    const oct17 = weeks.flat().find((c) => c?.date === "2026-10-17");
    expect(oct17).toBeDefined();
    expect(oct17?.count).toBe(3);
    expect(oct17?.minutes).toBe(85);
  });

  test("builds correct grid for a leap year (2024)", () => {
    const days: HeatmapDay[] = [
      { date: "2024-01-01", count: 4, minutes: 120 },
      { date: "2024-02-29", count: 7, minutes: 210 },
      { date: "2024-12-31", count: 2, minutes: 50 },
    ];

    const weeks = buildYearGrid("2024", days);

    // 2024 starts on Monday Jan 1 (0 leading padding days)
    // 366 days in leap year 2024.
    // 366 % 7 = 2 (Dec 30 Mon, Dec 31 Tue) -> 5 trailing padding days (Wed..Sun)
    // Total cells = 371 = 53 weeks.
    expect(weeks).toHaveLength(53);

    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }

    // First week Monday is Jan 1 (no leading padding)
    expect(weeks[0]?.[0]?.date).toBe("2024-01-01");
    expect(weeks[0]?.[0]?.count).toBe(4);
    expect(weeks[0]?.[0]?.minutes).toBe(120);

    // Leap day Feb 29 exists and has correct values
    const feb29 = weeks.flat().find((c) => c?.date === "2024-02-29");
    expect(feb29).toBeDefined();
    expect(feb29?.count).toBe(7);
    expect(feb29?.minutes).toBe(210);

    // Last week: Tuesday is Dec 31
    expect(weeks[52]?.[0]?.date).toBe("2024-12-30");
    expect(weeks[52]?.[1]?.date).toBe("2024-12-31");
    expect(weeks[52]?.[1]?.count).toBe(2);
    expect(weeks[52]?.[1]?.minutes).toBe(50);

    // Trailing days (Wed, Thu, Fri, Sat, Sun) are null
    expect(weeks[52]?.[2]).toBeNull();
    expect(weeks[52]?.[3]).toBeNull();
    expect(weeks[52]?.[4]).toBeNull();
    expect(weeks[52]?.[5]).toBeNull();
    expect(weeks[52]?.[6]).toBeNull();
  });

  test("builds correct grid for a leap year starting on Sunday (2012, 54 weeks)", () => {
    // 2012 starts Sunday Jan 1 -> 6 leading days
    // 366 days in 2012. 6 + 366 = 372.
    // Dec 31 is Monday -> 6 trailing days.
    // 378 cells = 54 weeks.
    const weeks = buildYearGrid(2012, []);
    expect(weeks).toHaveLength(54);
    expect(weeks[0]?.[0]).toBeNull();
    expect(weeks[0]?.[5]).toBeNull();
    expect(weeks[0]?.[6]?.date).toBe("2012-01-01");
    expect(weeks[53]?.[0]?.date).toBe("2012-12-31");
    expect(weeks[53]?.[1]).toBeNull();
    expect(weeks[53]?.[6]).toBeNull();
  });

  test("throws on invalid year", () => {
    expect(() => buildYearGrid("invalid", [])).toThrow(/Invalid year/);
    expect(() => buildYearGrid(999, [])).toThrow(/Invalid year/);
    expect(() => buildYearGrid(10000, [])).toThrow(/Invalid year/);
  });
});

describe("levelFor", () => {
  test("boundary: 0 → 0", () => {
    expect(levelFor(0, 100)).toBe(0);
    expect(levelFor(0, 1)).toBe(0);
  });

  test("boundary: negative values → 0", () => {
    expect(levelFor(-1, 100)).toBe(0);
    expect(levelFor(-50, 100)).toBe(0);
  });

  test("boundary: max 0 → 0", () => {
    expect(levelFor(0, 0)).toBe(0);
    expect(levelFor(10, 0)).toBe(0);
    expect(levelFor(100, 0)).toBe(0);
    expect(levelFor(5, -10)).toBe(0);
  });

  test("boundary: max → 4", () => {
    expect(levelFor(100, 100)).toBe(4);
    expect(levelFor(50, 50)).toBe(4);
    expect(levelFor(1, 1)).toBe(4);
  });

  test("values exceeding max → 4", () => {
    expect(levelFor(150, 100)).toBe(4);
    expect(levelFor(1000, 50)).toBe(4);
  });

  test("linear quartile partitions (1..4)", () => {
    // For max = 100:
    // (0..25] -> 1
    // (25..50] -> 2
    // (50..75] -> 3
    // (75..100] -> 4
    expect(levelFor(1, 100)).toBe(1);
    expect(levelFor(25, 100)).toBe(1);

    expect(levelFor(26, 100)).toBe(2);
    expect(levelFor(50, 100)).toBe(2);

    expect(levelFor(51, 100)).toBe(3);
    expect(levelFor(75, 100)).toBe(3);

    expect(levelFor(76, 100)).toBe(4);
    expect(levelFor(99, 100)).toBe(4);
  });

  test("handles NaN gracefully", () => {
    expect(levelFor(NaN, 100)).toBe(0);
    expect(levelFor(50, NaN)).toBe(0);
  });
});

describe("buildHourGrid", () => {
  test("constructs 7x24 matrix with correct placements", () => {
    const syntheticCells: HeatmapHourCell[] = [
      { weekday: 0, hour: 0, count: 1, minutes: 15 },
      { weekday: 2, hour: 14, count: 5, minutes: 75 },
      { weekday: 6, hour: 23, count: 2, minutes: 40 },
    ];

    const grid = buildHourGrid(syntheticCells);

    // 7 rows (weekdays 0..6: Mon..Sun)
    expect(grid).toHaveLength(7);

    // 24 columns (hours 0..23) per weekday
    for (let w = 0; w < 7; w++) {
      expect(grid[w]).toHaveLength(24);
    }

    // Monday (0), 00:00
    expect(grid[0]?.[0]).toEqual({
      weekday: 0,
      hour: 0,
      count: 1,
      minutes: 15,
    });

    // Wednesday (2), 14:00
    expect(grid[2]?.[14]).toEqual({
      weekday: 2,
      hour: 14,
      count: 5,
      minutes: 75,
    });

    // Sunday (6), 23:00
    expect(grid[6]?.[23]).toEqual({
      weekday: 6,
      hour: 23,
      count: 2,
      minutes: 40,
    });

    // Unpopulated cell: Tuesday (1), 08:00
    expect(grid[1]?.[8]).toEqual({
      weekday: 1,
      hour: 8,
      count: 0,
      minutes: 0,
    });
  });

  test("accumulates multiple entries for the same cell", () => {
    const duplicateCells: HeatmapHourCell[] = [
      { weekday: 4, hour: 18, count: 1, minutes: 20 },
      { weekday: 4, hour: 18, count: 2, minutes: 35 },
    ];

    const grid = buildHourGrid(duplicateCells);
    expect(grid[4]?.[18]).toEqual({
      weekday: 4,
      hour: 18,
      count: 3,
      minutes: 55,
    });
  });

  test("ignores invalid or out-of-range cells", () => {
    const invalidCells: HeatmapHourCell[] = [
      { weekday: -1, hour: 5, count: 1, minutes: 10 },
      { weekday: 7, hour: 5, count: 1, minutes: 10 },
      { weekday: 2, hour: -1, count: 1, minutes: 10 },
      { weekday: 2, hour: 24, count: 1, minutes: 10 },
      { weekday: 2.5, hour: 10, count: 1, minutes: 10 },
      { weekday: 2, hour: 10.5, count: 1, minutes: 10 },
    ];

    const grid = buildHourGrid(invalidCells);
    for (let w = 0; w < 7; w++) {
      for (let h = 0; h < 24; h++) {
        expect(grid[w]?.[h]?.count).toBe(0);
      }
    }
  });
});

describe("monthLabels", () => {
  test("returns 12 labels with correct week columns for a full year", () => {
    const weeks = buildYearGrid(2026, []);
    const labels = monthLabels(weeks);

    expect(labels).toHaveLength(12);

    expect(labels[0]?.label).toBe("Jan");
    expect(labels[0]?.weekIndex).toBe(0);
    expect(labels[0]?.col).toBe(0);
    expect(labels[0]?.month).toBe(1);

    expect(labels[1]?.label).toBe("Feb");
    expect(labels[1]?.weekIndex).toBeGreaterThan(0);
    expect(labels[1]?.month).toBe(2);

    expect(labels[11]?.label).toBe("Dec");
    expect(labels[11]?.month).toBe(12);
    expect(labels[11]?.weekIndex).toBeLessThan(53);

    // Week indices should be strictly ascending
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]!.weekIndex).toBeGreaterThan(labels[i - 1]!.weekIndex);
    }
  });

  test("handles empty weeks array", () => {
    expect(monthLabels([])).toEqual([]);
  });
});

describe("describeDay", () => {
  test("formats day description correctly with singular/plural items", () => {
    expect(describeDay({ date: "2026-10-17", minutes: 85, count: 3 })).toBe(
      "2026-10-17: 85 min, 3 items"
    );

    expect(describeDay("2026-10-17", 85, 3)).toBe(
      "2026-10-17: 85 min, 3 items"
    );

    expect(describeDay({ date: "2026-10-17", minutes: 42.4, count: 1 })).toBe(
      "2026-10-17: 42 min, 1 item"
    );

    expect(describeDay({ date: "2026-01-01", minutes: 0, count: 0 })).toBe(
      "2026-01-01: 0 min, 0 items"
    );

    expect(describeDay({ date: "2026-01-01", minutes: NaN, count: NaN })).toBe(
      "2026-01-01: 0 min, 0 items"
    );

    expect(describeDay({ date: "2026-01-01", minutes: -5, count: -1 })).toBe(
      "2026-01-01: 0 min, 0 items"
    );
  });
});

describe("HEATMAP_SOURCES", () => {
  test("contains audiobookshelf and manual, excludes import", () => {
    const values = HEATMAP_SOURCES.map((s) => s.value);
    expect(values).toContain("audiobookshelf");
    expect(values).toContain("manual");
    expect(values).not.toContain("import");
    expect(values).not.toContain("native-import");
  });
});
