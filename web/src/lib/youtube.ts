/**
 * Pure, DOM-free helpers for YouTube videos, topic/channel grouping,
 * Library sorting (`recent | time | title | category | creator`),
 * proportional bar ratios, search filtering, and 404 fallback synthesis.
 */

import type {
  LibrarySortV2,
  LibraryWork,
  YoutubeChannel,
  YoutubeOverview,
  YoutubeVideo,
  YoutubeVideoSort,
  YoutubeVideosResult,
} from "../api";
import { CATEGORIES } from "./categories";

export const UNCATEGORISED_TOPIC = "Uncategorised";

export const COMMON_YOUTUBE_TOPICS: ReadonlyArray<string> = [
  "Science & Technology",
  "Education",
  "History",
  "Essays & Criticism",
  "Programming",
  "Gaming",
  "Documentary",
  "Entertainment",
  "Music",
  "Podcast",
  "News & Politics",
];

export type YoutubeVideoGroupBy = "none" | "topic" | "channel";

export interface YoutubeChannelBar extends YoutubeChannel {
  readonly displayTopic: string;
  readonly sharePct: number;
  readonly barRatio: number;
}

export interface YoutubeTopicGroup {
  readonly topic: string;
  readonly isUncategorised: boolean;
  readonly channelsCount: number;
  readonly videosCount: number;
  readonly totalMinutes: number;
  readonly sharePct: number;
  readonly barRatio: number;
  readonly channels: readonly YoutubeChannelBar[];
}

export interface YoutubeVideoGroup {
  readonly key: string;
  readonly label: string;
  readonly kind: "topic" | "channel";
  readonly topic: string | null;
  readonly isUncategorised: boolean;
  readonly totalMinutes: number;
  readonly videosCount: number;
  readonly sharePct: number;
  readonly barRatio: number;
  readonly videos: readonly YoutubeVideo[];
}

/**
 * Sorts a list of `LibraryWork`s according to `LibrarySortV2`
 * (`"plays" | "recent" | "time" | "title" | "category" | "creator"`).
 */
export function sortLibraryWorks(
  works: readonly LibraryWork[],
  sort: LibrarySortV2 = "recent"
): LibraryWork[] {
  const copy = [...works];
  switch (sort) {
    case "plays":
      return copy.sort((a, b) => b.units - a.units || b.total_minutes - a.total_minutes || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
    case "time":
      return copy.sort((a, b) => {
        if (b.total_minutes !== a.total_minutes) {
          return b.total_minutes - a.total_minutes;
        }
        const aLast = a.last_at ?? "";
        const bLast = b.last_at ?? "";
        if (bLast !== aLast) {
          return bLast.localeCompare(aLast);
        }
        return a.title.localeCompare(b.title);
      });
    case "title":
      return copy.sort((a, b) => a.title.localeCompare(b.title));
    case "category":
      return copy.sort((a, b) => {
        const idxA = CATEGORIES.indexOf(a.category);
        const idxB = CATEGORIES.indexOf(b.category);
        if (idxA !== idxB) {
          return idxA - idxB;
        }
        if (b.total_minutes !== a.total_minutes) {
          return b.total_minutes - a.total_minutes;
        }
        return a.title.localeCompare(b.title);
      });
    case "creator":
      return copy.sort((a, b) => {
        const crA = (a.creator ?? a.channel ?? "").trim();
        const crB = (b.creator ?? b.channel ?? "").trim();
        if (Boolean(crA) !== Boolean(crB)) {
          return crA ? -1 : 1;
        }
        if (crA && crB) {
          const cmp = crA.localeCompare(crB, undefined, { sensitivity: "base" });
          if (cmp !== 0) return cmp;
        }
        if (b.total_minutes !== a.total_minutes) {
          return b.total_minutes - a.total_minutes;
        }
        return a.title.localeCompare(b.title);
      });
    case "recent":
    default:
      return copy.sort((a, b) => {
        const aLast = a.last_at ?? "";
        const bLast = b.last_at ?? "";
        if (bLast !== aLast) {
          return bLast.localeCompare(aLast);
        }
        if (b.total_minutes !== a.total_minutes) {
          return b.total_minutes - a.total_minutes;
        }
        return a.title.localeCompare(b.title);
      });
  }
}

/**
 * Sorts `YoutubeVideo[]` by `"plays"`, `"recent"`, `"time"` (watch time), or `"topic"`.
 */
export function sortYoutubeVideos(
  videos: readonly YoutubeVideo[],
  sort: YoutubeVideoSort = "recent"
): YoutubeVideo[] {
  const copy = [...videos];
  switch (sort) {
    case "plays":
      return copy.sort((a, b) => b.plays - a.plays || b.watched_minutes - a.watched_minutes || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
    case "time":
      return copy.sort((a, b) => {
        if (b.watched_minutes !== a.watched_minutes) {
          return b.watched_minutes - a.watched_minutes;
        }
        if (b.plays !== a.plays) {
          return b.plays - a.plays;
        }
        return a.title.localeCompare(b.title);
      });
    case "topic":
      return copy.sort((a, b) => {
        const tA = (a.topic ?? "").trim();
        const tB = (b.topic ?? "").trim();
        const uncatA =
          !tA ||
          tA.toLowerCase() === "uncategorised" ||
          tA.toLowerCase() === "uncategorized";
        const uncatB =
          !tB ||
          tB.toLowerCase() === "uncategorised" ||
          tB.toLowerCase() === "uncategorized";
        if (uncatA !== uncatB) {
          return uncatA ? 1 : -1;
        }
        const cmp = tA.localeCompare(tB, undefined, { sensitivity: "base" });
        if (cmp !== 0) return cmp;
        if (b.watched_minutes !== a.watched_minutes) {
          return b.watched_minutes - a.watched_minutes;
        }
        return a.title.localeCompare(b.title);
      });
    case "recent":
    default:
      return copy.sort((a, b) => {
        const aLast = a.last_at ?? "";
        const bLast = b.last_at ?? "";
        if (bLast !== aLast) {
          return bLast.localeCompare(aLast);
        }
        if (b.watched_minutes !== a.watched_minutes) {
          return b.watched_minutes - a.watched_minutes;
        }
        return a.title.localeCompare(b.title);
      });
  }
}

/**
 * Groups `YoutubeVideo[]` by `"topic"` or `"channel"`, computing total watch time,
 * share percentage, proportional `barRatio`, and sorting videos within each group.
 */
export function groupYoutubeVideos(
  videos: readonly YoutubeVideo[],
  groupBy: "topic" | "channel",
  sort: YoutubeVideoSort = "recent"
): YoutubeVideoGroup[] {
  const map = new Map<
    string,
    {
      label: string;
      topic: string | null;
      isUncategorised: boolean;
      totalMinutes: number;
      videos: YoutubeVideo[];
    }
  >();

  for (const v of videos) {
    if (groupBy === "topic") {
      const rawTopic = (v.topic ?? "").trim();
      const isUncat =
        !rawTopic ||
        rawTopic.toLowerCase() === "uncategorised" ||
        rawTopic.toLowerCase() === "uncategorized";
      const label = isUncat ? UNCATEGORISED_TOPIC : rawTopic;
      let bucket = map.get(label);
      if (!bucket) {
        bucket = {
          label,
          topic: isUncat ? null : label,
          isUncategorised: isUncat,
          totalMinutes: 0,
          videos: [],
        };
        map.set(label, bucket);
      }
      bucket.totalMinutes += Math.max(0, v.watched_minutes || 0);
      bucket.videos.push(v);
    } else {
      const ch = (v.channel ?? "").trim() || "Unknown Channel";
      let bucket = map.get(ch);
      if (!bucket) {
        bucket = {
          label: ch,
          topic: v.topic?.trim() || null,
          isUncategorised: false,
          totalMinutes: 0,
          videos: [],
        };
        map.set(ch, bucket);
      }
      if (!bucket.topic && v.topic?.trim()) {
        bucket.topic = v.topic.trim();
      }
      bucket.totalMinutes += Math.max(0, v.watched_minutes || 0);
      bucket.videos.push(v);
    }
  }

  const groups = [...map.values()].sort((a, b) => {
    if (groupBy === "topic" && a.isUncategorised !== b.isUncategorised) {
      return a.isUncategorised ? 1 : -1;
    }
    if (b.totalMinutes !== a.totalMinutes) {
      return b.totalMinutes - a.totalMinutes;
    }
    if (b.videos.length !== a.videos.length) {
      return b.videos.length - a.videos.length;
    }
    return a.label.localeCompare(b.label);
  });

  const grandMinutes = groups.reduce((acc, g) => acc + g.totalMinutes, 0);
  const maxMinutes = groups.reduce((acc, g) => Math.max(acc, g.totalMinutes), 0);
  const maxCount = groups.reduce((acc, g) => Math.max(acc, g.videos.length), 0);

  return groups.map((g) => {
    const sharePct =
      grandMinutes > 0
        ? Math.round((g.totalMinutes / grandMinutes) * 1000) / 10
        : 0;
    const barRatio =
      maxMinutes > 0
        ? Math.max(0.06, Math.min(1, g.totalMinutes / maxMinutes))
        : maxCount > 0
          ? Math.max(0.06, Math.min(1, g.videos.length / maxCount))
          : 0;
    return {
      key: `${groupBy}:${g.label}`,
      label: g.label,
      kind: groupBy,
      topic: g.topic,
      isUncategorised: g.isUncategorised,
      totalMinutes: Math.round(g.totalMinutes),
      videosCount: g.videos.length,
      sharePct,
      barRatio: Math.round(barRatio * 100) / 100,
      videos: sortYoutubeVideos(g.videos, sort),
    };
  });
}

/**
 * Ranks and filters YouTube channels, computing `barRatio` (`0..1`) and `sharePct`.
 */
export function rankYoutubeChannels(
  channels: readonly YoutubeChannel[],
  options: { topic?: string | null; q?: string } = {}
): YoutubeChannelBar[] {
  const qNorm = (options.q ?? "").trim().toLowerCase();
  const topicFilter = options.topic;

  const filtered = channels.filter((ch) => {
    const chTopic = ch.topic?.trim() || UNCATEGORISED_TOPIC;
    if (topicFilter !== undefined && topicFilter !== null && topicFilter !== "") {
      if (chTopic.toLowerCase() !== topicFilter.trim().toLowerCase()) {
        return false;
      }
    }
    if (qNorm) {
      const matchName = ch.channel.toLowerCase().includes(qNorm);
      const matchTopic = chTopic.toLowerCase().includes(qNorm);
      if (!matchName && !matchTopic) {
        return false;
      }
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (b.total_minutes !== a.total_minutes) {
      return b.total_minutes - a.total_minutes;
    }
    if (b.videos !== a.videos) {
      return b.videos - a.videos;
    }
    return a.channel.localeCompare(b.channel);
  });

  const totalMin = sorted.reduce(
    (acc, c) => acc + Math.max(0, c.total_minutes),
    0
  );
  const maxMin = sorted.reduce(
    (acc, c) => Math.max(acc, c.total_minutes),
    0
  );
  const maxVideos = sorted.reduce((acc, c) => Math.max(acc, c.videos), 0);

  return sorted.map((ch) => {
    const min = Math.max(0, ch.total_minutes);
    const sharePct =
      totalMin > 0 ? Math.round((min / totalMin) * 1000) / 10 : 0;
    const barRatio =
      maxMin > 0
        ? Math.max(0.06, Math.min(1, min / maxMin))
        : maxVideos > 0
          ? Math.max(0.06, Math.min(1, ch.videos / maxVideos))
          : 0;
    return {
      ...ch,
      total_minutes: Math.round(min),
      displayTopic: ch.topic?.trim() || UNCATEGORISED_TOPIC,
      sharePct,
      barRatio: Math.round(barRatio * 100) / 100,
    };
  });
}

/**
 * Groups a `YoutubeOverview` into `YoutubeTopicGroup[]` (topics -> channels),
 * with proportional bar ratios and optional search filtering.
 */
export function groupYoutubeByTopic(
  overview: YoutubeOverview,
  query = ""
): YoutubeTopicGroup[] {
  const qNorm = query.trim().toLowerCase();
  const groupMap = new Map<
    string,
    {
      topic: string;
      isUncategorised: boolean;
      channels: YoutubeChannel[];
      explicitVideos: number;
      explicitMinutes: number;
    }
  >();

  // Seed from overview.topics
  for (const t of overview.topics ?? []) {
    const name = t.topic?.trim() || UNCATEGORISED_TOPIC;
    const isUncat =
      name.toLowerCase() === "uncategorised" ||
      name.toLowerCase() === "uncategorized";
    const key = isUncat ? UNCATEGORISED_TOPIC : name;
    const existing = groupMap.get(key);
    if (existing) {
      existing.explicitVideos += t.videos;
      existing.explicitMinutes += t.total_minutes;
    } else {
      groupMap.set(key, {
        topic: key,
        isUncategorised: isUncat,
        channels: [],
        explicitVideos: t.videos,
        explicitMinutes: t.total_minutes,
      });
    }
  }

  // Attach channels to their topic
  for (const ch of overview.channels ?? []) {
    const rawTopic = ch.topic?.trim() || "";
    const isUncat =
      !rawTopic ||
      rawTopic.toLowerCase() === "uncategorised" ||
      rawTopic.toLowerCase() === "uncategorized";
    const key = isUncat ? UNCATEGORISED_TOPIC : rawTopic;

    if (qNorm) {
      const matchesTopic = key.toLowerCase().includes(qNorm);
      const matchesChannel = ch.channel.toLowerCase().includes(qNorm);
      if (!matchesTopic && !matchesChannel) {
        continue;
      }
    }

    let bucket = groupMap.get(key);
    if (!bucket) {
      bucket = {
        topic: key,
        isUncategorised: isUncat,
        channels: [],
        explicitVideos: 0,
        explicitMinutes: 0,
      };
      groupMap.set(key, bucket);
    }
    bucket.channels.push(ch);
  }

  const rawGroups: Array<{
    topic: string;
    isUncategorised: boolean;
    channelsCount: number;
    videosCount: number;
    totalMinutes: number;
    channels: YoutubeChannelBar[];
  }> = [];

  for (const bucket of groupMap.values()) {
    if (
      qNorm &&
      bucket.channels.length === 0 &&
      !bucket.topic.toLowerCase().includes(qNorm)
    ) {
      continue;
    }

    const rankedChannels = rankYoutubeChannels(bucket.channels);
    const chMinutes = rankedChannels.reduce(
      (acc, c) => acc + c.total_minutes,
      0
    );
    const chVideos = rankedChannels.reduce((acc, c) => acc + c.videos, 0);

    const totalMinutes =
      qNorm || chMinutes > 0
        ? chMinutes
        : Math.round(bucket.explicitMinutes);
    const videosCount =
      qNorm || chVideos > 0 ? chVideos : bucket.explicitVideos;
    const channelsCount =
      rankedChannels.length > 0
        ? rankedChannels.length
        : overview.topics.find((t) => t.topic === bucket.topic)?.channels ?? 0;

    if (totalMinutes <= 0 && videosCount <= 0 && rankedChannels.length === 0) {
      continue;
    }

    rawGroups.push({
      topic: bucket.topic,
      isUncategorised: bucket.isUncategorised,
      channelsCount,
      videosCount,
      totalMinutes,
      channels: rankedChannels,
    });
  }

  rawGroups.sort((a, b) => {
    if (a.isUncategorised !== b.isUncategorised) {
      return a.isUncategorised ? 1 : -1;
    }
    if (b.totalMinutes !== a.totalMinutes) {
      return b.totalMinutes - a.totalMinutes;
    }
    if (b.videosCount !== a.videosCount) {
      return b.videosCount - a.videosCount;
    }
    return a.topic.localeCompare(b.topic);
  });

  const grandTotalMinutes = rawGroups.reduce(
    (acc, g) => acc + g.totalMinutes,
    0
  );
  const maxGroupMinutes = rawGroups.reduce(
    (acc, g) => Math.max(acc, g.totalMinutes),
    0
  );
  const maxGroupVideos = rawGroups.reduce(
    (acc, g) => Math.max(acc, g.videosCount),
    0
  );

  return rawGroups.map((g) => {
    const sharePct =
      grandTotalMinutes > 0
        ? Math.round((g.totalMinutes / grandTotalMinutes) * 1000) / 10
        : 0;
    const barRatio =
      maxGroupMinutes > 0
        ? Math.max(0.06, Math.min(1, g.totalMinutes / maxGroupMinutes))
        : maxGroupVideos > 0
          ? Math.max(0.06, Math.min(1, g.videosCount / maxGroupVideos))
          : 0;
    return {
      ...g,
      sharePct,
      barRatio: Math.round(barRatio * 100) / 100,
    };
  });
}

/**
 * Returns a deduplicated list of available topic names (existing topics + presets).
 */
export function collectYoutubeTopics(
  overview: YoutubeOverview | null | undefined
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const add = (raw: string | null | undefined) => {
    const t = (raw ?? "").trim();
    if (
      !t ||
      t.toLowerCase() === "uncategorised" ||
      t.toLowerCase() === "uncategorized"
    ) {
      return;
    }
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      result.push(t);
    }
  };

  for (const t of overview?.topics ?? []) {
    add(t.topic);
  }
  for (const ch of overview?.channels ?? []) {
    add(ch.topic);
  }
  for (const preset of COMMON_YOUTUBE_TOPICS) {
    add(preset);
  }
  return result;
}

/**
 * Fallback synthesis: builds a `YoutubeOverview` from `LibraryWork[]`
 * when `GET /api/youtube` returns 404.
 */
export function buildYoutubeOverviewFromWorks(
  works: readonly LibraryWork[]
): YoutubeOverview {
  const ytWorks = works.filter((w) => w.category === "youtube");
  const channelsMap = new Map<string, YoutubeChannel>();
  const topicsMap = new Map<
    string,
    { channels: Set<string>; videos: number; total_minutes: number }
  >();

  let totalMinutes = 0;
  let totalVideos = 0;

  for (const w of ytWorks) {
    const chName = (w.channel ?? w.creator ?? w.title ?? "Unknown Channel").trim();
    const topic = w.topic?.trim() || null;
    const vids = Math.max(1, w.units || 1);
    const mins = Math.max(0, w.total_minutes || 0);

    totalMinutes += mins;
    totalVideos += vids;

    const existingCh = channelsMap.get(chName);
    if (existingCh) {
      existingCh.videos += vids;
      existingCh.total_minutes += mins;
      if (!existingCh.topic && topic) {
        existingCh.topic = topic;
      }
      if (w.last_at && (!existingCh.last_at || w.last_at > existingCh.last_at)) {
        existingCh.last_at = w.last_at;
      }
    } else {
      channelsMap.set(chName, {
        channel: chName,
        channel_id: null,
        topic,
        videos: vids,
        total_minutes: mins,
        last_at: w.last_at,
      });
    }

    const topicKey = topic ?? UNCATEGORISED_TOPIC;
    const existingTopic = topicsMap.get(topicKey);
    if (existingTopic) {
      existingTopic.channels.add(chName);
      existingTopic.videos += vids;
      existingTopic.total_minutes += mins;
    } else {
      topicsMap.set(topicKey, {
        channels: new Set([chName]),
        videos: vids,
        total_minutes: mins,
      });
    }
  }

  return {
    from: null,
    to: null,
    total_minutes: Math.round(totalMinutes),
    videos: totalVideos,
    topics: [...topicsMap.entries()].map(([topic, data]) => ({
      topic,
      channels: data.channels.size,
      videos: data.videos,
      total_minutes: Math.round(data.total_minutes),
    })),
    channels: [...channelsMap.values()],
    days: [],
    short_plays_hidden: 0,
    min_watch_minutes: 5,
  };
}

/**
 * Fallback synthesis: builds a `YoutubeVideosResult` from `LibraryWork[]`
 * when `GET /api/youtube/videos` returns 404.
 */
export function buildYoutubeVideosFromWorks(
  works: readonly LibraryWork[],
  params: {
    channel?: string;
    topic?: string;
    q?: string;
    sort?: YoutubeVideoSort;
  } = {}
): YoutubeVideosResult {
  const qNorm = (params.q ?? "").trim().toLowerCase();
  const chFilter = (params.channel ?? "").trim().toLowerCase();
  const topicFilter = (params.topic ?? "").trim().toLowerCase();

  const videos: YoutubeVideo[] = [];
  for (const w of works) {
    if (w.category !== "youtube") continue;
    const ch = w.channel ?? w.creator ?? w.title;
    const topic = w.topic ?? UNCATEGORISED_TOPIC;
    if (chFilter && ch.toLowerCase() !== chFilter) continue;
    if (topicFilter && topic.toLowerCase() !== topicFilter) continue;
    if (
      qNorm &&
      !w.title.toLowerCase().includes(qNorm) &&
      !ch.toLowerCase().includes(qNorm) &&
      !topic.toLowerCase().includes(qNorm)
    ) {
      continue;
    }
    videos.push({
      key: w.key,
      video_id: w.key,
      title: w.title,
      channel: ch,
      topic: w.topic,
      watched_minutes: w.total_minutes,
      plays: Math.max(1, w.units),
      first_at: w.first_at ?? new Date().toISOString(),
      last_at: w.last_at ?? new Date().toISOString(),
      thumbnail_url: w.cover_url,
    });
  }

  const sorted = sortYoutubeVideos(videos, params.sort ?? "recent");

  return {
    videos: sorted,
    total: sorted.length,
  };
}
