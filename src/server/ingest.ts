/**
 * Token-protected ingest endpoint for YouTube plays from the phone.
 *
 * The contract is fixed (the phone side is built against it): see
 * `docs/ingest-api.md`. Rules:
 * - `Bearer` token compared in constant time on the sha256 digests; the token
 *   is never logged and never echoed back in an error body.
 * - Body capped at 1 MB; invalid JSON or any invalid field rejects the whole
 *   batch (nothing is inserted), naming the field and play index.
 * - One `NewEvent` per play inserted through `insertEvents` (`INSERT OR IGNORE`
 *   on `record_hash`) inside one run recorded with `startRun`/`finishRun`
 *   (source `youtube`, kind `phone`). The events table is append-only: a
 *   re-sent play with more watched seconds is a new row, never an update.
 * - `raw` is rebuilt from the validated fields in a fixed key order, so the
 *   same play re-sent produces the same `record_hash`.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import type { Config } from "../core/config.ts";
import {
  finishRun,
  insertEvents,
  startRun,
  type NewEvent,
} from "../core/events.ts";

/** Maximum accepted ingest body size (1 MB). */
export const MAX_INGEST_BYTES = 1024 * 1024;

/** Plays dated more than this in the future are rejected (clock skew grace). */
export const MAX_FUTURE_MS = 5 * 60 * 1000;

const DEVICE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const APP_RE = /^[A-Za-z0-9_.]+$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface YoutubePlay {
  play_id: string;
  app: string;
  title: string;
  channel: string | null;
  video_id: string | null;
  started_at: string;
  ended_at: string;
  watched_seconds: number;
  media_duration_seconds: number | null;
  last_position_seconds: number | null;
}

/** Thrown by field validation; the message names the field (and play index). */
export class IngestValidationError extends Error {}

/** Read the ingest token out of a (possibly hand-built) config. */
function ingestToken(config: Config): string {
  const token = config.ingest?.token;
  return typeof token === "string" ? token : "";
}

/** `Bearer <token>` header → token, or null when missing/malformed. */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") {
    return null;
  }
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

/** Constant-time comparison of two tokens via their sha256 digests. */
export function tokensEqual(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  // Both digests are exactly 32 bytes, so this can never throw.
  return timingSafeEqual(providedHash, expectedHash);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Validate one timestamp string; returns its ms-normalized ISO form. */
function parseIsoMs(field: string, value: unknown, index: number): string {
  if (typeof value !== "string" || !ISO_MS_RE.test(value)) {
    throw new IngestValidationError(
      `plays[${index}].${field} must be a UTC ISO 8601 timestamp like 2026-10-17T18:02:11.000Z`
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new IngestValidationError(
      `plays[${index}].${field} is not a valid date: ${value}`
    );
  }
  return date.toISOString();
}

/**
 * Validate and normalize one play. Throws `IngestValidationError` naming the
 * field and play index on the first invalid field. Unknown extra fields are
 * ignored.
 */
function parsePlay(raw: unknown, index: number): YoutubePlay {
  if (!isObject(raw)) {
    throw new IngestValidationError(`plays[${index}] must be an object`);
  }

  const playIdRaw = raw.play_id;
  if (typeof playIdRaw !== "string" || !UUID_RE.test(playIdRaw)) {
    throw new IngestValidationError(`plays[${index}].play_id must be a UUID`);
  }
  const play_id = playIdRaw.toLowerCase();

  const appRaw = raw.app;
  if (
    typeof appRaw !== "string" ||
    appRaw.length < 1 ||
    appRaw.length > 100 ||
    !APP_RE.test(appRaw)
  ) {
    throw new IngestValidationError(
      `plays[${index}].app must be 1-100 characters matching [A-Za-z0-9_.]`
    );
  }
  const app = appRaw;

  const titleRaw = typeof raw.title === "string" ? raw.title : undefined;
  if (titleRaw === undefined) {
    throw new IngestValidationError(`plays[${index}].title must be a string`);
  }
  // Trailing whitespace is trimmed before the length check.
  const title = titleRaw.replace(/\s+$/, "");
  if (title.length < 1 || title.length > 500) {
    throw new IngestValidationError(
      `plays[${index}].title must be 1-500 characters after trimming trailing whitespace`
    );
  }

  let channel: string | null = null;
  if (raw.channel !== undefined && raw.channel !== null) {
    if (typeof raw.channel !== "string") {
      throw new IngestValidationError(
        `plays[${index}].channel must be a string or null`
      );
    }
    if (raw.channel === "") {
      channel = null; // empty string normalizes to null
    } else if (raw.channel.length > 200) {
      throw new IngestValidationError(
        `plays[${index}].channel must be at most 200 characters`
      );
    } else {
      channel = raw.channel;
    }
  }

  let video_id: string | null = null;
  if (raw.video_id !== undefined && raw.video_id !== null) {
    if (typeof raw.video_id !== "string" || !VIDEO_ID_RE.test(raw.video_id)) {
      throw new IngestValidationError(
        `plays[${index}].video_id must be an 11-character video id or null`
      );
    }
    video_id = raw.video_id;
  }

  const started_at = parseIsoMs("started_at", raw.started_at, index);
  const ended_at = parseIsoMs("ended_at", raw.ended_at, index);
  if (Date.parse(ended_at) < Date.parse(started_at)) {
    throw new IngestValidationError(
      `plays[${index}].ended_at must be greater than or equal to started_at`
    );
  }

  if (!isIntInRange(raw.watched_seconds, 0, 86400)) {
    throw new IngestValidationError(
      `plays[${index}].watched_seconds must be an integer 0-86400`
    );
  }

  let media_duration_seconds: number | null = null;
  if (
    raw.media_duration_seconds !== undefined &&
    raw.media_duration_seconds !== null
  ) {
    if (!isIntInRange(raw.media_duration_seconds, 0, 86400)) {
      throw new IngestValidationError(
        `plays[${index}].media_duration_seconds must be an integer 0-86400 or null`
      );
    }
    media_duration_seconds = raw.media_duration_seconds;
  }

  let last_position_seconds: number | null = null;
  if (
    raw.last_position_seconds !== undefined &&
    raw.last_position_seconds !== null
  ) {
    if (!isIntInRange(raw.last_position_seconds, 0, 86400)) {
      throw new IngestValidationError(
        `plays[${index}].last_position_seconds must be an integer 0-86400 or null`
      );
    }
    last_position_seconds = raw.last_position_seconds;
  }

  return {
    play_id,
    app,
    title,
    channel,
    video_id,
    started_at,
    ended_at,
    watched_seconds: raw.watched_seconds,
    media_duration_seconds,
    last_position_seconds,
  };
}

/**
 * Validate a full ingest body. Throws `IngestValidationError` (message names
 * the field and play index) on the first problem.
 */
export function parseIngestBody(body: unknown, nowMs: number): YoutubePlay[] {
  if (!isObject(body)) {
    throw new IngestValidationError("body must be a JSON object");
  }

  const device = body.device;
  if (
    typeof device !== "string" ||
    device.length < 1 ||
    device.length > 32 ||
    !DEVICE_RE.test(device)
  ) {
    throw new IngestValidationError(
      "device must be 1-32 characters matching [a-z0-9] with single hyphens"
    );
  }

  if (!Array.isArray(body.plays)) {
    throw new IngestValidationError("plays must be an array of 1-200 items");
  }
  const playsRaw = body.plays;
  if (playsRaw.length < 1 || playsRaw.length > 200) {
    throw new IngestValidationError(
      `plays must contain 1-200 items (got ${playsRaw.length})`
    );
  }

  const plays: YoutubePlay[] = [];
  for (let index = 0; index < playsRaw.length; index += 1) {
    const play = parsePlay(playsRaw[index], index);
    if (Date.parse(play.started_at) - nowMs > MAX_FUTURE_MS) {
      throw new IngestValidationError(
        `plays[${index}].started_at is more than 5 minutes in the future`
      );
    }
    plays.push(play);
  }

  return plays;
}

/**
 * Map one validated play to a `NewEvent`. `raw` is rebuilt from the validated
 * fields in a fixed key order, so the same play re-sent (even with an
 * equivalently formatted timestamp) hashes the same and inserts nothing.
 */
export function playToEvent(play: YoutubePlay, device: string): NewEvent {
  // Fixed key order per the contract: youtube_video first, then android_package.
  const external_ids: Record<string, string> = {};
  if (play.video_id !== null) {
    external_ids.youtube_video = play.video_id;
  }
  external_ids.android_package = play.app;

  const progress =
    play.last_position_seconds !== null &&
    play.media_duration_seconds !== null &&
    play.media_duration_seconds > 0
      ? Math.min(
          1,
          Math.max(0, play.last_position_seconds / play.media_duration_seconds)
        )
      : null;

  return {
    source: "youtube",
    source_kind: "phone_play",
    source_id: play.play_id,
    external_ids,
    media_type: "video",
    title: play.title,
    parent_title: play.channel,
    season: null,
    episode: null,
    started_at: play.started_at,
    ended_at: play.ended_at,
    duration_seconds: play.watched_seconds,
    progress,
    device,
    raw: {
      play_id: play.play_id,
      app: play.app,
      title: play.title,
      channel: play.channel,
      video_id: play.video_id,
      started_at: play.started_at,
      ended_at: play.ended_at,
      watched_seconds: play.watched_seconds,
      media_duration_seconds: play.media_duration_seconds,
      last_position_seconds: play.last_position_seconds,
    },
  };
}

export interface IngestHandlerDeps {
  db: Database;
  config: Config;
  /** Wall clock for the 5-minute-future check; defaults to `Date.now()`. */
  nowMs?: () => number;
}

function invalidJson(error: unknown): string {
  return `Invalid JSON body: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

/**
 * Hono handler for `POST /api/ingest/youtube-plays`. Query params are validated
 * by the caller (like every other route); this covers disabled → 503, auth →
 * 401, size → 413, validation → 400 and the insert run. The request token is
 * never logged or echoed.
 */
export async function handleYoutubePlays(
  c: Context,
  deps: IngestHandlerDeps
): Promise<Response> {
  const { db, config } = deps;

  if (ingestToken(config) === "") {
    return c.json({ error: "ingest is disabled" }, 503);
  }

  const provided = bearerToken(c.req.header("Authorization"));
  if (provided === null || !tokensEqual(provided, ingestToken(config))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Size checks: the declared length first, then the actual body.
  const contentLengthHeader = c.req.header("Content-Length");
  if (contentLengthHeader !== undefined) {
    const declared = Number(contentLengthHeader);
    if (Number.isInteger(declared) && declared > MAX_INGEST_BYTES) {
      return c.json({ error: "body too large (max 1 MB)" }, 413);
    }
  }
  const bodyText = await c.req.text();
  if (new TextEncoder().encode(bodyText).length > MAX_INGEST_BYTES) {
    return c.json({ error: "body too large (max 1 MB)" }, 413);
  }

  let plays: YoutubePlay[];
  let device: string;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    plays = parseIngestBody(parsed, (deps.nowMs ?? Date.now)());
    device = typeof (parsed as { device?: unknown }).device === "string"
      ? ((parsed as { device: string }).device)
      : "";
  } catch (caught) {
    const message =
      caught instanceof IngestValidationError
        ? caught.message
        : invalidJson(caught);
    return c.json({ error: message }, 400);
  }

  const events = plays.map((play) => playToEvent(play, device));

  let runId: number | null = null;
  try {
    runId = startRun(db, "youtube", "phone");
    const result = insertEvents(db, runId, events);
    try {
      finishRun(db, runId, {
        status: "ok",
        rowsSeen: result.seen,
        rowsInserted: result.inserted,
      });
    } catch {
      // Rows are inserted; a bookkeeping failure must not claim a 500.
    }
    return c.json({ accepted: plays.length, inserted: result.inserted }, 200);
  } catch {
    if (runId !== null) {
      try {
        finishRun(db, runId, { status: "failed", error: "ingest failed" });
      } catch {
        // A failing finishRun must not mask the 500 response.
      }
    }
    // No details: an error message could carry user data.
    return c.json({ error: "ingest failed" }, 500);
  }
}
