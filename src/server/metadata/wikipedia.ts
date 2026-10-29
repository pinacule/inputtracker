/**
 * Wikipedia + Wikidata metadata provider (Games on every platform). No key, GET only.
 *
 * - Search: `<wikipedia_url>/w/api.php?action=query&generator=search` with page
 *   descriptions, lead images (`pilicense=any` includes box art) and the Wikidata id.
 *   Only pages described as a video game are kept.
 * - Details by Wikidata id: `<wikidata_url>/w/api.php?action=wbgetentities` for
 *   developers (P178), genres (P136), publication date (P577) and the English
 *   article, then the article intro and lead image from Wikipedia.
 * Provider ids are Wikidata ids (`Q17185964`).
 */

import { fetchProviderJson, fetchRemoteCoverImage, type RemoteImageResult } from "./http.ts";
import {
  cleanDescription,
  isValidProviderId,
  metaCoverUrl,
  parseYear,
  type ProviderContext,
  type RankedCandidate,
  type WorkWithCover,
} from "./types.ts";

/** Wikimedia asks API clients to identify themselves. */
const REQUEST_INIT: RequestInit = {
  method: "GET",
  headers: { "User-Agent": "InputTracker/1.0 (self-hosted personal media log)" },
};

const QID_RE = /^Q\d{1,12}$/;
const VIDEO_GAME_RE = /\bvideo ?game\b/i;
const COVER_SIZE = "600";

interface WikiPage {
  pageid?: number;
  index?: number;
  title?: string;
  description?: string;
  extract?: string;
  thumbnail?: { source?: string };
  pageprops?: { wikibase_item?: string };
}

interface WikiQueryResponse {
  query?: { pages?: WikiPage[] };
}

interface WikidataSnak {
  mainsnak?: { datavalue?: { value?: unknown } };
}

interface WikidataEntity {
  claims?: Record<string, WikidataSnak[] | undefined>;
  labels?: { en?: { value?: string } };
  sitelinks?: { enwiki?: { title?: string } };
}

interface WikidataResponse {
  entities?: Record<string, WikidataEntity | undefined>;
}

/** "Breath of Fire (video game)" / "Ocarina of Time (2026 video game)" → bare title. */
function cleanGameTitle(title: string): string {
  return title.replace(/\s*\((?:\d{4} )?video game\)$/i, "").trim();
}

function wikiApiUrl(ctx: ProviderContext, params: Record<string, string>): string {
  const url = new URL(`${ctx.metaConfig.wikipedia_url}/w/api.php`);
  for (const [k, v] of Object.entries({ ...params, format: "json", formatversion: "2" })) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function searchWikipediaGames(query: string, ctx: ProviderContext): Promise<RankedCandidate[]> {
  const url = wikiApiUrl(ctx, {
    action: "query",
    generator: "search",
    gsrsearch: `${query} video game`,
    gsrlimit: "15",
    prop: "description|pageimages|pageprops",
    ppprop: "wikibase_item",
    piprop: "thumbnail",
    pithumbsize: COVER_SIZE,
    pilicense: "any",
  });
  const { data } = await fetchProviderJson<WikiQueryResponse>(ctx, "wikipedia", url, REQUEST_INIT);
  const pages = [...(data?.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const results: RankedCandidate[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const qid = page.pageprops?.wikibase_item ?? "";
    const description = page.description ?? "";
    const title = cleanGameTitle(page.title ?? "");
    if (!QID_RE.test(qid) || !isValidProviderId(qid) || !title || !VIDEO_GAME_RE.test(description)) continue;
    const remoteCoverUrl = page.thumbnail?.source ?? null;
    const year = parseYear(description);
    results.push({
      hit: {
        provider: "wikipedia",
        provider_id: qid,
        category: "game",
        title,
        subtitle: description || null,
        year,
        cover_url: remoteCoverUrl ? metaCoverUrl("wikipedia", qid) : null,
      },
      popularity: Math.max(0, 15 - i),
      remoteCoverUrl,
    });
  }
  return results;
}

function claimIds(entity: WikidataEntity, property: string): string[] {
  const ids: string[] = [];
  for (const snak of entity.claims?.[property] ?? []) {
    const value = snak.mainsnak?.datavalue?.value as { id?: unknown } | undefined;
    if (typeof value?.id === "string" && QID_RE.test(value.id) && !ids.includes(value.id)) ids.push(value.id);
  }
  return ids;
}

function firstClaimYear(entity: WikidataEntity, property: string): number | null {
  for (const snak of entity.claims?.[property] ?? []) {
    const value = snak.mainsnak?.datavalue?.value as { time?: unknown } | undefined;
    const year = parseYear(typeof value?.time === "string" ? value.time.replace(/^\+/, "") : null);
    if (year !== null) return year;
  }
  return null;
}

export async function getWikipediaWork(id: string, ctx: ProviderContext): Promise<WorkWithCover | null> {
  if (!QID_RE.test(id)) return null;
  const entityUrl = new URL(`${ctx.metaConfig.wikidata_url}/w/api.php`);
  for (const [k, v] of Object.entries({
    action: "wbgetentities", ids: id, props: "claims|labels|sitelinks",
    languages: "en", sitefilter: "enwiki", format: "json",
  })) entityUrl.searchParams.set(k, v);
  const { data } = await fetchProviderJson<WikidataResponse>(ctx, "wikipedia", entityUrl.toString(), REQUEST_INIT);
  const entity = data?.entities?.[id];
  if (!entity?.claims) return null;

  const developers = claimIds(entity, "P178").slice(0, 4);
  const genreIds = claimIds(entity, "P136").slice(0, 6);
  const labels = new Map<string, string>();
  const labelIds = [...developers, ...genreIds];
  if (labelIds.length > 0) {
    const labelUrl = new URL(`${ctx.metaConfig.wikidata_url}/w/api.php`);
    for (const [k, v] of Object.entries({
      action: "wbgetentities", ids: labelIds.join("|"), props: "labels", languages: "en", format: "json",
    })) labelUrl.searchParams.set(k, v);
    const labelRes = await fetchProviderJson<WikidataResponse>(ctx, "wikipedia", labelUrl.toString(), REQUEST_INIT);
    for (const [qid, e] of Object.entries(labelRes.data?.entities ?? {})) {
      const label = e?.labels?.en?.value?.trim();
      if (label) labels.set(qid, label);
    }
  }

  let page: WikiPage | undefined;
  const articleTitle = entity.sitelinks?.enwiki?.title;
  if (articleTitle) {
    const pageRes = await fetchProviderJson<WikiQueryResponse>(ctx, "wikipedia", wikiApiUrl(ctx, {
      action: "query", titles: articleTitle, prop: "extracts|pageimages", exintro: "1", explaintext: "1",
      piprop: "thumbnail", pithumbsize: COVER_SIZE, pilicense: "any",
    }), REQUEST_INIT);
    page = pageRes.data?.query?.pages?.[0];
  }

  const title = cleanGameTitle(entity.labels?.en?.value ?? articleTitle ?? "");
  if (!title) return null;
  const remoteCoverUrl = page?.thumbnail?.source ?? null;
  const genres = genreIds.map((g) => labels.get(g)).filter((g): g is string => !!g)
    .map((g) => g.replace(/ video game$/i, ""))
    .map((g) => g.charAt(0).toUpperCase() + g.slice(1));

  return {
    work: {
      provider: "wikipedia",
      provider_id: id,
      category: "game",
      title,
      original_title: null,
      banner_url: null,
      community_score: null,
      year: firstClaimYear(entity, "P577"),
      cover_url: remoteCoverUrl ? metaCoverUrl("wikipedia", id) : null,
      creators: developers.map((d) => labels.get(d)).filter((d): d is string => !!d),
      genres: [...new Set(genres)],
      description: cleanDescription(page?.extract),
      seasons: [],
      runtime_minutes: null,
      pages: null,
      external_ids: { wikidata: id },
    },
    remoteCoverUrl,
    remoteBannerUrl: null,
    remoteArt: [],
  };
}

export async function fetchWikipediaCover(id: string, ctx: ProviderContext): Promise<RemoteImageResult | null> {
  try {
    const url = (await getWikipediaWork(id, ctx))?.remoteCoverUrl;
    return url ? await fetchRemoteCoverImage(ctx, url) : null;
  } catch {
    return null;
  }
}
