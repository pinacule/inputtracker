import { describe, expect, test } from "bun:test";
import {
  buildAnnotationBody,
  formatNoteCounter,
  formatRating,
  formatStarValue,
  isNoteTooLong,
  MAX_NOTE_LENGTH,
  ratingToStars,
  starsToRating,
} from "../web/src/lib/annotations.ts";

describe("rating <-> stars", () => {
  test("ratingToStars halves the 1–10 rating", () => {
    expect(ratingToStars(7)).toBe(3.5);
    expect(ratingToStars(10)).toBe(5);
    expect(ratingToStars(1)).toBe(0.5);
    expect(ratingToStars(8)).toBe(4);
    expect(ratingToStars(null)).toBeNull();
    expect(ratingToStars(undefined)).toBeNull();
  });

  test("starsToRating doubles back to an integer, clamped", () => {
    expect(starsToRating(3.5)).toBe(7);
    expect(starsToRating(5)).toBe(10);
    expect(starsToRating(0.5)).toBe(1);
    expect(starsToRating(4.75)).toBe(10);
    expect(starsToRating(0.1)).toBe(1);
    expect(starsToRating(99)).toBe(10);
    expect(starsToRating(-3)).toBe(1);
  });

  test("round trip", () => {
    for (let rating = 1; rating <= 10; rating += 1) {
      expect(starsToRating(ratingToStars(rating)!)).toBe(rating);
    }
  });
});

describe("formatting", () => {
  test("formatStarValue uses a vulgar fraction for halves", () => {
    expect(formatStarValue(3.5)).toBe("3½");
    expect(formatStarValue(4)).toBe("4");
    expect(formatStarValue(0.5)).toBe("½");
    expect(formatStarValue(5)).toBe("5");
  });

  test("formatRating", () => {
    expect(formatRating(7)).toBe("3.5 of 5 stars");
    expect(formatRating(8)).toBe("4 of 5 stars");
    expect(formatRating(1)).toBe("0.5 of 5 stars");
    expect(formatRating(null)).toBe("Not rated");
    expect(formatRating(undefined)).toBe("Not rated");
  });

  test("formatNoteCounter", () => {
    expect(formatNoteCounter("")).toBe(`0 / ${MAX_NOTE_LENGTH}`);
    expect(formatNoteCounter("hello")).toBe(`5 / ${MAX_NOTE_LENGTH}`);
    expect(MAX_NOTE_LENGTH).toBe(5000);
  });

  test("isNoteTooLong mirrors the 5000-char limit", () => {
    expect(isNoteTooLong("x".repeat(5000))).toBe(false);
    expect(isNoteTooLong("x".repeat(5001))).toBe(true);
    // Trailing whitespace does not count (trimmed before storage).
    expect(isNoteTooLong("x".repeat(5000) + "   ")).toBe(false);
  });
});

describe("buildAnnotationBody", () => {
  test("happy path trims the note's trailing whitespace", () => {
    const res = buildAnnotationBody({
      source: "manual",
      title: "Synthetic Film",
      rating: 8,
      note: "Great!   \n",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toEqual({
        source: "manual",
        title: "Synthetic Film",
        rating: 8,
        note: "Great!",
      });
    }
  });

  test("null rating and blank note become null", () => {
    const res = buildAnnotationBody({
      source: "manual",
      title: "Synthetic Film",
      rating: null,
      note: "   ",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body.rating).toBeNull();
      expect(res.body.note).toBeNull();
    }
  });

  test("collects every validation message", () => {
    const res = buildAnnotationBody({
      source: "",
      title: "x".repeat(501),
      rating: 11,
      note: "x".repeat(5001),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(4);
      expect(res.errors.join(" ")).toContain("Source is required.");
      expect(res.errors.join(" ")).toContain("Title is too long");
      expect(res.errors.join(" ")).toContain("Rating must be a whole number");
      expect(res.errors.join(" ")).toContain("Note is too long");
    }
  });

  test("non-integer ratings are rejected", () => {
    for (const rating of [0, 7.5, Number.NaN]) {
      const res = buildAnnotationBody({
        source: "manual",
        title: "T",
        rating,
        note: null,
      });
      expect(res.ok, `rating ${rating}`).toBe(false);
    }
  });

  test("unicode and emoji survive", () => {
    const res = buildAnnotationBody({
      source: "manual",
      title: "Šťastný film 🎬",
      rating: 10,
      note: "Páči sa mi 🍿\nveľmi",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body.title).toBe("Šťastný film 🎬");
      expect(res.body.note).toBe("Páči sa mi 🍿\nveľmi");
    }
  });
});
