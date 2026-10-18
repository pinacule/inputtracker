/**
 * Read-only search over titles, series, authors and YouTube channels (Z03).
 *
 * Rules (same as `insights.ts` / `year-review.ts`):
 * - Events come from `getLatestConsumptionEvents` (reads `events_latest`,
 *   consumption kinds only). The pure functions filter by `CONSUMPTION_KINDS`
 *   again so they stay correct for any input.
 * - Grouping is exactly like Stats "top items": same `source` +
 *   `getSeriesOrTitle(event)`, so ten listening sessions of one book are one
 *   hit and every episode of a show is one hit. A YouTube "title" group is one
 *   video (videos have no season/episode, so the title is the video title).
 * - Local dates come from `formatLocalParts`; no other timezone math.
 * - Minutes = `duration_seconds / 60` (null -> 0 minutes, still 1 item).
 * - No SQL is built from user input: matching happens in memory over the
 *   events the helpers return, in a single pass, so a 100 000-event archive
 *   still searches fast (normalization per group, not per query).
 * - Nothing here writes to the database.
 *
 * Match fields (reported in this order, deduped):
 * - "title":   the group title, `getSeriesOrTitle(event)`.
 * - "series":  `parent_title` of a series-like event (show / podcast name).
 *              For episode groups the series name IS the group title, so such
 *              a group reports both "title" and "series".
 * - "parent":  `parent_title` of a non-series event on another source
 *              (e.g. the author of an audiobook).
 * - "channel": `parent_title` of a YouTube event.
 *
 * YouTube channels additionally appear as their own hit (key
 * `youtube-channel\u0000<channel>`) when the query matches the channel name,
 * with counts over all of that channel's views.
 */

import type { Database } from "bun:sqlite";
import { categoryOf } from "../core/category.ts";
import {
  CONSUMPTION_KINDS,
  coverUrlFor,
  formatLocalParts,
  getDisplayConsumptionEvents,
  getSeriesOrTitle,
  type ConsumptionEvent,
} from "./aggregate.ts";
import { getAnnotation } from "./annotations.ts";
import {
  type CategoryFilter,
  matchesCategoryFilter,
} from "./overrides.ts";

/** Combining diacritical marks (Unicode range) stripped by `normalizeForSearch`. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Lowercase, Unicode NFD with combining marks removed, whitespace collapsed,
 * trimmed. "Šťastný  Deň" -> "stastny den". Used for both the query and the
 * haystack.
 */
export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type MatchField = "title" | "series" | "parent" | "channel";

/** Canonical reporting order of the match fields. */
const MATCH_FIELDS: readonly MatchField[] = [
  "title",
  "series",
  "parent",
  "channel",
];

export interface SearchHit {
  /** Stable id of the group: `${source}\u0000${group title}` (opaque to the web). */
  key: string;
  /** `getSeriesOrTitle(event)`: series title for episodes, else the title. */
  title: string;
  source: string;
  /** Of the most recent event in the group. */
  media_type: string | null;
  /** Which fields matched (deduped, in the order above). */
  matched: MatchField[];
  /** parent_title (author / channel) of the most recent event, or null. */
  subtitle: string | null;
  /** Events in the group. */
  count: number;
  minutes: number;
  /** Local "YYYY-MM-DD" of the earliest event. */
  first_date: string;
  /** Local "YYYY-MM-DD" of the latest event. */
  last_date: string;
  /** From the most recent event that has one. */
  cover_url: string | null;
}

export interface SearchResult {
  query: string;
  /** Number of hits before `limit`/`offset`. */
  total: number;
  hits: SearchHit[];
}

export interface SearchOptions {
  q: string;
  source?: string;
  media_type?: string;
  limit: number;
  offset: number;
}

export interface TitleHistoryItem {
  id: number;
  started_at: string;
  /** Local "YYYY-MM-DD" of the event. */
  local_date: string;
  /** Local "HH:mm". */
  local_time: string;
  media_type: string | null;
  season: number | null;
  episode: number | null;
  minutes: number;
  /** The raw event title (e.g. YouTube video / episode name). */
  event_title: string | null;
}

export interface TitleHistory {
  key: string;
  title: string;
  source: string;
  subtitle: string | null;
  cover_url: string | null;
  count: number;
  minutes: number;
  /** Newest first, capped at 500 (count/minutes still cover all events). */
  items: TitleHistoryItem[];
  /**
   * Latest rating (1–10) for this title, or null when unrated. Always set by
   * `getTitleHistory` (the pure `titleHistory` below leaves it null: it does
   * no annotation lookup).
   */
  rating: number | null;
}

/** Key prefix of a YouTube channel hit. */
export const CHANNEL_KEY_PREFIX = "youtube-channel\u0000";

/** True when the event is an episode/show/podcast entry (its title is an episode name). */
function isSeriesLike(event: ConsumptionEvent): boolean {
  return (
    event.media_type === "episode" ||
    event.media_type === "show" ||
    event.media_type === "podcast" ||
    event.media_type === "podcast_episode" ||
    (event.season !== null && event.season !== undefined) ||
    (event.episode !== null && event.episode !== undefined)
  );
}

/**
 * Which match field the event's `parent_title` feeds: the channel for YouTube,
 * the series/show name for episodes, otherwise the parent (e.g. author).
 */
function parentField(event: ConsumptionEvent): MatchField {
  if (event.source === "youtube") {
    return "channel";
  }
  return isSeriesLike(event) ? "series" : "parent";
}

/** Latest of two events by (started_at, id) — matches the db's ASC ordering. */
function isAfter(a: ConsumptionEvent, b: ConsumptionEvent): boolean {
  return (
    a.started_at > b.started_at ||
    (a.started_at === b.started_at && a.id > b.id)
  );
}

/** Earliest of two events by (started_at, id). */
function isBefore(a: ConsumptionEvent, b: ConsumptionEvent): boolean {
  return isAfter(b, a);
}

/** Mutable accumulator for one title group (and one YouTube channel group). */
interface GroupAcc {
  key: string;
  title: string;
  source: string;
  /** Normalized group title, computed once per group. */
  normalizedTitle: string;
  count: number;
  seconds: number;
  earliest: ConsumptionEvent | null;
  latest: ConsumptionEvent | null;
  /** Latest event that has a cover, for `cover_url`. */
  latestCovered: ConsumptionEvent | null;
  /** Normalized parent_title -> match fields it feeds (e.g. author AND channel). */
  parents: Map<string, Set<MatchField>>;
}

function newGroup(
  key: string,
  title: string,
  source: string,
  normalize: (s: string) => string
): GroupAcc {
  return {
    key,
    title,
    source,
    normalizedTitle: normalize(title),
    count: 0,
    seconds: 0,
    earliest: null,
    latest: null,
    latestCovered: null,
    parents: new Map(),
  };
}

function addEventToGroup(
  group: GroupAcc,
  event: ConsumptionEvent,
  normalize: (s: string) => string
): void {
  group.count += 1;
  group.seconds += event.duration_seconds ?? 0;
  if (group.earliest === null || isBefore(event, group.earliest)) {
    group.earliest = event;
  }
  if (group.latest === null || isAfter(event, group.latest)) {
    group.latest = event;
  }
  if (coverUrlFor(event) !== null) {
    if (group.latestCovered === null || isAfter(event, group.latestCovered)) {
      group.latestCovered = event;
    }
  }
  const parent = event.parent_title?.trim();
  if (parent) {
    const normalized = normalize(parent);
    if (normalized !== "") {
      let fields = group.parents.get(normalized);
      if (!fields) {
        fields = new Set();
        group.parents.set(normalized, fields);
      }
      fields.add(parentField(event));
    }
  }
}

function groupCoverUrl(group: GroupAcc): string | null {
  return group.latestCovered !== null ? coverUrlFor(group.latestCovered) : null;
}

/** Fields matched by `needle` (a full query or a single word) in the group. */
function fieldsMatching(
  group: GroupAcc,
  needle: string
): Set<MatchField> {
  const matched = new Set<MatchField>();
  if (needle === "") {
    return matched;
  }
  if (group.normalizedTitle.includes(needle)) {
    matched.add("title");
  }
  for (const [normalized, fields] of group.parents) {
    if (normalized.includes(needle)) {
      for (const field of fields) {
        matched.add(field);
      }
    }
  }
  return matched;
}

/** Canonical order for the `matched` array. */
function orderFields(matched: Set<MatchField>): MatchField[] {
  return MATCH_FIELDS.filter((field) => matched.has(field));
}

/**
 * Pure search over consumption events. Multi-word queries match with AND in
 * any order: every word must be a substring of at least one of the group's
 * fields. `matched` lists the fields matching the whole query; when the words
 * only match across different fields, it lists the per-word fields instead.
 * An empty or 1-character query (after normalization) returns
 * `{ total: 0, hits: [] }`, not an error.
 */
export function searchEvents(
  events: readonly ConsumptionEvent[],
  tz: string,
  opts: SearchOptions
): SearchResult {
  const query = opts.q;
  const sourceFilter = opts.source;
  const mediaTypeFilter = opts.media_type;

  const normalizedQuery = normalizeForSearch(query);
  if (normalizedQuery.length < 2) {
    return { query, total: 0, hits: [] };
  }
  const words = normalizedQuery.split(" ").filter((w) => w !== "");

  // Normalization memo: parent/channel strings repeat heavily in a big
  // archive (100 000+ views of a few hundred channels), so normalize each
  // distinct string once per search.
  const normCache = new Map<string, string>();
  const norm = (s: string): string => {
    let value = normCache.get(s);
    if (value === undefined) {
      value = normalizeForSearch(s);
      normCache.set(s, value);
    }
    return value;
  };

  const groups = new Map<string, GroupAcc>();
  const channels = new Map<string, GroupAcc>();

  for (const event of events) {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      continue;
    }
    if (sourceFilter !== undefined && sourceFilter !== "" && event.source !== sourceFilter) {
      continue;
    }
    if (mediaTypeFilter !== undefined && mediaTypeFilter !== "" && event.media_type !== mediaTypeFilter) {
      continue;
    }

    const title = getSeriesOrTitle(event);
    const key = `${event.source}\u0000${title}`;
    let group = groups.get(key);
    if (!group) {
      group = newGroup(key, title, event.source, norm);
      groups.set(key, group);
    }
    addEventToGroup(group, event, norm);

    // YouTube channels additionally accumulate over all of their views.
    if (event.source === "youtube") {
      const channel = event.parent_title?.trim();
      if (channel) {
        const normalizedChannel = norm(channel);
        let channelGroup = channels.get(normalizedChannel);
        if (!channelGroup) {
          channelGroup = newGroup(
            `${CHANNEL_KEY_PREFIX}${channel}`,
            channel,
            event.source,
            norm
          );
          channels.set(normalizedChannel, channelGroup);
        }
        addEventToGroup(channelGroup, event, norm);
      }
    }
  }

  interface Ranked {
    group: GroupAcc;
    matched: MatchField[];
    tier: number;
    /** Channel hits show the fixed "YouTube channel" subtitle. */
    isChannel: boolean;
  }
  const ranked: Ranked[] = [];

  const consider = (group: GroupAcc): void => {
    // AND across words, in any order: every word must match somewhere.
    let allWords = true;
    const perWord = new Set<MatchField>();
    for (const word of words) {
      const fields = fieldsMatching(group, word);
      if (fields.size === 0) {
        allWords = false;
        break;
      }
      for (const field of fields) {
        perWord.add(field);
      }
    }
    if (!allWords) {
      return;
    }
    // Prefer fields matching the whole query; fall back to per-word fields.
    const full = fieldsMatching(group, normalizedQuery);
    const matched = orderFields(full.size > 0 ? full : perWord);

    // Tier 0: title starts with the query; 1: title contains it; 2: rest.
    let tier = 2;
    if (group.normalizedTitle.startsWith(normalizedQuery)) {
      tier = 0;
    } else if (group.normalizedTitle.includes(normalizedQuery)) {
      tier = 1;
    }
    ranked.push({ group, matched, tier, isChannel: false });
  };

  for (const group of groups.values()) {
    consider(group);
  }
  // The channel hit only exists when the query matches the channel name.
  for (const channelGroup of channels.values()) {
    const channelFields = fieldsMatching(channelGroup, normalizedQuery);
    if (channelFields.has("channel")) {
      ranked.push({
        group: channelGroup,
        matched: ["channel"],
        tier: channelGroup.normalizedTitle.startsWith(normalizedQuery)
          ? 0
          : channelGroup.normalizedTitle.includes(normalizedQuery)
            ? 1
            : 2,
        isChannel: true,
      });
    }
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    const lastA = a.group.latest?.started_at ?? "";
    const lastB = b.group.latest?.started_at ?? "";
    if (lastA !== lastB) {
      return lastA < lastB ? 1 : -1; // last_date desc
    }
    if (a.group.count !== b.group.count) {
      return b.group.count - a.group.count;
    }
    return a.group.title.localeCompare(b.group.title);
  });

  const toHit = (ranked: Ranked): SearchHit => {
    const group = ranked.group;
    return {
      key: group.key,
      title: group.title,
      source: group.source,
      media_type: group.latest?.media_type ?? null,
      matched: ranked.matched,
      subtitle: ranked.isChannel
        ? "YouTube channel"
        : group.latest?.parent_title?.trim() || null,
      count: group.count,
      minutes: group.seconds / 60,
      first_date: group.earliest
        ? formatLocalParts(group.earliest.started_at, tz).date
        : "",
      last_date: group.latest
        ? formatLocalParts(group.latest.started_at, tz).date
        : "",
      cover_url: groupCoverUrl(group),
    };
  };

  const total = ranked.length;
  const hits = ranked.slice(opts.offset, opts.offset + opts.limit).map(toHit);

  return { query, total, hits };
}

/**
 * Full history of one search hit (a title group or a YouTube channel).
 * `key` is the opaque `SearchHit.key`. Returns null for an unknown key.
 * Items are newest first, capped at 500; `count`/`minutes` still cover all
 * events in the group.
 */
export function titleHistory(
  events: readonly ConsumptionEvent[],
  tz: string,
  key: string
): TitleHistory | null {
  const sep = key.indexOf("\u0000");
  if (sep <= 0) {
    return null;
  }
  const keySource = key.slice(0, sep);
  const keyTitle = key.slice(sep + 1);
  if (keyTitle === "") {
    return null;
  }
  const isChannel = keySource === "youtube-channel";

  const matching = events.filter((event) => {
    if (!CONSUMPTION_KINDS.has(event.source_kind)) {
      return false;
    }
    if (isChannel) {
      return event.source === "youtube" && event.parent_title?.trim() === keyTitle;
    }
    return event.source === keySource && getSeriesOrTitle(event) === keyTitle;
  });
  if (matching.length === 0) {
    return null;
  }

  const group = newGroup(key, keyTitle, isChannel ? "youtube" : keySource, normalizeForSearch);
  for (const event of matching) {
    addEventToGroup(group, event, normalizeForSearch);
  }

  const items: TitleHistoryItem[] = [...matching]
    .sort((a, b) =>
      a.started_at < b.started_at
        ? 1
        : a.started_at > b.started_at
          ? -1
          : b.id - a.id
    )
    .slice(0, 500)
    .map((event) => {
      const local = formatLocalParts(event.started_at, tz);
      return {
        id: event.id,
        started_at: event.started_at,
        local_date: local.date,
        local_time: local.localTime,
        media_type: event.media_type ?? null,
        season: event.season ?? null,
        episode: event.episode ?? null,
        minutes: (event.duration_seconds ?? 0) / 60,
        event_title: event.title ?? null,
      };
    });

  return {
    key,
    title: group.title,
    source: group.source,
    subtitle: isChannel ? "YouTube channel" : group.latest?.parent_title?.trim() || null,
    cover_url: groupCoverUrl(group),
    count: group.count,
    minutes: group.seconds / 60,
    items,
    // No annotation lookup here; `getTitleHistory` fills in the real rating.
    rating: null,
  };
}

// --- Database wrappers ------------------------------------------------------

export interface GetSearchOptions extends SearchOptions {
  tz: string;
  categoryFilter?: CategoryFilter;
}

/** Reads consumption events through `getDisplayConsumptionEvents` and searches them. */
export function search(db: Database, opts: GetSearchOptions): SearchResult {
  let events = getDisplayConsumptionEvents(db, opts.source, opts.tz);
  if (opts.categoryFilter) {
    events = events.filter((e) =>
      matchesCategoryFilter(categoryOf(e), opts.categoryFilter)
    );
  }
  return searchEvents(events, opts.tz, {
    q: opts.q,
    source: opts.source,
    media_type: opts.media_type,
    limit: opts.limit,
    offset: opts.offset,
  });
}

export interface GetTitleHistoryOptions {
  tz: string;
  key: string;
}

/**
 * Reads consumption events (filtered by the source encoded in the key, when
 * it is known) and returns the title history, or null for an unknown key.
 * The returned history carries the title's latest rating (one lookup).
 */
export function getTitleHistory(
  db: Database,
  opts: GetTitleHistoryOptions
): TitleHistory | null {
  const sep = opts.key.indexOf("\u0000");
  const source =
    sep > 0
      ? opts.key.slice(0, sep) === "youtube-channel"
        ? "youtube"
        : opts.key.slice(0, sep)
      : undefined;
  const events = getDisplayConsumptionEvents(
    db,
    source !== undefined && source !== "" ? source : undefined,
    opts.tz
  );
  const history = titleHistory(events, opts.tz, opts.key);
  if (history === null) {
    return null;
  }
  // One annotation lookup for the single title in this response.
  const annotation = getAnnotation(db, history.source, history.title);
  return { ...history, rating: annotation.rating };
}
