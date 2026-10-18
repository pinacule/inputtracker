/**
 * Library aggregation (v2 section 3): works joined across all sources, grouped
 * by category (`GET /api/library`, `GET /api/library/work`).
 *
 * Rules:
 * - Reads `events_latest` via `getDisplayConsumptionEvents` (deduped with
 *   `dedupeConsumption`, tombstones hidden by migration v4).
 * - A work joins events in the same category that share a normalized
 *   series-or-title (`getSeriesOrTitle` + `normalizeForSearch`) or an external
 *   id (`anilist`, `mal`, `imdb`, `tvmaze`, `abs_item`, `meta_id`).
 * - YouTube works are channels (`LibraryWork.title` = channel name,
 *   `units` = videos); the work detail lists the videos in `history`.
 */

import type { Database } from "bun:sqlite";
import { CATEGORIES, categoryOf, type Category } from "../core/category.ts";
import type {
  CategoryTotal,
  DatePrecision,
  LibraryResult,
  LibraryWork,
  LibraryWorkDetail,
  SeasonInfo,
  WorkStatus,
} from "../core/contract.ts";
import {
  coverUrlFor,
  eventPrecision,
  getDisplayConsumptionEvents,
  getSeriesOrTitle,
  parseExternalIds,
  parseJsonObject,
  type ConsumptionEvent,
} from "./aggregate.ts";
import type { DedupedEvent } from "./dedup.ts";
import { normalizeForSearch } from "./search.ts";
import {
  getYoutubeVideoWorkDetail,
  resolveYoutubeLibraryWorkFields,
} from "./youtube-routes.ts";

const EXTERNAL_JOIN_KEYS = [
  "anilist",
  "mal",
  "imdb",
  "tvmaze",
  "abs_item",
  "meta_id",
] as const;

export interface InternalLibraryWork {
  work: LibraryWork;
  detail: LibraryWorkDetail;
  events: DedupedEvent[];
  creators: string[];
  originalTitle: string | null;
}

class DisjointSet {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) {
      root = this.parent[root]!;
    }
    let curr = i;
    while (curr !== root) {
      const nxt = this.parent[curr]!;
      this.parent[curr] = root;
      curr = nxt;
    }
    return root;
  }

  union(i: number, j: number): void {
    const rootI = this.find(i);
    const rootJ = this.find(j);
    if (rootI !== rootJ) {
      if (rootI < rootJ) {
        this.parent[rootJ] = rootI;
      } else {
        this.parent[rootI] = rootJ;
      }
    }
  }
}

/** Title of the work an event belongs to (channel name for YouTube). */
export function eventWorkTitle(
  event: ConsumptionEvent,
  category: Category
): string {
  if (category === "youtube") {
    const channel = event.parent_title?.trim();
    if (channel && channel !== "") {
      return channel;
    }
    const raw = parseJsonObject(event.raw);
    const work = parseJsonObject(raw?.["work"]);
    if (typeof work?.["title"] === "string" && work["title"].trim() !== "") {
      return work["title"].trim();
    }
    return event.title?.trim() || "Unknown channel";
  }

  if (event.source_kind === "archive") {
    const raw = parseJsonObject(event.raw);
    const work = parseJsonObject(raw?.["work"]);
    if (typeof work?.["title"] === "string" && work["title"].trim() !== "") {
      return work["title"].trim();
    }
  }

  return getSeriesOrTitle(event);
}

/** Join tokens for an event within its category. */
function eventJoinTokens(
  event: ConsumptionEvent,
  category: Category,
  workTitle: string
): string[] {
  const tokens: string[] = [];
  const normTitle = normalizeForSearch(workTitle);
  if (normTitle !== "") {
    tokens.push(`title:${normTitle}`);
  }

  const ext = parseExternalIds(event.external_ids);
  if (!ext) {
    return tokens;
  }

  if (category === "youtube") {
    const ytChannel = ext["youtube_channel"];
    if (typeof ytChannel === "string" && ytChannel.trim() !== "") {
      tokens.push(`ext:youtube_channel:${ytChannel.trim()}`);
    }
    return tokens;
  }

  for (const key of EXTERNAL_JOIN_KEYS) {
    const val = ext[key];
    const strVal =
      typeof val === "string"
        ? val.trim()
        : typeof val === "number" && Number.isFinite(val)
          ? String(val)
          : "";
    if (!strVal) {
      continue;
    }
    if (key === "meta_id") {
      const provider =
        typeof ext["meta_provider"] === "string"
          ? ext["meta_provider"].trim()
          : "";
      if (provider) {
        tokens.push(`ext:${provider}:${strVal}`);
      }
      tokens.push(`ext:meta_id:${strVal}`);
    } else {
      tokens.push(`ext:${key}:${strVal}`);
    }
  }

  return tokens;
}

interface MediaProgressSignal {
  source_id: string;
  title: string | null;
  progress: number | null;
  is_finished: boolean;
}

function readMediaProgressSignals(db: Database): MediaProgressSignal[] {
  const rows = db
    .query<
      {
        source_id: string;
        title: string | null;
        progress: number | null;
        ended_at: string | null;
        raw: string | null;
      },
      []
    >(
      `SELECT source_id, title, progress, ended_at, raw
       FROM events_latest
       WHERE source_kind = 'media_progress';`
    )
    .all();

  return rows.map((r) => {
    const raw = parseJsonObject(r.raw);
    const isFinished =
      (r.ended_at !== null && r.ended_at !== undefined) ||
      (r.progress !== null && r.progress !== undefined && r.progress >= 0.95) ||
      raw?.["isFinished"] === true;
    return {
      source_id: r.source_id,
      title: r.title,
      progress: r.progress,
      is_finished: isFinished,
    };
  });
}

interface AnnotationRecord {
  id: number;
  source: string;
  title: string;
  rating: number | null;
  note: string | null;
}

function readAllLatestAnnotations(db: Database): AnnotationRecord[] {
  return db
    .query<AnnotationRecord, []>(
      `SELECT id, source, title, rating, note
       FROM annotations_latest
       ORDER BY id DESC;`
    )
    .all();
}

function buildHistoryLabel(
  event: DedupedEvent,
  category: Category,
  workTitle: string
): string {
  if (event.source_kind === "archive") {
    const raw = parseJsonObject(event.raw);
    const consumed = parseJsonObject(raw?.["consumed"]);
    if (event.season !== null && event.season !== undefined) {
      const seasonsArr = Array.isArray(consumed?.["seasons"])
        ? (consumed["seasons"] as Array<{ number?: unknown; episodes?: unknown }>)
        : [];
      const match = seasonsArr.find((s) => s?.number === event.season);
      if (match && typeof match.episodes === "number") {
        return `Season ${event.season} (${match.episodes} ep)`;
      }
      return `Season ${event.season}`;
    }
    if (
      event.progress !== null &&
      event.progress !== undefined &&
      event.progress < 1
    ) {
      return `${event.title ?? workTitle} (${Math.round(event.progress * 100)}%)`;
    }
    return event.title ?? workTitle;
  }

  if (category === "youtube") {
    return event.title?.trim() || workTitle;
  }

  const hasSeason = event.season !== null && event.season !== undefined;
  const hasEpisode = event.episode !== null && event.episode !== undefined;
  if (hasSeason && hasEpisode) {
    const se = `S${String(event.season).padStart(2, "0")}E${String(
      event.episode
    ).padStart(2, "0")}`;
    const epTitle = event.title?.trim();
    if (epTitle && epTitle !== workTitle) {
      return `${se} · ${epTitle}`;
    }
    return se;
  }
  if (hasSeason) {
    return `Season ${event.season}`;
  }

  return event.title?.trim() || workTitle;
}

/**
 * Build all library works from `events_latest` (deduped via `dedupeConsumption`).
 */
export function buildAllLibraryWorks(
  db: Database,
  tz: string = "Europe/Bratislava"
): InternalLibraryWork[] {
  const events = getDisplayConsumptionEvents(db, undefined, tz);
  if (events.length === 0) {
    return [];
  }

  const progressSignals = readMediaProgressSignals(db);
  const progressByAbsId = new Map<string, MediaProgressSignal>();
  const progressByNormTitle = new Map<string, MediaProgressSignal>();
  for (const sig of progressSignals) {
    progressByAbsId.set(sig.source_id, sig);
    if (sig.title) {
      const nt = normalizeForSearch(sig.title);
      if (nt) {
        progressByNormTitle.set(nt, sig);
      }
    }
  }

  const annotations = readAllLatestAnnotations(db);
  const annotationsByNormTitle = new Map<string, AnnotationRecord[]>();
  for (const ann of annotations) {
    const nt = normalizeForSearch(ann.title);
    if (!nt) continue;
    let list = annotationsByNormTitle.get(nt);
    if (!list) {
      list = [];
      annotationsByNormTitle.set(nt, list);
    }
    list.push(ann);
  }

  // Group events by category first, then union-find within each category.
  const eventsByCategory = new Map<Category, DedupedEvent[]>();
  for (const ev of events) {
    const cat = categoryOf(ev);
    let list = eventsByCategory.get(cat);
    if (!list) {
      list = [];
      eventsByCategory.set(cat, list);
    }
    list.push(ev);
  }

  const allWorks: InternalLibraryWork[] = [];
  const usedKeys = new Set<string>();

  for (const cat of CATEGORIES) {
    const catEvents = eventsByCategory.get(cat);
    if (!catEvents || catEvents.length === 0) {
      continue;
    }

    const dsu = new DisjointSet(catEvents.length);
    const tokenToIndex = new Map<string, number>();
    const eventTitles: string[] = [];

    for (let i = 0; i < catEvents.length; i++) {
      const ev = catEvents[i]!;
      const wTitle = eventWorkTitle(ev, cat);
      eventTitles.push(wTitle);
      const tokens = eventJoinTokens(ev, cat, wTitle);
      for (const token of tokens) {
        const prev = tokenToIndex.get(token);
        if (prev !== undefined) {
          dsu.union(i, prev);
        } else {
          tokenToIndex.set(token, i);
        }
      }
    }

    const components = new Map<number, number[]>();
    for (let i = 0; i < catEvents.length; i++) {
      const root = dsu.find(i);
      let comp = components.get(root);
      if (!comp) {
        comp = [];
        components.set(root, comp);
      }
      comp.push(i);
    }

    for (const indices of components.values()) {
      const workEvents = indices.map((idx) => catEvents[idx]!);

      // Sort workEvents chronologically ascending by (started_at, id).
      workEvents.sort(
        (a, b) => a.started_at.localeCompare(b.started_at) || a.id - b.id
      );

      // Choose canonical title, creators, originalTitle, baseSeasons from archive snapshot or newest event.
      let canonicalTitle = eventTitles[indices[indices.length - 1]!]!;
      let baseSeasons: SeasonInfo[] = [];
      let creators: string[] = [];
      let originalTitle: string | null = null;
      let archiveCoverUrl: string | null = null;

      for (let i = workEvents.length - 1; i >= 0; i--) {
        const ev = workEvents[i]!;
        if (ev.source_kind === "archive") {
          const raw = parseJsonObject(ev.raw);
          const workSnap = parseJsonObject(raw?.["work"]);
          if (workSnap) {
            if (
              typeof workSnap["title"] === "string" &&
              workSnap["title"].trim() !== ""
            ) {
              canonicalTitle = workSnap["title"].trim();
            }
            if (
              Array.isArray(workSnap["seasons"]) &&
              workSnap["seasons"].length > 0 &&
              baseSeasons.length === 0
            ) {
              baseSeasons = workSnap["seasons"] as SeasonInfo[];
            }
            if (
              Array.isArray(workSnap["creators"]) &&
              creators.length === 0
            ) {
              creators = (workSnap["creators"] as unknown[]).filter(
                (c): c is string => typeof c === "string" && c.trim() !== ""
              );
            }
            if (
              typeof workSnap["original_title"] === "string" &&
              originalTitle === null
            ) {
              originalTitle = workSnap["original_title"];
            }
            if (
              typeof workSnap["cover_url"] === "string" &&
              archiveCoverUrl === null
            ) {
              archiveCoverUrl = workSnap["cover_url"];
            }
          }
          break;
        }
      }

      // Cover URL: prefer coverUrlFor from newest event that has one, else archiveCoverUrl.
      let coverUrl: string | null = null;
      for (let i = workEvents.length - 1; i >= 0; i--) {
        const c = coverUrlFor(workEvents[i]!);
        if (c !== null) {
          coverUrl = c;
          break;
        }
      }
      if (coverUrl === null) {
        coverUrl = archiveCoverUrl;
      }

      // Unique key for this work.
      const baseKey = `${cat}:${normalizeForSearch(canonicalTitle) || "untitled"}`;
      let key = baseKey;
      let suffix = 2;
      while (usedKeys.has(key)) {
        key = `${baseKey}#${suffix++}`;
      }
      usedKeys.add(key);

      // Total minutes, units, first_at, last_at, sources.
      let totalSeconds = 0;
      const sourceSet = new Set<string>();
      for (const ev of workEvents) {
        totalSeconds += ev.duration_seconds ?? 0;
        sourceSet.add(ev.source);
        if (ev.also_from) {
          for (const s of ev.also_from) {
            sourceSet.add(s);
          }
        }
      }
      const totalMinutes = totalSeconds / 60;
      const units = workEvents.length;
      const firstAt = workEvents[0]?.started_at ?? null;
      const lastAt = workEvents[workEvents.length - 1]?.started_at ?? null;
      const sources = Array.from(sourceSet).sort((a, b) => a.localeCompare(b));

      // Seasons & watched episode counts.
      const syncedEpisodesBySeason = new Map<number, Set<number>>();
      const syncedNoEpCountBySeason = new Map<number, number>();
      const archiveEpisodesBySeason = new Map<number, number>();
      const archiveWholeSeasons = new Set<number>();

      for (const ev of workEvents) {
        if (ev.season === null || ev.season === undefined) {
          continue;
        }
        const sNum = ev.season;
        if (ev.source_kind === "archive") {
          const raw = parseJsonObject(ev.raw);
          const consumed = parseJsonObject(raw?.["consumed"]);
          const seasonsArr = Array.isArray(consumed?.["seasons"])
            ? (consumed["seasons"] as Array<{
                number?: unknown;
                episodes?: unknown;
              }>)
            : [];
          const match = seasonsArr.find((s) => s?.number === sNum);
          if (match && typeof match.episodes === "number") {
            const prev = archiveEpisodesBySeason.get(sNum) ?? 0;
            if (match.episodes > prev) {
              archiveEpisodesBySeason.set(sNum, match.episodes);
            }
          } else {
            archiveWholeSeasons.add(sNum);
          }
        } else {
          if (ev.episode !== null && ev.episode !== undefined) {
            let epSet = syncedEpisodesBySeason.get(sNum);
            if (!epSet) {
              epSet = new Set<number>();
              syncedEpisodesBySeason.set(sNum, epSet);
            }
            epSet.add(ev.episode);
          } else {
            syncedNoEpCountBySeason.set(
              sNum,
              (syncedNoEpCountBySeason.get(sNum) ?? 0) + 1
            );
          }
        }
      }

      const detailSeasons: Array<SeasonInfo & { watched_episodes: number }> = [];
      if (baseSeasons.length > 0) {
        for (const sInfo of baseSeasons) {
          const syncedCount =
            (syncedEpisodesBySeason.get(sInfo.number)?.size ?? 0) +
            (syncedNoEpCountBySeason.get(sInfo.number) ?? 0);
          const archCount = archiveWholeSeasons.has(sInfo.number)
            ? sInfo.episodes
            : (archiveEpisodesBySeason.get(sInfo.number) ?? 0);
          const watched =
            sInfo.episodes > 0
              ? Math.min(sInfo.episodes, Math.max(syncedCount, archCount))
              : Math.max(syncedCount, archCount);
          detailSeasons.push({
            ...sInfo,
            watched_episodes: watched,
          });
        }
      } else if (cat === "anime" || cat === "series") {
        const allSeasonNums = new Set<number>([
          ...syncedEpisodesBySeason.keys(),
          ...syncedNoEpCountBySeason.keys(),
          ...archiveEpisodesBySeason.keys(),
          ...archiveWholeSeasons,
        ]);
        for (const sNum of Array.from(allSeasonNums).sort((a, b) => a - b)) {
          const syncedCount =
            (syncedEpisodesBySeason.get(sNum)?.size ?? 0) +
            (syncedNoEpCountBySeason.get(sNum) ?? 0);
          const archCount = archiveEpisodesBySeason.get(sNum) ?? 0;
          const watched = Math.max(
            syncedCount,
            archCount,
            archiveWholeSeasons.has(sNum) ? 1 : 0
          );
          detailSeasons.push({
            number: sNum,
            title: null,
            year: null,
            episodes: watched,
            episode_minutes: null,
            total_minutes: null,
            provider_id: null,
            watched_episodes: watched,
          });
        }
      }

      // Status computation.
      let maxProgress: number | null = null;
      let hasFinishedSignal = false;

      for (const ev of workEvents) {
        if (ev.season === null || ev.season === undefined) {
          if (ev.progress !== null && ev.progress !== undefined) {
            if (maxProgress === null || ev.progress > maxProgress) {
              maxProgress = ev.progress;
            }
          }
        }
        const ext = parseExternalIds(ev.external_ids);
        const absItem = ext?.["abs_item"];
        if (typeof absItem === "string") {
          const sig = progressByAbsId.get(absItem);
          if (sig) {
            if (sig.is_finished) hasFinishedSignal = true;
            if (
              sig.progress !== null &&
              (maxProgress === null || sig.progress > maxProgress)
            ) {
              maxProgress = sig.progress;
            }
          }
        }
      }

      const normCanonical = normalizeForSearch(canonicalTitle);
      const titleSig = progressByNormTitle.get(normCanonical);
      if (titleSig) {
        if (titleSig.is_finished) hasFinishedSignal = true;
        if (
          titleSig.progress !== null &&
          (maxProgress === null || titleSig.progress > maxProgress)
        ) {
          maxProgress = titleSig.progress;
        }
      }

      let status: WorkStatus = "unknown";
      if (hasFinishedSignal || (maxProgress !== null && maxProgress >= 0.95)) {
        status = "finished";
      } else if (baseSeasons.length > 0) {
        const allSeasonsFinished = detailSeasons.every((s) =>
          s.episodes > 0
            ? s.watched_episodes >= s.episodes
            : archiveWholeSeasons.has(s.number)
        );
        if (allSeasonsFinished) {
          status = "finished";
        } else {
          status = "in_progress";
        }
      } else {
        const hasSeasonArchive =
          archiveWholeSeasons.size > 0 || archiveEpisodesBySeason.size > 0;
        if (hasSeasonArchive) {
          if (
            archiveWholeSeasons.size > 0 &&
            archiveEpisodesBySeason.size === 0
          ) {
            status = "finished";
          } else {
            status = "in_progress";
          }
        } else if (
          cat === "film" ||
          workEvents.some((e) => e.media_type === "movie")
        ) {
          status =
            maxProgress !== null && maxProgress < 0.95
              ? "in_progress"
              : "finished";
        } else if (cat === "youtube" || cat === "music" || cat === "podcast") {
          status =
            maxProgress !== null && maxProgress > 0 ? "in_progress" : "unknown";
        } else if (
          cat === "anime" ||
          cat === "series" ||
          cat === "book" ||
          cat === "audiobook" ||
          cat === "other"
        ) {
          status = workEvents.length > 0 ? "in_progress" : "unknown";
        }
      }

      // Rating and note lookup across all normalized titles of the work's events.
      const candidateNormTitles = new Set<string>([normCanonical]);
      for (let i = 0; i < indices.length; i++) {
        const t = normalizeForSearch(eventTitles[indices[i]!]!);
        if (t) candidateNormTitles.add(t);
      }

      let bestAnnotation: AnnotationRecord | null = null;
      for (const nt of candidateNormTitles) {
        const list = annotationsByNormTitle.get(nt);
        if (!list) continue;
        for (const ann of list) {
          if (bestAnnotation === null || ann.id > bestAnnotation.id) {
            bestAnnotation = ann;
          }
        }
      }

      const rating = bestAnnotation?.rating ?? null;
      const note = bestAnnotation?.note ?? null;

      // History items (newest first).
      const history = [...workEvents]
        .sort(
          (a, b) => b.started_at.localeCompare(a.started_at) || b.id - a.id
        )
        .map((ev) => {
          const precision: DatePrecision = eventPrecision(ev);
          let entryId: string | null = null;
          if (ev.source_kind === "archive") {
            const raw = parseJsonObject(ev.raw);
            if (typeof raw?.["entry_id"] === "string") {
              entryId = raw["entry_id"];
            } else if (typeof ev.source_id === "string") {
              entryId = ev.source_id.split(":")[1] ?? null;
            }
          }
          return {
            started_at: ev.started_at,
            precision,
            label: buildHistoryLabel(ev, cat, canonicalTitle),
            minutes: (ev.duration_seconds ?? 0) / 60,
            source: ev.source,
            entry_id: entryId,
          };
        });

      const ytFields =
        cat === "youtube"
          ? resolveYoutubeLibraryWorkFields(db, workEvents, canonicalTitle, key)
          : { channel: null, topic: null };

      const work: LibraryWork = {
        key,
        category: cat,
        title: canonicalTitle,
        cover_url: coverUrl,
        total_minutes: totalMinutes,
        units,
        first_at: firstAt,
        last_at: lastAt,
        status,
        rating,
        sources,
        // v2.1 fields; filled by the edit and YouTube work.
        edited: false,
        channel: ytFields.channel,
        topic: ytFields.topic,
      };

      const detail: LibraryWorkDetail = {
        ...work,
        seasons: detailSeasons,
        history,
        note,
      };

      allWorks.push({
        work,
        detail,
        events: workEvents,
        creators,
        originalTitle,
      });
    }
  }

  return allWorks;
}

export type LibrarySort = "recent" | "time" | "title";

export interface GetLibraryOptions {
  category?: Category;
  q?: string;
  sort?: LibrarySort;
  tz?: string;
}

export function getLibrary(
  db: Database,
  opts: GetLibraryOptions = {}
): LibraryResult {
  const tz = opts.tz ?? "Europe/Bratislava";
  const allWorks = buildAllLibraryWorks(db, tz);

  // `categories` always lists every category that has data (for the tabs).
  const byCat = new Map<
    Category,
    { total_minutes: number; works: number; units: number }
  >();
  for (const item of allWorks) {
    const cat = item.work.category;
    let entry = byCat.get(cat);
    if (!entry) {
      entry = { total_minutes: 0, works: 0, units: 0 };
      byCat.set(cat, entry);
    }
    entry.total_minutes += item.work.total_minutes;
    entry.works += 1;
    entry.units += item.work.units;
  }

  const categories: CategoryTotal[] = [];
  for (const cat of CATEGORIES) {
    const entry = byCat.get(cat);
    if (entry && entry.works > 0) {
      categories.push({
        category: cat,
        total_minutes: entry.total_minutes,
        works: entry.works,
        units: entry.units,
      });
    }
  }

  let filtered = allWorks;
  if (opts.category !== undefined) {
    filtered = filtered.filter((w) => w.work.category === opts.category);
  }

  if (opts.q !== undefined && opts.q.trim() !== "") {
    const normQ = normalizeForSearch(opts.q);
    if (normQ !== "") {
      const words = normQ.split(" ").filter((w) => w !== "");
      filtered = filtered.filter((item) => {
        const haystack = normalizeForSearch(
          [
            item.work.title,
            item.originalTitle ?? "",
            ...item.creators,
          ].join(" ")
        );
        return words.every((w) => haystack.includes(w));
      });
    }
  }

  const sort = opts.sort ?? "recent";
  const works = filtered.map((item) => item.work);

  if (sort === "time") {
    works.sort(
      (a, b) =>
        b.total_minutes - a.total_minutes ||
        b.units - a.units ||
        a.title.localeCompare(b.title)
    );
  } else if (sort === "title") {
    works.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    // "recent"
    works.sort(
      (a, b) =>
        (b.last_at ?? "").localeCompare(a.last_at ?? "") ||
        b.total_minutes - a.total_minutes ||
        a.title.localeCompare(b.title)
    );
  }

  const total_minutes = works.reduce((sum, w) => sum + w.total_minutes, 0);

  return {
    categories,
    works,
    total_minutes,
  };
}

export function getLibraryWorkDetail(
  db: Database,
  key: string,
  tz: string = "Europe/Bratislava"
): LibraryWorkDetail | null {
  if (key.startsWith("youtube:video:")) {
    return getYoutubeVideoWorkDetail(db, key, tz);
  }
  const allWorks = buildAllLibraryWorks(db, tz);
  const found = allWorks.find((item) => item.work.key === key);
  return found ? found.detail : null;
}
