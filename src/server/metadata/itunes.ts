/**
 * iTunes Search API metadata provider (Films).
 *
 * Uses GET-only endpoints on `https://itunes.apple.com`:
 * - `/search?media=movie&entity=movie&term=<query>&limit=15`
 * - `/lookup?id=<id>`
 * Runtime comes from `trackTimeMillis`; artwork from `artworkUrl100` upscaled to `600x600`.
 */

import { writeCoverUrlCache } from "./cache.ts";
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
  parseYear,
  type ProviderContext,
  type RankedCandidate,
  type WorkWithCover,
} from "./types.ts";

interface ItunesItem {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  collectionId?: number;
  trackName?: string | null;
  collectionName?: string | null;
  artistName?: string | null;
  releaseDate?: string | null;
  trackTimeMillis?: number | null;
  primaryGenreName?: string | null;
  genres?: string[] | null;
  longDescription?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  artworkUrl100?: string | null;
  artworkUrl60?: string | null;
}

interface ItunesResponse {
  resultCount?: number;
  results?: ItunesItem[] | null;
}

/** Upscale iTunes artwork URL (e.g. `.../100x100bb.jpg` -> `.../600x600bb.jpg`). */
export function upscaleItunesArtwork(url: unknown): string | null {
  if (typeof url !== "string" || url.trim() === "") {
    return null;
  }
  return url.trim().replace(/\b(?:100x100|60x60|30x30)(?=[a-z.]|$)/gi, "600x600");
}

function runtimeMinutesFromMillis(millis: unknown): number | null {
  if (typeof millis !== "number" || !Number.isFinite(millis) || millis <= 0) {
    return null;
  }
  const minutes = Math.round(millis / 60_000);
  return minutes > 0 ? minutes : null;
}

function formatSubtitle(
  item: ItunesItem,
  year: number | null,
  runtimeMinutes: number | null
): string | null {
  const parts: string[] = [];
  const director = typeof item.artistName === "string" ? item.artistName.trim() : "";
  if (director !== "") {
    parts.push(director);
  }
  if (year !== null) {
    parts.push(String(year));
  }
  if (runtimeMinutes !== null) {
    parts.push(`${runtimeMinutes} min`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export async function searchItunes(
  query: string,
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  const url = new URL(`${ctx.metaConfig.itunes_url}/search`);
  url.searchParams.set("media", "movie");
  url.searchParams.set("entity", "movie");
  url.searchParams.set("term", query);
  url.searchParams.set("limit", "15");

  const { data } = await fetchProviderJson<ItunesResponse>(ctx, "itunes", url.toString());
  const items = Array.isArray(data?.results) ? data!.results! : [];
  const results: RankedCandidate[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const rawId = item.trackId ?? item.collectionId;
    if (typeof rawId !== "number" || rawId <= 0) continue;

    const providerId = String(rawId);
    if (!isValidProviderId(providerId)) continue;

    const title = (item.trackName ?? item.collectionName ?? "").trim();
    if (!title) continue;

    const year = parseYear(item.releaseDate);
    const runtimeMinutes = runtimeMinutesFromMillis(item.trackTimeMillis);
    const remoteCoverUrl = upscaleItunesArtwork(item.artworkUrl100 ?? item.artworkUrl60);

    results.push({
      hit: {
        provider: "itunes",
        provider_id: providerId,
        category: "film",
        title,
        subtitle: formatSubtitle(item, year, runtimeMinutes),
        year,
        cover_url: remoteCoverUrl ? metaCoverUrl("itunes", providerId) : null,
      },
      // Preserve iTunes search order when year/tier tie
      popularity: Math.max(0, 15 - i),
      remoteCoverUrl,
    });
  }

  return results;
}

export async function getItunesWork(
  id: string,
  ctx: ProviderContext
): Promise<WorkWithCover | null> {
  if (!/^\d+$/.test(id)) {
    return null;
  }

  const url = new URL(`${ctx.metaConfig.itunes_url}/lookup`);
  url.searchParams.set("id", id);

  const { status, data } = await fetchProviderJson<ItunesResponse>(ctx, "itunes", url.toString());
  if (status === 404 || !data || !Array.isArray(data.results) || data.results.length === 0) {
    return null;
  }

  const item =
    data.results.find((r) => String(r?.trackId ?? r?.collectionId) === id) ?? data.results[0];
  if (!item) {
    return null;
  }

  const rawId = item.trackId ?? item.collectionId;
  if (typeof rawId !== "number" || rawId <= 0) {
    return null;
  }
  const providerId = String(rawId);
  const title = (item.trackName ?? item.collectionName ?? "").trim();
  if (!title) {
    return null;
  }

  const year = parseYear(item.releaseDate);
  const runtimeMinutes = runtimeMinutesFromMillis(item.trackTimeMillis);
  const remoteCoverUrl = upscaleItunesArtwork(item.artworkUrl100 ?? item.artworkUrl60);

  const creators: string[] = [];
  if (typeof item.artistName === "string" && item.artistName.trim() !== "") {
    creators.push(item.artistName.trim());
  }

  const genres: string[] = [];
  if (Array.isArray(item.genres)) {
    for (const g of item.genres) {
      if (typeof g === "string" && g.trim() !== "" && !genres.includes(g.trim())) {
        genres.push(g.trim());
      }
    }
  } else if (typeof item.primaryGenreName === "string" && item.primaryGenreName.trim() !== "") {
    genres.push(item.primaryGenreName.trim());
  }

  const description = cleanDescription(
    item.longDescription ?? item.shortDescription ?? item.description
  );

  return {
    work: {
      provider: "itunes",
      provider_id: providerId,
      category: "film",
      title,
      original_title: null,
      year,
      cover_url: remoteCoverUrl ? metaCoverUrl("itunes", providerId) : null,
      creators,
      genres,
      description,
      seasons: [],
      runtime_minutes: runtimeMinutes,
      pages: null,
      external_ids: {
        itunes: providerId,
      },
    },
    remoteCoverUrl,
  };
}

export async function fetchItunesCover(
  id: string,
  ctx: ProviderContext
): Promise<RemoteImageResult | null> {
  if (!/^\d+$/.test(id)) {
    return null;
  }
  const url = new URL(`${ctx.metaConfig.itunes_url}/lookup`);
  url.searchParams.set("id", id);

  try {
    return await timedRequest(
      ctx.fetch,
      url.toString(),
      { method: "GET" },
      ctx.limiter,
      ctx.timeoutMs,
      async (response) => {
        if (!response.ok) return null;
        const directImage = await readValidatedImageResponse(response);
        if (directImage !== null) {
          return directImage;
        }
        const json = (await response.json()) as ItunesResponse;
        const item =
          json?.results?.find((r) => String(r?.trackId ?? r?.collectionId) === id) ??
          json?.results?.[0];
        const coverUrl = upscaleItunesArtwork(item?.artworkUrl100 ?? item?.artworkUrl60);
        if (!coverUrl) return null;
        writeCoverUrlCache(ctx.config, "itunes", id, coverUrl);
        return null;
      }
    );
  } catch {
    return null;
  }
}
