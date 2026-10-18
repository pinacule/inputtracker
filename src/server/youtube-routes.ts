/**
 * YouTube endpoints, channel topics, and topic precedence (v2.1 section 10):
 * - `POST /api/youtube/channel-topic` (`{ channel, topic | null }`)
 * - `GET /api/youtube` (`YoutubeOverview`)
 * - `GET /api/youtube/videos` (`YoutubeVideosResult`)
 *
 * Topic precedence:
 *   video edit (`WorkEdit.topic`) > channel topic > YouTube category (`genre`) > null
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { categoryOf } from "../core/category.ts";
import type {
  DatePrecision,
  LibraryWorkDetail,
  SeriesPoint,
  YoutubeChannel,
  YoutubeOverview,
  YoutubeTopic,
  YoutubeVideo,
  YoutubeVideosResult,
} from "../core/contract.ts";
import type { YoutubeChannelTopicRow } from "../core/schema.ts";
import {
  CONSUMPTION_KINDS,
  coverUrlFor,
  eventPrecision,
  formatLocalParts,
  getLatestConsumptionEvents,
  parseExternalIds,
  parseJsonObject,
  type ConsumptionEvent,
} from "./aggregate.ts";
import type { AppDeps } from "./app.ts";
import { dedupeConsumption } from "./dedup.ts";
import { getWorkOverrides } from "./overrides.ts";
import { normalizeForSearch } from "./search.ts";
import { isValidYoutubeVideoId } from "./thumbs.ts";
import {
  getEventYoutubeVideoId,
  getYoutubeMinWatchMinutesForDb,
  partitionYoutubeEvents,
  readYoutubeEnrichmentByVideoId,
  setYoutubeConfigForDb,
} from "./youtube-filter.ts";

export class YoutubeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YoutubeValidationError";
  }
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isValidDateStr(str: string): boolean {
  if (!DATE_RE.test(str)) {
    return false;
  }
  const [yStr, mStr, dStr] = str.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function addDaysStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + delta));
  const ys = String(dt.getUTCFullYear()).padStart(4, "0");
  const ms = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const ds = String(dt.getUTCDate()).padStart(2, "0");
  return `${ys}-${ms}-${ds}`;
}

function enumerateDayBuckets(from: string, to: string): string[] {
  const result: string[] = [];
  let curr = from;
  let guard = 0;
  while (curr <= to && guard < 20_000) {
    result.push(curr);
    curr = addDaysStr(curr, 1);
    guard++;
  }
  return result;
}

function validateQueryParams(
  urlStr: string,
  allowed: readonly string[]
): string | null {
  const url = new URL(urlStr);
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) {
      return `Unknown query parameter: '${key}'`;
    }
  }
  return null;
}

export function normalizeChannelKey(channel: string): string {
  const norm = normalizeForSearch(channel);
  return norm !== "" ? norm : channel.trim().toLowerCase();
}

export function channelTopicRecordHash(norm: {
  normalized_channel: string;
  rev: number;
  topic: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        normalized_channel: norm.normalized_channel,
        rev: norm.rev,
        topic: norm.topic,
      })
    )
    .digest("hex");
}

export interface SetChannelTopicResult {
  channel: string;
  topic: string | null;
  inserted: boolean;
}

/**
 * Append a channel topic override to `youtube_channel_topics`.
 * Setting `topic: null` (or `""`) clears the channel topic on read.
 * Sending the same topic as the current latest row is a no-op (`inserted: false`).
 */
export function setChannelTopic(
  db: Database,
  input: unknown,
  nowIso?: string
): SetChannelTopicResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new YoutubeValidationError("Body must be a JSON object");
  }

  const body = input as Record<string, unknown>;
  if (typeof body.channel !== "string") {
    throw new YoutubeValidationError("Field 'channel' is required and must be a string");
  }
  const channel = body.channel.trim();
  if (channel === "") {
    throw new YoutubeValidationError("Field 'channel' cannot be empty");
  }
  if (channel.length > 200) {
    throw new YoutubeValidationError(
      `Field 'channel' is too long (${channel.length} characters, max 200)`
    );
  }

  let topic: string | null = null;
  if (body.topic !== undefined && body.topic !== null) {
    if (typeof body.topic !== "string") {
      throw new YoutubeValidationError("Field 'topic' must be a string or null");
    }
    const trimmedTopic = body.topic.trim();
    if (trimmedTopic.length > 100) {
      throw new YoutubeValidationError(
        `Field 'topic' is too long (${trimmedTopic.length} characters, max 100)`
      );
    }
    topic = trimmedTopic.length > 0 ? trimmedTopic : null;
  }

  const normalizedChannel = normalizeChannelKey(channel);
  const createdAt = nowIso ?? new Date().toISOString();

  const tx = db.transaction((): SetChannelTopicResult => {
    const latest = db
      .query<YoutubeChannelTopicRow, [string]>(
        `SELECT * FROM youtube_channel_topics_latest
         WHERE normalized_channel = ?
         LIMIT 1;`
      )
      .get(normalizedChannel);

    if (latest && latest.topic === topic) {
      return {
        channel,
        topic,
        inserted: false,
      };
    }

    const revRow = db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM youtube_channel_topics
         WHERE normalized_channel = ?;`
      )
      .get(normalizedChannel);
    const nextRev = (revRow?.count ?? 0) + 1;

    const recordHash = channelTopicRecordHash({
      normalized_channel: normalizedChannel,
      rev: nextRev,
      topic,
    });

    const res = db.run(
      `INSERT OR IGNORE INTO youtube_channel_topics (
        record_hash,
        channel,
        normalized_channel,
        topic,
        created_at
      ) VALUES (?, ?, ?, ?, ?);`,
      [recordHash, channel, normalizedChannel, topic, createdAt]
    );

    return {
      channel,
      topic,
      inserted: res.changes > 0,
    };
  });

  return tx();
}

/**
 * Read the latest channel topic per normalized channel name.
 * A channel whose topic was cleared has value `null` in the map.
 */
export function getChannelTopicsMap(db: Database): Map<string, string | null> {
  const map = new Map<string, string | null>();
  try {
    const rows = db
      .query<YoutubeChannelTopicRow, []>(
        "SELECT * FROM youtube_channel_topics_latest;"
      )
      .all();
    for (const row of rows) {
      map.set(row.normalized_channel, row.topic);
    }
  } catch {
    // Table may not exist on a pre-v7 read-only snapshot.
  }
  return map;
}

// --- Video edit topic overrides (W04 integration + direct test hook) --------

const manualVideoTopicOverrides = new WeakMap<
  Database,
  Map<string, string | null>
>();

/**
 * Set or clear a video-level topic override (`WorkEdit.topic`) for `key`
 * (e.g. `youtube:video:<videoId>` or `<videoId>`). Used by tests and fallback
 * when `src/server/overrides.ts` (W04) is not yet merged.
 */
export function setVideoTopicOverride(
  db: Database,
  key: string,
  topic: string | null
): void {
  let map = manualVideoTopicOverrides.get(db);
  if (!map) {
    map = new Map<string, string | null>();
    manualVideoTopicOverrides.set(db, map);
  }
  map.set(key, topic);
}

/**
 * Read video/work topic overrides (`WorkEdit.topic`) from the work overrides, plus any
 * registered via `setVideoTopicOverride`.
 */
export function readWorkTopicOverrides(
  db: Database
): Map<string, string | null> {
  const out = new Map<string, string | null>();

  // 1. Topics stored with WorkEdit.topic (work overrides, migration v6).
  for (const [key, override] of getWorkOverrides(db)) {
    const t = override.topic;
    if (typeof t === "string" && t.trim() !== "") {
      out.set(key, t.trim());
    }
  }

  // 3. Apply in-memory overrides registered via setVideoTopicOverride
  const manual = manualVideoTopicOverrides.get(db);
  if (manual) {
    for (const [k, v] of manual.entries()) {
      out.set(k, v);
    }
  }

  return out;
}

export interface ResolveVideoTopicInput {
  videoKey: string;
  videoId: string;
  videoTitle?: string | null;
  channel: string | null;
  youtubeCategory: string | null;
  channelTopics: ReadonlyMap<string, string | null>;
  workTopicOverrides: ReadonlyMap<string, string | null>;
}

/**
 * Resolve a video's topic using the v2.1 precedence chain:
 *   video edit (`WorkEdit.topic`) > channel topic > YouTube category (`genre`) > null
 */
export function resolveVideoTopic(input: ResolveVideoTopicInput): string | null {
  const {
    videoKey,
    videoId,
    videoTitle,
    channel,
    youtubeCategory,
    channelTopics,
    workTopicOverrides,
  } = input;

  // 1. Video edit override (by videoKey, bare videoId, or normalized video title key)
  const candidateKeys = [videoKey, videoId];
  if (videoTitle) {
    const normTitle = normalizeForSearch(videoTitle);
    if (normTitle) {
      candidateKeys.push(`youtube:${normTitle}`);
    }
  }
  for (const k of candidateKeys) {
    const override = workTopicOverrides.get(k);
    if (typeof override === "string" && override.trim() !== "") {
      return override.trim();
    }
  }

  // 2. Channel topic (user's topic for the channel)
  if (channel && channel.trim() !== "") {
    const normChannel = normalizeChannelKey(channel);
    const channelWorkOverride = workTopicOverrides.get(`youtube:${normChannel}`);
    if (
      typeof channelWorkOverride === "string" &&
      channelWorkOverride.trim() !== ""
    ) {
      return channelWorkOverride.trim();
    }
    const channelTopic = channelTopics.get(normChannel);
    if (typeof channelTopic === "string" && channelTopic.trim() !== "") {
      return channelTopic.trim();
    }
  }

  // 3. YouTube category (`<meta itemprop="genre">` from watch page)
  if (typeof youtubeCategory === "string" && youtubeCategory.trim() !== "") {
    return youtubeCategory.trim();
  }

  // 4. Null
  return null;
}

/**
 * Pick the most common non-null category/topic among a list of `{ topic, minutes }`
 * items (tie-breaking by total minutes desc, then topic name asc).
 */
function mostCommonTopic(
  items: ReadonlyArray<{ topic: string | null; minutes: number }>
): string | null {
  const counts = new Map<string, { count: number; minutes: number }>();
  for (const item of items) {
    if (!item.topic || item.topic.trim() === "") {
      continue;
    }
    const t = item.topic.trim();
    let entry = counts.get(t);
    if (!entry) {
      entry = { count: 0, minutes: 0 };
      counts.set(t, entry);
    }
    entry.count += 1;
    entry.minutes += item.minutes;
  }

  if (counts.size === 0) {
    return null;
  }

  const sorted = Array.from(counts.entries()).sort(
    (a, b) =>
      b[1].count - a[1].count ||
      b[1].minutes - a[1].minutes ||
      a[0].localeCompare(b[0])
  );
  return sorted[0]![0];
}

/**
 * Compute `LibraryWork.channel` and `LibraryWork.topic` for a YouTube work in
 * `src/server/library.ts`.
 */
export function resolveYoutubeLibraryWorkFields(
  db: Database,
  workEvents: readonly ConsumptionEvent[],
  canonicalTitle: string,
  workKey: string
): { channel: string | null; topic: string | null } {
  const enrichmentMap = readYoutubeEnrichmentByVideoId(db);
  const channelTopics = getChannelTopicsMap(db);
  const workTopicOverrides = readWorkTopicOverrides(db);

  let channel: string | null = null;
  for (let i = workEvents.length - 1; i >= 0; i--) {
    const ev = workEvents[i]!;
    if (ev.parent_title && ev.parent_title.trim() !== "") {
      channel = ev.parent_title.trim();
      break;
    }
    const vid = getEventYoutubeVideoId(ev);
    if (vid) {
      const enr = enrichmentMap.get(vid);
      if (enr?.channel && enr.channel.trim() !== "") {
        channel = enr.channel.trim();
        break;
      }
    }
    if (ev.source_kind === "archive") {
      const raw = parseJsonObject(ev.raw);
      const workSnap = parseJsonObject(raw?.["work"]);
      if (typeof workSnap?.["title"] === "string" && workSnap["title"].trim() !== "") {
        channel = workSnap["title"].trim();
        break;
      }
    }
  }

  // Check work-level override first
  const directOverride = workTopicOverrides.get(workKey);
  if (typeof directOverride === "string" && directOverride.trim() !== "") {
    return { channel, topic: directOverride.trim() };
  }

  // Check channel-level topic
  if (channel) {
    const normChannel = normalizeChannelKey(channel);
    const chanOverride = workTopicOverrides.get(`youtube:${normChannel}`);
    if (typeof chanOverride === "string" && chanOverride.trim() !== "") {
      return { channel, topic: chanOverride.trim() };
    }
    const chanTopic = channelTopics.get(normChannel);
    if (typeof chanTopic === "string" && chanTopic.trim() !== "") {
      return { channel, topic: chanTopic.trim() };
    }
  }

  // Otherwise most common resolved topic / YouTube category among the work's videos
  const byVideo = new Map<string, { topic: string | null; minutes: number }>();
  for (const ev of workEvents) {
    const vid =
      getEventYoutubeVideoId(ev) ??
      ev.source_id ??
      ev.title ??
      String(ev.id);
    const vKey = `youtube:video:${vid}`;
    const enr = enrichmentMap.get(vid);
    const resolved = resolveVideoTopic({
      videoKey: vKey,
      videoId: vid,
      videoTitle: ev.title,
      channel,
      youtubeCategory: enr?.genre ?? null,
      channelTopics,
      workTopicOverrides,
    });
    const mins = (ev.duration_seconds ?? 0) / 60;
    const prev = byVideo.get(vid);
    if (!prev) {
      byVideo.set(vid, { topic: resolved, minutes: mins });
    } else {
      prev.minutes += mins;
      if (resolved !== null) {
        prev.topic = resolved;
      }
    }
  }

  const topic = mostCommonTopic(Array.from(byVideo.values()));
  return { channel, topic };
}

/**
 * Build a `LibraryWorkDetail` when `/api/library/work?key=` is called with a
 * video key (`youtube:video:<videoId>`).
 */
export function getYoutubeVideoWorkDetail(
  db: Database,
  key: string,
  tz: string = "Europe/Bratislava"
): LibraryWorkDetail | null {
  if (!key.startsWith("youtube:video:")) {
    return null;
  }
  const targetVideoId = key.slice("youtube:video:".length).trim();
  if (targetVideoId === "") {
    return null;
  }

  const rawEvents = getLatestConsumptionEvents(db);
  const { kept } = partitionYoutubeEvents(
    dedupeConsumption(rawEvents, tz),
    { tz, db }
  );

  const matching = kept.filter((ev) => {
    if (categoryOf(ev) !== "youtube") {
      return false;
    }
    const vid = getEventYoutubeVideoId(ev) ?? ev.source_id ?? String(ev.id);
    return vid === targetVideoId;
  });

  if (matching.length === 0) {
    return null;
  }

  matching.sort(
    (a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id
  );

  const enrichmentMap = readYoutubeEnrichmentByVideoId(db);
  const channelTopics = getChannelTopicsMap(db);
  const workTopicOverrides = readWorkTopicOverrides(db);
  const enr = enrichmentMap.get(targetVideoId);

  let title = enr?.title ?? targetVideoId;
  let channel: string | null = enr?.channel ?? null;
  let coverUrl: string | null = isValidYoutubeVideoId(targetVideoId)
    ? `/api/thumb/youtube/${targetVideoId}`
    : null;
  let totalSeconds = 0;
  const sourceSet = new Set<string>();

  for (const ev of matching) {
    if (ev.title && ev.title.trim() !== "") {
      title = ev.title.trim();
    }
    if (ev.parent_title && ev.parent_title.trim() !== "") {
      channel = ev.parent_title.trim();
    }
    const c = coverUrlFor(ev);
    if (c !== null) {
      coverUrl = c;
    }
    totalSeconds += ev.duration_seconds ?? 0;
    sourceSet.add(ev.source);
  }

  const topic = resolveVideoTopic({
    videoKey: key,
    videoId: targetVideoId,
    videoTitle: title,
    channel,
    youtubeCategory: enr?.genre ?? null,
    channelTopics,
    workTopicOverrides,
  });

  const history = [...matching]
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id - a.id)
    .map((ev) => ({
      started_at: ev.started_at,
      precision: eventPrecision(ev) as DatePrecision,
      label: ev.title?.trim() || title,
      minutes: (ev.duration_seconds ?? 0) / 60,
      source: ev.source,
      entry_id: null,
    }));

  const overridesMap = getWorkOverrides(db);
  const override = overridesMap.get(key);
  const edited =
    Boolean(override?.edited) ||
    workTopicOverrides.has(key) ||
    workTopicOverrides.has(targetVideoId);

  const effectiveTitle = override?.title ?? title;

  return {
    key,
    category: override?.category ?? "youtube",
    title: effectiveTitle,
    cover_url: coverUrl,
    total_minutes: totalSeconds / 60,
    units: matching.length,
    first_at: matching[0]?.started_at ?? null,
    last_at: matching[matching.length - 1]?.started_at ?? null,
    status: override?.status ?? "unknown",
    rating: override?.rating ?? null,
    progress: null,
    creator: channel,
    sources: Array.from(sourceSet).sort((a, b) => a.localeCompare(b)),
    edited,
    channel,
    topic,
    seasons: [],
    history,
    note: override?.note ?? null,
  };
}

// --- Overview & Videos aggregation ------------------------------------------

interface VideoInternal {
  video: YoutubeVideo;
  channelId: string | null;
  youtubeCategory: string | null;
}

interface YoutubeDataset {
  videos: VideoInternal[];
  keptEvents: ConsumptionEvent[];
  shortPlaysHidden: number;
  minWatchMinutes: number;
  channelTopics: Map<string, string | null>;
  workTopicOverrides: Map<string, string | null>;
}

function buildYoutubeDataset(
  db: Database,
  opts: {
    from?: string | null;
    to?: string | null;
    tz?: string;
    minWatchMinutes?: number;
  }
): YoutubeDataset {
  const tz = opts.tz ?? "Europe/Bratislava";
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const minWatchMinutes =
    opts.minWatchMinutes ?? getYoutubeMinWatchMinutesForDb(db);

  const allRaw = getLatestConsumptionEvents(db);
  const youtubeRaw = allRaw.filter((ev) => {
    if (!CONSUMPTION_KINDS.has(ev.source_kind)) {
      return false;
    }
    if (categoryOf(ev) !== "youtube") {
      return false;
    }
    if ((from !== null || to !== null) && eventPrecision(ev) === "unknown") {
      return false;
    }
    if (from !== null || to !== null) {
      const localDate = formatLocalParts(ev.started_at, tz).date;
      if (from !== null && localDate < from) {
        return false;
      }
      if (to !== null && localDate > to) {
        return false;
      }
    }
    return true;
  });

  const deduped = dedupeConsumption(youtubeRaw, tz);
  const { kept, shortVideoDaysHidden } = partitionYoutubeEvents(deduped, {
    tz,
    db,
    minWatchMinutes,
  });

  const enrichmentMap = readYoutubeEnrichmentByVideoId(db);
  const channelTopics = getChannelTopicsMap(db);
  const workTopicOverrides = readWorkTopicOverrides(db);

  // Group kept events by videoId
  const eventsByVideoId = new Map<string, ConsumptionEvent[]>();
  for (const ev of kept) {
    const vid =
      getEventYoutubeVideoId(ev) ??
      (ev.title?.trim() ? `title:${normalizeForSearch(ev.title)}` : null) ??
      ev.source_id ??
      String(ev.id);
    let list = eventsByVideoId.get(vid);
    if (!list) {
      list = [];
      eventsByVideoId.set(vid, list);
    }
    list.push(ev);
  }

  const videos: VideoInternal[] = [];

  for (const [vidKey, evList] of eventsByVideoId.entries()) {
    evList.sort(
      (a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id
    );

    const rawVideoId = getEventYoutubeVideoId(evList[0]!) ?? vidKey;
    const enr = enrichmentMap.get(rawVideoId);

    let title: string | null = enr?.title ?? null;
    let channel: string | null = enr?.channel ?? null;
    let channelId: string | null = enr?.channel_id ?? null;
    let watchedSeconds = 0;

    for (const ev of evList) {
      if (ev.title && ev.title.trim() !== "") {
        title = ev.title.trim();
      }
      if (ev.parent_title && ev.parent_title.trim() !== "") {
        channel = ev.parent_title.trim();
      }
      const ext = parseExternalIds(ev.external_ids);
      const extChannel = ext?.["youtube_channel"];
      if (typeof extChannel === "string" && extChannel.trim() !== "") {
        channelId = extChannel.trim();
      }
      watchedSeconds += ev.duration_seconds ?? 0;
    }

    const finalTitle = title ?? rawVideoId;
    const workKey = `youtube:video:${rawVideoId}`;
    const youtubeCategory = enr?.genre ?? null;
    const topic = resolveVideoTopic({
      videoKey: workKey,
      videoId: rawVideoId,
      videoTitle: finalTitle,
      channel,
      youtubeCategory,
      channelTopics,
      workTopicOverrides,
    });

    const thumbnailUrl = isValidYoutubeVideoId(rawVideoId)
      ? `/api/thumb/youtube/${rawVideoId}`
      : null;

    videos.push({
      video: {
        key: workKey,
        video_id: rawVideoId,
        title: finalTitle,
        channel,
        topic,
        watched_minutes: watchedSeconds / 60,
        plays: evList.length,
        first_at: evList[0]!.started_at,
        last_at: evList[evList.length - 1]!.started_at,
        thumbnail_url: thumbnailUrl,
      },
      channelId,
      youtubeCategory,
    });
  }

  return {
    videos,
    keptEvents: kept,
    shortPlaysHidden: shortVideoDaysHidden,
    minWatchMinutes,
    channelTopics,
    workTopicOverrides,
  };
}

export interface GetYoutubeOverviewOptions {
  from?: string | null;
  to?: string | null;
  tz?: string;
  minWatchMinutes?: number;
}

export function getYoutubeOverview(
  db: Database,
  opts: GetYoutubeOverviewOptions = {}
): YoutubeOverview {
  const tz = opts.tz ?? "Europe/Bratislava";
  const from = opts.from && opts.from !== "" ? opts.from : null;
  const to = opts.to && opts.to !== "" ? opts.to : null;

  const dataset = buildYoutubeDataset(db, {
    from,
    to,
    tz,
    minWatchMinutes: opts.minWatchMinutes,
  });

  let totalMinutes = 0;
  for (const v of dataset.videos) {
    totalMinutes += v.video.watched_minutes;
  }

  // Group into channels
  const channelAcc = new Map<
    string,
    {
      displayName: string;
      latestAt: string;
      channelId: string | null;
      videos: number;
      totalMinutes: number;
      categoryItems: Array<{ topic: string | null; minutes: number }>;
    }
  >();

  for (const item of dataset.videos) {
    const { video, channelId, youtubeCategory } = item;
    if (!video.channel || video.channel.trim() === "") {
      continue;
    }
    const normChan = normalizeChannelKey(video.channel);
    let acc = channelAcc.get(normChan);
    if (!acc) {
      acc = {
        displayName: video.channel,
        latestAt: video.last_at,
        channelId: channelId,
        videos: 0,
        totalMinutes: 0,
        categoryItems: [],
      };
      channelAcc.set(normChan, acc);
    }
    if (video.last_at >= acc.latestAt) {
      acc.latestAt = video.last_at;
      acc.displayName = video.channel;
      if (channelId) {
        acc.channelId = channelId;
      }
    } else if (!acc.channelId && channelId) {
      acc.channelId = channelId;
    }
    acc.videos += 1;
    acc.totalMinutes += video.watched_minutes;
    acc.categoryItems.push({
      topic: youtubeCategory ?? video.topic,
      minutes: video.watched_minutes,
    });
  }

  const channels: YoutubeChannel[] = [];
  for (const [normChan, acc] of channelAcc.entries()) {
    let chanTopic: string | null = null;
    const workOverride = dataset.workTopicOverrides.get(`youtube:${normChan}`);
    if (typeof workOverride === "string" && workOverride.trim() !== "") {
      chanTopic = workOverride.trim();
    } else {
      const userChanTopic = dataset.channelTopics.get(normChan);
      if (typeof userChanTopic === "string" && userChanTopic.trim() !== "") {
        chanTopic = userChanTopic.trim();
      } else {
        chanTopic = mostCommonTopic(acc.categoryItems);
      }
    }

    channels.push({
      channel: acc.displayName,
      channel_id: acc.channelId,
      topic: chanTopic,
      videos: acc.videos,
      total_minutes: acc.totalMinutes,
      last_at: acc.latestAt,
    });
  }

  channels.sort(
    (a, b) =>
      b.total_minutes - a.total_minutes ||
      b.videos - a.videos ||
      a.channel.localeCompare(b.channel)
  );

  // Group into topics
  const topicAcc = new Map<
    string,
    {
      topic: string;
      channelSet: Set<string>;
      videos: number;
      totalMinutes: number;
    }
  >();

  for (const { video } of dataset.videos) {
    if (!video.topic || video.topic.trim() === "") {
      continue;
    }
    const t = video.topic.trim();
    let acc = topicAcc.get(t);
    if (!acc) {
      acc = {
        topic: t,
        channelSet: new Set(),
        videos: 0,
        totalMinutes: 0,
      };
      topicAcc.set(t, acc);
    }
    if (video.channel && video.channel.trim() !== "") {
      acc.channelSet.add(normalizeChannelKey(video.channel));
    }
    acc.videos += 1;
    acc.totalMinutes += video.watched_minutes;
  }

  const topics: YoutubeTopic[] = Array.from(topicAcc.values())
    .map((acc) => ({
      topic: acc.topic,
      channels: acc.channelSet.size,
      videos: acc.videos,
      total_minutes: acc.totalMinutes,
    }))
    .sort(
      (a, b) =>
        b.total_minutes - a.total_minutes ||
        b.videos - a.videos ||
        a.topic.localeCompare(b.topic)
    );

  // Build days sparkline only when both from and to are given
  let days: SeriesPoint[] = [];
  if (from !== null && to !== null) {
    const dayBuckets = enumerateDayBuckets(from, to);
    const minutesByDay = new Map<string, number>();
    for (const ev of dataset.keptEvents) {
      if (eventPrecision(ev) !== "day") {
        continue;
      }
      const localDate = formatLocalParts(ev.started_at, tz).date;
      if (localDate < from || localDate > to) {
        continue;
      }
      const mins = (ev.duration_seconds ?? 0) / 60;
      if (mins > 0) {
        minutesByDay.set(localDate, (minutesByDay.get(localDate) ?? 0) + mins);
      }
    }
    days = dayBuckets.map((d) => {
      const mins = minutesByDay.get(d) ?? 0;
      return {
        bucket: d,
        minutes_by_category: mins > 0 ? { youtube: mins } : {},
      };
    });
  }

  return {
    from,
    to,
    total_minutes: totalMinutes,
    videos: dataset.videos.length,
    topics,
    channels,
    days,
    short_plays_hidden: dataset.shortPlaysHidden,
    min_watch_minutes: dataset.minWatchMinutes,
  };
}

export type YoutubeVideosSort = "recent" | "time" | "topic";

export const VALID_YOUTUBE_VIDEO_SORTS: ReadonlySet<YoutubeVideosSort> = new Set([
  "recent",
  "time",
  "topic",
]);

export function isValidYoutubeVideosSort(
  value: unknown
): value is YoutubeVideosSort {
  return (
    typeof value === "string" &&
    VALID_YOUTUBE_VIDEO_SORTS.has(value as YoutubeVideosSort)
  );
}

export interface GetYoutubeVideosOptions {
  channel?: string | null;
  topic?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
  sort?: YoutubeVideosSort;
  limit?: number;
  offset?: number;
  tz?: string;
  minWatchMinutes?: number;
}

export function getYoutubeVideos(
  db: Database,
  opts: GetYoutubeVideosOptions = {}
): YoutubeVideosResult {
  const tz = opts.tz ?? "Europe/Bratislava";
  const from = opts.from && opts.from !== "" ? opts.from : null;
  const to = opts.to && opts.to !== "" ? opts.to : null;
  const sort = opts.sort ?? "recent";
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const dataset = buildYoutubeDataset(db, {
    from,
    to,
    tz,
    minWatchMinutes: opts.minWatchMinutes,
  });

  let filtered = dataset.videos.map((v) => v.video);

  if (opts.channel !== undefined && opts.channel !== null && opts.channel.trim() !== "") {
    const wantedChan = normalizeChannelKey(opts.channel);
    filtered = filtered.filter(
      (v) => v.channel !== null && normalizeChannelKey(v.channel) === wantedChan
    );
  }

  if (opts.topic !== undefined && opts.topic !== null && opts.topic.trim() !== "") {
    const wantedTopic = normalizeForSearch(opts.topic);
    filtered = filtered.filter(
      (v) => v.topic !== null && normalizeForSearch(v.topic) === wantedTopic
    );
  }

  if (opts.q !== undefined && opts.q !== null && opts.q.trim() !== "") {
    const normQ = normalizeForSearch(opts.q);
    if (normQ !== "") {
      const words = normQ.split(" ").filter((w) => w !== "");
      filtered = filtered.filter((v) => {
        const haystack = normalizeForSearch(
          [v.title, v.channel ?? "", v.topic ?? "", v.video_id].join(" ")
        );
        return words.every((w) => haystack.includes(w));
      });
    }
  }

  if (sort === "time") {
    filtered.sort(
      (a, b) =>
        b.watched_minutes - a.watched_minutes ||
        b.plays - a.plays ||
        b.last_at.localeCompare(a.last_at) ||
        a.title.localeCompare(b.title)
    );
  } else if (sort === "topic") {
    filtered.sort((a, b) => {
      const ta = a.topic?.trim() ?? "";
      const tb = b.topic?.trim() ?? "";
      if (ta === "" && tb !== "") return 1;
      if (ta !== "" && tb === "") return -1;
      return (
        ta.localeCompare(tb) ||
        b.watched_minutes - a.watched_minutes ||
        a.title.localeCompare(b.title)
      );
    });
  } else {
    // "recent" (default): newest first (by last_at desc, then watched_minutes desc, then title asc)
    filtered.sort(
      (a, b) =>
        b.last_at.localeCompare(a.last_at) ||
        b.watched_minutes - a.watched_minutes ||
        a.title.localeCompare(b.title)
    );
  }

  const total = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  return {
    videos: paged,
    total,
  };
}

/**
 * Register YouTube v2.1 routes on `app`:
 * - `GET /api/youtube`
 * - `GET /api/youtube/videos`
 * - `POST /api/youtube/channel-topic`
 */
export function registerYoutubeRoutes(app: Hono, deps: AppDeps): void {
  const { db, config } = deps;
  const tz = config.timezone;

  setYoutubeConfigForDb(db, config);

  // GET /api/youtube?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get("/api/youtube", (c) => {
    const err = validateQueryParams(c.req.url, ["from", "to"]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const fromRaw = c.req.query("from");
    const from = fromRaw && fromRaw !== "" ? fromRaw : null;
    if (from !== null && !isValidDateStr(from)) {
      return c.json(
        { error: `Invalid from date format: '${from}' (expected YYYY-MM-DD)` },
        400
      );
    }

    const toRaw = c.req.query("to");
    const to = toRaw && toRaw !== "" ? toRaw : null;
    if (to !== null && !isValidDateStr(to)) {
      return c.json(
        { error: `Invalid to date format: '${to}' (expected YYYY-MM-DD)` },
        400
      );
    }

    if (from !== null && to !== null && from > to) {
      return c.json({ error: "'from' date must not be after 'to' date" }, 400);
    }

    const result = getYoutubeOverview(db, {
      from,
      to,
      tz,
      minWatchMinutes: config.youtube?.min_watch_minutes ?? 5,
    });
    return c.json(result);
  });

  // GET /api/youtube/videos?channel=&topic=&from=&to=&q=&sort=recent|time|topic&limit=50&offset=0
  app.get("/api/youtube/videos", (c) => {
    const err = validateQueryParams(c.req.url, [
      "channel",
      "topic",
      "from",
      "to",
      "q",
      "sort",
      "limit",
      "offset",
    ]);
    if (err) {
      return c.json({ error: err }, 400);
    }

    const sortRaw = c.req.query("sort");
    let sort: YoutubeVideosSort = "recent";
    if (sortRaw !== undefined && sortRaw !== "") {
      if (!isValidYoutubeVideosSort(sortRaw)) {
        return c.json(
          {
            error: `Invalid sort: '${sortRaw}' (expected recent, time or topic)`,
          },
          400
        );
      }
      sort = sortRaw;
    }

    const fromRaw = c.req.query("from");
    const from = fromRaw && fromRaw !== "" ? fromRaw : null;
    if (from !== null && !isValidDateStr(from)) {
      return c.json(
        { error: `Invalid from date format: '${from}' (expected YYYY-MM-DD)` },
        400
      );
    }

    const toRaw = c.req.query("to");
    const to = toRaw && toRaw !== "" ? toRaw : null;
    if (to !== null && !isValidDateStr(to)) {
      return c.json(
        { error: `Invalid to date format: '${to}' (expected YYYY-MM-DD)` },
        400
      );
    }

    if (from !== null && to !== null && from > to) {
      return c.json({ error: "'from' date must not be after 'to' date" }, 400);
    }

    const q = c.req.query("q");
    if (q !== undefined && q.length > 200) {
      return c.json(
        { error: `Invalid q: too long (${q.length} characters, max 200)` },
        400
      );
    }

    const channel = c.req.query("channel");
    if (channel !== undefined && channel.length > 200) {
      return c.json(
        { error: `Invalid channel: too long (${channel.length} characters, max 200)` },
        400
      );
    }

    const topic = c.req.query("topic");
    if (topic !== undefined && topic.length > 100) {
      return c.json(
        { error: `Invalid topic: too long (${topic.length} characters, max 100)` },
        400
      );
    }

    const limitRaw = c.req.query("limit");
    let limit = 50;
    if (limitRaw !== undefined && limitRaw !== "") {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 200) {
        return c.json(
          { error: `Invalid limit: '${limitRaw}' (expected integer 1..200)` },
          400
        );
      }
      limit = Number(limitRaw);
    }

    const offsetRaw = c.req.query("offset");
    let offset = 0;
    if (offsetRaw !== undefined && offsetRaw !== "") {
      if (!/^\d+$/.test(offsetRaw)) {
        return c.json(
          { error: `Invalid offset: '${offsetRaw}' (expected a non-negative integer)` },
          400
        );
      }
      offset = Number(offsetRaw);
    }

    const result = getYoutubeVideos(db, {
      channel,
      topic,
      from,
      to,
      q,
      sort,
      limit,
      offset,
      tz,
      minWatchMinutes: config.youtube?.min_watch_minutes ?? 5,
    });
    return c.json(result);
  });

  // POST /api/youtube/channel-topic
  app.post("/api/youtube/channel-topic", async (c) => {
    const err = validateQueryParams(c.req.url, []);
    if (err) {
      return c.json({ error: err }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (caught) {
      return c.json(
        {
          error: `Invalid JSON body: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        },
        400
      );
    }

    try {
      const result = setChannelTopic(db, body);
      return c.json(result);
    } catch (caught) {
      if (caught instanceof YoutubeValidationError) {
        return c.json({ error: caught.message }, 400);
      }
      throw caught;
    }
  });
}
