import { describe, expect, test } from "bun:test";
import type { ManualEventInput } from "../web/src/api.ts";
import {
  buildEventInput,
  describeImport,
  MEDIA_TYPE_OPTIONS,
  type AddFormState,
} from "../web/src/lib/forms.ts";

/** All fields empty except the given overrides; useful for required-field tests. */
function formState(overrides: Partial<AddFormState> = {}): AddFormState {
  return {
    media_type: "",
    title: "",
    parent_title: "",
    season: "",
    episode: "",
    started_at: "",
    duration_min: "",
    ended_at: "",
    ...overrides,
  };
}

function requireInput(state: AddFormState): ManualEventInput {
  const result = buildEventInput(state);
  if (result.input === null) {
    throw new Error(`expected valid input, got errors: ${result.errors.join("; ")}`);
  }
  return result.input;
}

describe("describeImport", () => {
  test("formats inserted/seen counts", () => {
    expect(describeImport({ seen: 5, inserted: 3 })).toBe("3 new of 5 seen");
  });

  test("reports zero new rows explicitly", () => {
    expect(describeImport({ seen: 5, inserted: 0 })).toBe("0 new of 5 seen");
  });
});

describe("MEDIA_TYPE_OPTIONS", () => {
  test("offers item media types, not daily short-form time", () => {
    expect(MEDIA_TYPE_OPTIONS.map((option) => option.value).sort()).toEqual(
      [
        "audiobook",
        "book",
        "episode",
        "movie",
        "music",
        "other",
        "podcast_episode",
        "video",
      ].sort()
    );
  });
});

describe("buildEventInput", () => {
  test("builds a full payload, converting minutes to seconds", () => {
    const input = requireInput(
      formState({
        media_type: "episode",
        title: "Synthetic Episode",
        parent_title: "Synthetic Series",
        season: "2",
        episode: "5",
        started_at: "2026-10-17T21:30",
        duration_min: "90",
        ended_at: "2026-10-17T23:00",
      })
    );

    expect(input).toEqual({
      media_type: "episode",
      title: "Synthetic Episode",
      parent_title: "Synthetic Series",
      season: 2,
      episode: 5,
      started_at: "2026-10-17T21:30",
      ended_at: "2026-10-17T23:00",
      duration_seconds: 5400,
    });
  });

  test("empty optional strings become null", () => {
    const input = requireInput(
      formState({
        media_type: "movie",
        title: "Synthetic Movie",
        started_at: "2026-10-17T20:00",
      })
    );

    expect(input).toEqual({
      media_type: "movie",
      title: "Synthetic Movie",
      parent_title: null,
      season: null,
      episode: null,
      started_at: "2026-10-17T20:00",
      ended_at: null,
      duration_seconds: null,
    });
  });

  test("trims whitespace around text fields", () => {
    const input = requireInput(
      formState({
        media_type: "book",
        title: "  Synthetic Book  ",
        parent_title: "  Fake Author  ",
        started_at: "  2026-10-17T09:00  ",
      })
    );

    expect(input.title).toBe("Synthetic Book");
    expect(input.parent_title).toBe("Fake Author");
    expect(input.started_at).toBe("2026-10-17T09:00");
  });

  test("zero minutes is kept as zero seconds", () => {
    const input = requireInput(
      formState({
        media_type: "other",
        title: "Synthetic Other",
        started_at: "2026-10-17T09:00",
        duration_min: "0",
      })
    );

    expect(input.duration_seconds).toBe(0);
  });

  test("collects every missing required field", () => {
    const result = buildEventInput(formState());

    expect(result.input).toBeNull();
    expect(result.errors).toContain("media_type is required");
    expect(result.errors).toContain("title is required");
    expect(result.errors).toContain("started_at is required");
  });

  test("rejects an unknown media type", () => {
    const result = buildEventInput(
      formState({
        media_type: "series",
        title: "Synthetic Series",
        started_at: "2026-10-17T09:00",
      })
    );

    expect(result.input).toBeNull();
    expect(result.errors).toContain("Invalid media_type: 'series'");
  });

  test("rejects non-numeric and negative durations", () => {
    const base = {
      media_type: "movie",
      title: "Synthetic Movie",
      started_at: "2026-10-17T09:00",
    };

    expect(buildEventInput(formState({ ...base, duration_min: "abc" })).errors).toContain(
      "duration must be a number"
    );
    expect(buildEventInput(formState({ ...base, duration_min: "-5" })).errors).toContain(
      "duration must be >= 0"
    );
  });

  test("rejects non-integer or negative season/episode", () => {
    const base = {
      media_type: "episode",
      title: "Synthetic Episode",
      started_at: "2026-10-17T09:00",
    };

    expect(buildEventInput(formState({ ...base, season: "1.5" })).errors).toContain(
      "season must be an integer >= 0"
    );
    expect(buildEventInput(formState({ ...base, episode: "-1" })).errors).toContain(
      "episode must be an integer >= 0"
    );
  });
});
