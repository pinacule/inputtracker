/**
 * Audiobookshelf data mapping functions (pure, no network, no DB).
 *
 * Maps Audiobookshelf sessions, user media progress, and listening stats
 * to canonical NewEvent objects. All functions are pure and never mutate inputs.
 */

import type { MediaType, NewEvent } from "../../core/events.ts";
import { toUtcIso } from "../../core/time.ts";

export interface AbsDeviceInfo {
  id?: string;
  userId?: string;
  deviceId?: string;
  ipAddress?: string | null;
  browserName?: string | null;
  browserVersion?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  clientVersion?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  sdkVersion?: string | null;
  clientName?: string | null;
  deviceName?: string | null;
  [key: string]: unknown;
}

export interface AbsSession {
  id: string;
  userId?: string;
  libraryId?: string;
  libraryItemId: string;
  bookId?: string;
  episodeId?: string | null;
  mediaType?: string | null;
  mediaMetadata?: Record<string, unknown> | null;
  chapters?: unknown[];
  displayTitle?: string | null;
  displayAuthor?: string | null;
  coverPath?: string | null;
  duration?: number | null;
  playMethod?: number | null;
  mediaPlayer?: string | null;
  deviceInfo?: AbsDeviceInfo | null;
  serverVersion?: string | null;
  date?: string | null;
  dayOfWeek?: string | null;
  timeListening: number;
  startTime?: number | null;
  currentTime?: number | null;
  startedAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface AbsSessionsEnvelope {
  total?: number;
  numPages?: number;
  page?: number;
  itemsPerPage?: number;
  sessions: AbsSession[];
  [key: string]: unknown;
}

export interface AbsMediaProgress {
  id: string;
  userId?: string;
  libraryItemId: string;
  episodeId?: string | null;
  mediaItemId?: string;
  mediaItemType: string;
  duration?: number | null;
  progress: number;
  currentTime?: number | null;
  isFinished?: boolean;
  hideFromContinueListening?: boolean;
  ebookLocation?: string | null;
  ebookProgress?: number | null;
  lastUpdate: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  [key: string]: unknown;
}

export interface AbsMeResponse {
  id?: string;
  username?: string;
  email?: string;
  type?: string;
  mediaProgress?: AbsMediaProgress[];
  [key: string]: unknown;
}

export interface AbsListeningStatsItem {
  id?: string;
  mediaMetadata?: {
    title?: string | null;
    [key: string]: unknown;
  } | null;
  timeListening?: number;
  [key: string]: unknown;
}

export interface AbsListeningStats {
  totalTime?: number;
  items?: Record<string, AbsListeningStatsItem>;
  days?: Record<string, number>;
  dayOfWeek?: Record<string, number>;
  today?: number;
  recentSessions?: AbsSession[];
  [key: string]: unknown;
}

export interface MapAllInput {
  sessions?: AbsSession[] | null;
  me?: AbsMeResponse | null;
  stats?: AbsListeningStats | null;
}

/**
 * Deeply clone an object/array while removing any property named `ipAddress`.
 * Never mutates the input argument.
 */
export function removeIpAddress<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => removeIpAddress(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "ipAddress") {
      continue;
    }
    result[key] = removeIpAddress(val);
  }
  return result as T;
}

function resolveDevice(deviceInfo?: AbsDeviceInfo | null): string | null {
  if (!deviceInfo) {
    return null;
  }

  if (typeof deviceInfo.deviceName === "string" && deviceInfo.deviceName.trim().length > 0) {
    return deviceInfo.deviceName.trim();
  }

  const clientName =
    typeof deviceInfo.clientName === "string" ? deviceInfo.clientName.trim() : "";
  const osName =
    typeof deviceInfo.osName === "string" ? deviceInfo.osName.trim() : "";
  const combined = `${clientName} ${osName}`.trim();
  return combined.length > 0 ? combined : null;
}

function computeSessionProgress(currentTime: unknown, duration: unknown): number | null {
  if (
    typeof currentTime !== "number" ||
    !Number.isFinite(currentTime) ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return null;
  }

  const ratio = currentTime / duration;
  if (!Number.isFinite(ratio)) {
    return null;
  }

  return Math.max(0, Math.min(1, ratio));
}

function resolveSessionMediaType(mediaType?: string | null): MediaType {
  if (mediaType === "book") {
    return "audiobook";
  }
  if (mediaType === "podcast") {
    return "podcast_episode";
  }
  return "other";
}

function resolveProgressMediaType(mediaItemType?: string | null): MediaType {
  if (mediaItemType === "book") {
    return "audiobook";
  }
  if (mediaItemType === "podcastEpisode" || mediaItemType === "podcast") {
    return "podcast_episode";
  }
  return "other";
}

/**
 * Maps a single Audiobookshelf session object to a NewEvent.
 */
export function mapSession(s: AbsSession): NewEvent {
  const external_ids: Record<string, unknown> = {
    abs_item: s.libraryItemId,
  };
  if (s.episodeId !== null && s.episodeId !== undefined) {
    external_ids.abs_episode = s.episodeId;
  }

  const media_type = resolveSessionMediaType(s.mediaType);
  const started_at = toUtcIso(s.startedAt);
  const ended_at =
    s.updatedAt !== undefined && s.updatedAt !== null
      ? toUtcIso(s.updatedAt)
      : null;
  const duration_seconds =
    typeof s.timeListening === "number" && Number.isFinite(s.timeListening)
      ? s.timeListening
      : null;
  const progress = computeSessionProgress(s.currentTime, s.duration);
  const device = resolveDevice(s.deviceInfo);
  const raw = removeIpAddress(s);

  return {
    source: "audiobookshelf",
    source_kind: "listening_session",
    source_id: s.id,
    external_ids,
    media_type,
    title: s.displayTitle ?? null,
    parent_title: s.displayAuthor ?? null,
    started_at,
    ended_at,
    duration_seconds,
    progress,
    device,
    raw,
  };
}

/**
 * Maps a single mediaProgress item to a NewEvent.
 */
export function mapMediaProgress(
  p: AbsMediaProgress,
  titleLookup?: (libraryItemId: string) => string | undefined
): NewEvent {
  const source_id =
    p.episodeId !== null && p.episodeId !== undefined && p.episodeId !== ""
      ? `${p.libraryItemId}:${p.episodeId}`
      : p.libraryItemId;

  const media_type = resolveProgressMediaType(p.mediaItemType);
  const started_at = toUtcIso(p.lastUpdate);
  const ended_at =
    p.finishedAt !== null && p.finishedAt !== undefined
      ? toUtcIso(p.finishedAt)
      : null;

  const progress =
    typeof p.progress === "number" && Number.isFinite(p.progress)
      ? Math.max(0, Math.min(1, p.progress))
      : null;

  const resolved = titleLookup ? titleLookup(p.libraryItemId) : undefined;
  const title =
    resolved !== undefined && resolved !== null && resolved.trim().length > 0
      ? resolved.trim()
      : p.libraryItemId;

  const raw = removeIpAddress(p);

  return {
    source: "audiobookshelf",
    source_kind: "media_progress",
    source_id,
    media_type,
    title,
    parent_title: null,
    started_at,
    ended_at,
    duration_seconds: null,
    progress,
    device: null,
    raw,
  };
}

/**
 * Maps listening stats `days` to daily snapshot NewEvents for cross-checks.
 */
export function mapListeningStats(stats: AbsListeningStats): NewEvent[] {
  if (!stats?.days || typeof stats.days !== "object") {
    return [];
  }

  const entries = Object.entries(stats.days).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return entries.map(([date, seconds]) => {
    const duration_seconds =
      typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null;

    return {
      source: "audiobookshelf",
      source_kind: "daily_stat",
      source_id: date,
      media_type: "other" as const,
      started_at: toUtcIso(date),
      ended_at: null,
      duration_seconds,
      title: null,
      parent_title: null,
      progress: null,
      device: null,
      raw: { date, seconds },
    };
  });
}

/**
 * Convenience function: maps sessions + user mediaProgress + daily stats.
 * Uses sessions displayTitle and stats item metadata for mediaProgress title fallback.
 * Produces deterministic ordering.
 */
export function mapAll({ sessions, me, stats }: MapAllInput): NewEvent[] {
  const sessionTitles = new Map<string, string>();
  if (sessions) {
    for (const s of sessions) {
      if (
        s.libraryItemId &&
        typeof s.displayTitle === "string" &&
        s.displayTitle.trim().length > 0
      ) {
        if (!sessionTitles.has(s.libraryItemId)) {
          sessionTitles.set(s.libraryItemId, s.displayTitle.trim());
        }
      }
    }
  }

  const titleLookup = (libraryItemId: string): string | undefined => {
    const fromSession = sessionTitles.get(libraryItemId);
    if (fromSession) {
      return fromSession;
    }
    const statItem = stats?.items?.[libraryItemId];
    const statTitle = statItem?.mediaMetadata?.title;
    if (typeof statTitle === "string" && statTitle.trim().length > 0) {
      return statTitle.trim();
    }
    return undefined;
  };

  const mappedSessions = (sessions ?? []).map(mapSession);
  const mappedProgress = (me?.mediaProgress ?? []).map((p) =>
    mapMediaProgress(p, titleLookup)
  );
  const mappedStats = stats ? mapListeningStats(stats) : [];

  return [...mappedSessions, ...mappedProgress, ...mappedStats];
}
