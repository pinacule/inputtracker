import { normalize, type NewEvent } from "./events.ts";

export const MAX_EVENT_BATCH = 200;
export const MAX_EVENT_BODY_BYTES = 1024 * 1024;
const FIELDS = new Set(["source", "source_kind", "source_id", "external_ids", "media_type", "title", "parent_title", "season", "episode", "started_at", "ended_at", "duration_seconds", "progress", "device", "raw"]);
const PAIRS = new Set(["youtube/aw_play", "youtube/shortform_day", "activitywatch/shortform_day"]);

export class EventBatchValidationError extends Error {}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strict wire contract; never echo untrusted field values (or secrets). */
export function parseEventBatch(input: unknown, nowMs = Date.now()): NewEvent[] {
  if (!object(input) || Object.keys(input).some((key) => key !== "events") || !Array.isArray(input.events) || input.events.length > MAX_EVENT_BATCH) {
    throw new EventBatchValidationError("body must contain only events (0-200 items)");
  }
  return input.events.map((value: unknown, index: number) => {
    const fail = (field: string): never => { throw new EventBatchValidationError(`events[${index}].${field} is invalid`); };
    if (!object(value)) return fail("event");
    if (Object.keys(value).some((key) => !FIELDS.has(key))) fail("fields");
    if (typeof value.source !== "string" || typeof value.source_kind !== "string" || !PAIRS.has(`${value.source}/${value.source_kind}`)) fail("source/source_kind");
    const text = (field: string, max: number, required = false): void => {
      const v = value[field];
      if (v === null || v === undefined) { if (required) fail(field); return; }
      if (typeof v !== "string" || v.length > max || (required && !v.trim()) || /[\x00-\x1f\x7f]/.test(v)) fail(field);
    };
    text("source_id", 512, true);
    text("title", 500);
    text("parent_title", 200);
    text("device", 32);
    if (value.media_type !== "video" && value.media_type !== "music" && !(value.source_kind === "shortform_day" && (value.media_type === "shortform" || value.media_type === "other"))) fail("media_type");
    for (const field of ["season", "episode"]) {
      if (value[field] !== undefined && value[field] !== null) fail(field);
    }
    for (const [field, max] of [["duration_seconds", 86400], ["progress", 1]] as const) {
      const v = value[field];
      if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)) fail(field);
    }
    for (const field of ["started_at", "ended_at"]) {
      const v = value[field];
      if (field === "ended_at" && (v === undefined || v === null)) continue;
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail(field);
    }
    if (Date.parse(value.started_at as string) > nowMs + 300_000) fail("started_at");
    if (typeof value.ended_at === "string" && value.ended_at < (value.started_at as string)) fail("ended_at");
    if (value.external_ids !== undefined && value.external_ids !== null) {
      if (!object(value.external_ids) || Object.keys(value.external_ids).length > 32) fail("external_ids");
      for (const [key, v] of Object.entries(value.external_ids as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || /token|secret|password|api[_-]?key|^__proto__$|^constructor$/i.test(key) || (typeof v !== "string" && typeof v !== "number") || (typeof v === "string" && (v.length > 512 || /[\x00-\x1f\x7f]/.test(v))) || (typeof v === "number" && !Number.isFinite(v))) fail("external_ids");
      }
    }
    // Raw is JSON only, bounded in depth/size; reject secret-like keys recursively.
    const json = (v: unknown, depth: number): void => {
      if (depth > 8) fail("raw");
      if (v === null || typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return;
      if (Array.isArray(v)) { for (const item of v) json(item, depth + 1); return; }
      if (!object(v)) fail("raw");
      for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
        if (/token|secret|password|api[_-]?key|^deleted$|^__proto__$|^constructor$/i.test(key)) fail("raw");
        json(item, depth + 1);
      }
    };
    if (value.raw !== undefined && value.raw !== null) {
      if (!object(value.raw) || JSON.stringify(value.raw).length > 32768) fail("raw");
      json(value.raw, 0);
    }
    if (value.source_kind === "aw_play") {
      const vid = (value.external_ids as Record<string, unknown> | undefined)?.youtube_video;
      if (typeof vid !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(vid)) fail("external_ids.youtube_video");
    }
    return normalize(value as unknown as NewEvent);
  });
}
