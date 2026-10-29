/**
 * Ranking and merging of metadata lookup hits across providers.
 *
 * Rules (docs/v2-spec.md):
 * - Exact title match first, then prefix/substring, then by popularity and year.
 * - Provider preference within a category:
 *   - Films: TMDB (when configured) > Cinemeta > iTunes
 *   - Series: TMDB (when configured) > TVmaze > Cinemeta
 * - Deduplicate hits that share the same IMDb ID within a category (keeping the
 *   preferred provider's hit, e.g. TVmaze over Cinemeta).
 * - Return at most 20 hits.
 */

import { normalizeForSearch } from "../search.ts";
import type { LookupHit, MetaProvider, RankedCandidate } from "./types.ts";

export const MAX_LOOKUP_RESULTS = 20;

const PROVIDER_PRIORITY: Record<MetaProvider, number> = {
  tmdb: 0,
  anilist: 1,
  tvmaze: 2,
  cinemeta: 3,
  itunes: 4,
  openlibrary: 5,
  steam: 6,
  wikipedia: 7,
};

function singleTitleTier(titleNorm: string, queryNorm: string, queryWords: string[]): number {
  if (titleNorm === "" || queryNorm === "") {
    return 4;
  }
  if (titleNorm === queryNorm) {
    return 0;
  }
  if (titleNorm.startsWith(queryNorm)) {
    return 1;
  }
  if (titleNorm.includes(queryNorm)) {
    return 2;
  }
  if (queryWords.length > 0 && queryWords.every((w) => titleNorm.includes(w))) {
    return 3;
  }
  return 4;
}

export function computeMatchTier(candidate: RankedCandidate, queryNorm: string): number {
  if (queryNorm === "") {
    return 4;
  }
  const queryWords = queryNorm.split(" ").filter((w) => w !== "");
  const titles = [candidate.hit.title, ...(candidate.alternateTitles ?? [])];
  let best = 4;
  for (const t of titles) {
    if (typeof t !== "string") continue;
    const tier = singleTitleTier(normalizeForSearch(t), queryNorm, queryWords);
    if (tier < best) {
      best = tier;
      if (best === 0) break;
    }
  }
  if (best === 4 && candidate.hit.subtitle) {
    const combined = normalizeForSearch(`${candidate.hit.title} ${candidate.hit.subtitle}`);
    if (queryWords.length > 0 && queryWords.every((w) => combined.includes(w))) {
      best = 3;
    }
  }
  return best;
}

function extractImdbId(candidate: RankedCandidate): string | null {
  // Games share no id across Steam and Wikipedia; the same title is the same game.
  if (candidate.hit.category === "game") {
    return `title:${normalizeForSearch(candidate.hit.title)}`;
  }
  if (typeof candidate.imdbId === "string" && /^tt\d+$/i.test(candidate.imdbId.trim())) {
    return candidate.imdbId.trim().toLowerCase();
  }
  if (
    candidate.hit.provider === "cinemeta" &&
    /^tt\d+$/i.test(candidate.hit.provider_id.trim())
  ) {
    return candidate.hit.provider_id.trim().toLowerCase();
  }
  return null;
}

export function rankLookupHits(
  query: string,
  candidates: readonly RankedCandidate[],
  limit: number = MAX_LOOKUP_RESULTS
): LookupHit[] {
  const queryNorm = normalizeForSearch(query);

  // Pre-collect the highest-priority provider for each (category, imdbId) pair
  // so a secondary provider (e.g. Cinemeta after TVmaze) is dropped when both
  // return the same IMDb work.
  const bestProviderByImdb = new Map<string, MetaProvider>();
  for (const c of candidates) {
    const imdb = extractImdbId(c);
    if (!imdb) continue;
    const imdbKey = `${c.hit.category}:${imdb}`;
    const existing = bestProviderByImdb.get(imdbKey);
    if (
      existing === undefined ||
      PROVIDER_PRIORITY[c.hit.provider] < PROVIDER_PRIORITY[existing]
    ) {
      bestProviderByImdb.set(imdbKey, c.hit.provider);
    }
  }

  const seenKey = new Set<string>();
  const seenImdb = new Set<string>();
  const scored: Array<{
    candidate: RankedCandidate;
    tier: number;
    popularity: number;
    year: number;
    index: number;
  }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const key = `${candidate.hit.provider}:${candidate.hit.provider_id}:${candidate.hit.category}`;
    if (seenKey.has(key)) {
      continue;
    }

    const imdb = extractImdbId(candidate);
    if (imdb) {
      const imdbKey = `${candidate.hit.category}:${imdb}`;
      const bestProv = bestProviderByImdb.get(imdbKey);
      if (bestProv !== undefined && bestProv !== candidate.hit.provider) {
        continue;
      }
      if (seenImdb.has(imdbKey)) {
        continue;
      }
      seenImdb.add(imdbKey);
    }

    seenKey.add(key);

    scored.push({
      candidate,
      tier: computeMatchTier(candidate, queryNorm),
      popularity:
        typeof candidate.popularity === "number" && Number.isFinite(candidate.popularity)
          ? candidate.popularity
          : 0,
      year:
        typeof candidate.hit.year === "number" && Number.isFinite(candidate.hit.year)
          ? candidate.hit.year
          : 0,
      index: i,
    });
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }

    const provA = a.candidate.hit.provider;
    const provB = b.candidate.hit.provider;
    if (a.candidate.hit.category === b.candidate.hit.category && provA !== provB) {
      return PROVIDER_PRIORITY[provA] - PROVIDER_PRIORITY[provB];
    }

    if (a.popularity !== b.popularity) {
      return b.popularity - a.popularity;
    }

    if (a.year !== b.year) {
      return b.year - a.year;
    }

    const prioDiff = PROVIDER_PRIORITY[provA] - PROVIDER_PRIORITY[provB];
    if (prioDiff !== 0) {
      return prioDiff;
    }

    const titleCmp = a.candidate.hit.title.localeCompare(b.candidate.hit.title);
    if (titleCmp !== 0) {
      return titleCmp;
    }

    return a.index - b.index;
  });

  return scored.slice(0, limit).map((s) => s.candidate.hit);
}
