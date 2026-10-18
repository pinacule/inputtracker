/**
 * Library aggregation (v2 section 3, v2.1 sections 7–9): works joined across
 * all sources, grouped by category (`GET /api/library`, `GET /api/library/work`,
 * `POST /api/library/work/edit`, `GET /api/library/hidden`).
 *
 * Rules:
 * - Reads `events_latest` (deduped with `dedupeConsumption`, tombstones hidden
 *   by migration v4).
 * - A work joins events in the same category that share a normalized
 *   series-or-title (`getSeriesOrTitle` + `normalizeForSearch`) or an external
 *   id (`anilist`, `mal`, `imdb`, `tvmaze`, `abs_item`, `meta_id`).
 * - Work keys are derived deterministically from canonical identity, never from
 *   list order.
 * - Overrides from `work_overrides_latest` apply on every read.
 */

import type { Database } from "bun:sqlite";
import { CATEGORIES, categoryOf, type Category } from "../core/category.ts";
import type { Config } from "../core/config.ts";
import type {
  CategoryTotal,
  DatePrecision,
  HiddenWorksResult,
  LibraryResult,
  LibraryWork,
  LibraryWorkDetail,
  SeasonInfo,
  WorkDetails,
  WorkStatus,
} from "../core/contract.ts";
import {
  coverUrlFor,
  eventPrecision,
  getLatestConsumptionEvents,
  parseExternalIds,
  parseJsonObject,
  type ConsumptionEvent,
} from "./aggregate.ts";
import { saveAnnotation } from "./annotations.ts";
import { dedupeConsumption, type DedupedEvent } from "./dedup.ts";
import { readWorkCache } from "./metadata/cache.ts";
import { lookupWork } from "./metadata/index.ts";
import {
  type CategoryFilterInput,
  eventWorkTitleForGrouping,
  getWorkOverrides,
  groupEventsIntoWorkComponents,
  isPlannedArchiveEvent,
  isValidWorkStatus,
  isWorkPlanned,
  matchesCategoryFilter,
  parseCategoryFilter,
  parseWorkEdit,
  saveWorkOverride,
  WorkOverrideNotFoundError,
  WorkOverrideValidationError,
} from "./overrides.ts";
import { tenthsToRating } from "./ratings.ts";
import { normalizeForSearch } from "./search.ts";

export interface InternalLibraryWork {
  work: LibraryWork;
  detail: LibraryWorkDetail;
  events: DedupedEvent[];
  creators: string[];
  originalTitle: string | null;
}

/** Title of the work an event belongs to (channel name for YouTube). */
export function eventWorkTitle(
  event: ConsumptionEvent,
  category: Category
): string {
  return eventWorkTitleForGrouping(event, category);
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
  rating_tenths?: number | null;
  note: string | null;
  created_at: string;
}

function readAllLatestAnnotations(db: Database): AnnotationRecord[] {
  const rows = db
    .query<AnnotationRecord, []>(
      `SELECT id, source, title, rating, rating_tenths, note, created_at
       FROM annotations_latest
       ORDER BY id DESC;`
    )
    .all();
  return rows.map((r) => ({
    ...r,
    rating: tenthsToRating(r.rating_tenths, r.rating),
  }));
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

export interface BuildLibraryWorksOptions {
  includeHidden?: boolean;
  onlyHidden?: boolean;
  config?: Config;
}

/**
 * Build all library works from `events_latest` (deduped via `dedupeConsumption`),
 * applying any overrides from `work_overrides_latest`.
 */
export function buildAllLibraryWorks(
  db: Database,
  tz: string = "Europe/Bratislava",
  opts: BuildLibraryWorksOptions = {}
): InternalLibraryWork[] {
  const rawEvents = getLatestConsumptionEvents(db);
  const events = dedupeConsumption(rawEvents, tz);
  if (events.length === 0) {
    return [];
  }

  const overrides = getWorkOverrides(db);

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

  const components = groupEventsIntoWorkComponents(events);
  const allWorks: InternalLibraryWork[] = [];

  for (const comp of components) {
    const {
      sourceCategory: cat,
      key,
      sourceCanonicalTitle,
      events: workEvents,
      eventTitles,
    } = comp;

    const override = overrides.get(key);
    const isHidden = override?.hidden === true;
    if (opts.onlyHidden) {
      if (!isHidden) {
        continue;
      }
    } else if (!opts.includeHidden && isHidden) {
      continue;
    }

    // Extract metadata from archive snapshot if present.
    let canonicalTitle = sourceCanonicalTitle;
    let baseSeasons: SeasonInfo[] = [];
    let creators: string[] = [];
    let originalTitle: string | null = null;
    let archiveCoverUrl: string | null = null;
    let archiveExplicitStatus: WorkStatus | null = null;

    for (let i = workEvents.length - 1; i >= 0; i--) {
      const ev = workEvents[i]!;
      if (ev.source_kind === "archive") {
        const raw = parseJsonObject(ev.raw);
        if (archiveExplicitStatus === null && isValidWorkStatus(raw?.["status"])) {
          archiveExplicitStatus = raw["status"];
        }
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
          if (Array.isArray(workSnap["creators"]) && creators.length === 0) {
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

    // Apply linked metadata override (`override.meta`).
    if (override?.meta !== null && override?.meta !== undefined) {
      let metaWork: WorkDetails | null = override.meta_work;
      if (metaWork === null && opts.config) {
        metaWork = readWorkCache(
          opts.config,
          override.meta.provider,
          override.meta.provider_id,
          Date.now()
        );
      }
      if (metaWork !== null) {
        if (Array.isArray(metaWork.seasons) && metaWork.seasons.length > 0) {
          baseSeasons = metaWork.seasons;
        }
        if (Array.isArray(metaWork.creators) && metaWork.creators.length > 0) {
          creators = metaWork.creators;
        }
        if (metaWork.original_title) {
          originalTitle = metaWork.original_title;
        }
      }
    }

    // Cover URL: override.meta wins, else coverUrlFor from newest event, else archiveCoverUrl.
    let coverUrl: string | null = null;
    if (override?.meta !== null && override?.meta !== undefined) {
      coverUrl = `/api/meta-cover/${override.meta.provider}/${override.meta.provider_id}`;
    } else {
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
    }

    const effectiveCategory: Category = override?.category ?? cat;
    const effectiveTitle: string = override?.title ?? canonicalTitle;

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
      if (isPlannedArchiveEvent(ev)) {
        continue;
      }
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
    } else if (
      effectiveCategory === "anime" ||
      effectiveCategory === "series"
    ) {
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
      if (isPlannedArchiveEvent(ev)) {
        continue;
      }
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
    if (isWorkPlanned(workEvents, undefined)) {
      status = "planned";
    } else if (archiveExplicitStatus === "dropped" && !hasFinishedSignal) {
      status = "dropped";
    } else if (archiveExplicitStatus === "in_progress" && !hasFinishedSignal) {
      status = "in_progress";
    } else if (archiveExplicitStatus === "finished") {
      status = "finished";
    } else if (hasFinishedSignal || (maxProgress !== null && maxProgress >= 0.95)) {
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

    if (override?.status !== null && override?.status !== undefined) {
      status = override.status;
    }

    const totalMinutes = status === "planned" ? 0 : totalSeconds / 60;

    // Rating and note lookup across all normalized titles of the work's events
    // and any overridden title.
    const candidateNormTitles = new Set<string>();
    if (normCanonical) candidateNormTitles.add(normCanonical);
    const normEffective = normalizeForSearch(effectiveTitle);
    if (normEffective) candidateNormTitles.add(normEffective);
    for (const t of eventTitles) {
      const nt = normalizeForSearch(t);
      if (nt) candidateNormTitles.add(nt);
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

    const rating = bestAnnotation ? bestAnnotation.rating : (override?.rating ?? null);
    const note = bestAnnotation ? bestAnnotation.note : (override?.note ?? null);

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
          label: buildHistoryLabel(ev, effectiveCategory, effectiveTitle),
          minutes: status === "planned" ? 0 : (ev.duration_seconds ?? 0) / 60,
          source: ev.source,
          entry_id: entryId,
        };
      });

    const work: LibraryWork = {
      key,
      category: effectiveCategory,
      title: effectiveTitle,
      cover_url: coverUrl,
      total_minutes: totalMinutes,
      units,
      first_at: firstAt,
      last_at: lastAt,
      status,
      rating,
      sources,
      edited: override?.edited ?? false,
      channel: null,
      topic: override?.topic ?? null,
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

  return allWorks;
}

export type LibrarySort = "recent" | "time" | "title";

export interface GetLibraryOptions {
  category?: CategoryFilterInput;
  exclude?: CategoryFilterInput;
  q?: string;
  sort?: LibrarySort;
  tz?: string;
  config?: Config;
}

export function getLibrary(
  db: Database,
  opts: GetLibraryOptions = {}
): LibraryResult {
  const tz = opts.tz ?? "Europe/Bratislava";
  const categoryFilter = parseCategoryFilter(opts.category, opts.exclude);
  const allWorks = buildAllLibraryWorks(db, tz, { config: opts.config });

  // `categories` always lists every category that has data (for the tabs/chips).
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
  if (categoryFilter !== undefined) {
    filtered = filtered.filter((w) =>
      matchesCategoryFilter(w.work.category, categoryFilter)
    );
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
  tz: string = "Europe/Bratislava",
  config?: Config
): LibraryWorkDetail | null {
  const allWorks = buildAllLibraryWorks(db, tz, { config });
  const found = allWorks.find((item) => item.work.key === key);
  return found ? found.detail : null;
}

export function getHiddenLibraryWorks(
  db: Database,
  tz: string = "Europe/Bratislava",
  config?: Config
): HiddenWorksResult {
  const hiddenWorks = buildAllLibraryWorks(db, tz, {
    onlyHidden: true,
    config,
  }).map((item) => item.work);

  hiddenWorks.sort((a, b) => a.title.localeCompare(b.title));
  return { works: hiddenWorks };
}

export interface EditLibraryWorkOptions {
  tz?: string;
  config?: Config;
  fetch?: typeof fetch;
  nowIso?: string;
}

/**
 * Apply a partial `WorkEdit` to the library work identified by `key`
 * (`POST /api/library/work/edit?key=`). Returns the updated `LibraryWorkDetail`.
 */
export async function editLibraryWork(
  db: Database,
  key: string,
  input: unknown,
  opts: EditLibraryWorkOptions = {}
): Promise<LibraryWorkDetail> {
  if (typeof key !== "string" || key.trim() === "") {
    throw new WorkOverrideValidationError(
      "Missing required query parameter: key"
    );
  }
  if (key.length > 500) {
    throw new WorkOverrideValidationError(
      `Invalid key: too long (${key.length} characters, max 500)`
    );
  }

  const parsed = parseWorkEdit(input);
  const tz = opts.tz ?? "Europe/Bratislava";
  const nowIso = opts.nowIso ?? new Date().toISOString();

  const allWorks = buildAllLibraryWorks(db, tz, {
    includeHidden: true,
    config: opts.config,
  });
  const target = allWorks.find((item) => item.work.key === key);
  if (!target) {
    throw new WorkOverrideNotFoundError(key);
  }

  const currentOverrides = getWorkOverrides(db);
  const current = currentOverrides.get(key) ?? null;

  let metaWork: WorkDetails | null = null;
  if (parsed.hasMeta && parsed.meta !== null && opts.config) {
    metaWork = readWorkCache(
      opts.config,
      parsed.meta.provider,
      parsed.meta.provider_id,
      Date.now()
    );
    if (metaWork === null && opts.fetch) {
      try {
        metaWork = await lookupWork(
          parsed.meta.provider,
          parsed.meta.provider_id,
          { config: opts.config, fetch: opts.fetch }
        );
      } catch {
        // Best-effort metadata lookup when linking.
      }
    }
  }

  saveWorkOverride(db, key, parsed, current, metaWork, nowIso);

  // Sync rating / note into the append-only annotations table so every read
  // path (library, reviews, search, title-history, progress, /api/annotations)
  // returns the exact same rating and note.
  if (
    parsed.hasRating ||
    parsed.hasNote ||
    (parsed.hasTitle &&
      (target.detail.rating !== null || target.detail.note !== null))
  ) {
    const nextRating = parsed.hasRating
      ? parsed.ratingTenths === null
        ? null
        : parsed.ratingTenths / 10
      : target.detail.rating;
    const nextNote = parsed.hasNote ? parsed.note : target.detail.note;
    const primarySource = target.work.sources[0] ?? "manual";

    const titlesToSync = new Set<string>([target.work.title]);
    if (parsed.hasTitle && parsed.title !== null) {
      titlesToSync.add(parsed.title);
    }
    for (const ev of target.events) {
      const wTitle = eventWorkTitleForGrouping(ev, categoryOf(ev));
      if (wTitle.trim() !== "") {
        titlesToSync.add(wTitle.trim());
      }
    }

    for (const t of titlesToSync) {
      if (t && t.trim() !== "") {
        saveAnnotation(
          db,
          {
            source: primarySource,
            title: t.trim(),
            rating: nextRating,
            note: nextNote,
          },
          nowIso
        );
      }
    }
  }

  const updatedWorks = buildAllLibraryWorks(db, tz, {
    includeHidden: true,
    config: opts.config,
  });
  const updated = updatedWorks.find((item) => item.work.key === key);
  if (!updated) {
    throw new WorkOverrideNotFoundError(key);
  }
  return updated.detail;
}
