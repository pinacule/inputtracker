/**
 * Shared types, validation and text helpers for metadata lookup providers.
 */

import type { Config, MetadataConfig } from "../../core/config.ts";
import type { Category, LookupHit, MetaProvider, SeasonInfo, WorkDetails } from "../../core/contract.ts";
import type { Limiter } from "../openlibrary.ts";

export type { Category, LookupHit, MetaProvider, SeasonInfo, WorkDetails };

export const META_PROVIDERS: readonly MetaProvider[] = [
  "anilist",
  "tvmaze",
  "cinemeta",
  "itunes",
  "openlibrary",
  "tmdb",
] as const;

const META_PROVIDER_SET: ReadonlySet<string> = new Set(META_PROVIDERS);

/** Strict validation for provider path/query parameter. */
export function isMetaProvider(value: unknown): value is MetaProvider {
  return typeof value === "string" && META_PROVIDER_SET.has(value);
}

/** Provider IDs must be 1..64 safe ASCII identifier chars (no slashes, dots or traversal). */
export const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_RE.test(value);
}

export function metaCoverUrl(provider: MetaProvider, providerId: string): string {
  return `/api/meta-cover/${provider}/${providerId}`;
}

/** Error raised when an upstream provider fails (timeout, 5xx, network error, bad JSON). */
export class ProviderError extends Error {
  constructor(
    public readonly provider: MetaProvider,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface RankedCandidate {
  hit: LookupHit;
  /** Provider-reported popularity/weight/edition count for ranking ties. */
  popularity?: number;
  /** Additional titles (e.g. romaji/native) considered for title match tier. */
  alternateTitles?: string[];
  /** Direct upstream image URL to cache for `/api/meta-cover/:provider/:id`. */
  remoteCoverUrl?: string | null;
  /** IMDb ID (`tt\d+`) when known, used to deduplicate hits across providers. */
  imdbId?: string | null;
}

export interface WorkWithCover {
  work: WorkDetails;
  remoteCoverUrl?: string | null;
}

export interface ProviderContext {
  config: Config;
  metaConfig: MetadataConfig;
  fetch: typeof fetch;
  limiter: Limiter;
  timeoutMs: number;
  now: () => number;
}

export function resolveMetadataConfig(config: Config): MetadataConfig {
  const m = config.metadata;
  const openlibraryDefault = config.covers?.openlibrary_url ?? "https://openlibrary.org";
  const openlibraryCoversDefault =
    config.covers?.openlibrary_covers_url ?? "https://covers.openlibrary.org";

  return {
    enabled: m?.enabled ?? true,
    anilist_url: (m?.anilist_url ?? "https://graphql.anilist.co").trim().replace(/\/+$/, ""),
    tvmaze_url: (m?.tvmaze_url ?? "https://api.tvmaze.com").trim().replace(/\/+$/, ""),
    cinemeta_url: (m?.cinemeta_url ?? "https://v3-cinemeta.strem.io").trim().replace(/\/+$/, ""),
    itunes_url: (m?.itunes_url ?? "https://itunes.apple.com").trim().replace(/\/+$/, ""),
    openlibrary_url: (m?.openlibrary_url ?? openlibraryDefault).trim().replace(/\/+$/, ""),
    openlibrary_covers_url: (m?.openlibrary_covers_url ?? openlibraryCoversDefault)
      .trim()
      .replace(/\/+$/, ""),
    tmdb_url: (m?.tmdb_url ?? "https://api.themoviedb.org/3").trim().replace(/\/+$/, ""),
    tmdb_image_url: (m?.tmdb_image_url ?? "https://image.tmdb.org/t/p").trim().replace(/\/+$/, ""),
    tmdb_api_key: typeof m?.tmdb_api_key === "string" ? m.tmdb_api_key.trim() : "",
  };
}

export function isTmdbConfigured(config: Config): boolean {
  const key = config.metadata?.tmdb_api_key;
  return typeof key === "string" && key.trim() !== "";
}

/** Parse a 4-digit year from a number or date string ("2019-07-07", "May 1968", etc.). */
export function parseYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 2999) {
    return value;
  }
  if (typeof value === "string") {
    const match = /\b([12]\d{3})\b/.exec(value);
    if (match) {
      const y = Number(match[1]);
      if (y >= 1000 && y <= 2999) {
        return y;
      }
    }
  }
  return null;
}

/** Parse a runtime in minutes from a number (`167`) or string (`"167 min"`, `"2h 47m"`). */
export function parseRuntimeMinutes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const hm = /(\d+)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(trimmed);
    if (hm) {
      const h = Number(hm[1] ?? 0);
      const m = Number(hm[2] ?? 0);
      const total = h * 60 + m;
      if (total > 0) return total;
    }
    const minMatch = /(\d+)\s*(?:min(?:utes?)?|m\b)/i.exec(trimmed) ?? /^\s*(\d+)\s*$/.exec(trimmed);
    if (minMatch) {
      const mins = Number(minMatch[1]);
      if (Number.isFinite(mins) && mins > 0) {
        return Math.round(mins);
      }
    }
  }
  return null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-zA-Z]+);/g, (full, name) => NAMED_ENTITIES[name.toLowerCase()] ?? full);
}

/**
 * Convert HTML / markdown description from a provider into plain text capped
 * at `maxLength` characters (contract: at most 600 characters).
 */
export function cleanDescription(raw: unknown, maxLength = 600): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  let text = raw
    // Remove AniList spoiler blocks ~! ... !~
    .replace(/~![\s\S]*?!~/g, "")
    // Turn line-breaking tags into spaces
    .replace(/<\s*(?:br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
    // Strip all remaining HTML tags
    .replace(/<[^>]+>/g, "");

  text = decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
  if (text === "") {
    return null;
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
