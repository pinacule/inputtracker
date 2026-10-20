/**
 * Stremio Cinemeta metadata provider (keyless, GET-only, IMDb IDs).
 *
 * Endpoints (`https://v3-cinemeta.strem.io`):
 * - `GET /catalog/movie/top/search=<url-encoded query>.json`
 * - `GET /catalog/series/top/search=<url-encoded query>.json`
 * - `GET /meta/movie/<id>.json`
 * - `GET /meta/series/<id>.json`
 */

import { readProviderHint, writeCoverUrlCache, writeProviderHint } from "./cache.ts";
import { artSource, selectArt } from "./art-types.ts";
import {
  fetchProviderJson,
  readValidatedImageResponse,
  type RemoteImageResult,
  timedRequest,
} from "./http.ts";
import {
  type Category,
  cleanDescription,
  isValidProviderId,
  metaCoverUrl,
  metaBannerUrl,
  normalizeCommunityScore,
  parseRuntimeMinutes,
  parseYear,
  type ProviderContext,
  type RankedCandidate,
  type SeasonInfo,
  type WorkWithCover,
} from "./types.ts";

const IMDB_ID_RE = /^tt\d+$/;

interface CinemetaCatalogItem {
  id?: string | null;
  imdb_id?: string | null;
  type?: "movie" | "series" | string | null;
  name?: string | null;
  releaseInfo?: string | number | null;
  year?: string | number | null;
  poster?: string | null;
  runtime?: string | number | null;
  director?: string[] | string | null;
  genres?: string[] | null;
  genre?: string[] | null;
  imdbRating?: string | number | null;
  description?: string | null;
}

interface CinemetaCatalogResponse {
  metas?: CinemetaCatalogItem[] | null;
}

interface CinemetaVideo {
  id?: string | null;
  season?: number | null;
  episode?: number | null;
  number?: number | null;
  name?: string | null;
  title?: string | null;
  released?: string | null;
  firstAired?: string | null;
  runtime?: string | number | null;
}

interface CinemetaMetaObject extends CinemetaCatalogItem {
  writer?: string[] | string | null;
  cast?: string[] | null;
  background?: string | null;
  videos?: CinemetaVideo[] | null;
}

interface CinemetaMetaResponse {
  meta?: CinemetaMetaObject | null;
}

interface CinemetaHint {
  kind: "movie" | "series";
  poster?: string | null;
}

function extractStringList(raw: unknown): string[] {
  const out: string[] = [];
  const add = (val: unknown) => {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed !== "" && !out.includes(trimmed)) {
        out.push(trimmed);
      }
    }
  };
  if (Array.isArray(raw)) {
    for (const item of raw) add(item);
  } else if (typeof raw === "string") {
    for (const part of raw.split(",")) add(part);
  }
  return out;
}

function pickPoster(item: { poster?: string | null } | null | undefined): string | null {
  if (typeof item?.poster === "string" && item.poster.trim() !== "") {
    return item.poster.trim();
  }
  return null;
}

function formatSearchSubtitle(
  item: CinemetaCatalogItem,
  kind: "movie" | "series",
  year: number | null
): string | null {
  const parts: string[] = [];
  const directors = extractStringList(item.director);
  if (kind === "movie" && directors[0]) {
    parts.push(directors[0]);
  }
  if (year !== null) {
    parts.push(String(year));
  }
  const runtime = parseRuntimeMinutes(item.runtime);
  if (kind === "movie" && runtime !== null) {
    parts.push(`${runtime} min`);
  } else if (parts.length === 0 || (kind === "series" && parts.length === 1)) {
    const genres = extractStringList(item.genres ?? item.genre).slice(0, 2);
    if (genres.length > 0) {
      parts.push(genres.join(", "));
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

async function searchCinemetaCatalog(
  kind: "movie" | "series",
  query: string,
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  const encoded = encodeURIComponent(query);
  const url = `${ctx.metaConfig.cinemeta_url}/catalog/${kind}/top/search=${encoded}.json`;

  const { data } = await fetchProviderJson<CinemetaCatalogResponse>(ctx, "cinemeta", url);
  const metas = Array.isArray(data?.metas) ? data!.metas! : [];
  const results: RankedCandidate[] = [];

  for (let i = 0; i < metas.length; i++) {
    const item = metas[i];
    if (!item) continue;

    const rawId = (item.id ?? item.imdb_id ?? "").trim();
    if (!IMDB_ID_RE.test(rawId) || !isValidProviderId(rawId)) {
      continue;
    }

    const title = typeof item.name === "string" ? item.name.trim() : "";
    if (!title) continue;

    const itemKind: "movie" | "series" =
      item.type === "series" ? "series" : item.type === "movie" ? "movie" : kind;
    const category: Category = itemKind === "series" ? "series" : "film";
    const year = parseYear(item.releaseInfo) ?? parseYear(item.year);
    const remoteCoverUrl = pickPoster(item);

    writeProviderHint<CinemetaHint>(ctx.config, "cinemeta", rawId, {
      kind: itemKind,
      poster: remoteCoverUrl,
    });
    if (remoteCoverUrl) {
      writeCoverUrlCache(ctx.config, "cinemeta", rawId, remoteCoverUrl);
    }

    // Preserve Cinemeta's catalog ranking order when title tier ties
    const ratingNum =
      typeof item.imdbRating === "number"
        ? item.imdbRating
        : typeof item.imdbRating === "string"
          ? parseFloat(item.imdbRating)
          : NaN;
    const popularity = Math.max(1, 50 - i) + (Number.isFinite(ratingNum) ? ratingNum : 0);

    results.push({
      hit: {
        provider: "cinemeta",
        provider_id: rawId,
        category,
        title,
        subtitle: formatSearchSubtitle(item, itemKind, year),
        year,
        cover_url: remoteCoverUrl ? metaCoverUrl("cinemeta", rawId) : null,
      },
      popularity,
      remoteCoverUrl,
      imdbId: rawId,
    });
  }

  return results;
}

export async function searchCinemeta(
  query: string,
  category: Category | "any",
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  if (category === "film") {
    return searchCinemetaCatalog("movie", query, ctx);
  }
  if (category === "series") {
    return searchCinemetaCatalog("series", query, ctx);
  }
  if (category === "any") {
    const [movies, series] = await Promise.all([
      searchCinemetaCatalog("movie", query, ctx),
      searchCinemetaCatalog("series", query, ctx),
    ]);
    return [...movies, ...series];
  }
  return [];
}

export const BROADCAST_SLOTS: ReadonlySet<number> = new Set([30, 60, 90]);
export const BROADCAST_SLOT_MULTIPLES: ReadonlySet<number> = new Set([30, 45, 60, 90, 120]);

/**
 * True when a cross-checked runtime (e.g. from Cinemeta/IMDb) is clearly lower
 * than a broadcast slot (30/60/90 min with commercials), rather than an ad-free
 * ~57–59 min hour on HBO/BBC.
 */
export function isClearlyLowerThanSlot(
  realMinutes: number,
  slotMinutes: number
): boolean {
  return (
    Number.isFinite(realMinutes) &&
    Number.isFinite(slotMinutes) &&
    realMinutes > 0 &&
    slotMinutes > 0 &&
    realMinutes <= Math.round(slotMinutes * 0.9) &&
    slotMinutes - realMinutes >= 4
  );
}

/**
 * Best-effort lookup of a series' typical episode runtime in minutes on Cinemeta
 * by IMDb ID (`tt\d+`). Never throws: returns `null` on 404, timeout or 5xx so
 * the caller can safely keep its own runtime when Cinemeta is unreachable.
 */
export async function fetchCinemetaSeriesRuntime(
  imdbId: string,
  ctx: ProviderContext
): Promise<number | null> {
  const cleanId = imdbId.trim().toLowerCase();
  if (!IMDB_ID_RE.test(cleanId)) {
    return null;
  }
  try {
    const url = `${ctx.metaConfig.cinemeta_url}/meta/series/${cleanId}.json`;
    const { status, data } = await fetchProviderJson<CinemetaMetaResponse>(
      ctx,
      "cinemeta",
      url
    );
    if (status === 404 || !data?.meta || typeof data.meta !== "object") {
      return null;
    }
    const meta = data.meta;
    const direct = parseRuntimeMinutes(meta.runtime);
    if (direct !== null && direct > 0) {
      return direct;
    }
    if (Array.isArray(meta.videos)) {
      const epRuntimes = meta.videos
        .filter((v) => v && typeof v.season === "number" && v.season >= 1)
        .map((v) => parseRuntimeMinutes(v.runtime))
        .filter((r): r is number => r !== null && r > 0);
      if (epRuntimes.length > 0) {
        return Math.round(
          epRuntimes.reduce((a, b) => a + b, 0) / epRuntimes.length
        );
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildSeriesSeasonsFromVideos(
  videos: CinemetaVideo[] | null | undefined,
  defaultEpisodeMinutes: number | null
): SeasonInfo[] {
  if (!Array.isArray(videos) || videos.length === 0) {
    return [];
  }

  const bySeason = new Map<number, CinemetaVideo[]>();
  const allKnownEpRuntimes: number[] = [];
  for (const v of videos) {
    if (!v || typeof v.season !== "number" || !Number.isInteger(v.season) || v.season < 1) {
      // Skip season 0 (specials) and invalid season numbers
      continue;
    }
    let list = bySeason.get(v.season);
    if (!list) {
      list = [];
      bySeason.set(v.season, list);
    }
    list.push(v);
    const rt = parseRuntimeMinutes(v.runtime);
    if (rt !== null && rt > 0) {
      allKnownEpRuntimes.push(rt);
    }
  }

  const fallbackEpisodeMinutes =
    defaultEpisodeMinutes ??
    (allKnownEpRuntimes.length > 0
      ? Math.round(
          allKnownEpRuntimes.reduce((a, b) => a + b, 0) / allKnownEpRuntimes.length
        )
      : null);

  const seasonNumbers = [...bySeason.keys()].sort((a, b) => a - b);
  const seasons: SeasonInfo[] = [];

  for (const num of seasonNumbers) {
    const eps = bySeason.get(num) ?? [];
    eps.sort((a, b) => (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0));

    const episodeCount = eps.length;
    let year: number | null = null;
    for (const ep of eps) {
      const y = parseYear(ep.released ?? ep.firstAired);
      if (y !== null) {
        year = y;
        break;
      }
    }

    const epRuntimes = eps
      .map((e) => parseRuntimeMinutes(e.runtime))
      .filter((r): r is number => r !== null && r > 0);

    const episodeMinutes =
      epRuntimes.length > 0
        ? Math.round(epRuntimes.reduce((a, b) => a + b, 0) / epRuntimes.length)
        : fallbackEpisodeMinutes;

    let totalMinutes: number | null = null;
    if (epRuntimes.length > 0) {
      let sum = 0;
      for (const ep of eps) {
        sum += parseRuntimeMinutes(ep.runtime) ?? episodeMinutes ?? 0;
      }
      totalMinutes = sum > 0 ? Math.round(sum) : null;
    } else if (episodeCount > 0 && episodeMinutes !== null) {
      totalMinutes = episodeCount * episodeMinutes;
    }

    seasons.push({
      number: num,
      title: null,
      year,
      episodes: episodeCount,
      episode_minutes: episodeMinutes,
      total_minutes: totalMinutes,
      provider_id: null,
    });
  }

  return seasons;
}

function mapCinemetaWork(
  id: string,
  meta: CinemetaMetaObject,
  kind: "movie" | "series"
): WorkWithCover | null {
  const providerId = (meta.id ?? meta.imdb_id ?? id).trim();
  if (!IMDB_ID_RE.test(providerId)) {
    return null;
  }

  const title = typeof meta.name === "string" ? meta.name.trim() : "";
  if (!title) {
    return null;
  }

  const year = parseYear(meta.year) ?? parseYear(meta.releaseInfo);
  const remoteCoverUrl = pickPoster(meta);
  const runtimeMinutes = parseRuntimeMinutes(meta.runtime);

  let creators = extractStringList(meta.director);
  if (creators.length === 0) {
    creators = extractStringList(meta.writer);
  }
  if (creators.length === 0 && Array.isArray(meta.cast)) {
    creators = extractStringList(meta.cast).slice(0, 3);
  }

  const genres = extractStringList(meta.genres ?? meta.genre);
  // Cinemeta films carry `videos: []`, so trust `type` first and only count episodes when it is absent.
  const isSeries =
    meta.type === "series" ||
    (meta.type !== "movie" &&
      (kind === "series" || (Array.isArray(meta.videos) && meta.videos.length > 0)));

  const seasons = isSeries ? buildSeriesSeasonsFromVideos(meta.videos, runtimeMinutes) : [];
  const finalYear = year ?? seasons[0]?.year ?? null;

  return {
    work: {
      provider: "cinemeta",
      provider_id: providerId,
      category: isSeries ? "series" : "film",
      title,
      original_title: null,
      banner_url: meta.background ? metaBannerUrl("cinemeta", providerId) : null,
      community_score: normalizeCommunityScore("IMDb", meta.imdbRating, 10),
      year: finalYear,
      cover_url: remoteCoverUrl ? metaCoverUrl("cinemeta", providerId) : null,
      creators,
      genres,
      description: cleanDescription(meta.description),
      seasons,
      runtime_minutes: isSeries ? null : runtimeMinutes,
      pages: null,
      external_ids: {
        imdb: providerId,
      },
    },
    remoteCoverUrl,
    remoteBannerUrl: meta.background ?? null,
    remoteArt: selectArt([artSource(meta.background, "backdrop"), artSource(remoteCoverUrl, "poster")]),
  };
}

export async function getCinemetaWork(
  id: string,
  ctx: ProviderContext,
  categoryOverride?: Category
): Promise<WorkWithCover | null> {
  if (!IMDB_ID_RE.test(id)) {
    return null;
  }

  const hint = readProviderHint<CinemetaHint>(ctx.config, "cinemeta", id);
  const preferredKind: "movie" | "series" | null =
    categoryOverride === "series"
      ? "series"
      : categoryOverride === "film"
        ? "movie"
        : hint?.kind ?? null;

  const tryKind = async (kind: "movie" | "series"): Promise<WorkWithCover | null> => {
    const url = `${ctx.metaConfig.cinemeta_url}/meta/${kind}/${id}.json`;
    const { status, data } = await fetchProviderJson<CinemetaMetaResponse>(ctx, "cinemeta", url);
    if (status === 404 || !data?.meta || typeof data.meta !== "object") {
      return null;
    }
    return mapCinemetaWork(id, data.meta, kind);
  };

  if (preferredKind === "series") {
    const res = await tryKind("series");
    if (res !== null) return res;
    return await tryKind("movie");
  }

  const movieRes = await tryKind("movie");
  if (movieRes !== null) {
    return movieRes;
  }
  return await tryKind("series");
}

export async function fetchCinemetaCover(
  id: string,
  ctx: ProviderContext
): Promise<RemoteImageResult | null> {
  if (!IMDB_ID_RE.test(id)) {
    return null;
  }

  const hint = readProviderHint<CinemetaHint>(ctx.config, "cinemeta", id);
  if (hint?.poster) {
    writeCoverUrlCache(ctx.config, "cinemeta", id, hint.poster);
    return null;
  }

  const kinds: ReadonlyArray<"movie" | "series"> =
    hint?.kind === "series" ? ["series", "movie"] : ["movie", "series"];

  for (const kind of kinds) {
    const url = `${ctx.metaConfig.cinemeta_url}/meta/${kind}/${id}.json`;
    try {
      const direct = await timedRequest(
        ctx.fetch,
        url,
        { method: "GET" },
        ctx.limiter,
        ctx.timeoutMs,
        async (response) => {
          if (!response.ok) return null;
          const directImage = await readValidatedImageResponse(response);
          if (directImage !== null) {
            return directImage;
          }
          const json = (await response.json()) as CinemetaMetaResponse;
          const poster = pickPoster(json?.meta);
          if (poster) {
            writeCoverUrlCache(ctx.config, "cinemeta", id, poster);
          }
          return null;
        }
      );
      if (direct !== null) {
        return direct;
      }
      if (hint?.poster) break;
    } catch {
      // Try next kind
    }
  }

  return null;
}
