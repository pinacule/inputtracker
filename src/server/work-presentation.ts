/** Network-free work-page metadata and category rankings. */
import type { Config } from "../core/config.ts";
import type { CommunityScore, LibraryWork, LibraryWorkDetail, MetaProvider, WorkDetails, WorkRank } from "../core/contract.ts";
import { parseExternalIds, parseJsonObject, type ConsumptionEvent } from "./aggregate.ts";
import { readWorkCache } from "./metadata/cache.ts";
import { cleanDescription, isMetaProvider, isValidProviderId, metaArtUrl, metaBannerUrl, normalizeCommunityScore, parseYear } from "./metadata/types.ts";

export function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.map((item: unknown) => typeof item === "string" ? item : parseJsonObject(item)?.["name"])
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
}

export function readCommunityScore(value: unknown): CommunityScore | null {
  const obj = parseJsonObject(value);
  const sources: readonly unknown[] = ["AniList", "TMDB", "TVmaze", "IMDb", "Open Library", "iTunes"];
  if (!obj || !sources.includes(obj["source"])) return null;
  return normalizeCommunityScore(obj["source"] as CommunityScore["source"], obj["value_10"], 10, obj["votes"]);
}

type Presentation = Pick<LibraryWorkDetail, "description" | "genres" | "creators" | "narrators" | "year" | "banner_url" | "community_score" | "art_url">;
type MetaLink = { provider: MetaProvider; provider_id: string };

export function workPresentation(
  events: readonly ConsumptionEvent[],
  linked: { meta: MetaLink | null; meta_work: WorkDetails | null; meta_unlinked?: boolean } | null,
  config?: Config,
  category?: LibraryWork["category"]
): Presentation {
  const newest = [...events].sort((a, b) => b.id - a.id);
  const snapshot = newest.map((event) => parseJsonObject(parseJsonObject(event.raw)?.["work"])).find(Boolean) ?? null;
  const targets: MetaLink[] = [];
  if (linked?.meta) targets.push(linked.meta);
  else {
    if (snapshot && isMetaProvider(snapshot["provider"]) && isValidProviderId(snapshot["provider_id"])) {
      targets.push({ provider: snapshot["provider"], provider_id: snapshot["provider_id"] });
    }
    for (const event of newest) {
      const ext = parseExternalIds(event.external_ids);
      if (!ext) continue;
      if (isMetaProvider(ext["meta_provider"]) && isValidProviderId(ext["meta_id"])) {
        targets.push({ provider: ext["meta_provider"], provider_id: ext["meta_id"] });
      }
      for (const [key, provider] of [["anilist", "anilist"], ["tvmaze", "tvmaze"], ["imdb", "cinemeta"], ["openlibrary", "openlibrary"], ["itunes", "itunes"], ["tmdb", "tmdb"]] as const) {
        const id = ext[key];
        if ((typeof id === "string" || typeof id === "number") && isValidProviderId(String(id))) {
          targets.push({ provider, provider_id: String(id) });
        }
      }
    }
  }
  let cached: WorkDetails | null = null;
  if (config) {
    for (const target of targets) {
      cached = readWorkCache(config, target.provider, target.provider_id, Date.now(), category)
        ?? readWorkCache(config, target.provider, target.provider_id, Date.now());
      if (cached) break;
    }
  }
  // Explicit linkage wins. The disk cache only fills fields absent from old snapshots.
  const primary = linked?.meta ? linked.meta_work ?? cached : snapshot ?? cached;
  const meta = primary ? parseJsonObject(primary) : null;
  const fallback = cached ? parseJsonObject(cached) : null;
  const rawMetas = newest.map((event) => parseJsonObject(parseJsonObject(event.raw)?.["mediaMetadata"])).filter((item) => item !== null);
  const absDescription = rawMetas.map((item) => cleanDescription(item["description"])).find(Boolean) ?? null;
  const absGenres = rawMetas.map((item) => cleanNames(item["genres"])).find((names) => names.length > 0) ?? [];
  const absAuthors = rawMetas.map((item) => cleanNames(item["authors"])).find((names) => names.length > 0) ?? [];
  const metaCreators = cleanNames(meta?.["creators"]);
  const metaGenres = cleanNames(meta?.["genres"]);
  const target = targets[0];
  // Reclassifying a film must not turn its numeric TMDB ID into a different TV work.
  const artCategory = meta?.["category"] === "film" || meta?.["category"] === "series" ? meta["category"] : category;
  const banner = meta?.["banner_url"] === undefined ? fallback?.["banner_url"] : meta["banner_url"];
  return {
    art_url: target && !linked?.meta_unlinked ? metaArtUrl(target.provider, target.provider_id, artCategory) : null,
    description: cleanDescription(meta?.["description"]) ?? cleanDescription(fallback?.["description"]) ?? absDescription,
    genres: metaGenres.length ? metaGenres : cleanNames(fallback?.["genres"]).length ? cleanNames(fallback?.["genres"]) : absGenres,
    creators: metaCreators.length ? metaCreators : cleanNames(fallback?.["creators"]).length ? cleanNames(fallback?.["creators"]) : absAuthors,
    narrators: rawMetas.map((item) => cleanNames(item["narrators"])).find((names) => names.length > 0) ?? [],
    year: parseYear(meta?.["year"]) ?? parseYear(fallback?.["year"]) ?? rawMetas.map((item) => parseYear(item["publishedYear"])).find((year) => year !== null) ?? null,
    // Never pass a third-party URL to the browser. Old snapshots gain a banner on refresh.
    banner_url: target && banner === metaBannerUrl(target.provider, target.provider_id) ? banner : null,
    community_score: readCommunityScore(meta?.["community_score"] === undefined ? fallback?.["community_score"] : meta["community_score"]),
  };
}

/** Rank only visible, non-planned category peers; competition ties use integer rating tenths. */
export function rankLibraryWorks(works: readonly LibraryWork[]): Map<string, WorkRank> {
  const byCategory = new Map<LibraryWork["category"], LibraryWork[]>();
  for (const work of works) {
    if (work.status === "planned") continue;
    const peers = byCategory.get(work.category) ?? [];
    peers.push(work);
    byCategory.set(work.category, peers);
  }
  const ranks = new Map<string, WorkRank>();
  for (const peers of byCategory.values()) {
    const minutes = (work: LibraryWork) => Number.isFinite(work.total_minutes) ? Math.max(0, work.total_minutes) : 0;
    const total = peers.reduce((sum, work) => sum + minutes(work), 0);
    const byTime = [...peers].sort((a, b) => minutes(b) - minutes(a));
    let timeRank = 0;
    for (let i = 0; i < byTime.length; i++) {
      const work = byTime[i]!;
      if (i === 0 || minutes(work) !== minutes(byTime[i - 1]!)) timeRank = i + 1;
      ranks.set(work.key, { time: minutes(work) > 0 ? timeRank : null, time_share_percent: total > 0 ? minutes(work) / total * 100 : 0, rating: null });
    }
    const rated = peers.filter((work) => work.rating !== null).sort((a, b) => Math.round(b.rating! * 10) - Math.round(a.rating! * 10));
    let ratingRank = 0;
    for (let i = 0; i < rated.length; i++) {
      const work = rated[i]!;
      if (i === 0 || Math.round(work.rating! * 10) !== Math.round(rated[i - 1]!.rating! * 10)) ratingRank = i + 1;
      ranks.get(work.key)!.rating = ratingRank;
    }
  }
  return ranks;
}
