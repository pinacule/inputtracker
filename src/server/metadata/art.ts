/** Lazy artwork resolution and local raster-image proxy; no archive/database writes. */
import type { MetaProvider, WorkArtResult } from "../../core/contract.ts";
import { getAnilistArt } from "./anilist.ts";
import { ART_CONTENT_TYPES, MAX_WORK_ART, selectArt, type ArtSource } from "./art-types.ts";
import {
  artImageAbsent, metaArtCacheDir, metadataCacheDir, readArtSources, readCachedArt,
  writeArtSources, writeCachedArt,
} from "./cache.ts";
import { getCinemetaWork } from "./cinemeta.ts";
import { defaultMetadataLimiter, fetchRemoteCoverImage, METADATA_TIMEOUT_MS, type RemoteImageResult } from "./http.ts";
import type { MetadataDeps } from "./index.ts";
import { getItunesWork } from "./itunes.ts";
import { getOpenLibraryArt } from "./openlibrary.ts";
import { getTmdbArt } from "./tmdb.ts";
import { getTvmazeArt } from "./tvmaze.ts";
import { isMetaProvider, isValidProviderId, resolveMetadataConfig, type ProviderContext } from "./types.ts";

const inFlightLists = new Map<string, Promise<ArtSource[]>>();
const inFlightImages = new Map<string, Promise<RemoteImageResult | null>>();

function context(deps: MetadataDeps): ProviderContext {
  return { config: deps.config, metaConfig: resolveMetadataConfig(deps.config), fetch: deps.fetch ?? globalThis.fetch,
    limiter: deps.limiter ?? defaultMetadataLimiter, timeoutMs: deps.timeoutMs ?? METADATA_TIMEOUT_MS, now: deps.now ?? Date.now };
}

async function sourcesFor(provider: MetaProvider, id: string, deps: MetadataDeps): Promise<ArtSource[]> {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) return [];
  const ctx = context(deps);
  // Disabled providers can still display permanently cached bytes, including a stale list.
  const cached = readArtSources(ctx.config, provider, id, ctx.now(), !ctx.metaConfig.enabled);
  if (cached !== null) return cached;
  if (!ctx.metaConfig.enabled) return [];
  const key = `${metadataCacheDir(ctx.config)}:${provider}:${id}`;
  const existing = inFlightLists.get(key);
  if (existing) return existing;
  const pending = (async () => {
    let sources: ArtSource[] = [];
    try {
      switch (provider) {
        case "anilist": sources = await getAnilistArt(id, ctx); break;
        case "tmdb": sources = await getTmdbArt(id, ctx); break;
        case "tvmaze": sources = await getTvmazeArt(id, ctx); break;
        case "openlibrary": sources = await getOpenLibraryArt(id, ctx); break;
        case "cinemeta": sources = (await getCinemetaWork(id, ctx))?.remoteArt ?? []; break;
        case "itunes": sources = (await getItunesWork(id, ctx))?.remoteArt ?? []; break;
      }
      sources = selectArt(sources);
    } catch { /* Unavailable optional art is a cached absence, never a work-page failure. */ }
    writeArtSources(ctx.config, provider, id, sources, ctx.now());
    return sources;
  })();
  inFlightLists.set(key, pending);
  try { return await pending; } finally { inFlightLists.delete(key); }
}

export async function getMetaArtList(provider: MetaProvider, id: string, deps: MetadataDeps): Promise<WorkArtResult> {
  const sources = await sourcesFor(provider, id, deps);
  const nowMs = (deps.now ?? Date.now)();
  return { images: sources.flatMap((source, n) => {
    const cached = readCachedArt(deps.config, source.url);
    if ((!cached && artImageAbsent(deps.config, source.url, nowMs)) || (!cached && !resolveMetadataConfig(deps.config).enabled)) return [];
    return [{ ...source, url: `/api/meta-art/${provider}/${id}/${n}` }];
  }) };
}

export async function getMetaArtImage(provider: MetaProvider, id: string, n: number, deps: MetadataDeps): Promise<RemoteImageResult | null> {
  if (!isMetaProvider(provider) || !isValidProviderId(id) || !Number.isInteger(n) || n < 0 || n >= MAX_WORK_ART) return null;
  const source = (await sourcesFor(provider, id, deps))[n];
  if (!source) return null;
  const cached = readCachedArt(deps.config, source.url);
  if (cached) return cached;
  const ctx = context(deps);
  if (!ctx.metaConfig.enabled || artImageAbsent(ctx.config, source.url, ctx.now())) return null;
  const key = `${metaArtCacheDir(ctx.config)}:${source.url}`;
  const existing = inFlightImages.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const fetched = await fetchRemoteCoverImage(ctx, source.url);
    const image = fetched && ART_CONTENT_TYPES.has(fetched.contentType) ? fetched : null;
    writeCachedArt(ctx.config, source.url, image, ctx.now());
    return image;
  })();
  inFlightImages.set(key, pending);
  try { return await pending; } finally { inFlightImages.delete(key); }
}
