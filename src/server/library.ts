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
  ArchiveConsumed,
  ArchiveRequest,
  ArchiveWhen,
  CategoryTotal,
  DatePrecision,
  HiddenWorksResult,
  LibraryResult,
  LibrarySortV2,
  LibraryWork,
  LibraryWorkDetail,
  ManualWork,
  MetaProvider,
  RefreshMetadataResult,
  SeasonInfo,
  WorkDetails,
  WorkStatus,
} from "../core/contract.ts";
import type { EventRow } from "../core/schema.ts";
import { computeArchiveRequestMinutes } from "../io/import-achriom.ts";
import {
  coverUrlFor,
  eventPrecision,
  getLatestConsumptionEvents,
  parseExternalIds,
  parseJsonObject,
  type ConsumptionEvent,
} from "./aggregate.ts";
import { getWorkAnnotations, saveAnnotation } from "./annotations.ts";
import { resolveWorkKey } from "../core/work-identity.ts";
import { getArchiveEntry, saveArchiveEntry } from "./archive.ts";
import {
  cleanMusicArtist,
  cleanMusicTitle,
  hasCachedCover,
  hasCachedCoverNone,
  titleCoverId,
} from "./covers.ts";
import { dedupeConsumption, type DedupedEvent } from "./dedup.ts";
import {
  filterShortYoutubeEvents,
  readYoutubeEnrichmentByVideoId,
} from "./youtube-filter.ts";
import { readWorkCache } from "./metadata/cache.ts";
import {
  isMetaProvider,
  isValidProviderId,
  lookupWork,
  type MetadataDeps,
} from "./metadata/index.ts";
import { ProviderError } from "./metadata/types.ts";
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
import {
  getYoutubeVideoWorkDetail,
  resolveYoutubeLibraryWorkFields,
} from "./youtube-routes.ts";
import { getFavoriteVideoIds } from "../sources/youtube/takeout.ts";

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
        FROM annotations_latest WHERE work_key IS NULL
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
  // Short YouTube video-days (below [youtube] min_watch_minutes) are left out, as in every read.
  // Time-only short-form never creates an archived work.
  const rawEvents = filterShortYoutubeEvents(getLatestConsumptionEvents(db), tz, db)
    .filter((e) => e.source_kind !== "shortform_day" && categoryOf(e) !== "shortform");
  const events = dedupeConsumption(rawEvents, tz);
  if (events.length === 0) {
    return [];
  }

  const overrides = getWorkOverrides(db);
  const favoriteVideoIds = getFavoriteVideoIds(db);

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
  const workAnnotations = getWorkAnnotations(db);
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

  const components = groupEventsIntoWorkComponents(events, db);
  const youtubeEnrichmentMap = readYoutubeEnrichmentByVideoId(db);
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
    let workSnapshot: WorkDetails | ManualWork | null = null;

    // Metadata freshness follows revision order, not the date the user watched the work.
    const archiveEvents = workEvents.filter((ev) => ev.source_kind === "archive")
      .sort((a, b) => b.id - a.id);
    for (const ev of archiveEvents) {
      if (ev.source_kind === "archive") {
        const raw = parseJsonObject(ev.raw);
        if (archiveExplicitStatus === null && isValidWorkStatus(raw?.["status"])) {
          archiveExplicitStatus = raw["status"];
        }
        const workSnap = parseJsonObject(raw?.["work"]);
        if (workSnap) {
          if (typeof raw?.["entry_id"] === "string") {
            workSnapshot = getArchiveEntry(db, raw["entry_id"]).work;
          }
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
      // An unresolved override must open lookup, not log the underlying (different) work.
      workSnapshot = null;
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
        workSnapshot = metaWork;
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
    } else if (!override?.meta_unlinked && baseSeasons.length === 0 && opts.config) {
      // Check on-disk work cache if the events carry a known metadata/external id
      for (let i = workEvents.length - 1; i >= 0; i--) {
        const ext = parseExternalIds(workEvents[i]!.external_ids);
        if (!ext) continue;
        const candidates: Array<{ provider: MetaProvider; id: string }> = [];
        if (typeof ext["meta_provider"] === "string" && typeof ext["meta_id"] === "string") {
          if (isMetaProvider(ext["meta_provider"]) && isValidProviderId(ext["meta_id"])) {
            candidates.push({ provider: ext["meta_provider"], id: ext["meta_id"] });
          }
        }
        if (typeof ext["anilist"] === "string" || typeof ext["anilist"] === "number") {
          candidates.push({ provider: "anilist", id: String(ext["anilist"]) });
        }
        if (typeof ext["tvmaze"] === "string" || typeof ext["tvmaze"] === "number") {
          candidates.push({ provider: "tvmaze", id: String(ext["tvmaze"]) });
        }
        if (typeof ext["imdb"] === "string" && /^tt\d+$/i.test(ext["imdb"])) {
          candidates.push({ provider: "cinemeta", id: ext["imdb"].toLowerCase() });
        }
        let foundCached: WorkDetails | null = null;
        for (const cand of candidates) {
          foundCached = readWorkCache(opts.config, cand.provider, cand.id, Date.now());
          if (foundCached) break;
        }
        if (foundCached) {
          workSnapshot ??= foundCached;
          if (Array.isArray(foundCached.seasons) && foundCached.seasons.length > 0) {
            baseSeasons = foundCached.seasons;
          }
          if (creators.length === 0 && Array.isArray(foundCached.creators) && foundCached.creators.length > 0) {
            creators = foundCached.creators;
          }
          if (!originalTitle && foundCached.original_title) {
            originalTitle = foundCached.original_title;
          }
          break;
        }
      }
    }

    // Cover URL: override.meta wins, else coverUrlFor from newest event, else archiveCoverUrl.
    let coverUrl: string | null = null;
    if (override?.meta !== null && override?.meta !== undefined) {
      coverUrl = `/api/meta-cover/${override.meta.provider}/${override.meta.provider_id}`;
    } else if (!override?.meta_unlinked) {
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
    if (override?.meta_unlinked && workSnapshot) {
      const { category, title, year, creators, seasons, runtime_minutes, pages } = workSnapshot;
      workSnapshot = { provider: "manual", category, title, year, creators, seasons, runtime_minutes, pages };
    }

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

    const boundAnnotation = workAnnotations.get(key);
    const rawRating = boundAnnotation ? boundAnnotation.rating : bestAnnotation ? bestAnnotation.rating : (override?.rating ?? null);
    // No ratings for music tracks (spec section 15).
    const rating = effectiveCategory === "music" ? null : rawRating;
    const note = boundAnnotation ? boundAnnotation.note : bestAnnotation ? bestAnnotation.note : (override?.note ?? null);

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

    const ytFields =
      effectiveCategory === "youtube"
        ? resolveYoutubeLibraryWorkFields(db, workEvents, effectiveTitle, key)
        : { channel: null, topic: override?.topic ?? null };

    // Resolve `creator`: author (books/audiobooks), artist (music), channel (YouTube), studio/creator, else null.
    let creator: string | null = null;
    if (effectiveCategory === "youtube") {
      creator = ytFields.channel ?? (creators.length > 0 ? creators.join(", ") : null);
    } else if (creators.length > 0) {
      creator = creators.join(", ");
    } else {
      for (let i = workEvents.length - 1; i >= 0; i--) {
        const ev = workEvents[i]!;
        const raw = parseJsonObject(ev.raw);
        const rawMeta = parseJsonObject(raw?.["mediaMetadata"]);
        const absAuthor =
          (typeof rawMeta?.["authorName"] === "string" && rawMeta["authorName"].trim() !== ""
            ? rawMeta["authorName"].trim()
            : null) ??
          (typeof raw?.["displayAuthor"] === "string" && raw["displayAuthor"].trim() !== ""
            ? raw["displayAuthor"].trim()
            : null);
        if (absAuthor) {
          creator = absAuthor;
          break;
        }
        const pt = ev.parent_title?.trim() ?? "";
        if (pt !== "") {
          const isEpisodeLike =
            ev.media_type === "episode" ||
            ev.media_type === "show" ||
            (ev.season !== null && ev.season !== undefined) ||
            (ev.episode !== null && ev.episode !== undefined);
          if (!isEpisodeLike || normalizeForSearch(pt) !== normalizeForSearch(effectiveTitle)) {
            creator = pt;
            break;
          }
        }
        if (ev.source === "youtube") {
          const ext = parseExternalIds(ev.external_ids);
          const vid = ext?.["youtube_video"];
          if (typeof vid === "string") {
            const enr = youtubeEnrichmentMap.get(vid);
            if (enr?.channel && enr.channel.trim() !== "") {
              creator = enr.channel.trim();
              break;
            }
          }
        }
      }
      if (effectiveCategory === "music") {
        const cleaned = cleanMusicArtist(creator);
        if (cleaned) {
          creator = cleaned;
        } else {
          const { embeddedArtist } = cleanMusicTitle(effectiveTitle);
          creator = embeddedArtist;
        }
      }
    }

    if (creator && creators.length === 0) {
      creators = [creator];
    }

    // Title-based cover URL for music tracks and unlinked books/audiobooks
    if (
      (effectiveCategory === "music" ||
        effectiveCategory === "book" ||
        effectiveCategory === "audiobook") &&
      (override?.meta === null || override?.meta === undefined)
    ) {
      const tCoverId = titleCoverId(effectiveCategory, effectiveTitle, creator);
      if (opts.config && hasCachedCover(opts.config, tCoverId)) {
        if (effectiveCategory === "music" || coverUrl === null) {
          coverUrl = `/api/cover/${tCoverId}`;
        }
      } else if (
        coverUrl === null &&
        effectiveCategory === "music" &&
        opts.config?.covers?.external !== false &&
        (!opts.config || !hasCachedCoverNone(opts.config, tCoverId))
      ) {
        coverUrl = `/api/cover/${tCoverId}`;
      }
    }

    // Explicit `progress` for works with seasons (series/anime), else null.
    const isMovieOnlyAnime =
      effectiveCategory === "anime" &&
      baseSeasons.length === 0 &&
      detailSeasons.length === 0 &&
      workEvents.every(
        (e) =>
          e.media_type === "movie" &&
          (e.season === null || e.season === undefined)
      );

    let progress: LibraryWork["progress"] = null;
    if (
      (effectiveCategory === "series" || effectiveCategory === "anime") &&
      !isMovieOnlyAnime
    ) {
      if (baseSeasons.length > 0) {
        const seasonsTotal = baseSeasons.length;
        const epTotalSum = baseSeasons.reduce(
          (acc, s) => acc + (s.episodes > 0 ? s.episodes : 0),
          0
        );
        const episodesTotal = epTotalSum > 0 ? epTotalSum : null;
        const episodesWatched =
          status === "planned"
            ? 0
            : detailSeasons.reduce((acc, s) => acc + s.watched_episodes, 0);
        const seasonsWatched =
          status === "planned"
            ? 0
            : detailSeasons.filter(
                (s) =>
                  archiveWholeSeasons.has(s.number) ||
                  (s.episodes > 0 && s.watched_episodes >= s.episodes)
              ).length;
        progress = {
          seasons_watched: seasonsWatched,
          seasons_total: seasonsTotal,
          episodes_watched: episodesWatched,
          episodes_total: episodesTotal,
        };
      } else {
        const epFromDetail = detailSeasons.reduce(
          (acc, s) => acc + s.watched_episodes,
          0
        );
        const epFallback =
          epFromDetail > 0
            ? epFromDetail
            : workEvents.filter(
                (e) => !isPlannedArchiveEvent(e) && e.media_type === "episode"
              ).length;
        progress = {
          seasons_watched: status === "planned" ? 0 : archiveWholeSeasons.size,
          seasons_total: null,
          episodes_watched: status === "planned" ? 0 : epFallback,
          episodes_total: null,
        };
      }
    }
    const isFavorite =
      favoriteVideoIds.size > 0 &&
      workEvents.some((ev) => {
        const vid = parseExternalIds(ev.external_ids)?.["youtube_video"];
        return typeof vid === "string" && favoriteVideoIds.has(vid);
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
      channel: ytFields.channel,
      topic: ytFields.topic,
      progress,
      creator,
      ...(favoriteVideoIds.size > 0 ? { favorite: isFavorite } : {}),
    };

    const detail: LibraryWorkDetail = {
      ...work,
      work_snapshot: workSnapshot,
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

export type LibrarySort = LibrarySortV2;

export const VALID_LIBRARY_SORTS: ReadonlySet<LibrarySortV2> = new Set([
  "plays",
  "recent",
  "time",
  "title",
  "category",
  "creator",
]);

export function isValidLibrarySort(value: unknown): value is LibrarySortV2 {
  return (
    typeof value === "string" &&
    VALID_LIBRARY_SORTS.has(value as LibrarySortV2)
  );
}

export interface GetLibraryOptions {
  category?: CategoryFilterInput;
  exclude?: CategoryFilterInput;
  q?: string;
  sort?: LibrarySortV2;
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
            item.work.creator ?? "",
            ...item.creators,
          ].join(" ")
        );
        return words.every((w) => haystack.includes(w));
      });
    }
  }

  const sort = opts.sort ?? "recent";
  const works = filtered.map((item) => item.work);

  if (sort === "plays") {
    works.sort((a, b) => b.units - a.units || b.total_minutes - a.total_minutes || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  } else if (sort === "time") {
    works.sort(
      (a, b) =>
        b.total_minutes - a.total_minutes ||
        b.units - a.units ||
        a.title.localeCompare(b.title)
    );
  } else if (sort === "title") {
    works.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sort === "category") {
    works.sort(
      (a, b) =>
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
        a.title.localeCompare(b.title)
    );
  } else if (sort === "creator") {
    works.sort((a, b) => {
      const ca = a.creator?.trim() ?? "";
      const cb = b.creator?.trim() ?? "";
      if (ca === "" && cb !== "") return 1;
      if (ca !== "" && cb === "") return -1;
      return ca.localeCompare(cb) || a.title.localeCompare(b.title);
    });
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
  key = resolveWorkKey(db, key);
  if (key.startsWith("youtube:video:")) {
    return getYoutubeVideoWorkDetail(db, key, tz);
  }
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
  key = resolveWorkKey(db, key);
  const tz = opts.tz ?? "Europe/Bratislava";
  const nowIso = opts.nowIso ?? new Date().toISOString();

  const allWorks = buildAllLibraryWorks(db, tz, {
    includeHidden: true,
    config: opts.config,
  });
  const target = allWorks.find((item) => item.work.key === key);
  // Single YouTube videos are not library works (those are per channel) but can be edited
  // (topic, rating, note) through their `youtube:video:<id>` key from /api/youtube/videos.
  if (
    !target &&
    !(key.startsWith("youtube:video:") && getYoutubeVideoWorkDetail(db, key, tz) !== null)
  ) {
    throw new WorkOverrideNotFoundError(key);
  }

  const currentOverrides = getWorkOverrides(db);
  const current = currentOverrides.get(key) ?? null;

  let metaWork: WorkDetails | null = null;
  if (parsed.hasMeta && parsed.meta !== null) {
    const snapshot = target?.detail.work_snapshot;
    if (snapshot && snapshot.provider === parsed.meta.provider &&
        snapshot.provider_id === parsed.meta.provider_id) {
      metaWork = snapshot;
    }
    // A previous metadata override is also an authoritative snapshot for offline Undo.
    if (!metaWork) {
      const previous = db.query<{ meta_json: string | null }, [string, string, string]>(
        `SELECT meta_json FROM work_overrides
         WHERE work_key = ? AND meta_provider = ? AND meta_id = ? AND meta_json IS NOT NULL
         ORDER BY id DESC LIMIT 1;`
      ).get(key, parsed.meta.provider, parsed.meta.provider_id);
      const stored = parseJsonObject(previous?.meta_json);
      if (stored?.["provider"] === parsed.meta.provider &&
          stored["provider_id"] === parsed.meta.provider_id) {
        metaWork = stored as unknown as WorkDetails;
      }
    }
  }
  if (!metaWork && parsed.hasMeta && parsed.meta !== null && target) {
    // Undo/relink to the stored provider must work offline, without degrading its snapshot.
    for (const ev of [...target.events].sort((a, b) => b.id - a.id)) {
      if (ev.source_kind !== "archive") continue;
      const entryId = parseJsonObject(ev.raw)?.["entry_id"];
      if (typeof entryId !== "string") continue;
      const snapshot = getArchiveEntry(db, entryId).work;
      if (snapshot.provider === parsed.meta.provider &&
          snapshot.provider_id === parsed.meta.provider_id) {
        metaWork = snapshot;
        break;
      }
    }
  }
  if (parsed.hasMeta && parsed.meta !== null && opts.config) {
    metaWork ??= readWorkCache(
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

  db.transaction(() => {
    saveWorkOverride(db, key, parsed, current, metaWork, nowIso);

    // Sync rating / note into the append-only annotations table so every read
    // path (library, reviews, search, title-history, progress, /api/annotations)
    // returns the exact same rating and note.
    if (
      target &&
      (parsed.hasRating || parsed.hasNote || parsed.hasMeta ||
        (parsed.hasTitle &&
          (target.detail.rating !== null || target.detail.note !== null)))
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
              work_key: key,
              title: t.trim(),
              rating: nextRating,
              note: nextNote,
            },
            nowIso
          );
        }
      }
    }
  })();
  if (!target) {
    // A single YouTube video (checked above).
    return getYoutubeVideoWorkDetail(db, key, tz)!;
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

export interface RefreshMetadataOptions {
  tz?: string;
  config: Config;
  fetch?: typeof fetch;
  now?: () => number;
  nowIso?: string;
  dryRun?: boolean;
  /** Bulk refresh only: wait before retrying a rate-limited (429) lookup. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

interface SingleEntryRefreshOutcome {
  entryId: string;
  title: string;
  changed: boolean;
  minutesBefore: number;
  minutesAfter: number;
}

/**
 * The provider's season list decides which seasons exist (a corrected chain may drop one, e.g. a
 * spin-off that was wrongly counted as a season); known values only fill gaps in it. An empty
 * provider list (incomplete response) keeps the previous seasons.
 */
function mergeRefreshedSeasons(
  previous: SeasonInfo[],
  fresh: SeasonInfo[],
  watchedNumbers: ReadonlySet<number> = new Set()
): SeasonInfo[] {
  if (fresh.length === 0) return previous;
  const prevByNumber = new Map(previous.map((season) => [season.number, season]));
  const byNumber = new Map<number, SeasonInfo>();
  for (const season of fresh) {
    const prev = prevByNumber.get(season.number);
    byNumber.set(season.number, prev ? {
      ...season,
      title: season.title ?? prev.title,
      year: season.year ?? prev.year,
      provider_id: season.provider_id ?? prev.provider_id,
      episodes: season.episodes > 0 ? season.episodes : prev.episodes,
      episode_minutes: season.episode_minutes !== null && season.episode_minutes > 0
        ? season.episode_minutes : prev.episode_minutes,
      total_minutes: season.total_minutes !== null && season.total_minutes > 0
        ? season.total_minutes : prev.total_minutes,
    } : season);
  }
  // A season the user watched never disappears because a provider response left it out.
  for (const season of previous) {
    if (!byNumber.has(season.number) && watchedNumbers.has(season.number)) {
      byNumber.set(season.number, season);
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

function mergeRefreshedWork(
  previous: WorkDetails | ManualWork | null,
  fresh: WorkDetails,
  watchedSeasons: ReadonlySet<number> = new Set()
): WorkDetails {
  if (!previous) return fresh;
  const linked = previous.provider !== "manual" ? previous : null;
  return {
    ...fresh,
    // A newly linked hand-made entry takes the provider's title; a linked one keeps its own.
    title: linked ? previous.title : fresh.title,
    category: previous.category,
    year: fresh.year ?? previous.year,
    cover_url: fresh.cover_url ?? linked?.cover_url ?? null,
    original_title: fresh.original_title ?? linked?.original_title ?? null,
    description: fresh.description ?? linked?.description ?? null,
    creators: fresh.creators.length > 0 ? fresh.creators : previous.creators,
    genres: fresh.genres.length > 0 ? fresh.genres : linked?.genres ?? [],
    seasons: mergeRefreshedSeasons(previous.seasons, fresh.seasons, watchedSeasons),
    // A stored page count describes the user's edition; absent provider data cannot erase it.
    pages: previous.pages !== null && previous.pages > 0 ? previous.pages : fresh.pages,
    runtime_minutes: fresh.runtime_minutes !== null && fresh.runtime_minutes > 0
      ? fresh.runtime_minutes : previous.runtime_minutes,
    // Existing canonical IDs win, even if a provider temporarily omits/misreports an ID.
    external_ids: { ...fresh.external_ids, ...linked?.external_ids },
  };
}

function getActiveArchiveRowsForEntry(db: Database, entryId: string): EventRow[] {
  const likePattern = `archive:${entryId}:%`;
  return db
    .query<EventRow, [string]>(
      `SELECT * FROM events_latest
       WHERE source = 'manual'
         AND source_kind = 'archive'
         AND source_id LIKE ?
       ORDER BY id ASC;`
    )
    .all(likePattern);
}

function extractEntryMetaTarget(
  workObj: Record<string, unknown> | null,
  rows: readonly EventRow[],
  overrideMeta?: { provider: MetaProvider; provider_id: string } | null
): { provider: MetaProvider; id: string } | null {
  if (
    overrideMeta &&
    isMetaProvider(overrideMeta.provider) &&
    isValidProviderId(overrideMeta.provider_id)
  ) {
    return { provider: overrideMeta.provider, id: overrideMeta.provider_id };
  }

  if (
    workObj &&
    isMetaProvider(workObj["provider"]) &&
    isValidProviderId(workObj["provider_id"])
  ) {
    return {
      provider: workObj["provider"],
      id: workObj["provider_id"],
    };
  }

  for (let i = rows.length - 1; i >= 0; i--) {
    const ext = parseExternalIds(rows[i]!.external_ids);
    if (!ext) continue;
    if (isMetaProvider(ext["meta_provider"]) && isValidProviderId(ext["meta_id"])) {
      return { provider: ext["meta_provider"], id: ext["meta_id"] };
    }
    if (typeof ext["anilist"] === "string" && isValidProviderId(ext["anilist"])) {
      return { provider: "anilist", id: ext["anilist"] };
    }
    if (typeof ext["tvmaze"] === "string" && isValidProviderId(ext["tvmaze"])) {
      return { provider: "tvmaze", id: ext["tvmaze"] };
    }
    if (typeof ext["imdb"] === "string" && /^tt\d+$/i.test(ext["imdb"])) {
      return { provider: "cinemeta", id: ext["imdb"].toLowerCase() };
    }
  }

  return null;
}

async function refreshSingleArchiveEntry(
  db: Database,
  entryId: string,
  tz: string,
  metaDeps: MetadataDeps,
  opts: {
    dryRun: boolean;
    nowIso: string;
    overrideMeta?: { provider: MetaProvider; provider_id: string } | null;
  }
): Promise<SingleEntryRefreshOutcome | null> {
  const activeRows = getActiveArchiveRowsForEntry(db, entryId);
  if (activeRows.length === 0) {
    return null;
  }

  const newestRow = activeRows[activeRows.length - 1]!;
  const raw = parseJsonObject(newestRow.raw);
  const workObj = parseJsonObject(raw?.["work"]);
  const existingConsumed = (parseJsonObject(
    raw?.["consumed"]
  ) as ArchiveConsumed | null) ?? {};
  const existingWhen = (parseJsonObject(
    raw?.["when"]
  ) as ArchiveWhen | null) ?? { precision: "unknown" };
  const existingStatus = isValidWorkStatus(raw?.["status"])
    ? (raw!["status"] as Exclude<WorkStatus, "unknown">)
    : undefined;
  const existingCategory = categoryOf(newestRow);

  const title =
    (typeof workObj?.["title"] === "string" && workObj["title"].trim() !== ""
      ? workObj["title"].trim()
      : newestRow.title) ?? "Untitled";

  const minutesBefore =
    existingStatus === "planned"
      ? 0
      : activeRows.reduce((sum, r) => sum + (r.duration_seconds ?? 0), 0) / 60;

  const metaTarget = extractEntryMetaTarget(
    workObj,
    activeRows,
    opts.overrideMeta
  );
  if (!metaTarget) {
    return {
      entryId,
      title,
      changed: false,
      minutesBefore,
      minutesAfter: minutesBefore,
    };
  }

  const freshWork = await lookupWork(
    metaTarget.provider,
    metaTarget.id,
    { ...metaDeps, bypassCache: true },
    existingCategory
  );
  if (!freshWork) {
    return {
      entryId,
      title,
      changed: false,
      minutesBefore,
      minutesAfter: minutesBefore,
    };
  }

  const storedEntry = getArchiveEntry(db, entryId);
  const nextWork = mergeRefreshedWork(
    storedEntry.work,
    freshWork,
    new Set((storedEntry.consumed.seasons ?? []).map((season) => season.number))
  );

  const nextConsumed: ArchiveConsumed = { ...existingConsumed };
  // A provider adding/removing seasons says nothing about what the user watched.

  const nextReq: ArchiveRequest = {
    entry_id: entryId,
    work: nextWork,
    consumed: nextConsumed,
    when: existingWhen,
    ...(existingStatus !== undefined ? { status: existingStatus } : {}),
  };

  const sim = computeArchiveRequestMinutes(nextReq);
  const minutesAfter = existingStatus === "planned" ? 0 : sim.totalMinutes;

  const workChanged =
    JSON.stringify(workObj) !== JSON.stringify(nextWork) ||
    JSON.stringify(existingConsumed) !== JSON.stringify(nextConsumed);
  const minutesChanged = Math.abs(minutesBefore - minutesAfter) > 0.001;
  const changed = workChanged || minutesChanged;

  if (!opts.dryRun && changed) {
    saveArchiveEntry(db, nextReq, tz, { nowIso: opts.nowIso });
  }

  return {
    entryId,
    title: nextWork.title || title,
    changed,
    minutesBefore,
    minutesAfter,
  };
}

export type RefreshWorkResponse = LibraryWorkDetail & RefreshMetadataResult;

/**
 * Re-look up linked metadata for one library work (`POST /api/library/work/refresh-metadata?key=`),
 * bypassing the work cache, and re-save any changed archive entries as new append-only revisions.
 */
export async function refreshLibraryWorkMetadata(
  db: Database,
  key: string,
  opts: RefreshMetadataOptions
): Promise<RefreshWorkResponse> {
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

  const tz = opts.tz ?? opts.config.timezone ?? "Europe/Bratislava";
  key = resolveWorkKey(db, key);
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const dryRun = Boolean(opts.dryRun);

  const allWorks = buildAllLibraryWorks(db, tz, {
    includeHidden: true,
    config: opts.config,
  });
  const target = allWorks.find((item) => item.work.key === key);
  if (!target) {
    throw new WorkOverrideNotFoundError(key);
  }

  const minutesBefore = target.work.total_minutes;
  const overrides = getWorkOverrides(db);
  const currentOverride = overrides.get(key) ?? null;
  if (currentOverride?.meta_unlinked) {
    return { ...target.detail, changed: false, minutes_before: minutesBefore, minutes_after: minutesBefore };
  }

  const metaDeps: MetadataDeps = {
    config: opts.config,
    fetch: opts.fetch,
    now: opts.now,
    bypassCache: true,
  };

  let overrideChanged = false;
  if (currentOverride?.meta !== null && currentOverride?.meta !== undefined) {
    const lookedUpMeta = await lookupWork(
      currentOverride.meta.provider,
      currentOverride.meta.provider_id,
      metaDeps,
      target.work.category
    );
    const freshMeta = lookedUpMeta
      ? mergeRefreshedWork(currentOverride.meta_work, lookedUpMeta)
      : null;
    if (
      freshMeta !== null &&
      JSON.stringify(currentOverride.meta_work) !== JSON.stringify(freshMeta)
    ) {
      overrideChanged = true;
      if (!dryRun) {
        const parsed = parseWorkEdit({
          meta: {
            provider: currentOverride.meta.provider,
            provider_id: currentOverride.meta.provider_id,
          },
        });
        saveWorkOverride(db, key, parsed, currentOverride, freshMeta, nowIso);
      }
    }
  }

  // Collect all distinct archive entry_ids for this work
  const entryIds = new Set<string>();
  for (const ev of target.events) {
    if (ev.source_kind !== "archive") continue;
    const raw = parseJsonObject(ev.raw);
    const eid =
      typeof raw?.["entry_id"] === "string"
        ? raw["entry_id"]
        : typeof ev.source_id === "string"
          ? ev.source_id.split(":")[1]
          : undefined;
    if (eid) {
      entryIds.add(eid);
    }
  }

  let anyEntryChanged = false;
  let simulatedDeltaMinutes = 0;

  for (const entryId of entryIds) {
    const outcome = await refreshSingleArchiveEntry(db, entryId, tz, metaDeps, {
      dryRun,
      nowIso,
      overrideMeta: currentOverride?.meta ?? null,
    });
    if (outcome) {
      if (outcome.changed) {
        anyEntryChanged = true;
      }
      simulatedDeltaMinutes += outcome.minutesAfter - outcome.minutesBefore;
    }
  }

  // If the work had no archive entries and no override.meta, but has an external metadata ID,
  // refresh the on-disk work cache for that external ID.
  if (entryIds.size === 0 && !currentOverride?.meta) {
    for (let i = target.events.length - 1; i >= 0; i--) {
      const ext = parseExternalIds(target.events[i]!.external_ids);
      if (!ext) continue;
      let prov: MetaProvider | null = null;
      let pid: string | null = null;
      if (isMetaProvider(ext["meta_provider"]) && isValidProviderId(ext["meta_id"])) {
        prov = ext["meta_provider"];
        pid = ext["meta_id"];
      } else if (typeof ext["anilist"] === "string" || typeof ext["anilist"] === "number") {
        prov = "anilist";
        pid = String(ext["anilist"]);
      } else if (typeof ext["tvmaze"] === "string" || typeof ext["tvmaze"] === "number") {
        prov = "tvmaze";
        pid = String(ext["tvmaze"]);
      } else if (typeof ext["imdb"] === "string" && /^tt\d+$/i.test(ext["imdb"])) {
        prov = "cinemeta";
        pid = ext["imdb"].toLowerCase();
      }
      if (prov && pid) {
        const fresh = await lookupWork(prov, pid, metaDeps, target.work.category);
        if (fresh) {
          overrideChanged = true;
        }
        break;
      }
    }
  }

  if (dryRun) {
    const minutesAfter = Math.max(0, minutesBefore + simulatedDeltaMinutes);
    return {
      ...target.detail,
      key: target.detail.key,
      changed: overrideChanged || anyEntryChanged,
      minutes_before: minutesBefore,
      minutes_after: minutesAfter,
    };
  }

  const updatedWorks = buildAllLibraryWorks(db, tz, {
    includeHidden: true,
    config: opts.config,
  });
  let updated = updatedWorks.find((item) => item.work.key === resolveWorkKey(db, key));
  if (!updated && entryIds.size > 0) {
    updated = updatedWorks.find((item) =>
      item.detail.history.some((h) => h.entry_id !== null && entryIds.has(h.entry_id))
    );
  }
  const finalDetail = updated ? updated.detail : target.detail;
  const minutesAfter = finalDetail.total_minutes;
  const changed =
    overrideChanged ||
    anyEntryChanged ||
    Math.abs(minutesBefore - minutesAfter) > 0.001;

  return {
    ...finalDetail,
    key: finalDetail.key,
    changed,
    minutes_before: minutesBefore,
    minutes_after: minutesAfter,
  };
}

export interface RefreshArchiveSummaryItem extends RefreshMetadataResult {
  title: string;
  /** Set when the lookup failed (provider down, still rate-limited after retries); nothing changed. */
  error?: string;
}

/** Waits for a rate-limited provider in the bulk refresh: 3 tries, 30 s, 60 s, 90 s. */
const REFRESH_RATE_LIMIT_WAITS_MS = [30_000, 60_000, 90_000];
/** Pause between works in the bulk refresh so AniList (≈30 requests/min) is not flooded. */
const REFRESH_PAUSE_MS = 1_500;

export function formatRefreshHours(minutes: number): string {
  const hours = minutes / 60;
  if (Math.abs(hours - Math.round(hours)) < 0.05 || hours >= 10) {
    return `${Math.round(hours)} h`;
  }
  return `${Math.round(hours * 10) / 10} h`;
}

export function formatRefreshHoursLine(item: {
  title: string;
  minutes_before: number;
  minutes_after: number;
}): string {
  return `${item.title}: ${formatRefreshHours(item.minutes_before)} → ${formatRefreshHours(
    item.minutes_after
  )}`;
}

/**
 * Refresh linked metadata for every archive entry in `db`
 * (`it archive refresh-metadata [--dry-run]`).
 */
export async function refreshAllArchiveMetadata(
  db: Database,
  opts: RefreshMetadataOptions
): Promise<RefreshArchiveSummaryItem[]> {
  const tz = opts.tz ?? opts.config.timezone ?? "Europe/Bratislava";
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const dryRun = Boolean(opts.dryRun);

  const allWorks = buildAllLibraryWorks(db, tz, {
    includeHidden: true,
    config: opts.config,
  });

  const archiveWorks = allWorks.filter((w) =>
    w.events.some((e) => e.source_kind === "archive")
  );

  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const results: RefreshArchiveSummaryItem[] = [];
  // One failing or rate-limited lookup must not abort the whole refresh: retry 429s after a
  // wait, record other failures per work and go on.
  for (const [index, item] of archiveWorks.entries()) {
    if (index > 0) await sleep(REFRESH_PAUSE_MS);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await refreshLibraryWorkMetadata(db, item.work.key, {
          ...opts,
          tz,
          nowIso,
          dryRun,
        });
        results.push({
          key: res.key,
          title: item.work.title,
          changed: res.changed,
          minutes_before: res.minutes_before,
          minutes_after: res.minutes_after,
        });
        break;
      } catch (caught) {
        const rateLimited =
          caught instanceof ProviderError && caught.status === 429;
        if (rateLimited && attempt < REFRESH_RATE_LIMIT_WAITS_MS.length) {
          await sleep(REFRESH_RATE_LIMIT_WAITS_MS[attempt]!);
          continue;
        }
        results.push({
          key: item.work.key,
          title: item.work.title,
          changed: false,
          minutes_before: item.work.total_minutes,
          minutes_after: item.work.total_minutes,
          error: caught instanceof Error ? caught.message : String(caught),
        });
        break;
      }
    }
  }

  return results;
}
