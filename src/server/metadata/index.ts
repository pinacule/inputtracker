/**
 * Metadata lookup orchestrator: search fan-out, work details, and permanent cover cache.
 */

import type { Config } from "../../core/config.ts";
import type { Category, LookupSearchResult, MetaProvider, WorkDetails } from "../../core/contract.ts";
import {
  fetchAnilistCover,
  getAnilistWork,
   MAX_ANILIST_HOPS,
  searchAnilist,
} from "./anilist.ts";
import {
  metaCoverCacheDir,
  metadataCacheDir,
  readCachedMetaCover,
  readCoverUrlCache,
  readSearchCache,
  readWorkCache,
  SEARCH_CACHE_TTL_MS,
  WORK_CACHE_TTL_MS,
  writeCachedMetaCover,
  writeSearchCache,
  writeWorkCache,
  readBannerSource,
  writeBannerSource,
  readCachedMetaBanner,
  writeCachedMetaBanner,
  metaBannerCacheDir,
  writeArtSources,
} from "./cache.ts";
import {
  defaultMetadataLimiter,
  fetchRemoteCoverImage,
  Limiter,
  MAX_META_COVER_BYTES,
  METADATA_TIMEOUT_MS,
  type RemoteImageResult,
} from "./http.ts";
import {
  fetchItunesCover,
  getItunesWork,
  searchItunes,
  upscaleItunesArtwork,
} from "./itunes.ts";
import {
  cleanOpenLibraryId,
  fetchOpenLibraryMetaCover,
  getOpenLibraryWork,
  searchOpenLibraryMeta,
} from "./openlibrary.ts";
import { computeMatchTier, MAX_LOOKUP_RESULTS, rankLookupHits } from "./rank.ts";
import { fetchSteamCover, getSteamWork, searchSteam } from "./steam.ts";
import { fetchWikipediaCover, getWikipediaWork, searchWikipediaGames } from "./wikipedia.ts";
import { fetchTmdbCover, getTmdbWork, searchTmdb } from "./tmdb.ts";
import { detectTvmazeSlotRuntime, fetchTvmazeCover, getTvmazeWork, searchTvmaze } from "./tvmaze.ts";
import {
  BROADCAST_SLOTS,
  BROADCAST_SLOT_MULTIPLES,
  fetchCinemetaCover,
  fetchCinemetaSeriesRuntime,
  getCinemetaWork,
  isClearlyLowerThanSlot,
  searchCinemeta,
} from "./cinemeta.ts";
import {
  cleanDescription,
  isMetaProvider,
  isTmdbConfigured,
  isValidProviderId,
  META_PROVIDERS,
  metaCoverUrl,
  metaArtUrl,
  parseRuntimeMinutes,
  PROVIDER_ID_RE,
  type ProviderContext,
  ProviderError,
  parseYear,
  type RankedCandidate,
  resolveMetadataConfig,
  type WorkWithCover,
} from "./types.ts";

export {
  BROADCAST_SLOTS,
  BROADCAST_SLOT_MULTIPLES,
  cleanDescription,
  cleanOpenLibraryId,
  computeMatchTier,
  defaultMetadataLimiter,
  detectTvmazeSlotRuntime,
  fetchCinemetaSeriesRuntime,
  isClearlyLowerThanSlot,
  isMetaProvider,
  isTmdbConfigured,
  isValidProviderId,
  Limiter,
  MAX_ANILIST_HOPS,
  MAX_LOOKUP_RESULTS,
  MAX_META_COVER_BYTES,
  META_PROVIDERS,
  metaCoverCacheDir,
  metaBannerCacheDir,
  metaCoverUrl,
  METADATA_TIMEOUT_MS,
  metadataCacheDir,
  parseRuntimeMinutes,
  parseYear,
  PROVIDER_ID_RE,
  ProviderError,
  rankLookupHits,
  resolveMetadataConfig,
  SEARCH_CACHE_TTL_MS,
  upscaleItunesArtwork,
  WORK_CACHE_TTL_MS,
  type ProviderContext,
  type RankedCandidate,
  type RemoteImageResult,
};

export interface MetadataDeps {
  config: Config;
  fetch?: typeof fetch;
  limiter?: Limiter;
  timeoutMs?: number;
  now?: () => number;
  /** When true, skip reading from the on-disk work cache and overwrite it with fresh details. */
  bypassCache?: boolean;
}

function buildContext(deps: MetadataDeps): ProviderContext {
  return {
    config: deps.config,
    metaConfig: resolveMetadataConfig(deps.config),
    fetch: deps.fetch ?? globalThis.fetch,
    limiter: deps.limiter ?? defaultMetadataLimiter,
    timeoutMs: deps.timeoutMs ?? METADATA_TIMEOUT_MS,
    now: deps.now ?? Date.now,
  };
}

/**
 * Providers queried for a given category.
 * When `metadata.tmdb_api_key` is set, TMDB is queried ahead of iTunes/TVmaze.
 */
export function providersForCategory(
  category: Category | "any",
  config: Config
): MetaProvider[] {
  const meta = resolveMetadataConfig(config);
  if (!meta.enabled) {
    return [];
  }
  const tmdbOn = isTmdbConfigured(config);

  switch (category) {
    case "anime":
      return ["anilist"];
    case "series":
      return tmdbOn ? ["tmdb", "tvmaze", "cinemeta"] : ["tvmaze", "cinemeta"];
    case "film":
      return tmdbOn ? ["tmdb", "cinemeta", "itunes"] : ["cinemeta", "itunes"];
    case "book":
    case "audiobook":
      return ["openlibrary"];
    case "game":
      return ["steam", "wikipedia"];
    case "any":
      return tmdbOn
        ? ["anilist", "tmdb", "tvmaze", "cinemeta", "itunes", "openlibrary", "steam", "wikipedia"]
        : ["anilist", "tvmaze", "cinemeta", "itunes", "openlibrary", "steam", "wikipedia"];
    default:
      return [];
  }
}

function cacheScopeForProvider(
  provider: MetaProvider,
  category: Category | "any"
): string {
  if (provider === "openlibrary") {
    return category === "audiobook" ? "audiobook" : "book";
  }
  if (provider === "tmdb" || provider === "cinemeta") {
    return category === "film" || category === "series" ? category : "any";
  }
  return "default";
}

async function runProviderSearch(
  provider: MetaProvider,
  query: string,
  category: Category | "any",
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  const nowMs = ctx.now();
  const scope = cacheScopeForProvider(provider, category);
  const cached = readSearchCache(ctx.config, provider, scope, query, nowMs);
  if (cached !== null) {
    return cached;
  }

  let candidates: RankedCandidate[];
  switch (provider) {
    case "anilist":
      candidates = await searchAnilist(query, ctx);
      break;
    case "tvmaze":
      candidates = await searchTvmaze(query, ctx);
      break;
    case "cinemeta":
      candidates = await searchCinemeta(query, category, ctx);
      break;
    case "itunes":
      candidates = await searchItunes(query, ctx);
      break;
    case "openlibrary":
      candidates = await searchOpenLibraryMeta(
        query,
        category === "audiobook" ? "audiobook" : "book",
        ctx
      );
      break;
    case "tmdb":
      candidates = await searchTmdb(query, category, ctx);
      break;
    case "steam":
      candidates = await searchSteam(query, ctx);
      break;
    case "wikipedia":
      candidates = await searchWikipediaGames(query, ctx);
      break;
  }

  writeSearchCache(ctx.config, provider, scope, query, candidates, nowMs);
  return candidates;
}

/**
 * Search across all providers matching `category` in parallel, ranking and
 * merging up to 20 results. Failed providers are recorded in `failed_providers`
 * without failing the overall search.
 */
export async function lookupSearch(
  query: string,
  category: Category | "any",
  deps: MetadataDeps
): Promise<LookupSearchResult> {
  const ctx = buildContext(deps);
  const providers = providersForCategory(category, deps.config);
  if (providers.length === 0) {
    return {
      query,
      category,
      results: [],
      failed_providers: [],
    };
  }

  const settled = await Promise.allSettled(
    providers.map((provider) => runProviderSearch(provider, query, category, ctx))
  );

  const allCandidates: RankedCandidate[] = [];
  const failedProviders: MetaProvider[] = [];

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;
    const outcome = settled[i]!;
    if (outcome.status === "fulfilled") {
      allCandidates.push(...outcome.value);
    } else {
      if (!failedProviders.includes(provider)) {
        failedProviders.push(provider);
      }
    }
  }

  const results = rankLookupHits(query, allCandidates, MAX_LOOKUP_RESULTS);

  return {
    query,
    category,
    results,
    failed_providers: failedProviders,
  };
}

/**
 * Fetch full work details from `provider` for `id`, reading/writing the 30-day
 * on-disk cache. Returns `null` when unknown (404), and throws `ProviderError`
 * when the upstream provider fails (timeout, 5xx, bad JSON).
 */
export async function lookupWork(
  provider: MetaProvider,
  id: string,
  deps: MetadataDeps,
  categoryOverride?: Category
): Promise<WorkDetails | null> {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return null;
  }

  const ctx = buildContext(deps);
  const nowMs = ctx.now();

  if (!deps.bypassCache) {
    const cached = readWorkCache(deps.config, provider, id, nowMs, categoryOverride);
    if (cached !== null) {
      return cached;
    }
  }

  if (!ctx.metaConfig.enabled) {
    return null;
  }

  let fetched: WorkWithCover | null = null;
  switch (provider) {
    case "anilist":
      fetched = await getAnilistWork(id, ctx);
      break;
    case "tvmaze":
      fetched = await getTvmazeWork(id, ctx);
      break;
    case "cinemeta":
      fetched = await getCinemetaWork(id, ctx, categoryOverride);
      break;
    case "itunes":
      fetched = await getItunesWork(id, ctx);
      break;
    case "openlibrary":
      fetched = await getOpenLibraryWork(id, ctx, categoryOverride);
      break;
    case "tmdb":
      fetched = await getTmdbWork(id, ctx, categoryOverride);
      break;
    case "steam":
      fetched = await getSteamWork(id, ctx);
      break;
    case "wikipedia":
      fetched = await getWikipediaWork(id, ctx);
      break;
  }

  if (fetched === null) {
    return null;
  }

  writeWorkCache(
    deps.config,
    provider,
    id,
    fetched.work,
    fetched.remoteCoverUrl,
    nowMs,
    categoryOverride
  );
  writeBannerSource(deps.config, provider, id, fetched.remoteBannerUrl ?? null, nowMs);
  if (fetched.remoteArt !== undefined) {
    const artId = metaArtUrl(provider, id, fetched.work.category).split("/").at(-1)!;
    writeArtSources(deps.config, provider, artId, fetched.remoteArt, nowMs);
  }
  return fetched.work;
}

const inFlightBanners = new Map<string, Promise<RemoteImageResult | null>>();

/** Local, permanently cached backgrounds; absence is cached and the UI uses its cover/gradient. */
export async function getMetaBanner(provider: MetaProvider, id: string, deps: MetadataDeps): Promise<RemoteImageResult | null> {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) return null;
  const cached = readCachedMetaBanner(deps.config, provider, id);
  if (cached) return cached;
  const key = `${metaBannerCacheDir(deps.config)}:${provider}:${id}`;
  const existing = inFlightBanners.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const ctx = buildContext(deps);
    if (!ctx.metaConfig.enabled) return null;
    try {
      let source = readBannerSource(deps.config, provider, id, ctx.now());
      if (!source) {
        // Older work caches lack the source URL; resolve once through the existing provider.
        await lookupWork(provider, id, { ...deps, bypassCache: true });
        source = readBannerSource(deps.config, provider, id, ctx.now());
        if (!source) writeBannerSource(deps.config, provider, id, null, ctx.now());
      }
      if (!source?.url) return null;
      const fetchedImage = await fetchRemoteCoverImage(ctx, source.url);
      const image = fetchedImage?.contentType === "image/svg+xml" ? null : fetchedImage;
      if (image) writeCachedMetaBanner(deps.config, provider, id, image);
      else writeBannerSource(deps.config, provider, id, null, ctx.now());
      return image;
    } catch {
      writeBannerSource(deps.config, provider, id, null, ctx.now());
      return null;
    }
  })();
  inFlightBanners.set(key, pending);
  try { return await pending; } finally { inFlightBanners.delete(key); }
}

const inFlightCovers = new Map<string, Promise<RemoteImageResult | null>>();

/**
 * Fetch and permanently cache a metadata cover image under
 * `<dirname(db_path)>/covers/meta/`. Concurrent calls for the same cover share
 * one in-flight request.
 */
export async function getMetaCover(
  provider: MetaProvider,
  id: string,
  deps: MetadataDeps
): Promise<RemoteImageResult | null> {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return null;
  }

  const key = `${provider}:${id}`;
  const existing = inFlightCovers.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      return await getMetaCoverInternal(provider, id, deps);
    } finally {
      inFlightCovers.delete(key);
    }
  })();

  inFlightCovers.set(key, promise);
  return promise;
}

async function getMetaCoverInternal(
  provider: MetaProvider,
  id: string,
  deps: MetadataDeps
): Promise<RemoteImageResult | null> {
  // 1. Always serve from the permanent disk cache first (even if metadata is disabled).
  const cached = readCachedMetaCover(deps.config, provider, id);
  if (cached !== null) {
    return cached;
  }

  const ctx = buildContext(deps);
  if (!ctx.metaConfig.enabled) {
    return null;
  }

  // 2. Check if we already recorded the remote image URL during search or getWork.
  let remoteUrl = readCoverUrlCache(deps.config, provider, id);

  // 3. Otherwise ask the provider module to resolve (or directly fetch) the cover.
  if (!remoteUrl) {
    let directImage: RemoteImageResult | null = null;
    switch (provider) {
      case "anilist":
        directImage = await fetchAnilistCover(id, ctx);
        break;
      case "tvmaze":
        directImage = await fetchTvmazeCover(id, ctx);
        break;
      case "cinemeta":
        directImage = await fetchCinemetaCover(id, ctx);
        break;
      case "itunes":
        directImage = await fetchItunesCover(id, ctx);
        break;
      case "openlibrary":
        directImage = await fetchOpenLibraryMetaCover(id, ctx);
        break;
      case "tmdb":
        directImage = await fetchTmdbCover(id, ctx);
        break;
      case "steam":
        directImage = await fetchSteamCover(id, ctx);
        break;
      case "wikipedia":
        directImage = await fetchWikipediaCover(id, ctx);
        break;
    }

    if (directImage !== null) {
      writeCachedMetaCover(deps.config, provider, id, directImage);
      return directImage;
    }

    remoteUrl = readCoverUrlCache(deps.config, provider, id);
  }

  if (!remoteUrl) {
    return null;
  }

  const downloaded = await fetchRemoteCoverImage(ctx, remoteUrl);
  if (downloaded === null) {
    return null;
  }

  writeCachedMetaCover(deps.config, provider, id, downloaded);
  return downloaded;
}
