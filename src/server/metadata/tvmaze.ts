/**
 * TVmaze metadata provider (Series).
 *
 * Uses GET-only endpoints on `https://api.tvmaze.com`:
 * - `/search/shows?q=<query>`
 * - `/shows/:id`
 * - `/shows/:id/seasons`
 * - `/shows/:id/episodes` (sums real per-episode runtimes for `total_minutes`)
 */

import { writeCoverUrlCache } from "./cache.ts";
import { artSource, selectArt, type ArtSource } from "./art-types.ts";
import {
  BROADCAST_SLOTS,
  BROADCAST_SLOT_MULTIPLES,
  fetchCinemetaSeriesRuntime,
  isClearlyLowerThanSlot,
} from "./cinemeta.ts";
import {
  fetchProviderJson,
  readValidatedImageResponse,
  type RemoteImageResult,
  timedRequest,
} from "./http.ts";
import {
  cleanDescription,
  isValidProviderId,
  metaCoverUrl,
  metaBannerUrl,
  normalizeCommunityScore,
  parseYear,
  type ProviderContext,
  type RankedCandidate,
  type SeasonInfo,
  type WorkWithCover,
} from "./types.ts";

interface TvmazeShow {
  rating?: { average?: number | null } | null;
  id?: number;
  name?: string | null;
  originalName?: string | null;
  premiered?: string | null;
  runtime?: number | null;
  averageRuntime?: number | null;
  weight?: number | null;
  genres?: string[] | null;
  summary?: string | null;
  network?: { name?: string | null } | null;
  webChannel?: { name?: string | null } | null;
  externals?: {
    imdb?: string | null;
    thetvdb?: number | string | null;
    tvrage?: number | string | null;
  } | null;
  image?: {
    medium?: string | null;
    original?: string | null;
  } | null;
  _embedded?: {
    seasons?: TvmazeSeason[] | null;
    episodes?: TvmazeEpisode[] | null;
    crew?: Array<{ type?: string | null; person?: { name?: string | null } | null }> | null;
  } | null;
}

interface TvmazeSeason {
  id?: number;
  number?: number | null;
  name?: string | null;
  episodeOrder?: number | null;
  premiereDate?: string | null;
  endDate?: string | null;
}

interface TvmazeEpisode {
  id?: number;
  name?: string | null;
  season?: number | null;
  number?: number | null;
  type?: string | null;
  airdate?: string | null;
  runtime?: number | null;
}

function pickImageUrl(show: TvmazeShow | null | undefined): string | null {
  const img = show?.image;
  if (!img) return null;
  for (const candidate of [img.medium, img.original]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return null;
}

function pickCreators(show: TvmazeShow): string[] {
  const creators: string[] = [];
  const add = (name: unknown) => {
    if (typeof name === "string") {
      const trimmed = name.trim();
      if (trimmed !== "" && !creators.includes(trimmed)) {
        creators.push(trimmed);
      }
    }
  };

  if (Array.isArray(show._embedded?.crew)) {
    for (const c of show._embedded!.crew!) {
      if (c?.type === "Creator" || c?.type === "Developer") {
        add(c.person?.name);
      }
    }
  }
  if (creators.length === 0) {
    add(show.network?.name);
    add(show.webChannel?.name);
  }
  return creators;
}

function formatSubtitle(show: TvmazeShow, year: number | null): string | null {
  const parts: string[] = [];
  if (year !== null) {
    parts.push(String(year));
  }
  const channel = show.network?.name?.trim() || show.webChannel?.name?.trim() || "";
  if (channel) {
    parts.push(channel);
  } else if (Array.isArray(show.genres) && show.genres.length > 0) {
    const g = show.genres.filter((x) => typeof x === "string" && x.trim() !== "").slice(0, 2);
    if (g.length > 0) {
      parts.push(g.join(", "));
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export async function searchTvmaze(
  query: string,
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  const url = new URL(`${ctx.metaConfig.tvmaze_url}/search/shows`);
  url.searchParams.set("q", query);

  const { data } = await fetchProviderJson< unknown >(ctx, "tvmaze", url.toString());
  const rows = Array.isArray(data) ? data : [];
  const results: RankedCandidate[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { score?: number; show?: TvmazeShow } & TvmazeShow;
    const show: TvmazeShow = item.show && typeof item.show === "object" ? item.show : item;
    if (typeof show.id !== "number" || show.id <= 0) continue;

    const providerId = String(show.id);
    if (!isValidProviderId(providerId)) continue;

    const title = typeof show.name === "string" ? show.name.trim() : "";
    if (!title) continue;

    const year = parseYear(show.premiered);
    const remoteCoverUrl = pickImageUrl(show);
    const weight =
      typeof show.weight === "number" && Number.isFinite(show.weight)
        ? show.weight
        : typeof item.score === "number" && Number.isFinite(item.score)
          ? Math.round(item.score * 100)
          : 0;

    const imdbId =
      typeof show.externals?.imdb === "string" && show.externals.imdb.trim() !== ""
        ? show.externals.imdb.trim()
        : null;

    results.push({
      hit: {
        provider: "tvmaze",
        provider_id: providerId,
        category: "series",
        title,
        subtitle: formatSubtitle(show, year),
        year,
        cover_url: remoteCoverUrl ? metaCoverUrl("tvmaze", providerId) : null,
      },
      popularity: weight,
      remoteCoverUrl,
      imdbId,
    });
  }

  return results;
}

function isRegularTvmazeEpisode(ep: TvmazeEpisode | null | undefined): ep is TvmazeEpisode & { season: number } {
  if (!ep || typeof ep.season !== "number" || !Number.isInteger(ep.season) || ep.season < 1) {
    return false;
  }
  if (typeof ep.type === "string" && ep.type.trim() !== "") {
    if (ep.type.trim().toLowerCase() !== "regular") {
      return false;
    }
  }
  if (ep.number !== undefined && (ep.number === null || typeof ep.number !== "number" || ep.number < 1)) {
    return false;
  }
  return true;
}

/**
 * Detect whether TVmaze only reports a commercial broadcast slot (30/60/90 min)
 * rather than real per-episode runtimes. Returns the base slot in minutes (30, 60,
 * or 90) when all known runtimes are slot values, else `null`.
 */
export function detectTvmazeSlotRuntime(
  showRuntime: number | null | undefined,
  averageRuntime: number | null | undefined,
  episodes: readonly TvmazeEpisode[]
): number | null {
  const showSlotCandidate =
    typeof showRuntime === "number" && BROADCAST_SLOTS.has(Math.round(showRuntime))
      ? Math.round(showRuntime)
      : typeof averageRuntime === "number" && BROADCAST_SLOTS.has(Math.round(averageRuntime))
        ? Math.round(averageRuntime)
        : null;

  const knownEpRuntimes: number[] = [];
  for (const ep of episodes) {
    if (!isRegularTvmazeEpisode(ep)) continue;
    if (typeof ep.runtime === "number" && Number.isFinite(ep.runtime) && ep.runtime > 0) {
      knownEpRuntimes.push(Math.round(ep.runtime));
    }
  }

  if (knownEpRuntimes.length === 0) {
    return showSlotCandidate;
  }

  // If episodes have non-slot individual runtimes (e.g. 58, 48, 47 or 29, 34, 31),
  // TVmaze already carries real per-episode runtimes.
  const allAreSlotMultiples = knownEpRuntimes.every((r) => BROADCAST_SLOT_MULTIPLES.has(r));
  if (!allAreSlotMultiples) {
    return null;
  }

  // Find the modal episode runtime.
  const counts = new Map<number, number>();
  let modalRuntime = knownEpRuntimes[0]!;
  let maxCount = 0;
  for (const r of knownEpRuntimes) {
    const c = (counts.get(r) ?? 0) + 1;
    counts.set(r, c);
    if (c > maxCount) {
      maxCount = c;
      modalRuntime = r;
    }
  }

  if (showSlotCandidate !== null) {
    return showSlotCandidate;
  }
  if (BROADCAST_SLOTS.has(modalRuntime)) {
    return modalRuntime;
  }
  return null;
}

function buildSeasons(
  rawSeasons: TvmazeSeason[],
  rawEpisodes: TvmazeEpisode[],
  defaultShowRuntime: number | null,
  slotReplacement?: { slotMinutes: number; realMinutes: number } | null
): SeasonInfo[] {
  const seasonMetaMap = new Map<number, TvmazeSeason>();
  const seasonNumbers = new Set<number>();

  for (const s of rawSeasons) {
    if (s && typeof s.number === "number" && Number.isInteger(s.number) && s.number >= 1) {
      seasonMetaMap.set(s.number, s);
      seasonNumbers.add(s.number);
    }
  }

  const episodesBySeason = new Map<number, TvmazeEpisode[]>();
  const allAdjustedEpRuntimes: number[] = [];

  const adjustEpRuntime = (rawRt: number | null | undefined): number | null => {
    if (typeof rawRt !== "number" || !Number.isFinite(rawRt) || rawRt <= 0) {
      return null;
    }
    const rounded = Math.round(rawRt);
    if (slotReplacement) {
      const { slotMinutes, realMinutes } = slotReplacement;
      if (rounded === slotMinutes) {
        return realMinutes;
      }
      if (rounded > slotMinutes && rounded % slotMinutes === 0) {
        return Math.round((rounded / slotMinutes) * realMinutes);
      }
      return realMinutes;
    }
    return rounded;
  };

  for (const ep of rawEpisodes) {
    if (!isRegularTvmazeEpisode(ep)) {
      continue;
    }
    seasonNumbers.add(ep.season);
    let list = episodesBySeason.get(ep.season);
    if (!list) {
      list = [];
      episodesBySeason.set(ep.season, list);
    }
    list.push(ep);
    const adj = adjustEpRuntime(ep.runtime);
    if (adj !== null) {
      allAdjustedEpRuntimes.push(adj);
    }
  }

  const effectiveDefaultRuntime =
    slotReplacement?.realMinutes ??
    defaultShowRuntime ??
    (allAdjustedEpRuntimes.length > 0
      ? Math.round(
          allAdjustedEpRuntimes.reduce((a, b) => a + b, 0) /
            allAdjustedEpRuntimes.length
        )
      : null);

  const sortedNumbers = [...seasonNumbers].sort((a, b) => a - b);
  const seasons: SeasonInfo[] = [];

  for (const num of sortedNumbers) {
    const meta = seasonMetaMap.get(num);
    const eps = episodesBySeason.get(num) ?? [];
    const episodeCount =
      eps.length > 0
        ? eps.length
        : typeof meta?.episodeOrder === "number" && meta.episodeOrder > 0
          ? Math.round(meta.episodeOrder)
          : 0;

    // Skip announced future seasons that have 0 episodes.
    if (episodeCount <= 0) {
      continue;
    }

    const knownRuntimes = eps
      .map((e) => adjustEpRuntime(e.runtime))
      .filter((r): r is number => r !== null && r > 0);

    const episodeMinutes =
      knownRuntimes.length > 0
        ? Math.round(knownRuntimes.reduce((acc, r) => acc + r, 0) / knownRuntimes.length)
        : effectiveDefaultRuntime;

    let totalMinutes: number | null = null;
    if (eps.length > 0 && (knownRuntimes.length > 0 || episodeMinutes !== null)) {
      let sum = 0;
      for (const ep of eps) {
        const r = adjustEpRuntime(ep.runtime) ?? episodeMinutes ?? 0;
        sum += r;
      }
      totalMinutes = sum > 0 ? Math.round(sum) : null;
    } else if (episodeCount > 0 && episodeMinutes !== null) {
      totalMinutes = episodeCount * episodeMinutes;
    }

    const rawTitle = typeof meta?.name === "string" ? meta.name.trim() : "";
    const year = parseYear(meta?.premiereDate) ?? parseYear(eps[0]?.airdate);

    seasons.push({
      number: num,
      title: rawTitle !== "" ? rawTitle : null,
      year,
      episodes: episodeCount,
      episode_minutes: episodeMinutes,
      total_minutes: totalMinutes,
      provider_id: null,
    });
  }

  return seasons;
}

export async function getTvmazeWork(
  id: string,
  ctx: ProviderContext
): Promise<WorkWithCover | null> {
  if (!/^\d+$/.test(id)) {
    return null;
  }

  const base = ctx.metaConfig.tvmaze_url;
  const showRes = await fetchProviderJson<TvmazeShow>(ctx, "tvmaze", `${base}/shows/${id}`);
  if (showRes.status === 404 || !showRes.data || typeof showRes.data.id !== "number") {
    return null;
  }

  const show = showRes.data;
  const [seasonsRes, episodesRes] = await Promise.all([
    fetchProviderJson<TvmazeSeason[]>(ctx, "tvmaze", `${base}/shows/${id}/seasons`),
    fetchProviderJson<TvmazeEpisode[]>(ctx, "tvmaze", `${base}/shows/${id}/episodes`),
  ]);

  const rawSeasons = Array.isArray(seasonsRes.data)
    ? seasonsRes.data
    : Array.isArray(show._embedded?.seasons)
      ? show._embedded!.seasons!
      : [];
  const rawEpisodes = Array.isArray(episodesRes.data)
    ? episodesRes.data
    : Array.isArray(show._embedded?.episodes)
      ? show._embedded!.episodes!
      : [];

  const defaultRuntimeRaw = show.averageRuntime ?? show.runtime;
  const defaultRuntime =
    typeof defaultRuntimeRaw === "number" && Number.isFinite(defaultRuntimeRaw) && defaultRuntimeRaw > 0
      ? Math.round(defaultRuntimeRaw)
      : null;

  const imdbId =
    typeof show.externals?.imdb === "string" && show.externals.imdb.trim() !== ""
      ? show.externals.imdb.trim()
      : null;

  let slotReplacement: { slotMinutes: number; realMinutes: number } | null = null;
  const slotMinutes = detectTvmazeSlotRuntime(show.runtime, show.averageRuntime, rawEpisodes);
  if (imdbId !== null) {
    if (slotMinutes !== null) {
      const cineRuntime = await fetchCinemetaSeriesRuntime(imdbId, ctx);
      if (cineRuntime !== null && isClearlyLowerThanSlot(cineRuntime, slotMinutes)) {
        slotReplacement = { slotMinutes, realMinutes: cineRuntime };
      }
    } else if (
      defaultRuntime === null &&
      !rawEpisodes.some(
        (e) =>
          isRegularTvmazeEpisode(e) &&
          typeof e.runtime === "number" &&
          Number.isFinite(e.runtime) &&
          e.runtime > 0
      )
    ) {
      const cineRuntime = await fetchCinemetaSeriesRuntime(imdbId, ctx);
      if (cineRuntime !== null && cineRuntime > 0) {
        slotReplacement = { slotMinutes: cineRuntime, realMinutes: cineRuntime };
      }
    }
  }

  const seasons = buildSeasons(rawSeasons, rawEpisodes, defaultRuntime, slotReplacement);

  const providerId = String(show.id);
  const title = typeof show.name === "string" && show.name.trim() !== "" ? show.name.trim() : `Show ${id}`;
  const originalTitle =
    typeof show.originalName === "string" &&
    show.originalName.trim() !== "" &&
    show.originalName.trim() !== title
      ? show.originalName.trim()
      : null;
  const year = parseYear(show.premiered) ?? seasons[0]?.year ?? null;
  const remoteCoverUrl = pickImageUrl(show);

  const externalIds: Record<string, string> = {
    tvmaze: providerId,
  };
  if (typeof show.externals?.imdb === "string" && show.externals.imdb.trim() !== "") {
    externalIds.imdb = show.externals.imdb.trim();
  }
  if (
    show.externals?.thetvdb !== undefined &&
    show.externals?.thetvdb !== null &&
    String(show.externals.thetvdb).trim() !== ""
  ) {
    externalIds.thetvdb = String(show.externals.thetvdb).trim();
  }

  const genres = Array.isArray(show.genres)
    ? show.genres.filter((g): g is string => typeof g === "string" && g.trim() !== "")
    : [];

  let remoteBannerUrl: string | null = null;
  let remoteArt: ArtSource[] | undefined;
  try {
    const images = await fetchTvmazeImages(id, ctx);
    remoteArt = tvmazeArtSources(images);
    // Preserve existing banner/snapshot selection; gallery ranking is display-only.
    remoteBannerUrl = images.find((image) => image?.type === "background")?.resolutions?.original?.url ?? null;
  } catch {
    // Backgrounds are optional and fetched only alongside cached work details.
  }

  return {
    work: {
      provider: "tvmaze",
      provider_id: providerId,
      category: "series",
      title,
      original_title: originalTitle,
      banner_url: remoteBannerUrl ? metaBannerUrl("tvmaze", providerId) : null,
      community_score: normalizeCommunityScore("TVmaze", show.rating?.average, 10),
      year,
      cover_url: remoteCoverUrl ? metaCoverUrl("tvmaze", providerId) : null,
      creators: pickCreators(show),
      genres,
      description: cleanDescription(show.summary),
      seasons,
      runtime_minutes: null,
      pages: null,
      external_ids: externalIds,
    },
    remoteCoverUrl,
    remoteBannerUrl,
    remoteArt,
  };
}

interface TvmazeImage { type?: string; resolutions?: { original?: { url?: string; width?: number; height?: number } } }

async function fetchTvmazeImages(id: string, ctx: ProviderContext): Promise<TvmazeImage[]> {
  const { data } = await fetchProviderJson<TvmazeImage[]>(
    ctx, "tvmaze", `${ctx.metaConfig.tvmaze_url}/shows/${id}/images`
  );
  return Array.isArray(data) ? data : [];
}

function tvmazeArtSources(images: TvmazeImage[]): ArtSource[] {
  const sources = images.flatMap((image) => {
    if (!["background", "banner", "poster"].includes(image?.type ?? "")) return [];
    const original = image?.resolutions?.original;
    return [artSource(original?.url, image.type === "background" ? "backdrop" : image.type === "banner" ? "banner" : "poster", original?.width, original?.height)];
  });
  sources.sort((a, b) => (b?.width ?? 0) * (b?.height ?? 0) - (a?.width ?? 0) * (a?.height ?? 0));
  return selectArt(sources);
}

export async function getTvmazeArt(id: string, ctx: ProviderContext): Promise<ArtSource[]> {
  if (!/^\d+$/.test(id)) return [];
  return tvmazeArtSources(await fetchTvmazeImages(id, ctx));
}

export async function fetchTvmazeCover(
  id: string,
  ctx: ProviderContext
): Promise<RemoteImageResult | null> {
  if (!/^\d+$/.test(id)) {
    return null;
  }
  const url = `${ctx.metaConfig.tvmaze_url}/shows/${id}`;
  try {
    return await timedRequest(
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
        const show = (await response.json()) as TvmazeShow;
        const coverUrl = pickImageUrl(show);
        if (!coverUrl) return null;
        writeCoverUrlCache(ctx.config, "tvmaze", id, coverUrl);
        return null;
      }
    );
  } catch {
    return null;
  }
}
