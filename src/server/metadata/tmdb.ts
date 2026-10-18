/**
 * TMDB metadata provider (optional, for Films and Series when `metadata.tmdb_api_key` is set).
 *
 * Rules (docs/v2-spec.md):
 * - Enabled only when `metadata.tmdb_api_key` is non-empty.
 * - `tmdb_api_key` is a secret: never include it in error messages or logs.
 * - GET requests only.
 */

import { readProviderHint, writeCoverUrlCache, writeProviderHint } from "./cache.ts";
import {
  fetchProviderJson,
  readValidatedImageResponse,
  type RemoteImageResult,
  timedRequest,
} from "./http.ts";
import {
  type Category,
  cleanDescription,
  isTmdbConfigured,
  isValidProviderId,
  metaCoverUrl,
  parseYear,
  type ProviderContext,
  type RankedCandidate,
  type SeasonInfo,
  type WorkWithCover,
} from "./types.ts";

interface TmdbSearchItem {
  id?: number | string;
  media_type?: "movie" | "tv" | "person" | string;
  title?: string | null;
  name?: string | null;
  original_title?: string | null;
  original_name?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
  poster_path?: string | null;
  popularity?: number | null;
  overview?: string | null;
}

interface TmdbSearchResponse {
  results?: TmdbSearchItem[] | null;
}

interface TmdbGenre {
  id?: number;
  name?: string | null;
}

interface TmdbMovieResponse {
  id?: number | string;
  title?: string | null;
  original_title?: string | null;
  release_date?: string | null;
  runtime?: number | null;
  poster_path?: string | null;
  overview?: string | null;
  imdb_id?: string | null;
  genres?: Array<TmdbGenre | string> | null;
  external_ids?: {
    imdb_id?: string | null;
  } | null;
  credits?: {
    crew?: Array<{ job?: string | null; name?: string | null }> | null;
  } | null;
}

interface TmdbTvSeason {
  id?: number;
  season_number?: number | null;
  name?: string | null;
  air_date?: string | null;
  episode_count?: number | null;
  episode_minutes?: number | null;
}

interface TmdbTvResponse {
  id?: number | string;
  name?: string | null;
  original_name?: string | null;
  first_air_date?: string | null;
  episode_run_time?: number[] | null;
  poster_path?: string | null;
  overview?: string | null;
  genres?: Array<TmdbGenre | string> | null;
  created_by?: Array<{ name?: string | null }> | null;
  networks?: Array<{ name?: string | null }> | null;
  seasons?: TmdbTvSeason[] | null;
  external_ids?: {
    imdb_id?: string | null;
    tvdb_id?: number | string | null;
  } | null;
}

interface TmdbHint {
  kind: "movie" | "tv";
  posterPath?: string | null;
}

function buildTmdbUrl(
  ctx: ProviderContext,
  path: string,
  params: Record<string, string> = {}
): string {
  const url = new URL(`${ctx.metaConfig.tmdb_url}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  if (ctx.metaConfig.tmdb_api_key) {
    url.searchParams.set("api_key", ctx.metaConfig.tmdb_api_key);
  }
  return url.toString();
}

function tmdbHeaders(ctx: ProviderContext): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (ctx.metaConfig.tmdb_api_key) {
    headers.Authorization = `Bearer ${ctx.metaConfig.tmdb_api_key}`;
  }
  return headers;
}

function buildPosterUrl(ctx: ProviderContext, posterPath: unknown): string | null {
  if (typeof posterPath !== "string" || posterPath.trim() === "") {
    return null;
  }
  const clean = posterPath.trim();
  if (/^https?:\/\//i.test(clean)) {
    return clean;
  }
  const slash = clean.startsWith("/") ? clean : `/${clean}`;
  return `${ctx.metaConfig.tmdb_image_url}/w500${slash}`;
}

function extractGenreNames(genres: Array<TmdbGenre | string> | null | undefined): string[] {
  if (!Array.isArray(genres)) return [];
  const names: string[] = [];
  for (const g of genres) {
    const raw = typeof g === "string" ? g : g?.name;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed !== "" && !names.includes(trimmed)) {
        names.push(trimmed);
      }
    }
  }
  return names;
}

async function searchTmdbEndpoint(
  endpoint: "/search/movie" | "/search/tv",
  kind: "movie" | "tv",
  query: string,
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  const url = buildTmdbUrl(ctx, endpoint, { query });
  const { data } = await fetchProviderJson<TmdbSearchResponse>(ctx, "tmdb", url, {
    method: "GET",
    headers: tmdbHeaders(ctx),
  });

  const items = Array.isArray(data?.results) ? data!.results! : [];
  const results: RankedCandidate[] = [];

  for (const item of items) {
    if (!item || (typeof item.id !== "number" && typeof item.id !== "string")) continue;
    if (item.media_type === "person") continue;

    const itemKind: "movie" | "tv" =
      item.media_type === "tv"
        ? "tv"
        : item.media_type === "movie"
          ? "movie"
          : kind;

    const rawId = String(item.id).trim();
    if (!isValidProviderId(rawId)) continue;

    const title = (
      itemKind === "tv" ? (item.name ?? item.title) : (item.title ?? item.name)
    )?.trim();
    if (!title) continue;

    const originalTitle = (
      itemKind === "tv" ? item.original_name : item.original_title
    )?.trim();
    const year = parseYear(itemKind === "tv" ? item.first_air_date : item.release_date);
    const remoteCoverUrl = buildPosterUrl(ctx, item.poster_path);
    const category: Category = itemKind === "tv" ? "series" : "film";

    writeProviderHint<TmdbHint>(ctx.config, "tmdb", rawId, {
      kind: itemKind,
      posterPath: item.poster_path ?? null,
    });
    if (remoteCoverUrl) {
      writeCoverUrlCache(ctx.config, "tmdb", rawId, remoteCoverUrl);
    }

    const subtitleParts: string[] = [];
    if (year !== null) subtitleParts.push(String(year));
    subtitleParts.push(itemKind === "tv" ? "Series" : "Film");

    results.push({
      hit: {
        provider: "tmdb",
        provider_id: rawId,
        category,
        title,
        subtitle: subtitleParts.join(" · "),
        year,
        cover_url: remoteCoverUrl ? metaCoverUrl("tmdb", rawId) : null,
      },
      popularity:
        typeof item.popularity === "number" && Number.isFinite(item.popularity)
          ? item.popularity
          : 0,
      alternateTitles:
        originalTitle && originalTitle !== title ? [originalTitle] : undefined,
      remoteCoverUrl,
    });
  }

  return results;
}

export async function searchTmdb(
  query: string,
  category: Category | "any",
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  if (!isTmdbConfigured(ctx.config)) {
    return [];
  }
  if (category === "film") {
    return searchTmdbEndpoint("/search/movie", "movie", query, ctx);
  }
  if (category === "series") {
    return searchTmdbEndpoint("/search/tv", "tv", query, ctx);
  }
  if (category === "any") {
    const [movies, shows] = await Promise.all([
      searchTmdbEndpoint("/search/movie", "movie", query, ctx),
      searchTmdbEndpoint("/search/tv", "tv", query, ctx),
    ]);
    return [...movies, ...shows];
  }
  return [];
}

function parseTmdbId(
  id: string,
  categoryOverride?: Category,
  hint?: TmdbHint | null
): { rawId: string; preferredKind: "movie" | "tv" | null } {
  const movieMatch = /^movie[-_](.+)$/i.exec(id);
  if (movieMatch && movieMatch[1]) {
    return { rawId: movieMatch[1], preferredKind: "movie" };
  }
  const tvMatch = /^tv[-_](.+)$/i.exec(id);
  if (tvMatch && tvMatch[1]) {
    return { rawId: tvMatch[1], preferredKind: "tv" };
  }
  if (categoryOverride === "film") {
    return { rawId: id, preferredKind: "movie" };
  }
  if (categoryOverride === "series") {
    return { rawId: id, preferredKind: "tv" };
  }
  if (hint?.kind === "movie" || hint?.kind === "tv") {
    return { rawId: id, preferredKind: hint.kind };
  }
  return { rawId: id, preferredKind: null };
}

function mapTmdbMovie(
  requestedId: string,
  rawId: string,
  data: TmdbMovieResponse,
  ctx: ProviderContext
): WorkWithCover | null {
  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (!title) return null;

  const originalTitle =
    typeof data.original_title === "string" &&
    data.original_title.trim() !== "" &&
    data.original_title.trim() !== title
      ? data.original_title.trim()
      : null;

  const year = parseYear(data.release_date);
  const runtimeMinutes =
    typeof data.runtime === "number" && Number.isFinite(data.runtime) && data.runtime > 0
      ? Math.round(data.runtime)
      : null;
  const remoteCoverUrl = buildPosterUrl(ctx, data.poster_path);

  const creators: string[] = [];
  if (Array.isArray(data.credits?.crew)) {
    for (const member of data.credits!.crew!) {
      if (
        member?.job === "Director" &&
        typeof member.name === "string" &&
        member.name.trim() !== "" &&
        !creators.includes(member.name.trim())
      ) {
        creators.push(member.name.trim());
      }
    }
  }

  const externalIds: Record<string, string> = {
    tmdb: rawId,
  };
  const imdbId = data.imdb_id ?? data.external_ids?.imdb_id;
  if (typeof imdbId === "string" && imdbId.trim() !== "") {
    externalIds.imdb = imdbId.trim();
  }

  return {
    work: {
      provider: "tmdb",
      provider_id: requestedId,
      category: "film",
      title,
      original_title: originalTitle,
      year,
      cover_url: remoteCoverUrl ? metaCoverUrl("tmdb", requestedId) : null,
      creators,
      genres: extractGenreNames(data.genres),
      description: cleanDescription(data.overview),
      seasons: [],
      runtime_minutes: runtimeMinutes,
      pages: null,
      external_ids: externalIds,
    },
    remoteCoverUrl,
  };
}

function mapTmdbTv(
  requestedId: string,
  rawId: string,
  data: TmdbTvResponse,
  ctx: ProviderContext
): WorkWithCover | null {
  const title = typeof data.name === "string" ? data.name.trim() : "";
  if (!title) return null;

  const originalTitle =
    typeof data.original_name === "string" &&
    data.original_name.trim() !== "" &&
    data.original_name.trim() !== title
      ? data.original_name.trim()
      : null;

  const year = parseYear(data.first_air_date);
  const remoteCoverUrl = buildPosterUrl(ctx, data.poster_path);

  const defaultEpRuntime =
    Array.isArray(data.episode_run_time) &&
    typeof data.episode_run_time[0] === "number" &&
    data.episode_run_time[0] > 0
      ? Math.round(data.episode_run_time[0])
      : null;

  const seasons: SeasonInfo[] = [];
  const rawSeasons = Array.isArray(data.seasons) ? data.seasons : [];
  const validSeasons = rawSeasons
    .filter(
      (s): s is TmdbTvSeason & { season_number: number } =>
        Boolean(s && typeof s.season_number === "number" && s.season_number >= 1)
    )
    .sort((a, b) => a.season_number - b.season_number);

  for (const s of validSeasons) {
    const episodes =
      typeof s.episode_count === "number" && Number.isFinite(s.episode_count) && s.episode_count > 0
        ? Math.round(s.episode_count)
        : 0;
    const epMin =
      typeof s.episode_minutes === "number" && s.episode_minutes > 0
        ? Math.round(s.episode_minutes)
        : defaultEpRuntime;
    const totalMinutes = episodes > 0 && epMin !== null ? episodes * epMin : null;
    const sTitle = typeof s.name === "string" && s.name.trim() !== "" ? s.name.trim() : null;

    seasons.push({
      number: s.season_number,
      title: sTitle,
      year: parseYear(s.air_date),
      episodes,
      episode_minutes: epMin,
      total_minutes: totalMinutes,
      provider_id: null,
    });
  }

  const creators: string[] = [];
  const addCreator = (name: unknown) => {
    if (typeof name === "string") {
      const trimmed = name.trim();
      if (trimmed !== "" && !creators.includes(trimmed)) {
        creators.push(trimmed);
      }
    }
  };
  if (Array.isArray(data.created_by)) {
    for (const c of data.created_by) addCreator(c?.name);
  }
  if (creators.length === 0 && Array.isArray(data.networks)) {
    for (const n of data.networks) addCreator(n?.name);
  }

  const externalIds: Record<string, string> = {
    tmdb: rawId,
  };
  if (
    typeof data.external_ids?.imdb_id === "string" &&
    data.external_ids.imdb_id.trim() !== ""
  ) {
    externalIds.imdb = data.external_ids.imdb_id.trim();
  }
  if (
    data.external_ids?.tvdb_id !== undefined &&
    data.external_ids?.tvdb_id !== null &&
    String(data.external_ids.tvdb_id).trim() !== ""
  ) {
    externalIds.thetvdb = String(data.external_ids.tvdb_id).trim();
  }

  return {
    work: {
      provider: "tmdb",
      provider_id: requestedId,
      category: "series",
      title,
      original_title: originalTitle,
      year,
      cover_url: remoteCoverUrl ? metaCoverUrl("tmdb", requestedId) : null,
      creators,
      genres: extractGenreNames(data.genres),
      description: cleanDescription(data.overview),
      seasons,
      runtime_minutes: null,
      pages: null,
      external_ids: externalIds,
    },
    remoteCoverUrl,
  };
}

export async function getTmdbWork(
  id: string,
  ctx: ProviderContext,
  categoryOverride?: Category
): Promise<WorkWithCover | null> {
  if (!isTmdbConfigured(ctx.config) || !isValidProviderId(id)) {
    return null;
  }

  const hint = readProviderHint<TmdbHint>(ctx.config, "tmdb", id);
  const { rawId, preferredKind } = parseTmdbId(id, categoryOverride, hint);
  if (!/^\d+$/.test(rawId)) {
    return null;
  }

  const fetchMovie = async (): Promise<WorkWithCover | null> => {
    const url = buildTmdbUrl(ctx, `/movie/${rawId}`, {
      append_to_response: "external_ids,credits",
    });
    const { status, data } = await fetchProviderJson<TmdbMovieResponse & TmdbTvResponse>(
      ctx,
      "tmdb",
      url,
      { method: "GET", headers: tmdbHeaders(ctx) }
    );
    if (status === 404 || !data) return null;
    if (typeof data.title === "string" && data.title.trim() !== "") {
      return mapTmdbMovie(id, rawId, data, ctx);
    }
    if (typeof data.name === "string" && data.name.trim() !== "") {
      return mapTmdbTv(id, rawId, data, ctx);
    }
    return null;
  };

  const fetchTv = async (): Promise<WorkWithCover | null> => {
    const url = buildTmdbUrl(ctx, `/tv/${rawId}`, {
      append_to_response: "external_ids,credits",
    });
    const { status, data } = await fetchProviderJson<TmdbTvResponse & TmdbMovieResponse>(
      ctx,
      "tmdb",
      url,
      { method: "GET", headers: tmdbHeaders(ctx) }
    );
    if (status === 404 || !data) return null;
    if (typeof data.name === "string" && data.name.trim() !== "") {
      return mapTmdbTv(id, rawId, data, ctx);
    }
    if (typeof data.title === "string" && data.title.trim() !== "") {
      return mapTmdbMovie(id, rawId, data, ctx);
    }
    return null;
  };

  if (preferredKind === "tv") {
    return await fetchTv();
  }
  if (preferredKind === "movie") {
    return await fetchMovie();
  }

  const movieResult = await fetchMovie();
  if (movieResult !== null) {
    return movieResult;
  }
  return await fetchTv();
}

export async function fetchTmdbCover(
  id: string,
  ctx: ProviderContext
): Promise<RemoteImageResult | null> {
  if (!isTmdbConfigured(ctx.config) || !isValidProviderId(id)) {
    return null;
  }
  const hint = readProviderHint<TmdbHint>(ctx.config, "tmdb", id);
  if (hint?.posterPath) {
    const url = buildPosterUrl(ctx, hint.posterPath);
    if (url) {
      writeCoverUrlCache(ctx.config, "tmdb", id, url);
      return null;
    }
  }

  const { rawId, preferredKind } = parseTmdbId(id, undefined, hint);
  if (!/^\d+$/.test(rawId)) {
    return null;
  }
  const endpoint = preferredKind === "tv" ? `/tv/${rawId}` : `/movie/${rawId}`;
  const url = buildTmdbUrl(ctx, endpoint);

  try {
    return await timedRequest(
      ctx.fetch,
      url,
      { method: "GET", headers: tmdbHeaders(ctx) },
      ctx.limiter,
      ctx.timeoutMs,
      async (response) => {
        if (!response.ok) return null;
        const directImage = await readValidatedImageResponse(response);
        if (directImage !== null) {
          return directImage;
        }
        const json = (await response.json()) as { poster_path?: string | null };
        const coverUrl = buildPosterUrl(ctx, json?.poster_path);
        if (!coverUrl) return null;
        writeCoverUrlCache(ctx.config, "tmdb", id, coverUrl);
        return null;
      }
    );
  } catch {
    return null;
  }
}
