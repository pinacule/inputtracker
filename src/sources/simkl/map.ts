/**
 * Simkl all-items mapping to InputTracker events.
 *
 * Pure functions: transforms Simkl /sync/all-items response JSON into NewEvent[].
 * One event per watch:
 * - movie entry with last_watched_at -> movie event
 * - show/anime episode with watched_at -> episode event
 * - anime entry with anime_type === "movie" -> movie event
 * - items without watch time or episodes without watched_at -> skipped
 *
 * Timestamps normalized with toUtcIso (stored as .000Z).
 * Malformed entries (missing ids/title) are skipped, never throw.
 */

import type { MediaType, NewEvent } from "../../core/events.ts";
import { toUtcIso } from "../../core/time.ts";

export interface SimklIds {
  simkl?: number | string;
  slug?: string;
  imdb?: string;
  tmdb?: number | string;
  tvdb?: number | string;
  mal?: number | string;
  anidb?: number | string;
  anilist?: number | string;
  kitsu?: number | string;
  [key: string]: unknown;
}

export interface SimklMediaItem {
  title?: string | null;
  year?: number | null;
  poster?: string | null;
  runtime?: number | null;
  ids?: SimklIds | null;
  anime_type?: string | null;
  [key: string]: unknown;
}

export interface SimklMovieEntry {
  last_watched_at?: string | string[] | null;
  watched_at?: string | string[] | null;
  status?: string | null;
  user_rating?: number | null;
  user_rated_at?: string | null;
  movie?: SimklMediaItem | null;
  show?: SimklMediaItem | null;
  anime?: SimklMediaItem | null;
  [key: string]: unknown;
}

export interface SimklEpisode {
  number?: number | null;
  watched_at?: string | string[] | null;
  title?: string | null;
  [key: string]: unknown;
}

export interface SimklSeason {
  number?: number | null;
  episodes?: SimklEpisode[] | null;
  [key: string]: unknown;
}

export interface SimklShowEntry {
  last_watched_at?: string | string[] | null;
  watched_at?: string | string[] | null;
  status?: string | null;
  last_watched?: string | null;
  show?: SimklMediaItem | null;
  anime?: SimklMediaItem | null;
  movie?: SimklMediaItem | null;
  seasons?: SimklSeason[] | null;
  [key: string]: unknown;
}

export interface SimklAnimeEntry {
  anime_type?: string | null;
  last_watched_at?: string | string[] | null;
  watched_at?: string | string[] | null;
  status?: string | null;
  last_watched?: string | null;
  show?: SimklMediaItem | null;
  anime?: SimklMediaItem | null;
  movie?: SimklMediaItem | null;
  seasons?: SimklSeason[] | null;
  [key: string]: unknown;
}

export interface SimklAllItems {
  movies?: SimklMovieEntry[] | null;
  shows?: SimklShowEntry[] | null;
  anime?: SimklAnimeEntry[] | null;
  [key: string]: unknown;
}

function extractTimestamps(val: unknown): string[] {
  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(val)) {
    const res: string[] = [];
    for (const item of val) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed.length > 0) res.push(trimmed);
      } else if (item && typeof item === "object" && typeof (item as { watched_at?: unknown }).watched_at === "string") {
        const trimmed = ((item as { watched_at: string }).watched_at).trim();
        if (trimmed.length > 0) res.push(trimmed);
      }
    }
    return res;
  }
  return [];
}

function buildExternalIds(
  ids: SimklIds | null | undefined,
  poster: string | null | undefined
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  if (ids && typeof ids === "object") {
    for (const [k, v] of Object.entries(ids)) {
      if (v !== undefined && v !== null) {
        result[k] = v;
      }
    }
  }
  if (typeof poster === "string" && poster.trim() !== "") {
    result.simkl_poster = poster.trim();
  }
  return Object.keys(result).length > 0 ? result : null;
}

function mapMovieEntry(
  entry: SimklMovieEntry | null | undefined,
  events: NewEvent[]
): void {
  if (!entry || typeof entry !== "object") {
    return;
  }

  const item = entry.movie ?? entry.anime ?? entry.show;
  if (!item || typeof item !== "object") {
    return;
  }

  const simklId = item.ids?.simkl;
  if (simklId === undefined || simklId === null || String(simklId).trim() === "") {
    return;
  }

  const title = item.title;
  if (typeof title !== "string" || title.trim() === "") {
    return;
  }

  const watchTimes = [
    ...extractTimestamps(entry.last_watched_at),
    ...extractTimestamps(entry.watched_at),
  ];
  if (watchTimes.length === 0) {
    return;
  }

  const durationSeconds =
    typeof item.runtime === "number" && Number.isFinite(item.runtime) && item.runtime > 0
      ? Math.round(item.runtime * 60)
      : null;

  const externalIds = buildExternalIds(item.ids, item.poster);

  for (const wt of watchTimes) {
    let startedAt: string;
    try {
      startedAt = toUtcIso(wt);
    } catch {
      continue;
    }

    const sourceId = `movie:${simklId}:${startedAt}`;
    events.push({
      source: "simkl",
      source_kind: "watch",
      source_id: sourceId,
      external_ids: externalIds,
      media_type: "movie",
      title: title.trim(),
      parent_title: null,
      season: null,
      episode: null,
      started_at: startedAt,
      ended_at: null,
      duration_seconds: durationSeconds,
      progress: null,
      device: null,
      raw: entry,
    });
  }
}

function mapShowEntry(
  entry: SimklShowEntry | null | undefined,
  events: NewEvent[]
): void {
  if (!entry || typeof entry !== "object") {
    return;
  }

  const item = entry.show ?? entry.anime ?? entry.movie;
  if (!item || typeof item !== "object") {
    return;
  }

  const simklId = item.ids?.simkl;
  if (simklId === undefined || simklId === null || String(simklId).trim() === "") {
    return;
  }

  const title = item.title;
  if (typeof title !== "string" || title.trim() === "") {
    return;
  }

  if (!Array.isArray(entry.seasons)) {
    return;
  }

  const durationSeconds =
    typeof item.runtime === "number" && Number.isFinite(item.runtime) && item.runtime > 0
      ? Math.round(item.runtime * 60)
      : null;

  const externalIds = buildExternalIds(item.ids, item.poster);
  const showSummary = {
    title: title.trim(),
    ids: item.ids ?? {},
  };

  for (const season of entry.seasons) {
    if (!season || typeof season !== "object") {
      continue;
    }
    const seasonNumber = season.number;
    if (typeof seasonNumber !== "number" || !Number.isFinite(seasonNumber)) {
      continue;
    }

    if (!Array.isArray(season.episodes)) {
      continue;
    }

    for (const episode of season.episodes) {
      if (!episode || typeof episode !== "object") {
        continue;
      }
      const episodeNumber = episode.number;
      if (typeof episodeNumber !== "number" || !Number.isFinite(episodeNumber)) {
        continue;
      }

      const watchTimes = extractTimestamps(episode.watched_at);
      if (watchTimes.length === 0) {
        continue;
      }

      const raw = {
        ...episode,
        show: showSummary,
      };

      for (const wt of watchTimes) {
        let startedAt: string;
        try {
          startedAt = toUtcIso(wt);
        } catch {
          continue;
        }

        const sourceId = `ep:${simklId}:${seasonNumber}:${episodeNumber}:${startedAt}`;
        events.push({
          source: "simkl",
          source_kind: "watch",
          source_id: sourceId,
          external_ids: externalIds,
          media_type: "episode",
          title: title.trim(),
          parent_title: null,
          season: seasonNumber,
          episode: episodeNumber,
          started_at: startedAt,
          ended_at: null,
          duration_seconds: durationSeconds,
          progress: null,
          device: null,
          raw,
        });
      }
    }
  }
}

function mapAnimeEntry(
  entry: SimklAnimeEntry | null | undefined,
  events: NewEvent[]
): void {
  if (!entry || typeof entry !== "object") {
    return;
  }

  const animeType = (
    entry.anime_type ??
    entry.anime?.anime_type ??
    entry.show?.anime_type ??
    ""
  )
    .toString()
    .trim()
    .toLowerCase();

  if (animeType === "movie") {
    mapMovieEntry(entry, events);
  } else {
    mapShowEntry(entry, events);
  }
}

/**
 * Map all items from Simkl /sync/all-items to InputTracker NewEvent[].
 * Pure function, tolerant of missing or malformed fields.
 */
export function mapAll(allItems: SimklAllItems | null | undefined): NewEvent[] {
  const events: NewEvent[] = [];
  if (!allItems || typeof allItems !== "object") {
    return events;
  }

  if (Array.isArray(allItems.movies)) {
    for (const m of allItems.movies) {
      mapMovieEntry(m, events);
    }
  }

  if (Array.isArray(allItems.shows)) {
    for (const s of allItems.shows) {
      mapShowEntry(s, events);
    }
  }

  if (Array.isArray(allItems.anime)) {
    for (const a of allItems.anime) {
      mapAnimeEntry(a, events);
    }
  }

  return events;
}

export const mapSimklAll = mapAll;
