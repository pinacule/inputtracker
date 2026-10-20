/**
 * Library category of an event: the group a user thinks in ("anime", "films",
 * "books"), as opposed to `source` (where the data came from) and `media_type`
 * (the technical unit). Pure and derived on read, so no stored row changes.
 *
 * Order of rules:
 * 1. An explicit `category` in `raw` (archive entries written by the app).
 * 2. `media_type` for the unambiguous types.
 * 3. Movies and episodes with an anime database id (Simkl copies MAL / AniList /
 *    AniDB / Kitsu ids into `external_ids`) are anime; the rest are films/series.
 */

export const CATEGORIES = [
  "anime",
  "series",
  "film",
  "book",
  "audiobook",
  "youtube",
  "podcast",
  "music",
  "shortform",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

const ANIME_ID_KEYS = ["mal", "anilist", "anidb", "kitsu"] as const;

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function hasAnimeId(externalIds: Record<string, unknown> | null): boolean {
  if (externalIds === null) return false;
  return ANIME_ID_KEYS.some((key) => {
    const v = externalIds[key];
    return (typeof v === "string" && v !== "") || (typeof v === "number" && Number.isFinite(v));
  });
}

export function categoryOf(event: {
  media_type: string;
  external_ids?: unknown;
  raw?: unknown;
}): Category {
  if (event.media_type === "shortform") return "shortform";
  const raw = asObject(event.raw);
  if (raw !== null && isCategory(raw["category"])) {
    return raw["category"];
  }
  switch (event.media_type) {
    case "audiobook":
      return "audiobook";
    case "book":
      return "book";
    case "podcast_episode":
      return "podcast";
    case "music":
      return "music";
    case "video":
      return asObject(event.external_ids)?.["youtube_music"] === true
        ? "music"
        : "youtube";
    case "movie":
      return hasAnimeId(asObject(event.external_ids)) ? "anime" : "film";
    case "episode":
      return hasAnimeId(asObject(event.external_ids)) ? "anime" : "series";
    default:
      return "other";
  }
}
