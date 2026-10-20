/**
 * Disk cache for metadata lookup responses and cover images.
 *
 * TTLs (per docs/v2-spec.md):
 * - Search responses: 7 days
 * - Work details: 30 days
 * - Cover images (`dirname(db_path)/covers/meta/`): permanent (never expire once
 *   downloaded, so the archive survives a provider disappearing).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../../core/config.ts";
import { normalizeImageType } from "../covers.ts";
import { normalizeForSearch } from "../search.ts";
import type { RemoteImageResult } from "./http.ts";
import {
  isMetaProvider,
  isValidProviderId,
  type MetaProvider,
  type RankedCandidate,
  type WorkDetails,
} from "./types.ts";

/** 7 days in milliseconds for search results. */
export const SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 30 days in milliseconds for work details. */
export const WORK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MEMORY_CACHE_ROOT = join(tmpdir(), `inputtracker-meta-mem-${process.pid}`);

function storageBaseDir(config: Config): string {
  const dbPath = config.storage?.db_path ?? ":memory:";
  if (dbPath === ":memory:" || dbPath.trim() === "") {
    return MEMORY_CACHE_ROOT;
  }
  return dirname(dbPath);
}

/** `<dirname(db_path)>/covers/meta`; holds permanent cover images. */
export function metaCoverCacheDir(config: Config): string {
  return join(storageBaseDir(config), "covers", "meta");
}

/** `<dirname(db_path)>/metadata-cache`; holds 7d search and 30d work JSON cache. */
export function metadataCacheDir(config: Config): string {
  return join(storageBaseDir(config), "metadata-cache");
}

function sha256Hex(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

// --- Search cache (7 days) ---------------------------------------------------

interface SearchCacheEnvelope {
  savedAt: number;
  query: string;
  candidates: RankedCandidate[];
}

function searchCachePath(
  config: Config,
  provider: MetaProvider,
  scope: string,
  query: string
): string {
  const norm = normalizeForSearch(query);
  const hash = sha256Hex(`${provider}\u0000${scope}\u0000${norm}`);
  return join(metadataCacheDir(config), `search_${provider}_${hash}.json`);
}

export function readSearchCache(
  config: Config,
  provider: MetaProvider,
  scope: string,
  query: string,
  nowMs: number
): RankedCandidate[] | null {
  const path = searchCachePath(config, provider, scope, query);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as SearchCacheEnvelope;
    if (
      typeof raw?.savedAt !== "number" ||
      !Number.isFinite(raw.savedAt) ||
      nowMs - raw.savedAt >= SEARCH_CACHE_TTL_MS ||
      !Array.isArray(raw.candidates)
    ) {
      return null;
    }
    return raw.candidates;
  } catch {
    return null;
  }
}

export function writeSearchCache(
  config: Config,
  provider: MetaProvider,
  scope: string,
  query: string,
  candidates: RankedCandidate[],
  nowMs: number
): void {
  const path = searchCachePath(config, provider, scope, query);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const envelope: SearchCacheEnvelope = {
      savedAt: nowMs,
      query,
      candidates,
    };
    writeFileSync(path, JSON.stringify(envelope), "utf8");
  } catch {
    // Cache is best-effort.
  }

  for (const c of candidates) {
    if (c.remoteCoverUrl && isValidProviderId(c.hit.provider_id)) {
      writeCoverUrlCache(config, c.hit.provider, c.hit.provider_id, c.remoteCoverUrl);
    }
  }
}

// --- Work details cache (30 days) --------------------------------------------

interface WorkCacheEnvelope {
  savedAt: number;
  work: WorkDetails;
  remoteCoverUrl?: string | null;
}

function workCachePath(
  config: Config,
  provider: MetaProvider,
  id: string,
  categoryOverride?: string
): string {
  const suffix = categoryOverride ? `_${categoryOverride}` : "";
  return join(metadataCacheDir(config), `work_${provider}_${id}${suffix}.json`);
}

export function readWorkCache(
  config: Config,
  provider: MetaProvider,
  id: string,
  nowMs: number,
  categoryOverride?: string
): WorkDetails | null {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return null;
  }
  const path = workCachePath(config, provider, id, categoryOverride);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as WorkCacheEnvelope;
    if (
      typeof raw?.savedAt !== "number" ||
      !Number.isFinite(raw.savedAt) ||
      nowMs - raw.savedAt >= WORK_CACHE_TTL_MS ||
      !raw.work ||
      typeof raw.work !== "object"
    ) {
      return null;
    }
    return raw.work;
  } catch {
    return null;
  }
}

export function writeWorkCache(
  config: Config,
  provider: MetaProvider,
  id: string,
  work: WorkDetails,
  remoteCoverUrl: string | null | undefined,
  nowMs: number,
  categoryOverride?: string
): void {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return;
  }
  const path = workCachePath(config, provider, id, categoryOverride);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const envelope: WorkCacheEnvelope = {
      savedAt: nowMs,
      work,
      remoteCoverUrl: remoteCoverUrl ?? null,
    };
    writeFileSync(path, JSON.stringify(envelope), "utf8");
  } catch {
    // Cache is best-effort.
  }

  if (remoteCoverUrl) {
    writeCoverUrlCache(config, provider, id, remoteCoverUrl);
    if (isValidProviderId(work.provider_id) && work.provider_id !== id) {
      writeCoverUrlCache(config, provider, work.provider_id, remoteCoverUrl);
    }
  }
}

// Banner source resolution (including an absent background) shares the work TTL.
export function readBannerSource(config: Config, provider: MetaProvider, id: string, nowMs: number): { url: string | null } | null {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) return null;
  try {
    const raw = JSON.parse(readFileSync(join(metadataCacheDir(config), `bannerurl_${provider}_${id}.json`), "utf8")) as { savedAt: number; url: unknown };
    if (!Number.isFinite(raw.savedAt) || nowMs - raw.savedAt >= WORK_CACHE_TTL_MS) return null;
    return raw.url === null || typeof raw.url === "string" ? { url: raw.url } : null;
  } catch { return null; }
}

export function writeBannerSource(config: Config, provider: MetaProvider, id: string, url: string | null, nowMs: number): void {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) return;
  try {
    mkdirSync(metadataCacheDir(config), { recursive: true });
    writeFileSync(join(metadataCacheDir(config), `bannerurl_${provider}_${id}.json`), JSON.stringify({ savedAt: nowMs, url }));
  } catch { /* Best-effort. */ }
}

export function metaBannerCacheDir(config: Config): string {
  return join(storageBaseDir(config), "covers", "meta-banner");
}

export function readCachedMetaBanner(config: Config, provider: MetaProvider, id: string): RemoteImageResult | null {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) return null;
  try {
    const path = join(metaBannerCacheDir(config), `${provider}_${id}`);
    const contentType = normalizeImageType(readFileSync(`${path}.type`, "utf8"));
    const bytes = new Uint8Array(readFileSync(`${path}.img`));
    return contentType && contentType !== "image/svg+xml" && bytes.byteLength > 0 ? { bytes, contentType } : null;
  } catch { return null; }
}

export function writeCachedMetaBanner(config: Config, provider: MetaProvider, id: string, image: RemoteImageResult): void {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) return;
  try {
    const path = join(metaBannerCacheDir(config), `${provider}_${id}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.img`, image.bytes);
    writeFileSync(`${path}.type`, image.contentType);
  } catch { /* Best-effort. */ }
}

// --- Cover source URL & provider hint cache ----------------------------------

function coverUrlPath(config: Config, provider: MetaProvider, id: string): string {
  return join(metadataCacheDir(config), `coverurl_${provider}_${id}.txt`);
}

export function readCoverUrlCache(
  config: Config,
  provider: MetaProvider,
  id: string
): string | null {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return null;
  }
  const path = coverUrlPath(config, provider, id);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const url = readFileSync(path, "utf8").trim();
    return url !== "" ? url : null;
  } catch {
    return null;
  }
}

export function writeCoverUrlCache(
  config: Config,
  provider: MetaProvider,
  id: string,
  url: string
): void {
  if (!isMetaProvider(provider) || !isValidProviderId(id) || !url) {
    return;
  }
  const path = coverUrlPath(config, provider, id);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${url}\n`, "utf8");
  } catch {
    // Best-effort.
  }
}

function hintPath(config: Config, provider: MetaProvider, id: string): string {
  return join(metadataCacheDir(config), `hint_${provider}_${id}.json`);
}

export function readProviderHint<T>(
  config: Config,
  provider: MetaProvider,
  id: string
): T | null {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return null;
  }
  const path = hintPath(config, provider, id);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeProviderHint<T>(
  config: Config,
  provider: MetaProvider,
  id: string,
  hint: T
): void {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return;
  }
  const path = hintPath(config, provider, id);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(hint), "utf8");
  } catch {
    // Best-effort.
  }
}

// --- Permanent cover image cache (`dirname(db_path)/covers/meta/`) -----------

function metaCoverPaths(
  config: Config,
  provider: MetaProvider,
  id: string
): { imgPath: string; typePath: string } {
  const dir = metaCoverCacheDir(config);
  const key = `${provider}_${id}`;
  return {
    imgPath: join(dir, `${key}.img`),
    typePath: join(dir, `${key}.type`),
  };
}

export function readCachedMetaCover(
  config: Config,
  provider: MetaProvider,
  id: string
): RemoteImageResult | null {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return null;
  }
  const { imgPath, typePath } = metaCoverPaths(config, provider, id);
  if (!existsSync(imgPath) || !existsSync(typePath)) {
    return null;
  }
  try {
    const contentType = normalizeImageType(readFileSync(typePath, "utf8"));
    if (contentType === null) {
      return null;
    }
    const bytes = new Uint8Array(readFileSync(imgPath));
    if (bytes.byteLength === 0) {
      return null;
    }
    return { bytes, contentType };
  } catch {
    return null;
  }
}

export function writeCachedMetaCover(
  config: Config,
  provider: MetaProvider,
  id: string,
  image: RemoteImageResult
): void {
  if (!isMetaProvider(provider) || !isValidProviderId(id)) {
    return;
  }
  const { imgPath, typePath } = metaCoverPaths(config, provider, id);
  try {
    mkdirSync(dirname(imgPath), { recursive: true });
    writeFileSync(imgPath, image.bytes);
    writeFileSync(typePath, image.contentType, "utf8");
  } catch {
    // Best-effort.
  }
}
