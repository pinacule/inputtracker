import { describe, expect, test } from "bun:test";
import { categoryOf, isCategory } from "../src/core/category.ts";

describe("categoryOf", () => {
  test("explicit raw.category wins, as an object or a JSON string", () => {
    expect(categoryOf({ media_type: "episode", raw: { category: "anime" } })).toBe("anime");
    expect(categoryOf({ media_type: "other", raw: JSON.stringify({ category: "book" }) })).toBe("book");
  });

  test("an unknown raw.category is ignored", () => {
    expect(categoryOf({ media_type: "movie", raw: { category: "cartoons" } })).toBe("film");
  });

  test("unambiguous media types", () => {
    expect(categoryOf({ media_type: "audiobook" })).toBe("audiobook");
    expect(categoryOf({ media_type: "book" })).toBe("book");
    expect(categoryOf({ media_type: "podcast_episode" })).toBe("podcast");
    expect(categoryOf({ media_type: "music" })).toBe("music");
    expect(categoryOf({ media_type: "video" })).toBe("youtube");
    expect(categoryOf({ media_type: "other" })).toBe("other");
  });

  test("anime ids turn movies and episodes into anime", () => {
    expect(categoryOf({ media_type: "episode", external_ids: '{"simkl":1,"mal":"38000"}' })).toBe("anime");
    expect(categoryOf({ media_type: "movie", external_ids: { anilist: 101348 } })).toBe("anime");
    expect(categoryOf({ media_type: "episode", external_ids: { simkl: 1, imdb: "tt0000001" } })).toBe("series");
    expect(categoryOf({ media_type: "movie", external_ids: null })).toBe("film");
    expect(categoryOf({ media_type: "movie", external_ids: "not json" })).toBe("film");
  });

  test("isCategory", () => {
    expect(isCategory("anime")).toBe(true);
    expect(isCategory("Anime")).toBe(false);
    expect(isCategory(3)).toBe(false);
  });
});
