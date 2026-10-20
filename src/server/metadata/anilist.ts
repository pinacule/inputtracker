/**
 * AniList GraphQL metadata provider (Anime: TV series & anime films).
 *
 * Uses AniList's read-only GraphQL endpoint (`POST https://graphql.anilist.co`).
 * - Search deduplicates a franchise so sequels and side stories (`PREQUEL` /
 *   `PARENT` of another hit in the same result set) are collapsed into the
 *   root entry, and formats the root hit's subtitle with the released season
 *   and episode count (e.g. `"2019 · 2 seasons · 48 episodes"`).
 * - Work details walk `PREQUEL` back to the first season and then `SEQUEL`
 *   forward over `TV` / `TV_SHORT` / `ONA` entries (max 15 hops).
 * - Anime with format `MOVIE` have `runtime_minutes` and `seasons: []`.
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
  metaBannerUrl,
  normalizeCommunityScore,
  parseYear,
  type ProviderContext,
  ProviderError,
  type RankedCandidate,
  type SeasonInfo,
  type WorkWithCover,
} from "./types.ts";

export const MAX_ANILIST_HOPS = 15;

const SEASON_FORMATS: ReadonlySet<string> = new Set(["TV", "TV_SHORT", "ONA"]);
const CHILD_TO_PARENT_RELATIONS: ReadonlySet<string> = new Set([
  "PREQUEL",
  "PARENT",
  "FULL_STORY",
  "MAIN_STORY",
]);
const PARENT_TO_CHILD_RELATIONS: ReadonlySet<string> = new Set([
  "SEQUEL",
  "SIDE_STORY",
  "SPIN_OFF",
  "SUMMARY",
]);

const SEARCH_QUERY = `
query ($search: String, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
      id
      idMal
      type
      format
      status
      episodes
      duration
      seasonYear
      startDate { year }
      popularity
      title { english romaji native }
      coverImage { extraLarge large medium }
      relations {
        edges {
          relationType(version: 2)
          node {
            id
            type
            format
            status
            episodes
            duration
            seasonYear
            startDate { year }
            title { english romaji native }
          }
        }
      }
    }
  }
}
`.trim();

const MEDIA_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    type
    format
    status
    episodes
    duration
    seasonYear
    startDate { year }
    popularity
    genres
    averageScore
    bannerImage
    description(asHtml: false)
    title { english romaji native }
    coverImage { extraLarge large medium }
    studios {
      nodes { name isAnimationStudio }
      edges { isMain node { name } }
    }
    relations {
      edges {
        relationType(version: 2)
        node {
          id
          idMal
          type
          format
          status
          episodes
          duration
          seasonYear
          startDate { year }
          title { english romaji native }
          coverImage { extraLarge large medium }
        }
      }
    }
  }
}
`.trim();

interface AniListTitle {
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
}

interface AniListRelationEdge {
  relationType?: string | null;
  node?: AniListMediaNode | null;
}

interface AniListMediaNode {
  id?: number;
  idMal?: number | null;
  type?: string | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  duration?: number | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null } | null;
  popularity?: number | null;
  averageScore?: number | null;
  bannerImage?: string | null;
  genres?: string[] | null;
  description?: string | null;
  title?: AniListTitle | null;
  coverImage?: {
    extraLarge?: string | null;
    large?: string | null;
    medium?: string | null;
  } | null;
  studios?: {
    nodes?: Array<{ name?: string | null; isAnimationStudio?: boolean | null }> | null;
    edges?: Array<{ isMain?: boolean | null; node?: { name?: string | null } | null }> | null;
  } | null;
  relations?: {
    edges?: Array<AniListRelationEdge | null> | null;
  } | null;
}

function pickTitle(title: AniListTitle | null | undefined): string | null {
  if (!title) return null;
  for (const candidate of [title.english, title.romaji, title.native]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return null;
}

function pickAlternateTitles(title: AniListTitle | null | undefined, primary: string): string[] {
  if (!title) return [];
  const out: string[] = [];
  for (const candidate of [title.english, title.romaji, title.native]) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed !== "" && trimmed !== primary && !out.includes(trimmed)) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function pickOriginalTitle(title: AniListTitle | null | undefined, primary: string): string | null {
  if (!title) return null;
  for (const candidate of [title.native, title.romaji]) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed !== "" && trimmed !== primary) {
        return trimmed;
      }
    }
  }
  return null;
}

function pickCoverUrl(node: AniListMediaNode | null | undefined): string | null {
  const c = node?.coverImage;
  if (!c) return null;
  for (const u of [c.large, c.extraLarge, c.medium]) {
    if (typeof u === "string" && u.trim() !== "") {
      return u.trim();
    }
  }
  return null;
}

function pickYear(node: AniListMediaNode | null | undefined): number | null {
  return parseYear(node?.seasonYear) ?? parseYear(node?.startDate?.year);
}

function isUnreleasedFutureNode(node: AniListMediaNode | null | undefined, currentYear: number): boolean {
  if (!node) return true;
  if (typeof node.status === "string") {
    const st = node.status.trim().toUpperCase();
    if (st === "NOT_YET_RELEASED" || st === "CANCELLED") {
      return true;
    }
    if (st === "FINISHED" || st === "RELEASING") {
      return false;
    }
  }
  const year = pickYear(node);
  if (year !== null && year > currentYear) {
    return true;
  }
  return false;
}

function pickStudios(node: AniListMediaNode | null | undefined): string[] {
  const studios = node?.studios;
  if (!studios) return [];

  const names: string[] = [];
  const add = (name: unknown) => {
    if (typeof name === "string") {
      const trimmed = name.trim();
      if (trimmed !== "" && !names.includes(trimmed)) {
        names.push(trimmed);
      }
    }
  };

  if (Array.isArray(studios.nodes) && studios.nodes.length > 0) {
    const animNodes = studios.nodes.filter((n) => n?.isAnimationStudio === true);
    const source = animNodes.length > 0 ? animNodes : studios.nodes;
    for (const n of source) {
      add(n?.name);
    }
  }
  if (names.length === 0 && Array.isArray(studios.edges)) {
    const mainEdges = studios.edges.filter((e) => e?.isMain === true);
    const source = mainEdges.length > 0 ? mainEdges : studios.edges;
    for (const e of source) {
      add(e?.node?.name);
    }
  }
  return names;
}

function formatSingleHitSubtitle(node: AniListMediaNode, year: number | null): string | null {
  const parts: string[] = [];
  if (year !== null) {
    parts.push(String(year));
  }
  const format = typeof node.format === "string" ? node.format.toUpperCase() : "";
  if (format === "MOVIE") {
    parts.push("Film");
    if (typeof node.duration === "number" && node.duration > 0) {
      parts.push(`${node.duration} min`);
    }
  } else {
    if (typeof node.episodes === "number" && node.episodes > 0) {
      parts.push(`${node.episodes} ${node.episodes === 1 ? "episode" : "episodes"}`);
    } else if (format) {
      parts.push(format);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

async function graphqlPost<T>(
  ctx: ProviderContext,
  query: string,
  variables: Record<string, unknown>
): Promise<{ status: number; data: T | null }> {
  const url = ctx.metaConfig.anilist_url;
  const res = await fetchProviderJson<{
    data?: T | null;
    errors?: Array<{ message?: string; status?: number }>;
  }>(ctx, "anilist", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 404 || res.data === null) {
    return { status: 404, data: null };
  }

  if (Array.isArray(res.data.errors) && res.data.errors.length > 0 && !res.data.data) {
    const isNotFound = res.data.errors.some(
      (e) => e?.status === 404 || /not\s+found/i.test(e?.message ?? "")
    );
    if (isNotFound) {
      return { status: 404, data: null };
    }
    throw new ProviderError(
      "anilist",
      `AniList GraphQL error: ${res.data.errors[0]?.message ?? "unknown"}`
    );
  }

  return { status: res.status, data: res.data.data ?? null };
}

function isAnimeNode(node: AniListMediaNode | null | undefined): node is AniListMediaNode & { id: number } {
  if (!node || typeof node.id !== "number" || node.id <= 0) {
    return false;
  }
  if (typeof node.type === "string" && node.type.toUpperCase() === "MANGA") {
    return false;
  }
  return true;
}

function isSeasonCandidate(node: AniListMediaNode | null | undefined): node is AniListMediaNode & { id: number } {
  if (!isAnimeNode(node)) {
    return false;
  }
  const format = typeof node.format === "string" ? node.format.toUpperCase() : "";
  return SEASON_FORMATS.has(format);
}

/** A narrative sequel is not necessarily another season of the same series. */
function sharesSeriesRoot(a: AniListMediaNode, b: AniListMediaNode): boolean {
  const titles = (node: AniListMediaNode): string[] =>
    [node.title?.english, node.title?.romaji, node.title?.native]
      .filter((t): t is string => typeof t === "string" && t.trim() !== "")
      .map((t) => t.normalize("NFKC").toLowerCase()
        .replace(/(?:\b(?:season|part|cour|s)\s*\d+|\b\d+(?:st|nd|rd|th)?\s*season|\s+\d+)\s*$/iu, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ").trim());
  return titles(a).some((left) => left !== "" && titles(b).some((right) =>
    right !== "" && (left === right || left.startsWith(`${right} `) || right.startsWith(`${left} `))));
}

function mergeNodeFields<T extends AniListMediaNode>(
  primary: T,
  fallback: AniListMediaNode
): T {
  return {
    ...fallback,
    ...primary,
    status: primary.status ?? fallback.status,
    title: primary.title ?? fallback.title,
    episodes: primary.episodes ?? fallback.episodes,
    duration: primary.duration ?? fallback.duration,
    seasonYear: primary.seasonYear ?? fallback.seasonYear,
    startDate: primary.startDate ?? fallback.startDate,
    coverImage: primary.coverImage ?? fallback.coverImage,
    relations: primary.relations ?? fallback.relations,
  };
}

export async function searchAnilist(
  query: string,
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  const { data } = await graphqlPost<{ Page?: { media?: AniListMediaNode[] | null } | null }>(
    ctx,
    SEARCH_QUERY,
    { search: query, page: 1, perPage: 10 }
  );

  const rawList = (Array.isArray(data?.Page?.media) ? data!.Page!.media! : []).filter(isAnimeNode);
  if (rawList.length === 0) {
    return [];
  }

  const currentYear = new Date(ctx.now()).getUTCFullYear();

  // Index hits in the result set and all known nodes (including relation stubs).
  const hitById = new Map<number, AniListMediaNode & { id: number }>();
  const hitIndexById = new Map<number, number>();
  const knownNodes = new Map<number, AniListMediaNode & { id: number }>();

  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i]!;
    hitById.set(item.id, item);
    hitIndexById.set(item.id, i);
    knownNodes.set(item.id, item);
  }

  for (const item of rawList) {
    const edges = item.relations?.edges;
    if (!Array.isArray(edges)) continue;
    for (const edge of edges) {
      const target = edge?.node;
      if (!isAnimeNode(target)) continue;
      const existing = knownNodes.get(target.id);
      knownNodes.set(target.id, existing ? mergeNodeFields(existing, target) : target);
    }
  }

  // Build parent graph (`childId -> Set<parentOrPrequelId>`) and sequel graph (`seasonId -> nextSeasonId`).
  const parentsOf = new Map<number, Set<number>>();
  const addParentLink = (childId: number, parentId: number) => {
    if (childId === parentId) return;
    let set = parentsOf.get(childId);
    if (!set) {
      set = new Set();
      parentsOf.set(childId, set);
    }
    set.add(parentId);
  };

  const sequelOf = new Map<number, number>();

  for (const node of knownNodes.values()) {
    const edges = node.relations?.edges;
    if (!Array.isArray(edges)) continue;
    for (const edge of edges) {
      if (!edge || !isAnimeNode(edge.node)) continue;
      const rel = (edge.relationType ?? "").toUpperCase();
      const target = knownNodes.get(edge.node.id) ?? edge.node;

      const nodeId = node.id;
      const targetId = target.id;
      const nodeIsSeason = isSeasonCandidate(node);
      const targetIsSeason = isSeasonCandidate(target);

      if (nodeIsSeason && targetIsSeason &&
          (rel === "SPIN_OFF" || !sharesSeriesRoot(node, target))) {
        continue;
      }

      if (CHILD_TO_PARENT_RELATIONS.has(rel)) {
        if (nodeIsSeason && !targetIsSeason) {
          // A prequel/parent OVA/Movie/Special belongs under the TV series, never above it.
          addParentLink(targetId, nodeId);
        } else {
          addParentLink(nodeId, targetId);
        }
      } else if (PARENT_TO_CHILD_RELATIONS.has(rel)) {
        if (!nodeIsSeason && targetIsSeason) {
          addParentLink(nodeId, targetId);
        } else {
          addParentLink(targetId, nodeId);
        }
      }

      if (rel === "SEQUEL" && nodeIsSeason && targetIsSeason) {
        if (!sequelOf.has(nodeId)) {
          sequelOf.set(nodeId, targetId);
        }
      } else if (rel === "PREQUEL" && nodeIsSeason && targetIsSeason) {
        if (!sequelOf.has(targetId)) {
          sequelOf.set(targetId, nodeId);
        }
      }
    }
  }

  // Find whether a hit has an ancestor (via PREQUEL / PARENT) in the same search result set.
  const findRootHitAncestor = (startId: number): number | null => {
    const visited = new Set<number>([startId]);
    const queue: number[] = [...(parentsOf.get(startId) ?? [])];
    let bestAncestor: number | null = null;

    while (queue.length > 0 && visited.size <= MAX_ANILIST_HOPS * 2) {
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);

      if (hitById.has(curr)) {
        // Guard against malformed symmetric cycles: only treat `curr` as ancestor
        // if `curr` cannot walk up to `startId` or `curr` appeared earlier.
        const revParents = parentsOf.get(curr);
        const isMutual = revParents?.has(startId) ?? false;
        if (!isMutual || (hitIndexById.get(curr) ?? 0) < (hitIndexById.get(startId) ?? 0)) {
          bestAncestor = curr;
        }
      }

      const nextParents = parentsOf.get(curr);
      if (nextParents) {
        for (const p of nextParents) {
          if (!visited.has(p)) {
            queue.push(p);
          }
        }
      }
    }
    return bestAncestor;
  };

  const droppedIds = new Set<number>();
  const extraTitlesByRoot = new Map<number, string[]>();

  for (const item of rawList) {
    const ancestorId = findRootHitAncestor(item.id);
    if (ancestorId !== null) {
      droppedIds.add(item.id);
      const list = extraTitlesByRoot.get(ancestorId) ?? [];
      const t = pickTitle(item.title);
      if (t && !list.includes(t)) list.push(t);
      for (const alt of pickAlternateTitles(item.title, t ?? "")) {
        if (!list.includes(alt)) list.push(alt);
      }
      extraTitlesByRoot.set(ancestorId, list);
    }
  }

  const computeRootSubtitle = (root: AniListMediaNode & { id: number }, year: number | null): string | null => {
    if (!isSeasonCandidate(root) || isUnreleasedFutureNode(root, currentYear)) {
      return formatSingleHitSubtitle(root, year);
    }

    const chain: Array<AniListMediaNode & { id: number }> = [root];
    const visited = new Set<number>([root.id]);
    let currId = root.id;

    while (chain.length <= MAX_ANILIST_HOPS) {
      const nextId = sequelOf.get(currId);
      if (nextId === undefined || visited.has(nextId)) {
        break;
      }
      const nextNode = knownNodes.get(nextId);
      if (!nextNode || !isSeasonCandidate(nextNode) || !sharesSeriesRoot(root, nextNode) || isUnreleasedFutureNode(nextNode, currentYear)) {
        break;
      }
      const hasEpisodes = typeof nextNode.episodes === "number" && nextNode.episodes > 0;
      const st = typeof nextNode.status === "string" ? nextNode.status.toUpperCase() : "";
      if (!hasEpisodes && st !== "FINISHED" && st !== "RELEASING") {
        // An entry with no episodes and no released status is an unreleased future season
        break;
      }

      visited.add(nextId);
      chain.push(nextNode);
      currId = nextId;
    }

    if (chain.length < 2) {
      return formatSingleHitSubtitle(root, year);
    }

    const parts: string[] = [];
    if (year !== null) {
      parts.push(String(year));
    }
    parts.push(`${chain.length} seasons`);

    const allHaveEpisodes = chain.every(
      (s) => typeof s.episodes === "number" && Number.isFinite(s.episodes) && s.episodes > 0
    );
    if (allHaveEpisodes) {
      const totalEpisodes = chain.reduce((sum, s) => sum + Math.round(s.episodes ?? 0), 0);
      if (totalEpisodes > 0) {
        parts.push(`${totalEpisodes} episodes`);
      }
    }

    return parts.join(" · ");
  };

  const results: RankedCandidate[] = [];

  for (const item of rawList) {
    if (droppedIds.has(item.id)) {
      continue;
    }

    const providerId = String(item.id);
    if (!isValidProviderId(providerId)) continue;

    const title = pickTitle(item.title);
    if (!title) continue;

    const year = pickYear(item);
    const remoteCoverUrl = pickCoverUrl(item);
    const alternateTitles = [
      ...pickAlternateTitles(item.title, title),
      ...(extraTitlesByRoot.get(item.id) ?? []),
    ];

    results.push({
      hit: {
        provider: "anilist",
        provider_id: providerId,
        category: "anime",
        title,
        subtitle: computeRootSubtitle(item, year),
        year,
        cover_url: remoteCoverUrl ? metaCoverUrl("anilist", providerId) : null,
      },
      popularity: typeof item.popularity === "number" ? item.popularity : 0,
      alternateTitles,
      remoteCoverUrl,
    });
  }

  return results;
}

const BRIDGE_FORMATS: ReadonlySet<string> = new Set(["MOVIE", "OVA", "SPECIAL"]);

function isBridgeCandidate(node: AniListMediaNode | null | undefined): node is AniListMediaNode & { id: number } {
  if (!isAnimeNode(node)) {
    return false;
  }
  const format = typeof node.format === "string" ? node.format.toUpperCase() : "";
  return BRIDGE_FORMATS.has(format);
}

function findRelationTarget(
  node: AniListMediaNode,
  relationType: "PREQUEL" | "SEQUEL",
  visited: ReadonlySet<number>,
  currentYear: number
): (AniListMediaNode & { id: number }) | null {
  const edges = node.relations?.edges;
  if (!Array.isArray(edges)) {
    return null;
  }
  for (const edge of edges) {
    if (!edge || edge.relationType !== relationType) continue;
    const target = edge.node;
    if (
      isSeasonCandidate(target) &&
      (!isSeasonCandidate(node) || sharesSeriesRoot(node, target)) &&
      !visited.has(target.id) &&
      (relationType === "PREQUEL" || !isUnreleasedFutureNode(target, currentYear))
    ) {
      return target;
    }
  }
  return null;
}

function findBridgeRelationTarget(
  node: AniListMediaNode,
  relationType: "PREQUEL" | "SEQUEL",
  visited: ReadonlySet<number>,
  currentYear: number
): (AniListMediaNode & { id: number }) | null {
  const edges = node.relations?.edges;
  if (!Array.isArray(edges)) {
    return null;
  }
  for (const edge of edges) {
    if (!edge || edge.relationType !== relationType) continue;
    const target = edge.node;
    if (
      isBridgeCandidate(target) &&
      !visited.has(target.id) &&
      !isUnreleasedFutureNode(target, currentYear)
    ) {
      return target;
    }
  }
  return null;
}

function findParentSeasonTarget(
  node: AniListMediaNode,
  currentYear: number
): (AniListMediaNode & { id: number }) | null {
  const edges = node.relations?.edges;
  if (!Array.isArray(edges)) {
    return null;
  }
  for (const preferredRel of ["PARENT", "MAIN_STORY", "FULL_STORY", "SEQUEL", "PREQUEL"]) {
    for (const edge of edges) {
      if (!edge || edge.relationType !== preferredRel) continue;
      const target = edge.node;
      if (isSeasonCandidate(target) && !isUnreleasedFutureNode(target, currentYear)) {
        return target;
      }
    }
  }
  return null;
}

function toSeasonInfo(
  node: AniListMediaNode,
  seasonNumber: number,
  fallbackEpisodeMinutes: number | null = null
): SeasonInfo {
  const episodes =
    typeof node.episodes === "number" && Number.isFinite(node.episodes) && node.episodes > 0
      ? Math.round(node.episodes)
      : 0;
  const episodeMinutes =
    typeof node.duration === "number" && Number.isFinite(node.duration) && node.duration > 0
      ? Math.round(node.duration)
      : fallbackEpisodeMinutes;
  const totalMinutes =
    episodes > 0 && episodeMinutes !== null ? episodes * episodeMinutes : null;

  return {
    number: seasonNumber,
    title: pickTitle(node.title),
    year: pickYear(node),
    episodes,
    episode_minutes: episodeMinutes,
    total_minutes: totalMinutes,
    provider_id: typeof node.id === "number" ? String(node.id) : null,
  };
}

export async function getAnilistWork(
  id: string,
  ctx: ProviderContext
): Promise<WorkWithCover | null> {
  if (!/^\d+$/.test(id)) {
    return null;
  }
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return null;
  }

  const currentYear = new Date(ctx.now()).getUTCFullYear();
  const nodeCache = new Map<number, AniListMediaNode>();

  const fetchMediaById = async (mediaId: number): Promise<AniListMediaNode | null> => {
    const existing = nodeCache.get(mediaId);
    if (existing) {
      return existing;
    }
    const { status, data } = await graphqlPost<{ Media?: AniListMediaNode | null }>(
      ctx,
      MEDIA_QUERY,
      { id: mediaId }
    );
    if (status === 404 || !data?.Media || typeof data.Media.id !== "number") {
      return null;
    }
    nodeCache.set(data.Media.id, data.Media);
    const cov = pickCoverUrl(data.Media);
    if (cov) {
      writeCoverUrlCache(ctx.config, "anilist", String(data.Media.id), cov);
    }
    return data.Media;
  };

  const initialMedia = await fetchMediaById(numericId);
  if (!initialMedia) {
    return null;
  }

  const format = typeof initialMedia.format === "string" ? initialMedia.format.toUpperCase() : "";
  const isMovie = format === "MOVIE";

  let rootMedia = initialMedia;
  const seasons: SeasonInfo[] = [];

  if (!isMovie) {
    let startMedia = initialMedia;
    if (!isSeasonCandidate(startMedia)) {
      const parentTvStub = findParentSeasonTarget(startMedia, currentYear);
      if (parentTvStub) {
        const fetchedTv = await fetchMediaById(parentTvStub.id);
        startMedia = fetchedTv ? mergeNodeFields(fetchedTv, parentTvStub) : parentTvStub;
        nodeCache.set(startMedia.id!, startMedia);
      }
    }

    // 1. Walk PREQUEL back to the first season (over TV / TV_SHORT / ONA, max 15 hops).
    const visitedBack = new Set<number>([initialMedia.id!, startMedia.id!]);
    let current = startMedia;
    let backHops = 0;

    while (backHops < MAX_ANILIST_HOPS) {
      let prequelStub = findRelationTarget(current, "PREQUEL", visitedBack, currentYear);
      if (!prequelStub && backHops + 1 < MAX_ANILIST_HOPS) {
        const bridgeStub = findBridgeRelationTarget(current, "PREQUEL", visitedBack, currentYear);
        if (bridgeStub) {
          visitedBack.add(bridgeStub.id);
          backHops += 1;
          const fetchedBridge = await fetchMediaById(bridgeStub.id);
          const bridgeNode = fetchedBridge ? mergeNodeFields(fetchedBridge, bridgeStub) : bridgeStub;
          nodeCache.set(bridgeNode.id!, bridgeNode);
          prequelStub = findRelationTarget(bridgeNode, "PREQUEL", visitedBack, currentYear);
        }
      }
      if (!prequelStub) {
        break;
      }
      if (!sharesSeriesRoot(startMedia, prequelStub)) break;
      visitedBack.add(prequelStub.id);
      backHops += 1;

      const fetchedPrequel = await fetchMediaById(prequelStub.id);
      const previousNode = fetchedPrequel ? mergeNodeFields(fetchedPrequel, prequelStub) : prequelStub;
      if (!sharesSeriesRoot(startMedia, previousNode)) break;
      current = previousNode;
      nodeCache.set(current.id!, current);
    }

    rootMedia = current;

    // 2. Walk SEQUEL forward from the first season (over TV / TV_SHORT / ONA, max 15 hops).
    const chainNodes: AniListMediaNode[] = [rootMedia];
    const visitedForward = new Set<number>([rootMedia.id!]);
    let cursor = rootMedia;
    let forwardHops = 0;

    while (forwardHops < MAX_ANILIST_HOPS) {
      let sequelStub = findRelationTarget(cursor, "SEQUEL", visitedForward, currentYear);
      if (!sequelStub && forwardHops + 1 < MAX_ANILIST_HOPS) {
        const bridgeStub = findBridgeRelationTarget(cursor, "SEQUEL", visitedForward, currentYear);
        if (bridgeStub) {
          visitedForward.add(bridgeStub.id);
          forwardHops += 1;
          const fetchedBridge = await fetchMediaById(bridgeStub.id);
          const bridgeNode = fetchedBridge ? mergeNodeFields(fetchedBridge, bridgeStub) : bridgeStub;
          nodeCache.set(bridgeNode.id!, bridgeNode);
          sequelStub = findRelationTarget(bridgeNode, "SEQUEL", visitedForward, currentYear);
        }
      }
      if (!sequelStub) {
        break;
      }
      if (!sharesSeriesRoot(rootMedia, sequelStub)) break;
      visitedForward.add(sequelStub.id);
      forwardHops += 1;

      const fetchedSequel = await fetchMediaById(sequelStub.id);
      const nextNode = fetchedSequel ? mergeNodeFields(fetchedSequel, sequelStub) : sequelStub;
      if (!sharesSeriesRoot(rootMedia, nextNode) || isUnreleasedFutureNode(nextNode, currentYear)) {
        break;
      }
      nodeCache.set(nextNode.id!, nextNode);
      chainNodes.push(nextNode);
      cursor = nextNode;
    }

    const knownDurations = chainNodes
      .map((n) => n.duration)
      .filter((d): d is number => typeof d === "number" && Number.isFinite(d) && d > 0);
    const fallbackEpMin =
      knownDurations.length > 0
        ? Math.round(knownDurations.reduce((a, b) => a + b, 0) / knownDurations.length)
        : null;

    for (let i = 0; i < chainNodes.length; i++) {
      seasons.push(toSeasonInfo(chainNodes[i]!, i + 1, fallbackEpMin));
    }
  }

  const title = pickTitle(rootMedia.title) ?? pickTitle(initialMedia.title) ?? `Anime ${id}`;
  const originalTitle =
    pickOriginalTitle(rootMedia.title, title) ?? pickOriginalTitle(initialMedia.title, title);
  const year = pickYear(rootMedia) ?? pickYear(initialMedia);
  const remoteCoverUrl = pickCoverUrl(initialMedia) ?? pickCoverUrl(rootMedia);
  const remoteBannerUrl = initialMedia.bannerImage ?? rootMedia.bannerImage ?? null;

  const externalIds: Record<string, string> = {
    anilist: String(initialMedia.id ?? numericId),
  };
  const malId = initialMedia.idMal ?? rootMedia.idMal;
  if (typeof malId === "number" && Number.isFinite(malId) && malId > 0) {
    externalIds.mal = String(malId);
  }

  const genresSource = initialMedia.genres ?? rootMedia.genres;
  const genres = Array.isArray(genresSource)
    ? genresSource.filter((g): g is string => typeof g === "string" && g.trim() !== "")
    : [];

  const creators = pickStudios(initialMedia);
  if (creators.length === 0) {
    for (const s of pickStudios(rootMedia)) {
      creators.push(s);
    }
  }

  const runtimeMinutes =
    isMovie && typeof initialMedia.duration === "number" && initialMedia.duration > 0
      ? Math.round(initialMedia.duration)
      : null;

  return {
    work: {
      provider: "anilist",
      provider_id: String(initialMedia.id ?? numericId),
      category: "anime",
      title,
      original_title: originalTitle,
      banner_url: remoteBannerUrl ? metaBannerUrl("anilist", id) : null,
      community_score: normalizeCommunityScore("AniList", initialMedia.averageScore ?? rootMedia.averageScore, 100),
      year,
      cover_url: remoteCoverUrl
        ? metaCoverUrl("anilist", String(initialMedia.id ?? numericId))
        : null,
      creators,
      genres,
      description: cleanDescription(initialMedia.description ?? rootMedia.description),
      seasons,
      runtime_minutes: runtimeMinutes,
      pages: null,
      external_ids: externalIds,
    },
    remoteCoverUrl,
    remoteBannerUrl,
  };
}

export async function fetchAnilistCover(
  id: string,
  ctx: ProviderContext
): Promise<RemoteImageResult | null> {
  if (!/^\d+$/.test(id)) {
    return null;
  }
  const numericId = Number(id);
  const url = ctx.metaConfig.anilist_url;

  try {
    return await timedRequest(
      ctx.fetch,
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query: MEDIA_QUERY,
          variables: { id: numericId },
        }),
      },
      ctx.limiter,
      ctx.timeoutMs,
      async (response) => {
        if (!response.ok) return null;
        const directImage = await readValidatedImageResponse(response);
        if (directImage !== null) {
          return directImage;
        }
        const json = (await response.json()) as {
          data?: { Media?: AniListMediaNode | null } | null;
        };
        const coverUrl = pickCoverUrl(json?.data?.Media);
        if (!coverUrl) return null;
        writeCoverUrlCache(ctx.config, "anilist", id, coverUrl);
        return null;
      }
    );
  } catch {
    return null;
  }
}
