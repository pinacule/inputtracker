/**
 * YouTube video enrichment (v2.1 section 10).
 *
 * Strictly GET requests only:
 * 1. YouTube oEmbed (`/oembed?url=https://www.youtube.com/watch?v=<id>&format=json`)
 *    for `author_name` (channel), `author_url`, `thumbnail_url`, `title`.
 * 2. YouTube watch page (`/watch?v=<id>`) for `<meta itemprop="genre" content="...">`
 *    (YouTube's category, e.g. "Science & Technology", used as the default topic).
 *
 * Results are cached permanently in the append-only `youtube_videos` table
 * (read via `youtube_videos_latest`). Failures are cached with a `retry_after`
 * timestamp. Runs during ActivityWatch/YouTube sync (capped by
 * `youtube.enrich_per_sync`, default 50) and via `it youtube enrich [--limit N]`;
 * never during API reads.
 */

import type { Database } from "bun:sqlite";
import type { Config } from "../../core/config.ts";
import type {
  YoutubeEnrichmentStatus,
  YoutubeVideoRow,
} from "../../core/schema.ts";
import { getLatestConsumptionEvents, parseExternalIds } from "../../server/aggregate.ts";
import {
  Limiter,
  METADATA_TIMEOUT_MS,
  timedRequest,
} from "../../server/metadata/http.ts";
import { isValidYoutubeVideoId } from "../../server/thumbs.ts";
import { filterShortYoutubeEvents } from "../../server/youtube-filter.ts";

export const DEFAULT_YOUTUBE_BASE_URL = "https://www.youtube.com";
export const DEFAULT_ENRICH_PER_SYNC = 50;
export const DEFAULT_ENRICH_DELAY_MS = 50;

/** Cooldown for 404 / deleted / private videos: 7 days. */
export const NOT_FOUND_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Default cooldown for 429 Too Many Requests when no Retry-After header is given: 6 hours. */
export const RATE_LIMIT_RETRY_MS = 6 * 60 * 60 * 1000;
/** Cooldown for 5xx / timeout / network errors: 1 hour. */
export const SERVER_ERROR_RETRY_MS = 60 * 60 * 1000;

export const defaultYoutubeEnrichLimiter = new Limiter(2);

export interface ParsedOembed {
  title: string | null;
  channel: string | null;
  channel_url: string | null;
  channel_id: string | null;
  thumbnail_url: string | null;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode standard HTML entities in `<meta content="...">` values. */
export function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (full, dec?: string, hex?: string, named?: string) => {
      if (dec !== undefined) {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
      }
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
      }
      if (named !== undefined) {
        const lower = named.toLowerCase();
        if (lower in NAMED_ENTITIES) {
          return NAMED_ENTITIES[lower]!;
        }
      }
      return full;
    }
  );
}

function extractChannelIdFromUrl(urlStr: string | null): string | null {
  if (!urlStr) {
    return null;
  }
  const channelMatch = /\/channel\/([A-Za-z0-9_-]+)/.exec(urlStr);
  if (channelMatch && channelMatch[1]) {
    return channelMatch[1];
  }
  const handleMatch = /\/@([A-Za-z0-9_.-]+)/.exec(urlStr);
  if (handleMatch && handleMatch[1]) {
    return `@${handleMatch[1]}`;
  }
  return null;
}

function nonEmptyString(val: unknown): string | null {
  if (typeof val !== "string") {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a YouTube oEmbed JSON payload, handling missing or non-string fields gracefully.
 */
export function parseOembedPayload(data: unknown): ParsedOembed {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      title: null,
      channel: null,
      channel_url: null,
      channel_id: null,
      thumbnail_url: null,
    };
  }
  const rec = data as Record<string, unknown>;
  const title = nonEmptyString(rec.title);
  const channel = nonEmptyString(rec.author_name);
  const channel_url = nonEmptyString(rec.author_url);
  const channel_id = extractChannelIdFromUrl(channel_url);
  const rawThumb = nonEmptyString(rec.thumbnail_url);
  let thumbnail_url: string | null = null;
  if (rawThumb) {
    try {
      const u = new URL(rawThumb);
      if (u.protocol === "https:" || u.protocol === "http:") {
        thumbnail_url = rawThumb;
      }
    } catch {
      thumbnail_url = null;
    }
  }

  return {
    title,
    channel,
    channel_url,
    channel_id,
    thumbnail_url,
  };
}

/**
 * Extract `<meta itemprop="genre" content="...">` from a YouTube watch page HTML.
 * Supports arbitrary attribute order, single or double quotes, and HTML entities.
 */
export function parseWatchPageGenre(html: string): string | null {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }

  const metaTagRe = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaTagRe.exec(html)) !== null) {
    const tag = match[0];
    if (!/\bitemprop\s*=\s*(?:"genre"|'genre'|genre(?=[>\s/]))/i.test(tag)) {
      continue;
    }
    const contentMatch =
      /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'/]+))/i.exec(tag);
    if (!contentMatch) {
      continue;
    }
    const rawContent =
      contentMatch[1] ?? contentMatch[2] ?? contentMatch[3] ?? "";
    const decoded = decodeHtmlEntities(rawContent).trim();
    if (decoded.length > 0) {
      return decoded;
    }
  }

  return null;
}

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into a
 * positive delay in milliseconds, falling back to `fallbackMs`.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number,
  fallbackMs: number
): number {
  if (typeof header === "string" && header.trim() !== "") {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number.parseInt(trimmed, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    } else {
      const dateMs = Date.parse(trimmed);
      if (!Number.isNaN(dateMs) && dateMs > nowMs) {
        return dateMs - nowMs;
      }
    }
  }
  return fallbackMs;
}

export interface NewYoutubeVideoEnrichment {
  video_id: string;
  title: string | null;
  channel: string | null;
  channel_url: string | null;
  channel_id: string | null;
  thumbnail_url: string | null;
  genre: string | null;
  status: YoutubeEnrichmentStatus;
  http_status: number | null;
  retry_after: string | null;
  fetched_at: string;
}

/** Insert one enrichment revision into the append-only `youtube_videos` table. */
export function insertYoutubeVideoEnrichment(
  db: Database,
  row: NewYoutubeVideoEnrichment
): void {
  db.run(
    `INSERT INTO youtube_videos (
      video_id,
      title,
      channel,
      channel_url,
      channel_id,
      thumbnail_url,
      genre,
      status,
      http_status,
      retry_after,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      row.video_id,
      row.title,
      row.channel,
      row.channel_url,
      row.channel_id,
      row.thumbnail_url,
      row.genre,
      row.status,
      row.http_status,
      row.retry_after,
      row.fetched_at,
    ]
  );
}

/** Read all latest enrichment rows keyed by `video_id`. */
export function getYoutubeVideoEnrichmentMap(
  db: Database
): Map<string, YoutubeVideoRow> {
  const rows = db
    .query<YoutubeVideoRow, []>("SELECT * FROM youtube_videos_latest;")
    .all();
  const map = new Map<string, YoutubeVideoRow>();
  for (const row of rows) {
    map.set(row.video_id, row);
  }
  return map;
}

export interface FetchVideoEnrichmentOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  limiter?: Limiter;
  timeoutMs?: number;
  nowMs?: () => number;
  previous?: YoutubeVideoRow | null;
}

/**
 * Perform the GET-only oEmbed and watch page requests for one `videoId` and
 * build the `NewYoutubeVideoEnrichment` record to append. Never throws.
 */
export async function fetchVideoEnrichment(
  videoId: string,
  opts: FetchVideoEnrichmentOptions = {}
): Promise<NewYoutubeVideoEnrichment> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_YOUTUBE_BASE_URL).replace(/\/+$/, "");
  const limiter = opts.limiter ?? defaultYoutubeEnrichLimiter;
  const timeoutMs = opts.timeoutMs ?? METADATA_TIMEOUT_MS;
  const nowMs = opts.nowMs ? opts.nowMs() : Date.now();
  const fetchedAt = new Date(nowMs).toISOString();
  const prev = opts.previous ?? null;

  const watchTargetUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `${baseUrl}/oembed?url=${encodeURIComponent(watchTargetUrl)}&format=json`;
  const watchUrl = `${baseUrl}/watch?v=${encodeURIComponent(videoId)}`;

  let parsedOembed: ParsedOembed = {
    title: prev?.title ?? null,
    channel: prev?.channel ?? null,
    channel_url: prev?.channel_url ?? null,
    channel_id: prev?.channel_id ?? null,
    thumbnail_url: prev?.thumbnail_url ?? null,
  };

  // --- Step 1: GET oEmbed ---
  try {
    const oembedOutcome = await timedRequest(
      fetchFn,
      oembedUrl,
      { method: "GET" },
      limiter,
      timeoutMs,
      async (response) => {
        const status = response.status;
        const retryHeader = response.headers.get("retry-after");
        if (!response.ok) {
          return { ok: false as const, status, retryHeader, data: null };
        }
        const data: unknown = await response.json();
        return { ok: true as const, status, retryHeader: null, data };
      }
    );

    if (!oembedOutcome.ok) {
      const httpStatus = oembedOutcome.status;
      if (httpStatus === 404) {
        return {
          video_id: videoId,
          ...parsedOembed,
          genre: prev?.genre ?? null,
          status: "not_found",
          http_status: 404,
          retry_after: new Date(nowMs + NOT_FOUND_RETRY_MS).toISOString(),
          fetched_at: fetchedAt,
        };
      }
      const cooldown =
        httpStatus === 429
          ? parseRetryAfterMs(oembedOutcome.retryHeader, nowMs, RATE_LIMIT_RETRY_MS)
          : SERVER_ERROR_RETRY_MS;
      return {
        video_id: videoId,
        ...parsedOembed,
        genre: prev?.genre ?? null,
        status: "failed",
        http_status: httpStatus,
        retry_after: new Date(nowMs + cooldown).toISOString(),
        fetched_at: fetchedAt,
      };
    }

    const fromOembed = parseOembedPayload(oembedOutcome.data);
    parsedOembed = {
      title: fromOembed.title ?? parsedOembed.title,
      channel: fromOembed.channel ?? parsedOembed.channel,
      channel_url: fromOembed.channel_url ?? parsedOembed.channel_url,
      channel_id: fromOembed.channel_id ?? parsedOembed.channel_id,
      thumbnail_url: fromOembed.thumbnail_url ?? parsedOembed.thumbnail_url,
    };
  } catch {
    return {
      video_id: videoId,
      ...parsedOembed,
      genre: prev?.genre ?? null,
      status: "failed",
      http_status: null,
      retry_after: new Date(nowMs + SERVER_ERROR_RETRY_MS).toISOString(),
      fetched_at: fetchedAt,
    };
  }

  // --- Step 2: GET watch page for itemprop="genre" ---
  try {
    const watchOutcome = await timedRequest(
      fetchFn,
      watchUrl,
      { method: "GET" },
      limiter,
      timeoutMs,
      async (response) => {
        const status = response.status;
        const retryHeader = response.headers.get("retry-after");
        if (!response.ok) {
          return { ok: false as const, status, retryHeader, html: "" };
        }
        const html = await response.text();
        return { ok: true as const, status, retryHeader: null, html };
      }
    );

    if (!watchOutcome.ok) {
      const httpStatus = watchOutcome.status;
      if (httpStatus === 404) {
        return {
          video_id: videoId,
          ...parsedOembed,
          genre: prev?.genre ?? null,
          status: "not_found",
          http_status: 404,
          retry_after: new Date(nowMs + NOT_FOUND_RETRY_MS).toISOString(),
          fetched_at: fetchedAt,
        };
      }
      const cooldown =
        httpStatus === 429
          ? parseRetryAfterMs(watchOutcome.retryHeader, nowMs, RATE_LIMIT_RETRY_MS)
          : SERVER_ERROR_RETRY_MS;
      return {
        video_id: videoId,
        ...parsedOembed,
        genre: prev?.genre ?? null,
        status: "failed",
        http_status: httpStatus,
        retry_after: new Date(nowMs + cooldown).toISOString(),
        fetched_at: fetchedAt,
      };
    }

    const genre = parseWatchPageGenre(watchOutcome.html) ?? prev?.genre ?? null;
    return {
      video_id: videoId,
      ...parsedOembed,
      genre,
      status: "ok",
      http_status: 200,
      retry_after: null,
      fetched_at: fetchedAt,
    };
  } catch {
    return {
      video_id: videoId,
      ...parsedOembed,
      genre: prev?.genre ?? null,
      status: "failed",
      http_status: null,
      retry_after: new Date(nowMs + SERVER_ERROR_RETRY_MS).toISOString(),
      fetched_at: fetchedAt,
    };
  }
}

/**
 * Find up to `limit` distinct YouTube video IDs from `events_latest` (excluding
 * short video-days below `minWatchMinutes`) that need enrichment at `nowIso`.
 * Videos without a channel (`parent_title` missing) come first, newest first.
 */
export function findVideosToEnrich(
  db: Database,
  nowIso: string,
  limit: number,
  tz: string = "Europe/Bratislava",
  minWatchMinutes?: number
): string[] {
  if (limit <= 0) {
    return [];
  }

  const rawEvents = getLatestConsumptionEvents(db, "youtube");
  const visibleEvents = filterShortYoutubeEvents(
    rawEvents,
    tz,
    db,
    minWatchMinutes
  );

  const existingMap = getYoutubeVideoEnrichmentMap(db);

  // Track per video_id: whether any event already has a channel, and latest started_at.
  const candidates = new Map<
    string,
    { videoId: string; hasChannel: boolean; latestAt: string }
  >();

  for (const ev of visibleEvents) {
    if (ev.media_type !== "video") {
      continue;
    }
    const ext = parseExternalIds(ev.external_ids);
    const vid = ext?.["youtube_video"];
    if (!isValidYoutubeVideoId(vid)) {
      continue;
    }

    const cached = existingMap.get(vid);
    if (cached) {
      if (cached.status === "ok") {
        continue;
      }
      if (cached.retry_after !== null && cached.retry_after > nowIso) {
        continue;
      }
    }

    const evHasChannel = Boolean(ev.parent_title && ev.parent_title.trim() !== "");
    const existing = candidates.get(vid);
    if (!existing) {
      candidates.set(vid, {
        videoId: vid,
        hasChannel: evHasChannel,
        latestAt: ev.started_at,
      });
    } else {
      if (evHasChannel) {
        existing.hasChannel = true;
      }
      if (ev.started_at > existing.latestAt) {
        existing.latestAt = ev.started_at;
      }
    }
  }

  return Array.from(candidates.values())
    .sort((a, b) => {
      if (a.hasChannel !== b.hasChannel) {
        return a.hasChannel ? 1 : -1; // Missing channel first (ActivityWatch plays)
      }
      const byTime = b.latestAt.localeCompare(a.latestAt);
      if (byTime !== 0) {
        return byTime;
      }
      return a.videoId.localeCompare(b.videoId);
    })
    .slice(0, limit)
    .map((c) => c.videoId);
}

export interface EnrichYoutubeVideosOptions {
  config?: Config;
  limit?: number;
  delayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  limiter?: Limiter;
  timeoutMs?: number;
}

export interface EnrichYoutubeVideosResult {
  attempted: number;
  enriched: number;
  failed: number;
  notFound: number;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enrich up to `limit` unenriched YouTube videos in `db`, sleeping `delayMs`
 * between videos. Never throws; caches results and failures in `youtube_videos`.
 */
export async function enrichYoutubeVideos(
  db: Database,
  opts: EnrichYoutubeVideosOptions = {}
): Promise<EnrichYoutubeVideosResult> {
  const tz = opts.config?.timezone ?? "Europe/Bratislava";
  const minWatchMinutes = opts.config?.youtube?.min_watch_minutes ?? 5;
  const limit =
    opts.limit ?? opts.config?.youtube?.enrich_per_sync ?? DEFAULT_ENRICH_PER_SYNC;
  const delayMs = opts.delayMs ?? DEFAULT_ENRICH_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const nowMsFn = opts.nowMs ?? Date.now;
  const baseUrl = opts.config?.youtube?.base_url ?? DEFAULT_YOUTUBE_BASE_URL;

  if (limit <= 0) {
    return { attempted: 0, enriched: 0, failed: 0, notFound: 0 };
  }

  let videoIds: string[];
  let existingMap: Map<string, YoutubeVideoRow>;
  try {
    const nowIso = new Date(nowMsFn()).toISOString();
    videoIds = findVideosToEnrich(db, nowIso, limit, tz, minWatchMinutes);
    existingMap = getYoutubeVideoEnrichmentMap(db);
  } catch {
    return { attempted: 0, enriched: 0, failed: 0, notFound: 0 };
  }

  let attempted = 0;
  let enriched = 0;
  let failed = 0;
  let notFound = 0;

  for (let i = 0; i < videoIds.length; i++) {
    if (i > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    const videoId = videoIds[i]!;
    attempted += 1;

    const record = await fetchVideoEnrichment(videoId, {
      fetch: opts.fetch,
      baseUrl,
      limiter: opts.limiter,
      timeoutMs: opts.timeoutMs,
      nowMs: nowMsFn,
      previous: existingMap.get(videoId) ?? null,
    });

    try {
      insertYoutubeVideoEnrichment(db, record);
    } catch {
      // Best-effort cache write
    }

    if (record.status === "ok") {
      enriched += 1;
    } else if (record.status === "not_found") {
      notFound += 1;
    } else {
      failed += 1;
    }
  }

  return { attempted, enriched, failed, notFound };
}
