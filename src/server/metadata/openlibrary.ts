/**
 * Open Library metadata provider (Books and Audiobooks).
 *
 * Reuses `fetchOpenLibraryCover` from `src/server/openlibrary.ts` where it fits.
 * Queries:
 * - `/search.json` (includes `number_of_pages_median`, `cover_i`, `isbn`, `author_name`)
 * - `/works/:id.json` and best-effort `/works/:id/editions.json` for pages/ISBN
 */

import { fetchOpenLibraryCover } from "../openlibrary.ts";
import { readProviderHint, writeCoverUrlCache, writeProviderHint } from "./cache.ts";
import { artSource, selectArt, type ArtSource } from "./art-types.ts";
import {
  fetchProviderJson,
  readValidatedImageResponse,
  type RemoteImageResult,
  timedRequest,
} from "./http.ts";
import {
  type Category,
  cleanDescription,
  isValidProviderId,
  metaCoverUrl,
  normalizeCommunityScore,
  parseYear,
  type ProviderContext,
  type RankedCandidate,
  type WorkWithCover,
} from "./types.ts";

interface OpenLibrarySearchDoc {
  key?: string | null;
  title?: string | null;
  author_name?: string[] | null;
  first_publish_year?: number | string | null;
  number_of_pages_median?: number | null;
  cover_i?: number | null;
  isbn?: string[] | null;
  edition_count?: number | null;
  subject?: string[] | null;
}

interface OpenLibrarySearchResponse {
  numFound?: number;
  docs?: OpenLibrarySearchDoc[] | null;
}

interface OpenLibraryWorkResponse {
  key?: string | null;
  title?: string | null;
  description?: string | { type?: string; value?: string | null } | null;
  covers?: number[] | null;
  cover_i?: number | null;
  subjects?: string[] | null;
  subject?: string[] | null;
  first_publish_date?: string | number | null;
  first_publish_year?: number | string | null;
  number_of_pages_median?: number | null;
  number_of_pages?: number | null;
  author_name?: string[] | null;
  authors?: Array<{
    name?: string | null;
    author?: { key?: string | null; name?: string | null } | null;
  }> | null;
  isbn?: string[] | null;
  isbn_13?: string[] | null;
  isbn_10?: string[] | null;
}

interface OpenLibraryEditionEntry {
  title?: string | null;
  number_of_pages?: number | null;
  isbn_13?: string[] | null;
  isbn_10?: string[] | null;
  publish_date?: string | null;
  covers?: number[] | null;
  authors?: Array<{ name?: string | null }> | null;
}

interface OpenLibraryEditionsResponse {
  entries?: OpenLibraryEditionEntry[] | null;
  editions?: OpenLibraryEditionEntry[] | null;
}

interface OpenLibraryHint {
  title?: string;
  authors?: string[];
  year?: number | null;
  pages?: number | null;
  coverId?: number | null;
  isbn?: string | null;
  subjects?: string[];
  category?: "book" | "audiobook";
}

export function cleanOpenLibraryId(rawKey: unknown): string | null {
  if (typeof rawKey !== "string") return null;
  const cleaned = rawKey
    .trim()
    .replace(/^\/+(?:works|books|authors)\/+/, "")
    .replace(/\/+$/, "");
  return isValidProviderId(cleaned) ? cleaned : null;
}

function pickFirstIsbn(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  // Prefer 13-digit ISBN when available, else first non-empty string
  for (const item of list) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (/^\d{13}$/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  for (const item of list) {
    if (typeof item === "string" && item.trim() !== "") {
      return item.trim();
    }
  }
  return null;
}

function medianPages(numbers: number[]): number | null {
  const valid = numbers
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  if (valid.length % 2 === 1) {
    return Math.round(valid[mid]!);
  }
  return Math.round((valid[mid - 1]! + valid[mid]!) / 2);
}

function formatSubtitle(
  authors: string[],
  year: number | null,
  pages: number | null,
  category: "book" | "audiobook"
): string | null {
  const parts: string[] = [];
  if (authors[0]) {
    parts.push(authors[0]);
  }
  if (year !== null) {
    parts.push(String(year));
  }
  if (category === "book" && pages !== null && pages > 0) {
    parts.push(`${pages} pages`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export async function searchOpenLibraryMeta(
  query: string,
  targetCategory: "book" | "audiobook",
  ctx: ProviderContext
): Promise<RankedCandidate[]> {
  const url = new URL(`${ctx.metaConfig.openlibrary_url}/search.json`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "10");
  url.searchParams.set(
    "fields",
    "key,title,author_name,first_publish_year,number_of_pages_median,cover_i,isbn,edition_count,subject"
  );

  const { data } = await fetchProviderJson<OpenLibrarySearchResponse>(
    ctx,
    "openlibrary",
    url.toString()
  );

  const docs = Array.isArray(data?.docs) ? data!.docs! : [];
  const results: RankedCandidate[] = [];

  for (const doc of docs) {
    if (!doc) continue;
    const providerId = cleanOpenLibraryId(doc.key);
    if (!providerId) continue;

    const title = typeof doc.title === "string" ? doc.title.trim() : "";
    if (!title) continue;

    const authors = Array.isArray(doc.author_name)
      ? doc.author_name
          .filter((a): a is string => typeof a === "string" && a.trim() !== "")
          .map((a) => a.trim())
      : [];
    const year = parseYear(doc.first_publish_year);
    const pages =
      typeof doc.number_of_pages_median === "number" &&
      Number.isFinite(doc.number_of_pages_median) &&
      doc.number_of_pages_median > 0
        ? Math.round(doc.number_of_pages_median)
        : null;
    const coverId =
      typeof doc.cover_i === "number" && Number.isFinite(doc.cover_i) && doc.cover_i > 0
        ? Math.round(doc.cover_i)
        : null;
    const isbn = pickFirstIsbn(doc.isbn);
    const subjects = Array.isArray(doc.subject)
      ? doc.subject
          .filter((s): s is string => typeof s === "string" && s.trim() !== "")
          .slice(0, 8)
      : [];

    const remoteCoverUrl =
      coverId !== null
        ? `${ctx.metaConfig.openlibrary_covers_url}/b/id/${coverId}-M.jpg`
        : null;

    writeProviderHint<OpenLibraryHint>(ctx.config, "openlibrary", providerId, {
      title,
      authors,
      year,
      pages,
      coverId,
      isbn,
      subjects,
      category: targetCategory,
    });
    if (remoteCoverUrl) {
      writeCoverUrlCache(ctx.config, "openlibrary", providerId, remoteCoverUrl);
    }

    const popularity =
      typeof doc.edition_count === "number" && Number.isFinite(doc.edition_count)
        ? doc.edition_count
        : 0;

    results.push({
      hit: {
        provider: "openlibrary",
        provider_id: providerId,
        category: targetCategory,
        title,
        subtitle: formatSubtitle(authors, year, pages, targetCategory),
        year,
        cover_url: remoteCoverUrl ? metaCoverUrl("openlibrary", providerId) : null,
      },
      popularity,
      remoteCoverUrl,
    });
  }

  return results;
}

function extractDescription(
  desc: string | { type?: string; value?: string | null } | null | undefined
): string | null {
  if (typeof desc === "string") {
    return cleanDescription(desc);
  }
  if (desc && typeof desc === "object" && typeof desc.value === "string") {
    return cleanDescription(desc.value);
  }
  return null;
}

export async function getOpenLibraryWork(
  id: string,
  ctx: ProviderContext,
  categoryOverride?: Category
): Promise<WorkWithCover | null> {
  if (!isValidProviderId(id)) {
    return null;
  }

  const hint = readProviderHint<OpenLibraryHint>(ctx.config, "openlibrary", id);
  const base = ctx.metaConfig.openlibrary_url;
  const workUrl = `${base}/works/${id}.json`;

  const { status, data } = await fetchProviderJson<OpenLibraryWorkResponse>(
    ctx,
    "openlibrary",
    workUrl
  );

  if (status === 404 || !data || typeof data !== "object") {
    return null;
  }

  const title =
    (typeof data.title === "string" && data.title.trim() !== ""
      ? data.title.trim()
      : hint?.title) ?? "";
  if (!title) {
    return null;
  }

  // Creators (authors)
  const creators: string[] = [];
  const addCreator = (name: unknown) => {
    if (typeof name === "string") {
      const trimmed = name.trim();
      if (trimmed !== "" && !creators.includes(trimmed)) {
        creators.push(trimmed);
      }
    }
  };

  if (Array.isArray(data.author_name)) {
    for (const a of data.author_name) addCreator(a);
  }
  if (Array.isArray(data.authors)) {
    for (const entry of data.authors) {
      addCreator(entry?.name ?? entry?.author?.name);
    }
  }
  if (creators.length === 0 && Array.isArray(hint?.authors)) {
    for (const a of hint!.authors!) addCreator(a);
  }

  // Best-effort author lookup if `/works/:id.json` only had `/authors/OL...A` keys
  if (creators.length === 0 && Array.isArray(data.authors)) {
    const firstKey = data.authors[0]?.author?.key;
    const authorId = cleanOpenLibraryId(firstKey);
    if (authorId) {
      try {
        const authorRes = await fetchProviderJson<{ name?: string }>(
          ctx,
          "openlibrary",
          `${base}/authors/${authorId}.json`
        );
        addCreator(authorRes.data?.name);
      } catch {
        // Best-effort only
      }
    }
  }

  // Pages
  let pages: number | null = null;
  const rawPages = data.number_of_pages_median ?? data.number_of_pages ?? hint?.pages;
  if (typeof rawPages === "number" && Number.isFinite(rawPages) && rawPages > 0) {
    pages = Math.round(rawPages);
  }

  // ISBN
  let isbn: string | null =
    pickFirstIsbn(data.isbn) ??
    pickFirstIsbn(data.isbn_13) ??
    pickFirstIsbn(data.isbn_10) ??
    hint?.isbn ??
    null;

  // Cover ID
  let coverId: number | null = null;
  if (typeof data.cover_i === "number" && data.cover_i > 0) {
    coverId = Math.round(data.cover_i);
  } else if (Array.isArray(data.covers)) {
    const validCover = data.covers.find((c) => typeof c === "number" && c > 0);
    if (validCover !== undefined) {
      coverId = Math.round(validCover);
    }
  }
  if (coverId === null && typeof hint?.coverId === "number" && hint.coverId > 0) {
    coverId = hint.coverId;
  }

  let year =
    parseYear(data.first_publish_year) ??
    parseYear(data.first_publish_date) ??
    hint?.year ??
    null;

  // Best-effort `/works/:id/editions.json` when pages or isbn are missing
  let editionArt: ArtSource[] | undefined;
  if (pages === null || isbn === null) {
    try {
      const edRes = await fetchProviderJson<OpenLibraryEditionsResponse>(
        ctx,
        "openlibrary",
        `${base}/works/${id}/editions.json?limit=10`
      );
      const entries = Array.isArray(edRes.data?.entries)
        ? edRes.data!.entries!
        : Array.isArray(edRes.data?.editions)
          ? edRes.data!.editions!
          : [];
      editionArt = openLibraryEditionArt(entries, ctx, data.covers);
      if (entries.length > 0) {
        if (pages === null) {
          pages = medianPages(
            entries
              .map((e) => e?.number_of_pages)
              .filter((n): n is number => typeof n === "number")
          );
        }
        if (isbn === null) {
          for (const e of entries) {
            isbn = pickFirstIsbn(e?.isbn_13) ?? pickFirstIsbn(e?.isbn_10);
            if (isbn) break;
          }
        }
        if (coverId === null) {
          for (const e of entries) {
            const c = e?.covers?.find((x) => typeof x === "number" && x > 0);
            if (c !== undefined) {
              coverId = Math.round(c);
              break;
            }
          }
        }
        if (year === null) {
          for (const e of entries) {
            year = parseYear(e?.publish_date);
            if (year !== null) break;
          }
        }
      }
    } catch {
      // Editions fallback is optional; never fail the work lookup if unavailable.
    }
  }

  const rawGenres = data.subjects ?? data.subject ?? hint?.subjects ?? [];
  const genres = Array.isArray(rawGenres)
    ? rawGenres
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .map((s) => s.trim())
        .slice(0, 8)
    : [];

  const category: Category =
    categoryOverride === "audiobook" || (categoryOverride === undefined && hint?.category === "audiobook")
      ? "audiobook"
      : "book";

  const remoteCoverUrl =
    coverId !== null
      ? `${ctx.metaConfig.openlibrary_covers_url}/b/id/${coverId}-M.jpg`
      : null;

  const externalIds: Record<string, string> = {
    openlibrary: id,
  };
  if (isbn) {
    externalIds.isbn = isbn;
  }

  let communityScore = null;
  try {
    const ratings = await fetchProviderJson<{ summary?: { average?: number; count?: number } }>(
      ctx, "openlibrary", `${base}/works/${id}/ratings.json`
    );
    communityScore = normalizeCommunityScore("Open Library", ratings.data?.summary?.average, 5, ratings.data?.summary?.count);
  } catch {
    // Ratings are optional; an unavailable score must not block book metadata.
  }

  return {
    work: {
      provider: "openlibrary",
      provider_id: id,
      category,
      title,
      original_title: null,
      banner_url: null,
      community_score: communityScore,
      year,
      cover_url: remoteCoverUrl ? metaCoverUrl("openlibrary", id) : null,
      creators,
      genres,
      description: extractDescription(data.description),
      seasons: [],
      runtime_minutes: null,
      pages,
      external_ids: externalIds,
    },
    remoteCoverUrl,
    remoteArt: editionArt,
  };
}

function openLibraryEditionArt(entries: OpenLibraryEditionEntry[], ctx: ProviderContext, covers?: number[] | null): ArtSource[] {
  const ids: unknown[] = [...(Array.isArray(covers) ? covers : []), ...entries.flatMap((entry) => Array.isArray(entry?.covers) ? entry.covers : [])];
  return selectArt(ids.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
    .map((id) => artSource(`${ctx.metaConfig.openlibrary_covers_url}/b/id/${id}-L.jpg?default=false`, "cover")));
}

export async function getOpenLibraryArt(id: string, ctx: ProviderContext): Promise<ArtSource[]> {
  if (!/^OL\d+W$/.test(id)) return [];
  const { data } = await fetchProviderJson<OpenLibraryEditionsResponse>(ctx, "openlibrary", `${ctx.metaConfig.openlibrary_url}/works/${id}/editions.json?limit=50`);
  const entries = Array.isArray(data?.entries) ? data.entries : Array.isArray(data?.editions) ? data.editions : [];
  return openLibraryEditionArt(entries, ctx);
}

export async function fetchOpenLibraryMetaCover(
  id: string,
  ctx: ProviderContext
): Promise<RemoteImageResult | null> {
  // If id is already a numeric cover_i, use fetchOpenLibraryCover directly.
  if (/^\d+$/.test(id)) {
    const coverId = Number(id);
    if (Number.isSafeInteger(coverId) && coverId > 0) {
      try {
        return await fetchOpenLibraryCover(coverId, {
          fetch: ctx.fetch,
          coversBaseUrl: ctx.metaConfig.openlibrary_covers_url,
          limiter: ctx.limiter,
          timeoutMs: ctx.timeoutMs,
        });
      } catch {
        return null;
      }
    }
  }

  const hint = readProviderHint<OpenLibraryHint>(ctx.config, "openlibrary", id);
  if (typeof hint?.coverId === "number" && hint.coverId > 0) {
    try {
      return await fetchOpenLibraryCover(hint.coverId, {
        fetch: ctx.fetch,
        coversBaseUrl: ctx.metaConfig.openlibrary_covers_url,
        limiter: ctx.limiter,
        timeoutMs: ctx.timeoutMs,
      });
    } catch {
      return null;
    }
  }

  // Otherwise inspect `/works/:id.json` to discover `covers[0]` (or accept direct image response in mocks)
  const workUrl = `${ctx.metaConfig.openlibrary_url}/works/${id}.json`;
  let discoveredCoverId: number | null = null;
  try {
    const direct = await timedRequest(
      ctx.fetch,
      workUrl,
      { method: "GET" },
      ctx.limiter,
      ctx.timeoutMs,
      async (response) => {
        if (!response.ok) return null;
        const directImage = await readValidatedImageResponse(response);
        if (directImage !== null) {
          return directImage;
        }
        const json = (await response.json()) as OpenLibraryWorkResponse;
        const cid =
          typeof json?.cover_i === "number" && json.cover_i > 0
            ? json.cover_i
            : Array.isArray(json?.covers)
              ? json.covers.find((c) => typeof c === "number" && c > 0) ?? null
              : null;
        if (cid !== null) {
          discoveredCoverId = Math.round(cid);
        }
        return null;
      }
    );
    if (direct !== null) {
      return direct;
    }
  } catch {
    return null;
  }

  if (discoveredCoverId !== null) {
    try {
      return await fetchOpenLibraryCover(discoveredCoverId, {
        fetch: ctx.fetch,
        coversBaseUrl: ctx.metaConfig.openlibrary_covers_url,
        limiter: ctx.limiter,
        timeoutMs: ctx.timeoutMs,
      });
    } catch {
      return null;
    }
  }

  return null;
}
