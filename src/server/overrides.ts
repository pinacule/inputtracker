/**
 * Work overrides (v2.1 section 8) and multi-category filter helpers (section 9).
 *
 * Rules:
 * - `work_overrides` is append-only (migration v6): every edit inserts a new row,
 *   and `work_overrides_latest` selects `MAX(id)` per `work_key`.
 * - Work keys are derived deterministically from canonical identity (external
 *   IDs / metadata provider+id, else normalized category+title), never from list
 *   order (`#2` suffixes).
 * - Overrides apply on every read: library, calendar, heat maps, stats, series,
 *   insights, search, and month/year reviews.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { CATEGORIES, categoryOf, isCategory, type Category } from "../core/category.ts";
import type {
  MetaProvider,
  WorkDetails,
  WorkEdit,
  WorkStatus,
} from "../core/contract.ts";
import type { WorkOverrideRow } from "../core/schema.ts";
import type { DedupedEvent } from "./dedup.ts";
import {
  AnnotationValidationError,
  parseNote,
  parseRevId,
} from "./annotations.ts";
import {
  RatingValidationError,
  ratingToTenths,
  tenthsToRating,
} from "./ratings.ts";
import { normalizeForSearch } from "./search.ts";

export const VALID_WORK_STATUSES: ReadonlySet<WorkStatus> = new Set<WorkStatus>([
  "in_progress",
  "finished",
  "dropped",
  "planned",
  "unknown",
]);

export function isValidWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === "string" && VALID_WORK_STATUSES.has(value as WorkStatus);
}

const VALID_META_PROVIDERS: ReadonlySet<MetaProvider> = new Set<MetaProvider>([
  "anilist",
  "tvmaze",
  "cinemeta",
  "itunes",
  "openlibrary",
  "tmdb",
]);

const META_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const EXTERNAL_JOIN_KEYS = [
  "anilist",
  "mal",
  "imdb",
  "tvmaze",
  "abs_item",
  "meta_id",
] as const;

/**
 * Deterministic priority order of external ID keys when deriving a work's
 * canonical key. `imdb` and `mal` come first because they are shared across
 * Simkl and metadata providers (Cinemeta, TVmaze, TMDB, AniList).
 */
const CANONICAL_ID_PRIORITY = [
  "imdb",
  "mal",
  "anilist",
  "tvmaze",
  "openlibrary",
  "itunes",
  "tmdb",
  "abs_item",
] as const;

export class WorkOverrideValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkOverrideValidationError";
  }
}

export class WorkOverrideNotFoundError extends Error {
  constructor(key: string) {
    super(`Work not found: ${key}`);
    this.name = "WorkOverrideNotFoundError";
  }
}

export class CategoryFilterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategoryFilterValidationError";
  }
}

// --- Multi-category filter (section 9) ---------------------------------------

export interface CategoryFilter {
  include?: ReadonlySet<Category>;
  exclude?: ReadonlySet<Category>;
}

export type CategoryFilterInput =
  | Category
  | readonly Category[]
  | string
  | undefined;

function parseCategoryList(
  raw: CategoryFilterInput,
  paramName: "category" | "exclude"
): Set<Category> | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  const tokens: string[] = Array.isArray(raw)
    ? raw.map((x) => String(x))
    : typeof raw === "string"
      ? raw.split(",")
      : [String(raw)];

  const set = new Set<Category>();
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!isCategory(trimmed)) {
      throw new CategoryFilterValidationError(
        `Invalid ${paramName}: '${trimmed}'`
      );
    }
    set.add(trimmed);
  }
  return set.size > 0 ? set : undefined;
}

/**
 * Parse `category` (comma-separated or array) and `exclude` (comma-separated or
 * array) into a validated `CategoryFilter`. Throws `CategoryFilterValidationError`
 * on any unknown category name.
 */
export function parseCategoryFilter(
  category?: CategoryFilterInput,
  exclude?: CategoryFilterInput
): CategoryFilter | undefined {
  const inc = parseCategoryList(category, "category");
  const exc = parseCategoryList(exclude, "exclude");
  if (!inc && !exc) {
    return undefined;
  }
  return { include: inc, exclude: exc };
}

/** True when `category` passes the `include` and `exclude` sets of `filter`. */
export function matchesCategoryFilter(
  category: Category,
  filter?: CategoryFilter
): boolean {
  if (!filter) {
    return true;
  }
  if (filter.include && filter.include.size > 0 && !filter.include.has(category)) {
    return false;
  }
  if (filter.exclude && filter.exclude.size > 0 && filter.exclude.has(category)) {
    return false;
  }
  return true;
}

// --- JSON / event helpers ----------------------------------------------------

function parseObj(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export interface EventForWorkGrouping {
  id: number;
  source: string;
  source_kind: string;
  source_id?: string;
  external_ids?: unknown;
  media_type: string;
  title: string | null;
  parent_title?: string | null;
  season?: number | null;
  episode?: number | null;
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  progress?: number | null;
  raw?: unknown;
}

function seriesOrTitleOf(event: EventForWorkGrouping): string {
  const isSeriesOrShow =
    event.media_type === "episode" ||
    event.media_type === "show" ||
    event.media_type === "podcast" ||
    event.media_type === "podcast_episode" ||
    (event.season !== null && event.season !== undefined) ||
    (event.episode !== null && event.episode !== undefined);

  if (isSeriesOrShow && event.parent_title && event.parent_title.trim() !== "") {
    return event.parent_title.trim();
  }
  return event.title?.trim() || event.parent_title?.trim() || "Untitled";
}

/** Title of the work an event belongs to (channel name for YouTube). */
export function eventWorkTitleForGrouping(
  event: EventForWorkGrouping,
  category: Category
): string {
  if (category === "youtube") {
    const channel = event.parent_title?.trim();
    if (channel && channel !== "") {
      return channel;
    }
    const raw = parseObj(event.raw);
    const work = parseObj(raw?.["work"]);
    if (typeof work?.["title"] === "string" && work["title"].trim() !== "") {
      return work["title"].trim();
    }
    return event.title?.trim() || "Unknown channel";
  }

  if (event.source_kind === "archive") {
    const raw = parseObj(event.raw);
    const work = parseObj(raw?.["work"]);
    if (typeof work?.["title"] === "string" && work["title"].trim() !== "") {
      return work["title"].trim();
    }
  }

  return seriesOrTitleOf(event);
}

/** Join tokens for an event within its category. */
export function eventJoinTokensForGrouping(
  event: EventForWorkGrouping,
  category: Category,
  workTitle: string
): string[] {
  const tokens: string[] = [];
  const normTitle = normalizeForSearch(workTitle);
  if (normTitle !== "") {
    tokens.push(`title:${normTitle}`);
  }

  const ext = parseObj(event.external_ids);
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

/**
 * Derive a deterministic, stable work key from the component's canonical
 * identity (external IDs, metadata provider+id, else normalized category+title).
 * Never depends on event list order or `#2` suffixes.
 */
export function computeCanonicalWorkKey(
  category: Category,
  workEvents: readonly EventForWorkGrouping[],
  canonicalTitle: string
): string {
  if (category === "youtube") {
    const channelIds = new Set<string>();
    for (const ev of workEvents) {
      const ext = parseObj(ev.external_ids);
      const ch = ext?.["youtube_channel"];
      if (typeof ch === "string" && ch.trim() !== "") {
        channelIds.add(ch.trim());
      }
    }
    if (channelIds.size > 0) {
      const best = [...channelIds].sort()[0]!;
      return `youtube:channel:${best}`;
    }
    const norm = normalizeForSearch(canonicalTitle);
    if (norm !== "") {
      return `youtube:${norm}`;
    }
    const fallbackId = workEvents
      .map((e) => `${e.source}:${e.source_id ?? e.id}`)
      .sort()[0]!;
    return `youtube:id:${fallbackId}`;
  }

  for (const idKey of CANONICAL_ID_PRIORITY) {
    const values = new Set<string>();
    for (const ev of workEvents) {
      const ext = parseObj(ev.external_ids);
      if (!ext) continue;
      const val = ext[idKey];
      const strVal =
        typeof val === "string"
          ? val.trim()
          : typeof val === "number" && Number.isFinite(val)
            ? String(val)
            : "";
      if (strVal !== "") {
        values.add(strVal);
      }
    }
    if (values.size > 0) {
      const best = [...values].sort()[0]!;
      return `${category}:${idKey}:${best}`;
    }
  }

  const metaPairs = new Set<string>();
  for (const ev of workEvents) {
    const ext = parseObj(ev.external_ids);
    if (!ext) continue;
    const provider =
      typeof ext["meta_provider"] === "string" ? ext["meta_provider"].trim() : "";
    const metaId =
      typeof ext["meta_id"] === "string"
        ? ext["meta_id"].trim()
        : typeof ext["meta_id"] === "number" && Number.isFinite(ext["meta_id"])
          ? String(ext["meta_id"])
          : "";
    if (provider !== "" && metaId !== "") {
      metaPairs.add(`${provider}:${metaId}`);
    }
  }
  if (metaPairs.size > 0) {
    const best = [...metaPairs].sort()[0]!;
    return `${category}:${best}`;
  }

  const normTitles = new Set<string>();
  const normCanonical = normalizeForSearch(canonicalTitle);
  if (normCanonical !== "") {
    normTitles.add(normCanonical);
  }
  for (const ev of workEvents) {
    const nt = normalizeForSearch(eventWorkTitleForGrouping(ev, category));
    if (nt !== "") {
      normTitles.add(nt);
    }
  }
  if (normTitles.size > 0) {
    const best = [...normTitles].sort()[0]!;
    return `${category}:${best}`;
  }

  const fallbackId = workEvents
    .map((e) => `${e.source}:${e.source_id ?? e.id}`)
    .sort()[0]!;
  return `${category}:id:${fallbackId}`;
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

export interface GroupedWorkComponent<E extends EventForWorkGrouping> {
  sourceCategory: Category;
  key: string;
  sourceCanonicalTitle: string;
  events: E[];
  eventTitles: string[];
}

/**
 * Group events by source category and join tokens into work components with
 * stable keys.
 */
export function groupEventsIntoWorkComponents<E extends EventForWorkGrouping>(
  events: readonly E[]
): GroupedWorkComponent<E>[] {
  const eventsByCategory = new Map<Category, E[]>();
  for (const ev of events) {
    const cat = categoryOf(ev);
    let list = eventsByCategory.get(cat);
    if (!list) {
      list = [];
      eventsByCategory.set(cat, list);
    }
    list.push(ev);
  }

  const result: GroupedWorkComponent<E>[] = [];

  for (const cat of CATEGORIES) {
    const catEvents = eventsByCategory.get(cat);
    if (!catEvents || catEvents.length === 0) {
      continue;
    }

    const dsu = new DisjointSet(catEvents.length);
    const tokenToIndex = new Map<string, number>();
    const titles: string[] = [];

    for (let i = 0; i < catEvents.length; i++) {
      const ev = catEvents[i]!;
      const wTitle = eventWorkTitleForGrouping(ev, cat);
      titles.push(wTitle);
      const tokens = eventJoinTokensForGrouping(ev, cat, wTitle);
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
      const pairs = indices.map((idx) => ({
        event: catEvents[idx]!,
        title: titles[idx]!,
      }));
      pairs.sort(
        (a, b) =>
          a.event.started_at.localeCompare(b.event.started_at) ||
          a.event.id - b.event.id
      );

      const workEvents = pairs.map((p) => p.event);
      const eventTitles = pairs.map((p) => p.title);

      let sourceCanonicalTitle = eventTitles[eventTitles.length - 1]!;
      for (let i = workEvents.length - 1; i >= 0; i--) {
        const ev = workEvents[i]!;
        if (ev.source_kind === "archive") {
          const raw = parseObj(ev.raw);
          const workSnap = parseObj(raw?.["work"]);
          if (
            typeof workSnap?.["title"] === "string" &&
            workSnap["title"].trim() !== ""
          ) {
            sourceCanonicalTitle = workSnap["title"].trim();
            break;
          }
        }
      }

      const key = computeCanonicalWorkKey(cat, workEvents, sourceCanonicalTitle);

      result.push({
        sourceCategory: cat,
        key,
        sourceCanonicalTitle,
        events: workEvents,
        eventTitles,
      });
    }
  }

  return result;
}

// --- Overrides table (migration v6) ------------------------------------------

export interface LatestOverride {
  id: number;
  record_hash: string;
  work_key: string;
  rev_id: string;
  title: string | null;
  category: Category | null;
  status: WorkStatus | null;
  rating: number | null;
  rating_tenths: number | null;
  note: string | null;
  hidden: boolean;
  meta: { provider: MetaProvider; provider_id: string } | null;
  meta_work: WorkDetails | null;
  /** Explicit WorkEdit.meta=null, distinct from an override that never mentioned metadata. */
  meta_unlinked: boolean;
  topic: string | null;
  created_at: string;
  edited: boolean;
}

function rowToLatestOverride(row: WorkOverrideRow): LatestOverride {
  const meta =
    typeof row.meta_provider === "string" &&
    VALID_META_PROVIDERS.has(row.meta_provider as MetaProvider) &&
    typeof row.meta_id === "string" &&
    META_ID_RE.test(row.meta_id)
      ? {
          provider: row.meta_provider as MetaProvider,
          provider_id: row.meta_id,
        }
      : null;

  let metaWork: WorkDetails | null = null;
  let metaUnlinked = false;
  if (typeof row.meta_json === "string" && row.meta_json.trim() !== "") {
    try {
      const parsed = JSON.parse(row.meta_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metaUnlinked = (parsed as Record<string, unknown>)["unlinked"] === true;
        if (!metaUnlinked) metaWork = parsed as WorkDetails;
      }
    } catch {
      metaWork = null;
    }
  }

  const category = isCategory(row.category) ? row.category : null;
  const status = isValidWorkStatus(row.status) ? row.status : null;
  const ratingTenths =
    typeof row.rating_tenths === "number" && Number.isFinite(row.rating_tenths)
      ? row.rating_tenths
      : null;
  const rating = tenthsToRating(ratingTenths, null);
  const title =
    typeof row.title === "string" && row.title.trim() !== ""
      ? row.title.trim()
      : null;
  const note =
    typeof row.note === "string" && row.note !== "" ? row.note : null;
  const hidden = row.hidden === 1;
  const topic =
    typeof row.topic === "string" && row.topic.trim() !== ""
      ? row.topic.trim()
      : null;

  const edited =
    title !== null ||
    category !== null ||
    status !== null ||
    ratingTenths !== null ||
    note !== null ||
    hidden ||
    meta !== null ||
    topic !== null;

  return {
    id: row.id,
    record_hash: row.record_hash,
    work_key: row.work_key,
    rev_id: row.rev_id,
    title,
    category,
    status,
    rating,
    rating_tenths: ratingTenths,
    note,
    hidden,
    meta,
    meta_work: metaWork,
    meta_unlinked: metaUnlinked,
    topic,
    created_at: row.created_at,
    edited,
  };
}

/**
 * Read the latest override per work key from `work_overrides_latest`.
 */
export function getWorkOverrides(db: Database): Map<string, LatestOverride> {
  const map = new Map<string, LatestOverride>();
  try {
    const rows = db
      .query<WorkOverrideRow, []>(
        "SELECT * FROM work_overrides_latest ORDER BY id ASC;"
      )
      .all();
    for (const row of rows) {
      map.set(row.work_key, rowToLatestOverride(row));
    }
  } catch {
    // Table/view may not exist on a partially-migrated test database.
  }
  return map;
}

const ALLOWED_WORK_EDIT_KEYS = new Set([
  "title",
  "category",
  "status",
  "rating",
  "note",
  "hidden",
  "meta",
  "topic",
]);

export interface ParsedWorkEdit {
  hasTitle: boolean;
  title: string | null;
  hasCategory: boolean;
  category: Category | null;
  hasStatus: boolean;
  status: WorkStatus | null;
  hasRating: boolean;
  ratingTenths: number | null;
  hasNote: boolean;
  note: string | null;
  hasHidden: boolean;
  hidden: boolean;
  hasMeta: boolean;
  meta: { provider: MetaProvider; provider_id: string } | null;
  hasTopic: boolean;
  topic: string | null;
}

/** Validate a `WorkEdit` payload (`POST /api/library/work/edit?key=`). */
export function parseWorkEdit(input: unknown): ParsedWorkEdit {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkOverrideValidationError("Request body must be a JSON object");
  }
  const obj = input as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_WORK_EDIT_KEYS.has(k)) {
      throw new WorkOverrideValidationError(`Unknown field in WorkEdit: '${k}'`);
    }
  }

  let hasTitle = false;
  let title: string | null = null;
  if ("title" in obj && obj.title !== undefined) {
    hasTitle = true;
    if (obj.title === null) {
      title = null;
    } else if (typeof obj.title === "string") {
      const trimmed = obj.title.trim();
      if (trimmed.length === 0) {
        throw new WorkOverrideValidationError(
          "Field 'title' cannot be empty (use null to clear)"
        );
      }
      if (trimmed.length > 500) {
        throw new WorkOverrideValidationError(
          `Field 'title' is too long (${trimmed.length} characters, max 500)`
        );
      }
      title = trimmed;
    } else {
      throw new WorkOverrideValidationError(
        "Field 'title' must be a string or null"
      );
    }
  }

  let hasCategory = false;
  let category: Category | null = null;
  if ("category" in obj && obj.category !== undefined) {
    hasCategory = true;
    if (obj.category === null) {
      category = null;
    } else if (isCategory(obj.category)) {
      category = obj.category;
    } else {
      throw new WorkOverrideValidationError(
        `Invalid category: '${String(obj.category)}'`
      );
    }
  }

  let hasStatus = false;
  let status: WorkStatus | null = null;
  if ("status" in obj && obj.status !== undefined) {
    hasStatus = true;
    if (obj.status === null) {
      status = null;
    } else if (isValidWorkStatus(obj.status)) {
      status = obj.status;
    } else {
      throw new WorkOverrideValidationError(
        `Invalid status: '${String(obj.status)}'`
      );
    }
  }

  let hasRating = false;
  let ratingTenths: number | null = null;
  if ("rating" in obj && obj.rating !== undefined) {
    hasRating = true;
    try {
      ratingTenths = ratingToTenths(obj.rating);
    } catch (err) {
      if (
        err instanceof RatingValidationError ||
        err instanceof AnnotationValidationError
      ) {
        throw new WorkOverrideValidationError(err.message);
      }
      throw err;
    }
  }

  let hasNote = false;
  let note: string | null = null;
  if ("note" in obj && obj.note !== undefined) {
    hasNote = true;
    try {
      note = parseNote(obj.note);
    } catch (err) {
      if (err instanceof AnnotationValidationError) {
        throw new WorkOverrideValidationError(err.message);
      }
      throw err;
    }
  }

  let hasHidden = false;
  let hidden = false;
  if ("hidden" in obj && obj.hidden !== undefined) {
    hasHidden = true;
    if (obj.hidden === null || obj.hidden === false) {
      hidden = false;
    } else if (obj.hidden === true) {
      hidden = true;
    } else {
      throw new WorkOverrideValidationError("Field 'hidden' must be a boolean");
    }
  }

  let hasMeta = false;
  let meta: { provider: MetaProvider; provider_id: string } | null = null;
  if ("meta" in obj && obj.meta !== undefined) {
    hasMeta = true;
    if (obj.meta === null) {
      meta = null;
    } else if (
      typeof obj.meta === "object" &&
      !Array.isArray(obj.meta) &&
      typeof (obj.meta as Record<string, unknown>).provider === "string" &&
      VALID_META_PROVIDERS.has(
        (obj.meta as Record<string, unknown>).provider as MetaProvider
      ) &&
      typeof (obj.meta as Record<string, unknown>).provider_id === "string" &&
      META_ID_RE.test((obj.meta as Record<string, unknown>).provider_id as string)
    ) {
      const m = obj.meta as { provider: MetaProvider; provider_id: string };
      meta = { provider: m.provider, provider_id: m.provider_id };
    } else {
      throw new WorkOverrideValidationError(
        "Field 'meta' must be { provider, provider_id } or null"
      );
    }
  }

  let hasTopic = false;
  let topic: string | null = null;
  if ("topic" in obj && obj.topic !== undefined) {
    hasTopic = true;
    if (obj.topic === null) {
      topic = null;
    } else if (typeof obj.topic === "string") {
      const trimmed = obj.topic.trim();
      if (trimmed.length > 200) {
        throw new WorkOverrideValidationError(
          `Field 'topic' is too long (${trimmed.length} characters, max 200)`
        );
      }
      topic = trimmed.length === 0 ? null : trimmed;
    } else {
      throw new WorkOverrideValidationError(
        "Field 'topic' must be a string or null"
      );
    }
  }

  return {
    hasTitle,
    title,
    hasCategory,
    category,
    hasStatus,
    status,
    hasRating,
    ratingTenths,
    hasNote,
    note,
    hasHidden,
    hidden,
    hasMeta,
    meta,
    hasTopic,
    topic,
  };
}

export function workOverrideRecordHash(norm: {
  work_key: string;
  rev_id: string;
  title: string | null;
  category: string | null;
  status: string | null;
  rating_tenths: number | null;
  note: string | null;
  hidden: number;
  meta_provider: string | null;
  meta_id: string | null;
  topic: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        work_key: norm.work_key,
        rev_id: norm.rev_id,
        title: norm.title,
        category: norm.category,
        status: norm.status,
        rating_tenths: norm.rating_tenths,
        note: norm.note,
        hidden: norm.hidden,
        meta_provider: norm.meta_provider,
        meta_id: norm.meta_id,
        topic: norm.topic,
      })
    )
    .digest("hex");
}

/**
 * Insert a new append-only override revision for `workKey`.
 */
export function saveWorkOverride(
  db: Database,
  workKey: string,
  edit: ParsedWorkEdit,
  current: LatestOverride | null,
  metaWork: WorkDetails | null,
  nowIso?: string
): { rev_id: string; inserted: boolean; override: LatestOverride } {
  const title = edit.hasTitle ? edit.title : (current?.title ?? null);
  const category = edit.hasCategory ? edit.category : (current?.category ?? null);
  const status = edit.hasStatus ? edit.status : (current?.status ?? null);
  const ratingTenths = edit.hasRating
    ? edit.ratingTenths
    : (current?.rating_tenths ?? null);
  const note = edit.hasNote ? edit.note : (current?.note ?? null);
  const hidden = edit.hasHidden ? edit.hidden : (current?.hidden ?? false);
  const meta = edit.hasMeta ? edit.meta : (current?.meta ?? null);
  const topic = edit.hasTopic ? edit.topic : (current?.topic ?? null);
  const effectiveMetaWork = edit.hasMeta
    ? edit.meta === null
      ? null
      : metaWork
    : (current?.meta_work ?? null);

  const revId = parseRevId(undefined);
  const createdAt = nowIso ?? new Date().toISOString();
  const hiddenInt = hidden ? 1 : 0;
  const metaProvider = meta?.provider ?? null;
  const metaId = meta?.provider_id ?? null;
  const metaUnlinked = edit.hasMeta ? edit.meta === null : (current?.meta_unlinked ?? false);
  const metaJson = metaUnlinked ? JSON.stringify({ unlinked: true })
    : effectiveMetaWork ? JSON.stringify(effectiveMetaWork) : null;

  const recordHash = workOverrideRecordHash({
    work_key: workKey,
    rev_id: revId,
    title,
    category,
    status,
    rating_tenths: ratingTenths,
    note,
    hidden: hiddenInt,
    meta_provider: metaProvider,
    meta_id: metaId,
    topic,
  });

  const res = db.run(
    `INSERT OR IGNORE INTO work_overrides (
      record_hash,
      work_key,
      rev_id,
      title,
      category,
      status,
      rating_tenths,
      note,
      hidden,
      meta_provider,
      meta_id,
      meta_json,
      topic,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      recordHash,
      workKey,
      revId,
      title,
      category,
      status,
      ratingTenths,
      note,
      hiddenInt,
      metaProvider,
      metaId,
      metaJson,
      topic,
      createdAt,
    ]
  );

  const row = db
    .query<WorkOverrideRow, [string]>(
      "SELECT * FROM work_overrides_latest WHERE work_key = ? LIMIT 1;"
    )
    .get(workKey);

  if (!row) {
    throw new Error("Failed to read back work override");
  }

  return {
    rev_id: revId,
    inserted: res.changes > 0,
    override: rowToLatestOverride(row),
  };
}

/**
 * True when an archive event has `raw.status === "planned"`.
 */
export function isPlannedArchiveEvent(event: {
  source_kind?: string;
  raw?: unknown;
}): boolean {
  if (event.source_kind !== "archive") {
    return false;
  }
  const raw = parseObj(event.raw);
  return raw?.["status"] === "planned";
}

/**
 * Determine if a work component is planned (either from its archive events when
 * not overridden, or from `override.status === "planned"`).
 */
export function isWorkPlanned(
  workEvents: readonly EventForWorkGrouping[],
  override?: LatestOverride
): boolean {
  if (override?.status !== null && override?.status !== undefined) {
    return override.status === "planned";
  }
  if (workEvents.length === 0) {
    return false;
  }
  let hasPlannedArchive = false;
  for (const ev of workEvents) {
    if (isPlannedArchiveEvent(ev)) {
      hasPlannedArchive = true;
    } else {
      return false;
    }
  }
  return hasPlannedArchive;
}

/**
 * Apply work overrides and planned-work filtering to `events` (for non-library
 * reads: calendar, heat map, stats, series, search, insights, reviews).
 *
 * - Events of hidden works (`override.hidden === true`) are omitted.
 * - Events of planned works (`status === "planned"`) are omitted.
 * - Overridden `title`, `category`, and `meta` are projected onto shallow clones
 *   of the events so every downstream consumer sees the overridden values.
 */
export function applyWorkOverridesToEvents(
  db: Database,
  events: DedupedEvent[],
  allEventsForGrouping?: readonly DedupedEvent[]
): DedupedEvent[] {
  if (events.length === 0) {
    return events;
  }

  const overrides = getWorkOverrides(db);
  const groupingInput = allEventsForGrouping ?? events;
  const hasAnyPlanned = groupingInput.some((e) => isPlannedArchiveEvent(e));

  if (overrides.size === 0 && !hasAnyPlanned) {
    return events;
  }

  const components = groupEventsIntoWorkComponents(groupingInput);
  const componentByEventId = new Map<
    number,
    {
      comp: GroupedWorkComponent<DedupedEvent>;
      override: LatestOverride | undefined;
      planned: boolean;
    }
  >();

  for (const comp of components) {
    const override = overrides.get(comp.key);
    const planned = isWorkPlanned(comp.events, override);
    for (const ev of comp.events) {
      componentByEventId.set(ev.id, { comp, override, planned });
    }
  }

  const result: DedupedEvent[] = [];

  for (const ev of events) {
    const info = componentByEventId.get(ev.id);
    if (!info) {
      if (isPlannedArchiveEvent(ev)) {
        continue;
      }
      result.push(ev);
      continue;
    }

    const { comp, override, planned } = info;
    if (planned || override?.hidden === true) {
      continue;
    }

    if (
      !override ||
      (override.title === null &&
        override.category === null &&
        override.meta === null)
    ) {
      result.push(ev);
      continue;
    }

    let nextTitle = ev.title;
    let nextParentTitle = ev.parent_title;
    let nextRaw = ev.raw;
    let nextExt = ev.external_ids;

    if (override.title !== null) {
      if (comp.sourceCategory === "youtube") {
        if (ev.parent_title && ev.parent_title.trim() !== "") {
          nextParentTitle = override.title;
        } else {
          nextTitle = override.title;
        }
      } else {
        const isSeriesOrShow =
          ev.media_type === "episode" ||
          ev.media_type === "show" ||
          ev.media_type === "podcast" ||
          ev.media_type === "podcast_episode" ||
          (ev.season !== null && ev.season !== undefined) ||
          (ev.episode !== null && ev.episode !== undefined);

        if (isSeriesOrShow && ev.parent_title && ev.parent_title.trim() !== "") {
          nextParentTitle = override.title;
          if (
            !ev.title ||
            ev.title.trim() === "" ||
            ev.title.trim() === ev.parent_title.trim() ||
            ev.title.trim() === comp.sourceCanonicalTitle
          ) {
            nextTitle = override.title;
          }
        } else {
          nextTitle = override.title;
        }
      }

      const rawObj = parseObj(nextRaw);
      if (rawObj && rawObj["work"] && typeof rawObj["work"] === "object") {
        nextRaw = {
          ...rawObj,
          work: {
            ...(rawObj["work"] as Record<string, unknown>),
            title: override.title,
          },
        };
      }
    }

    if (override.category !== null) {
      const rawObj = parseObj(nextRaw) ?? {};
      nextRaw = {
        ...rawObj,
        category: override.category,
      };
    }

    if (override.meta !== null) {
      const extObj = parseObj(nextExt) ?? {};
      nextExt = {
        ...extObj,
        meta_provider: override.meta.provider,
        meta_id: override.meta.provider_id,
        meta_override: "1",
      };
    } else if (override.meta_unlinked) {
      nextExt = { ...(parseObj(nextExt) ?? {}), meta_unlinked: "1" };
    }

    result.push({
      ...ev,
      title: nextTitle,
      parent_title: nextParentTitle,
      raw: nextRaw,
      external_ids: nextExt,
    });
  }

  return result;
}
