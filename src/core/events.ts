import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export type MediaType =
  | "audiobook"
  | "podcast_episode"
  | "movie"
  | "episode"
  | "video"
  | "music"
  | "shortform"
  | "book"
  | "other";

export const VALID_MEDIA_TYPES: ReadonlySet<string> = new Set<MediaType>([
  "audiobook",
  "podcast_episode",
  "movie",
  "episode",
  "video",
  "music",
  "shortform",
  "book",
  "other",
]);

export interface NewEvent {
  source: string;
  source_kind: string;
  source_id: string;
  external_ids?: Record<string, unknown> | null;
  media_type: MediaType;
  title?: string | null;
  parent_title?: string | null;
  season?: number | null;
  episode?: number | null;
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  progress?: number | null;
  device?: string | null;
  raw?: unknown | null;
}

export interface NormalizedEvent {
  source: string;
  source_kind: string;
  source_id: string;
  external_ids: Record<string, unknown> | null;
  media_type: MediaType;
  title: string | null;
  parent_title: string | null;
  season: number | null;
  episode: number | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  progress: number | null;
  device: string | null;
  raw: unknown | null;
}

export const HASH_FIELDS = [
  "source",
  "source_kind",
  "source_id",
  "external_ids",
  "media_type",
  "title",
  "parent_title",
  "season",
  "episode",
  "started_at",
  "ended_at",
  "duration_seconds",
  "progress",
  "device",
] as const;

export interface InsertResult {
  seen: number;
  inserted: number;
}

export interface FinishRunOptions {
  status: "ok" | "failed";
  rowsSeen?: number;
  rowsInserted?: number;
  error?: string | null;
}

let redactFn: ((s: string) => string) | null = null;
let redactChecked = false;

function getRedactFn(): ((s: string) => string) | null {
  if (redactChecked) {
    return redactFn;
  }
  try {
    const req = createRequire(import.meta.url);
    const cfg = req("./config.ts");
    if (typeof cfg?.redact === "function") {
      redactFn = cfg.redact;
    }
  } catch {
    // callers pass redacted text
  }
  redactChecked = true;
  return redactFn;
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[k] = sortKeys((obj as Record<string, unknown>)[k]);
  }
  return sorted;
}

function parseTimestamp(field: string, val: unknown, required: boolean): string | null {
  if (val === undefined || val === null) {
    if (required) {
      throw new Error(`Field '${field}' is required and cannot be null or undefined`);
    }
    return null;
  }
  if (typeof val !== "string") {
    throw new Error(`Field '${field}' must be a string`);
  }
  const trimmed = val.trim();
  if (trimmed === "") {
    if (required) {
      throw new Error(`Field '${field}' is required and cannot be empty`);
    }
    throw new Error(`Field '${field}' is an invalid timestamp: ""`);
  }

  // If the timestamp string has no timezone indicator, treat it as UTC to avoid host-local variation
  const hasTimezone = /([Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(trimmed);
  const normalizedStr = hasTimezone ? trimmed : `${trimmed.replace(" ", "T")}Z`;

  const date = new Date(normalizedStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Field '${field}' is an invalid timestamp: "${trimmed}"`);
  }
  return date.toISOString();
}

function parseRequiredString(field: string, val: unknown): string {
  if (typeof val !== "string") {
    throw new Error(`Field '${field}' is required and must be a string`);
  }
  const trimmed = val.trim();
  if (trimmed === "") {
    throw new Error(`Field '${field}' is required and cannot be empty`);
  }
  return trimmed;
}

function parseOptionalString(val: unknown): string | null {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val !== "string") {
    throw new Error("Optional text field must be a string");
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalFiniteNumber(field: string, val: unknown): number | null {
  if (val === undefined || val === null) {
    return null;
  }
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`Field '${field}' must be a finite number`);
  }
  return val;
}

export function normalize(e: NewEvent): NormalizedEvent {
  if (!e || typeof e !== "object") {
    throw new Error("Event must be an object");
  }

  const source = parseRequiredString("source", e.source);
  const sourceKind = parseRequiredString("source_kind", e.source_kind);
  const sourceId = parseRequiredString("source_id", e.source_id);

  const mediaTypeStr = parseRequiredString("media_type", e.media_type);
  if (!VALID_MEDIA_TYPES.has(mediaTypeStr as MediaType)) {
    throw new Error(`Invalid media_type: '${mediaTypeStr}'`);
  }
  const mediaType = mediaTypeStr as MediaType;

  const startedAt = parseTimestamp("started_at", e.started_at, true)!;
  const endedAt = parseTimestamp("ended_at", e.ended_at, false);

  let externalIds: Record<string, unknown> | null = null;
  if (e.external_ids !== undefined && e.external_ids !== null) {
    let rawExt: unknown = e.external_ids;
    if (typeof rawExt === "string") {
      try {
        rawExt = JSON.parse(rawExt);
      } catch {
        throw new Error("Field 'external_ids' is an invalid JSON string");
      }
    }
    if (typeof rawExt !== "object" || Array.isArray(rawExt) || rawExt === null) {
      throw new Error("Field 'external_ids' must be an object or null");
    }
    externalIds = sortKeys(rawExt) as Record<string, unknown>;
  }

  const title = parseOptionalString(e.title);
  const parentTitle = parseOptionalString(e.parent_title);
  const device = parseOptionalString(e.device);

  const season = parseOptionalFiniteNumber("season", e.season);
  const episode = parseOptionalFiniteNumber("episode", e.episode);
  const durationSeconds = parseOptionalFiniteNumber("duration_seconds", e.duration_seconds);

  let progress: number | null = null;
  if (e.progress !== undefined && e.progress !== null) {
    if (typeof e.progress !== "number" || !Number.isFinite(e.progress)) {
      throw new Error("Field 'progress' must be a finite number");
    }
    if (e.progress < 0 || e.progress > 1) {
      throw new Error(`Field 'progress' must be between 0 and 1, got ${e.progress}`);
    }
    progress = e.progress;
  }

  const raw = e.raw === undefined ? null : e.raw;

  return {
    source,
    source_kind: sourceKind,
    source_id: sourceId,
    external_ids: externalIds,
    media_type: mediaType,
    title,
    parent_title: parentTitle,
    season,
    episode,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: durationSeconds,
    progress,
    device,
    raw,
  };
}

export function recordHashNormalized(norm: NormalizedEvent): string {
  const hashObj: Record<string, unknown> = {};
  for (const field of HASH_FIELDS) {
    hashObj[field] = norm[field];
  }
  const canonicalJson = JSON.stringify(hashObj);
  return createHash("sha256").update(canonicalJson).digest("hex");
}

export function recordHash(e: NormalizedEvent | NewEvent): string {
  const norm = normalize(e as NewEvent);
  return recordHashNormalized(norm);
}

export function insertEvents(
  db: Database,
  runId: number | null,
  events: Iterable<NewEvent>
): InsertResult {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO events (
      record_hash,
      source,
      source_kind,
      source_id,
      external_ids,
      media_type,
      title,
      parent_title,
      season,
      episode,
      started_at,
      ended_at,
      duration_seconds,
      progress,
      device,
      raw,
      ingested_at,
      ingest_run_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    );
  `);

  const latestShortform = db.query<{ id: number; record_hash: string; external_ids: string | null }, [string, string, string]>(
    "SELECT id, record_hash, external_ids FROM events_latest WHERE source = ? AND source_kind = ? AND source_id = ?"
  );

  const runTx = db.transaction((evs: Iterable<NewEvent>) => {
    let seen = 0;
    let inserted = 0;
    const nowUtc = new Date().toISOString();

    for (const rawEvent of evs) {
      seen++;
      let norm = normalize(rawEvent);
      if (norm.source_kind === "shortform_day") {
        // Daily corrections may return to an older value. An unchanged latest
        // snapshot is a no-op; every transition gets append-only revision identity.
        const { shortform_revision: _ignored, ...ids } = norm.external_ids ?? {};
        const latest = latestShortform.get(norm.source, norm.source_kind, norm.source_id);
        const previousIds = latest?.external_ids ? JSON.parse(latest.external_ids) as Record<string, unknown> : {};
        const previousRevision = previousIds.shortform_revision;
        norm = normalize({ ...norm, external_ids: Object.keys(ids).length || previousRevision !== undefined
          ? { ...ids, ...(previousRevision !== undefined ? { shortform_revision: previousRevision } : {}) } : null });
        if (latest && recordHashNormalized(norm) !== latest.record_hash) {
          norm = normalize({ ...norm, external_ids: { ...ids, shortform_revision: latest.id } });
        }
      }
      const hash = recordHashNormalized(norm);
      const extIdsJson =
        norm.external_ids !== null ? JSON.stringify(norm.external_ids) : null;
      const rawJson = norm.raw !== null ? JSON.stringify(norm.raw) : null;

      const res = insertStmt.run(
        hash,
        norm.source,
        norm.source_kind,
        norm.source_id,
        extIdsJson,
        norm.media_type,
        norm.title,
        norm.parent_title,
        norm.season,
        norm.episode,
        norm.started_at,
        norm.ended_at,
        norm.duration_seconds,
        norm.progress,
        norm.device,
        rawJson,
        nowUtc,
        runId
      );
      inserted += res.changes;
    }

    return { seen, inserted };
  });

  return runTx(events);
}

export function startRun(
  db: Database,
  source: string,
  kind?: string | null
): number {
  const trimmedSource = parseRequiredString("source", source);
  const startedAt = new Date().toISOString();
  const res = db.run(
    `INSERT INTO ingest_runs (source, kind, started_at, status)
     VALUES (?, ?, ?, 'running');`,
    [trimmedSource, kind ?? null, startedAt]
  );
  return Number(res.lastInsertRowid);
}

export function finishRun(
  db: Database,
  runId: number,
  options: FinishRunOptions
): void {
  if (options.status !== "ok" && options.status !== "failed") {
    throw new Error(`Invalid status for finishRun: '${options.status}'`);
  }

  // callers pass redacted text
  let cleanError: string | null = options.error ?? null;
  const redact = getRedactFn();
  if (cleanError !== null && redact) {
    cleanError = redact(cleanError);
  }

  const finishedAt = new Date().toISOString();
  const rowsSeen = options.rowsSeen ?? 0;
  const rowsInserted = options.rowsInserted ?? 0;

  const res = db.run(
    `UPDATE ingest_runs
     SET status = ?,
         finished_at = ?,
         rows_seen = ?,
         rows_inserted = ?,
         error = ?
     WHERE id = ?;`,
    [options.status, finishedAt, rowsSeen, rowsInserted, cleanError, runId]
  );

  if (res.changes === 0) {
    throw new Error(`Ingest run with id ${runId} not found`);
  }
}
