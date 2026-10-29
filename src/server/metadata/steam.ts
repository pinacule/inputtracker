/**
 * Steam Store metadata provider (Games). No key, GET only.
 *
 * - Search: `<steam_url>/api/storesearch/?term=<query>&l=english&cc=US`
 * - Details: `<steam_url>/api/appdetails?appids=<id>&l=english`
 * - Portrait cover / hero art: `<steam_cdn_url>/store_item_assets/steam/apps/<id>/library_600x900_2x.jpg`
 *   and `library_hero.jpg`. Some apps have no portrait capsule; the cover then
 *   falls back to the wide `header_image` from app details.
 */

import { artSource, selectArt } from "./art-types.ts";
import { fetchProviderJson, fetchRemoteCoverImage, type RemoteImageResult } from "./http.ts";
import {
  cleanDescription,
  isValidProviderId,
  metaCoverUrl,
  normalizeCommunityScore,
  parseYear,
  type ProviderContext,
  type RankedCandidate,
  type WorkWithCover,
} from "./types.ts";

interface SteamSearchItem {
  type?: string;
  name?: string | null;
  id?: number;
}

interface SteamSearchResponse {
  total?: number;
  items?: SteamSearchItem[] | null;
}

interface SteamAppData {
  type?: string;
  name?: string | null;
  steam_appid?: number;
  developers?: string[] | null;
  genres?: Array<{ description?: string | null }> | null;
  release_date?: { date?: string | null } | null;
  short_description?: string | null;
  header_image?: string | null;
  metacritic?: { score?: number | null } | null;
  screenshots?: Array<{ path_full?: string | null }> | null;
}

type SteamDetailsResponse = Record<string, { success?: boolean; data?: SteamAppData | null } | undefined>;

const APP_ID_RE = /^\d{1,10}$/;
/** Soundtracks are sold as apps but are never what a game search wants. */
const SOUNDTRACK_RE = /\bsoundtrack\b|\bOST\b/i;

function appAssetUrl(ctx: ProviderContext, id: string, file: string): string {
  return `${ctx.metaConfig.steam_cdn_url}/store_item_assets/steam/apps/${id}/${file}`;
}

export async function searchSteam(query: string, ctx: ProviderContext): Promise<RankedCandidate[]> {
  const url = new URL(`${ctx.metaConfig.steam_url}/api/storesearch/`);
  url.searchParams.set("term", query);
  url.searchParams.set("l", "english");
  url.searchParams.set("cc", "US");

  const { data } = await fetchProviderJson<SteamSearchResponse>(ctx, "steam", url.toString());
  const items = Array.isArray(data?.items) ? data!.items! : [];
  const results: RankedCandidate[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.type !== "app" || typeof item.id !== "number" || item.id <= 0) continue;
    const providerId = String(item.id);
    const title = (item.name ?? "").trim();
    if (!title || !isValidProviderId(providerId) || SOUNDTRACK_RE.test(title)) continue;
    results.push({
      hit: {
        provider: "steam",
        provider_id: providerId,
        category: "game",
        title,
        subtitle: "Steam",
        year: null,
        cover_url: metaCoverUrl("steam", providerId),
      },
      // Preserve Steam's relevance order when tiers tie.
      popularity: Math.max(0, 15 - i),
    });
  }
  return results;
}

async function fetchAppData(id: string, ctx: ProviderContext): Promise<SteamAppData | null> {
  const url = new URL(`${ctx.metaConfig.steam_url}/api/appdetails`);
  url.searchParams.set("appids", id);
  url.searchParams.set("l", "english");
  const { status, data } = await fetchProviderJson<SteamDetailsResponse>(ctx, "steam", url.toString());
  const entry = status === 404 ? undefined : data?.[id];
  return entry?.success === true && entry.data ? entry.data : null;
}

export async function getSteamWork(id: string, ctx: ProviderContext): Promise<WorkWithCover | null> {
  if (!APP_ID_RE.test(id)) return null;
  const app = await fetchAppData(id, ctx);
  const title = (app?.name ?? "").trim();
  if (!app || !title) return null;

  const creators = (app.developers ?? [])
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => d.trim());
  const genres: string[] = [];
  for (const g of app.genres ?? []) {
    const name = typeof g?.description === "string" ? g.description.trim() : "";
    if (name !== "" && !genres.includes(name)) genres.push(name);
  }
  const hero = appAssetUrl(ctx, id, "library_hero.jpg");

  return {
    work: {
      provider: "steam",
      provider_id: id,
      category: "game",
      title,
      original_title: null,
      banner_url: null,
      community_score: normalizeCommunityScore("Metacritic", app.metacritic?.score, 100),
      year: parseYear(app.release_date?.date),
      cover_url: metaCoverUrl("steam", id),
      creators,
      genres,
      description: cleanDescription(app.short_description),
      seasons: [],
      runtime_minutes: null,
      pages: null,
      external_ids: { steam: id },
    },
    // The cover resolves through fetchSteamCover (portrait first, header fallback).
    remoteCoverUrl: null,
    remoteBannerUrl: hero,
    remoteArt: selectArt([
      artSource(hero, "backdrop"),
      ...(app.screenshots ?? []).slice(0, 4).map((s) => artSource(s?.path_full, "backdrop")),
      artSource(app.header_image, "banner"),
    ]),
  };
}

export async function fetchSteamCover(id: string, ctx: ProviderContext): Promise<RemoteImageResult | null> {
  if (!APP_ID_RE.test(id)) return null;
  for (const file of ["library_600x900_2x.jpg", "library_600x900.jpg"]) {
    const image = await fetchRemoteCoverImage(ctx, appAssetUrl(ctx, id, file));
    if (image) return image;
  }
  try {
    const header = (await fetchAppData(id, ctx))?.header_image;
    return typeof header === "string" && header !== "" ? await fetchRemoteCoverImage(ctx, header) : null;
  } catch {
    return null;
  }
}
