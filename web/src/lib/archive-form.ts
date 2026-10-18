/**
 * Pure helpers for the v2 lookup-first "Add to Archive" flow.
 *
 * Computes estimated durations from seasons/episodes, film runtimes, book pages,
 * or manual hour overrides; formats human-readable previews ("2 seasons · 48 episodes · ≈ 19 h");
 * formats ArchiveWhen precisions; and validates/builds `ArchiveRequest` payloads.
 *
 * No DOM dependencies; safe to run under Bun or in the browser.
 */

import type {
  ArchiveConsumed,
  ArchiveRequest,
  ArchiveWhen,
  Category,
  DatePrecision,
  ManualWork,
  SeasonInfo,
  WorkDetails,
} from "../api";
import { isCategory } from "./categories";
import { formatLocalDay } from "./format-date";
import { formatMinutes } from "./stats";

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface ArchiveTimePreview {
  readonly totalMinutes: number;
  readonly estimated: boolean;
  readonly units: number;
  readonly seasonsCount: number;
  readonly episodesCount: number;
  readonly summaryText: string;
}

/**
 * Formats minutes as a friendly hours/minutes label for archive previews.
 * Uses whole/one-decimal hours for large values (e.g. "≈ 19 h" or "≈ 1.5 h")
 * and exact hours+minutes when not estimated or < 3 hours.
 */
export function formatArchiveDuration(
  minutes: number,
  estimated = true
): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "0m";
  }
  const rounded = Math.round(minutes);
  const prefix = estimated ? "≈ " : "";

  if (rounded < 60) {
    return `${prefix}${rounded}m`;
  }

  const hours = rounded / 60;
  // For multi-hour season/book estimates (>= 5 h), show clean hours like "≈ 19 h" or "≈ 19.5 h"
  if (estimated && hours >= 5) {
    const hRounded = Math.round(hours * 2) / 2;
    return Number.isInteger(hRounded)
      ? `${prefix}${hRounded} h`
      : `${prefix}${hRounded.toFixed(1)} h`;
  }

  return `${prefix}${formatMinutes(rounded)}`;
}

/**
 * Computes total minutes, unit count, and a human-readable preview line
 * before saving an archive entry, following the exact rules in `docs/v2-spec.md`:
 *
 * - `minutes_override` always wins when > 0.
 * - Series/anime with seasons: for each selected season, whole season -> `season.total_minutes`
 *   (or `season.episodes * season.episode_minutes`), partial -> `episodes * season.episode_minutes`.
 * - Film (or single-entry work without seasons): `runtime_minutes * times`.
 * - Book: `minutes_override`, else `pages * 1.5 * progress`.
 * - Audiobook/other: `minutes_override`.
 */
export function computeArchivePreview(
  work: WorkDetails | ManualWork,
  consumed: ArchiveConsumed
): ArchiveTimePreview {
  const hasOverride =
    consumed.minutes_override !== undefined &&
    consumed.minutes_override !== null &&
    Number.isFinite(consumed.minutes_override) &&
    consumed.minutes_override > 0;

  const overrideMin = hasOverride
    ? Math.round(consumed.minutes_override!)
    : null;

  // 1. Series / Anime with seasons
  if (
    (work.category === "anime" || work.category === "series") &&
    work.seasons.length > 0
  ) {
    const selected = consumed.seasons ?? [];
    let seasonsCount = 0;
    let episodesCount = 0;
    let calcMinutes = 0;

    const seasonMap = new Map<number, SeasonInfo>();
    for (const s of work.seasons) {
      seasonMap.set(s.number, s);
    }

    for (const sel of selected) {
      const info = seasonMap.get(sel.number);
      if (!info) continue;
      seasonsCount += 1;

      const totalEp = Math.max(0, info.episodes || 0);
      const rawEp = sel.episodes;
      const isWhole =
        rawEp === undefined ||
        rawEp === null ||
        (totalEp > 0 && rawEp >= totalEp);
      const watchedEp = isWhole
        ? totalEp
        : Math.max(0, Math.min(totalEp || rawEp, Math.round(rawEp)));

      episodesCount += watchedEp;

      if (isWhole && info.total_minutes !== null && info.total_minutes > 0) {
        calcMinutes += info.total_minutes;
      } else if (info.episode_minutes !== null && info.episode_minutes > 0) {
        calcMinutes += watchedEp * info.episode_minutes;
      } else if (
        info.total_minutes !== null &&
        info.total_minutes > 0 &&
        totalEp > 0
      ) {
        calcMinutes += Math.round((info.total_minutes * watchedEp) / totalEp);
      }
    }

    const totalMinutes = overrideMin ?? Math.round(calcMinutes);
    const estimated = overrideMin === null;
    const parts: string[] = [];
    parts.push(`${seasonsCount} ${seasonsCount === 1 ? "season" : "seasons"}`);
    if (episodesCount > 0) {
      parts.push(
        `${episodesCount} ${episodesCount === 1 ? "episode" : "episodes"}`
      );
    }
    if (totalMinutes > 0) {
      parts.push(formatArchiveDuration(totalMinutes, estimated));
    }

    return {
      totalMinutes,
      estimated,
      units: Math.max(1, seasonsCount),
      seasonsCount,
      episodesCount,
      summaryText: parts.join(" · "),
    };
  }

  // 2. Film or single-entry Anime movie (no seasons)
  if (work.category === "film" || work.category === "anime" || work.category === "series") {
    const times = Math.max(1, Math.round(consumed.times ?? 1));
    const runtime =
      work.runtime_minutes !== null && work.runtime_minutes > 0
        ? work.runtime_minutes
        : 0;
    const totalMinutes = overrideMin ?? Math.round(runtime * times);
    const estimated = overrideMin === null;

    const parts: string[] = [
      `${times} ${times === 1 ? "viewing" : "viewings"}`,
    ];
    if (totalMinutes > 0) {
      parts.push(formatArchiveDuration(totalMinutes, estimated));
    }

    return {
      totalMinutes,
      estimated,
      units: times,
      seasonsCount: 0,
      episodesCount: 0,
      summaryText: parts.join(" · "),
    };
  }

  // 3. Book
  if (work.category === "book") {
    const progress =
      consumed.progress !== undefined && consumed.progress !== null
        ? Math.max(0, Math.min(1, consumed.progress))
        : 1;
    const pages = work.pages !== null && work.pages > 0 ? work.pages : 0;
    const calcMinutes = pages > 0 ? Math.round(pages * 1.5 * progress) : 0;
    const totalMinutes = overrideMin ?? calcMinutes;
    const estimated = overrideMin === null;

    const pct = Math.round(progress * 100);
    const parts: string[] = [pct >= 100 ? "Finished" : `${pct}% read`];
    if (pages > 0) {
      const readPages = Math.round(pages * progress);
      parts.push(
        pct >= 100 ? `${pages} pages` : `${readPages} of ${pages} pages`
      );
    }
    if (totalMinutes > 0) {
      parts.push(formatArchiveDuration(totalMinutes, estimated));
    }

    return {
      totalMinutes,
      estimated,
      units: 1,
      seasonsCount: 0,
      episodesCount: 0,
      summaryText: parts.join(" · "),
    };
  }

  // 4. Audiobook / Podcast / Music / YouTube / Other
  const progress =
    consumed.progress !== undefined && consumed.progress !== null
      ? Math.max(0, Math.min(1, consumed.progress))
      : 1;
  const runtimeFallback =
    work.runtime_minutes !== null && work.runtime_minutes > 0
      ? Math.round(work.runtime_minutes * progress)
      : 0;
  const totalMinutes = overrideMin ?? runtimeFallback;
  const estimated = overrideMin === null && runtimeFallback > 0;
  const pct = Math.round(progress * 100);

  const parts: string[] = [pct >= 100 ? "Finished" : `${pct}% complete`];
  if (totalMinutes > 0) {
    parts.push(formatArchiveDuration(totalMinutes, estimated));
  }

  return {
    totalMinutes,
    estimated,
    units: 1,
    seasonsCount: 0,
    episodesCount: 0,
    summaryText: parts.join(" · "),
  };
}

function formatSingleWhenDate(precision: DatePrecision, date?: string): string {
  if (!date || precision === "unknown") {
    return "Date unknown";
  }
  if (precision === "day") {
    return formatLocalDay(date);
  }
  if (precision === "month") {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(date);
    if (m) {
      const monthIdx = Number.parseInt(m[2]!, 10) - 1;
      return `${SHORT_MONTHS[monthIdx]} ${m[1]}`;
    }
    return date;
  }
  return date;
}

/**
 * Formats an `ArchiveWhen` object into a calm display string:
 * - `{ precision: "day", date: "2026-10-17" }` -> `"17.10.2026"`
 * - `{ precision: "month", date: "2021-03", end_date: "2021-05" }` -> `"Mar 2021 – May 2021"`
 * - `{ precision: "year", date: "2021" }` -> `"2021"`
 * - `{ precision: "unknown" }` -> `"Date unknown"`
 */
export function formatArchiveWhen(when: ArchiveWhen): string {
  if (!when || when.precision === "unknown" || !when.date) {
    return "Date unknown";
  }
  const start = formatSingleWhenDate(when.precision, when.date);
  if (when.end_date && when.end_date !== when.date) {
    const end = formatSingleWhenDate(when.precision, when.end_date);
    return `${start} – ${end}`;
  }
  return start;
}

/**
 * Formats a `LibraryWorkDetail["history"][number]` date according to its `precision`.
 */
export function formatHistoryPrecisionDate(
  startedAt: string,
  precision: DatePrecision
): string {
  if (precision === "unknown") {
    return "Undated";
  }
  const datePart = startedAt.slice(0, 10);
  if (precision === "year") {
    return datePart.slice(0, 4);
  }
  if (precision === "month") {
    return formatSingleWhenDate("month", datePart.slice(0, 7));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return formatLocalDay(datePart);
  }
  return startedAt;
}

function isValidWhenDate(precision: DatePrecision, value: string): boolean {
  switch (precision) {
    case "day":
      return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);
    case "month":
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
    case "year":
      return /^\d{4}$/.test(value);
    case "unknown":
      return true;
  }
}

export interface ManualWorkDraft {
  category: Category;
  title: string;
  year?: string | number | null;
  creators?: string | string[];
  runtime_minutes?: string | number | null;
  pages?: string | number | null;
  seasons_count?: string | number | null;
  episodes_per_season?: string | number | null;
  episode_minutes?: string | number | null;
  seasons?: SeasonInfo[];
}

export type BuildManualWorkResult =
  | { ok: true; work: ManualWork }
  | { ok: false; errors: string[] };

/**
 * Validates and builds a `ManualWork` when no metadata provider knows the title.
 */
export function buildManualWork(draft: ManualWorkDraft): BuildManualWorkResult {
  const errors: string[] = [];

  if (!isCategory(draft.category)) {
    errors.push("Choose a valid category.");
  }

  const title = (draft.title ?? "").trim();
  if (!title) {
    errors.push("Title is required.");
  } else if (title.length > 300) {
    errors.push("Title must be 300 characters or fewer.");
  }

  let year: number | null = null;
  if (draft.year !== undefined && draft.year !== null && String(draft.year).trim() !== "") {
    const parsedYear = Number(String(draft.year).trim());
    if (!Number.isInteger(parsedYear) || parsedYear < 1800 || parsedYear > 2100) {
      errors.push("Year must be between 1800 and 2100.");
    } else {
      year = parsedYear;
    }
  }

  const creators: string[] = Array.isArray(draft.creators)
    ? draft.creators.map((c) => c.trim()).filter(Boolean)
    : typeof draft.creators === "string"
      ? draft.creators
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];

  let runtimeMinutes: number | null = null;
  if (
    draft.runtime_minutes !== undefined &&
    draft.runtime_minutes !== null &&
    String(draft.runtime_minutes).trim() !== ""
  ) {
    const parsed = Number(String(draft.runtime_minutes).trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push("Runtime must be a positive number of minutes.");
    } else {
      runtimeMinutes = Math.round(parsed);
    }
  }

  let pages: number | null = null;
  if (
    draft.pages !== undefined &&
    draft.pages !== null &&
    String(draft.pages).trim() !== ""
  ) {
    const parsed = Number(String(draft.pages).trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      errors.push("Page count must be a positive whole number.");
    } else {
      pages = parsed;
    }
  }

  let seasons: SeasonInfo[] = [];
  if (draft.seasons && draft.seasons.length > 0) {
    seasons = draft.seasons;
  } else if (draft.category === "anime" || draft.category === "series") {
    const sCountRaw = String(draft.seasons_count ?? "").trim();
    const epCountRaw = String(draft.episodes_per_season ?? "").trim();
    const epMinRaw = String(draft.episode_minutes ?? "").trim();

    const sCount = sCountRaw ? Number(sCountRaw) : 1;
    const epCount = epCountRaw ? Number(epCountRaw) : 12;
    const epMin = epMinRaw ? Number(epMinRaw) : 24;

    if (sCountRaw && (!Number.isInteger(sCount) || sCount < 0 || sCount > 50)) {
      errors.push("Seasons count must be between 0 and 50.");
    } else if (sCount > 0) {
      const safeEps = Number.isInteger(epCount) && epCount > 0 ? epCount : 12;
      const safeMin = Number.isFinite(epMin) && epMin > 0 ? Math.round(epMin) : null;
      seasons = Array.from({ length: sCount }, (_, i) => ({
        number: i + 1,
        title: `Season ${i + 1}`,
        year,
        episodes: safeEps,
        episode_minutes: safeMin,
        total_minutes: safeMin !== null ? safeEps * safeMin : null,
        provider_id: null,
      }));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    work: {
      provider: "manual",
      category: draft.category,
      title,
      year,
      creators,
      seasons,
      runtime_minutes: runtimeMinutes,
      pages,
    },
  };
}

export interface BuildArchiveRequestInput {
  entry_id?: string;
  work: WorkDetails | ManualWork | null;
  consumed: ArchiveConsumed;
  when: ArchiveWhen;
  rating?: number | null;
  note?: string | null;
}

export type BuildArchiveRequestResult =
  | { ok: true; request: ArchiveRequest }
  | { ok: false; errors: string[] };

/**
 * Validates and builds an `ArchiveRequest` ready for `POST /api/archive`.
 */
export function buildArchiveRequest(
  input: BuildArchiveRequestInput
): BuildArchiveRequestResult {
  const errors: string[] = [];

  if (!input.work) {
    return { ok: false, errors: ["Select a work or enter one by hand first."] };
  }

  const work = input.work;
  if (!work.title || work.title.trim() === "") {
    errors.push("Work title is required.");
  }

  // Validate consumed based on category
  const consumed: ArchiveConsumed = {};

  if (
    (work.category === "anime" || work.category === "series") &&
    work.seasons.length > 0
  ) {
    const selected = input.consumed.seasons ?? [];
    if (selected.length === 0) {
      errors.push("Select at least one season you watched.");
    } else {
      const seasonMap = new Map<number, SeasonInfo>();
      for (const s of work.seasons) {
        seasonMap.set(s.number, s);
      }
      consumed.seasons = selected.map((sel) => {
        const info = seasonMap.get(sel.number);
        const maxEp = info?.episodes ?? 0;
        if (
          sel.episodes !== undefined &&
          sel.episodes !== null &&
          (maxEp === 0 || sel.episodes < maxEp)
        ) {
          return {
            number: sel.number,
            episodes: Math.max(1, Math.round(sel.episodes)),
          };
        }
        // Omit `episodes` when the whole season was watched, per contract.ts
        return { number: sel.number };
      });
    }
  } else if (
    work.category === "film" ||
    work.category === "anime" ||
    work.category === "series"
  ) {
    const times = input.consumed.times ?? 1;
    if (!Number.isInteger(times) || times < 1 || times > 1000) {
      errors.push("Times watched must be a whole number of at least 1.");
    } else {
      consumed.times = times;
    }
  } else {
    const progress = input.consumed.progress ?? 1;
    if (!Number.isFinite(progress) || progress <= 0 || progress > 1) {
      errors.push("Progress must be between 1% and 100%.");
    } else {
      consumed.progress = Math.round(progress * 100) / 100;
    }
  }

  if (
    input.consumed.minutes_override !== undefined &&
    input.consumed.minutes_override !== null
  ) {
    const override = Number(input.consumed.minutes_override);
    if (!Number.isFinite(override) || override < 0) {
      errors.push("Time override must be 0 or greater.");
    } else if (override > 0) {
      consumed.minutes_override = Math.round(override);
    }
  }

  // Validate When
  const precision = input.when.precision;
  const when: ArchiveWhen = { precision };

  if (precision !== "unknown") {
    const date = (input.when.date ?? "").trim();
    if (!date) {
      errors.push(`Enter a ${precision} for when you consumed this work.`);
    } else if (!isValidWhenDate(precision, date)) {
      errors.push(`Invalid ${precision} format: "${date}".`);
    } else {
      when.date = date;
    }

    const endDate = (input.when.end_date ?? "").trim();
    if (endDate) {
      if (!isValidWhenDate(precision, endDate)) {
        errors.push(`Invalid end ${precision} format: "${endDate}".`);
      } else if (date && endDate < date) {
        errors.push("End date cannot be earlier than start date.");
      } else if (endDate !== date) {
        when.end_date = endDate;
      }
    }
  }

  // Validate optional rating & note
  let rating: number | null | undefined = undefined;
  if (input.rating !== undefined && input.rating !== null) {
    if (
      !Number.isInteger(input.rating) ||
      input.rating < 1 ||
      input.rating > 10
    ) {
      errors.push("Rating must be a whole number between 1 and 10.");
    } else {
      rating = input.rating;
    }
  }

  let note: string | null | undefined = undefined;
  if (input.note !== undefined && input.note !== null) {
    const trimmed = input.note.trim();
    if (trimmed.length > 5000) {
      errors.push("Note must be 5000 characters or fewer.");
    } else if (trimmed.length > 0) {
      note = trimmed;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const entryId =
    input.entry_id && input.entry_id.trim() !== ""
      ? input.entry_id.trim()
      : crypto.randomUUID();

  const request: ArchiveRequest = {
    entry_id: entryId,
    work,
    consumed,
    when,
  };

  if (rating !== undefined) {
    request.rating = rating;
  }
  if (note !== undefined) {
    request.note = note;
  }

  return { ok: true, request };
}
