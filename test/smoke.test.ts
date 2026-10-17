import { describe, expect, test } from "bun:test";

import { usage } from "../src/cli/index.ts";

describe("usage", () => {
  test("returns a string mentioning inputtracker", () => {
    const text = usage();

    expect(typeof text).toBe("string");
    expect(text).toContain("inputtracker");
  });
});
