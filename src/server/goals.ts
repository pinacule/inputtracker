import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { VALID_MEDIA_TYPES } from "../core/events.ts";
import type { GoalRow } from "../core/schema.ts";
import {
  getLatestConsumptionEvents,
  type ConsumptionEvent,
} from "./aggregate.ts";
import { computeYearReview } from "./year-review.ts";

export type GoalMetric = "items" | "hours" | "titles" | "active_days";
export type GoalStatus =
  | "done"
  | "on_track"
  | "behind"
  | "missed"
  | "not_started";

export const VALID_GOAL_METRICS: ReadonlySet<GoalMetric> = new Set<GoalMetric>([
  "items",
  "hours",
  "titles",
  "active_days",
]);

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GoalNotFoundError extends Error {
  constructor(goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "GoalNotFoundError";
  }
}

export class GoalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalValidationError";
  }
}

export interface AddGoalInput {
  goal_id?: string;
  rev_id?: string;
  year: number;
  metric: GoalMetric | string;
  source?: string | null;
  media_type?: string | null;
  target: number;
  archived?: number | boolean;
}

export interface AddGoalResult {
  goal_id: string;
  rev_id: string;
  inserted: boolean;
}

export interface GoalProgress {
  current: number;
  target: number;
  percent: number;
  expected: number;
  status: GoalStatus;
}

export interface GoalWithProgress {
  goal_id: string;
  year: number;
  metric: GoalMetric;
  source: string | null;
  media_type: string | null;
  target: number;
  archived: number;
  created_at: string;
  progress: GoalProgress;
}

export interface GetGoalsOptions {
  year?: number;
  tz: string;
  today: string;
  includeArchived?: boolean;
}

/** Compute sha256 of canonical JSON for a goal revision. */
export function goalRecordHash(norm: {
  goal_id: string;
  rev_id: string;
  year: number;
  metric: string;
  source: string | null;
  media_type: string | null;
  target: number;
  archived: number;
}): string {
  const hashObj = {
    archived: norm.archived,
    goal_id: norm.goal_id,
    media_type: norm.media_type,
    metric: norm.metric,
    rev_id: norm.rev_id,
    source: norm.source,
    target: norm.target,
    year: norm.year,
  };
  return createHash("sha256").update(JSON.stringify(hashObj)).digest("hex");
}

/** True when `year` is a leap year (Gregorian). */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days from Jan 1 of `year` through `today` (local "YYYY-MM-DD"), inclusive. */
function daysUpTo(today: string, year: number): number {
  const [y, m, d] = today.split("-").map(Number);
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(y!, m! - 1, d!);
  return Math.round((end - start) / 86400000) + 1;
}

/**
 * Validates and inserts a goal revision. Returns `{ goal_id, rev_id, inserted }`.
 */
export function addGoalRevision(
  db: Database,
  input: AddGoalInput,
  now?: string
): AddGoalResult {
  if (!input || typeof input !== "object") {
    throw new GoalValidationError("Input must be an object");
  }

  // Validate goal_id
  let goalId = input.goal_id;
  if (goalId !== undefined && goalId !== null && goalId !== "") {
    if (typeof goalId !== "string" || !UUID_RE.test(goalId)) {
      throw new GoalValidationError(`Invalid goal_id format: '${goalId}'`);
    }
    const existing = db
      .query<{ goal_id: string }, [string]>(
        "SELECT goal_id FROM goals_latest WHERE goal_id = ? LIMIT 1;"
      )
      .get(goalId);
    if (!existing) {
      throw new GoalNotFoundError(goalId);
    }
  } else {
    goalId = crypto.randomUUID();
  }

  // Validate rev_id
  let revId = input.rev_id;
  if (revId !== undefined && revId !== null && revId !== "") {
    if (typeof revId !== "string" || !UUID_RE.test(revId)) {
      throw new GoalValidationError(`Invalid rev_id format: '${revId}'`);
    }
  } else {
    revId = crypto.randomUUID();
  }

  // Validate year
  const year = input.year;
  if (
    typeof year !== "number" ||
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2100
  ) {
    throw new GoalValidationError(
      `Invalid year: '${year}' (must be an integer between 2000 and 2100)`
    );
  }

  // Validate metric
  const metricStr = input.metric;
  if (
    typeof metricStr !== "string" ||
    !VALID_GOAL_METRICS.has(metricStr as GoalMetric)
  ) {
    throw new GoalValidationError(
      `Invalid metric: '${metricStr}' (expected one of: items, hours, titles, active_days)`
    );
  }
  const metric = metricStr as GoalMetric;

  // Validate target
  const target = input.target;
  if (
    typeof target !== "number" ||
    !Number.isFinite(target) ||
    target <= 0 ||
    target > 1_000_000
  ) {
    throw new GoalValidationError(
      `Invalid target: '${target}' (must be finite, > 0, and <= 1,000,000)`
    );
  }

  // Validate source
  let source: string | null = null;
  if (input.source !== undefined && input.source !== null) {
    if (typeof input.source !== "string") {
      throw new GoalValidationError("Optional source must be a string");
    }
    const trimmed = input.source.trim();
    if (trimmed.length > 64) {
      throw new GoalValidationError(
        `Source too long: ${trimmed.length} characters (max 64)`
      );
    }
    source = trimmed.length > 0 ? trimmed : null;
  }

  // Validate media_type
  let mediaType: string | null = null;
  if (input.media_type !== undefined && input.media_type !== null) {
    if (typeof input.media_type !== "string") {
      throw new GoalValidationError("Optional media_type must be a string");
    }
    const trimmed = input.media_type.trim();
    if (trimmed.length > 0) {
      if (!VALID_MEDIA_TYPES.has(trimmed)) {
        throw new GoalValidationError(`Invalid media_type: '${trimmed}'`);
      }
      mediaType = trimmed;
    }
  }

  // Validate archived
  let archived = 0;
  if (input.archived !== undefined && input.archived !== null) {
    if (typeof input.archived === "boolean") {
      archived = input.archived ? 1 : 0;
    } else if (input.archived === 0 || input.archived === 1) {
      archived = input.archived;
    } else {
      throw new GoalValidationError(
        `Invalid archived flag: '${input.archived}' (must be 0, 1, or boolean)`
      );
    }
  }

  const createdAt = now ?? new Date().toISOString();

  const recordHash = goalRecordHash({
    goal_id: goalId,
    rev_id: revId,
    year,
    metric,
    source,
    media_type: mediaType,
    target,
    archived,
  });

  const res = db.run(
    `INSERT OR IGNORE INTO goals (
      record_hash,
      goal_id,
      rev_id,
      year,
      metric,
      source,
      media_type,
      target,
      archived,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      recordHash,
      goalId,
      revId,
      year,
      metric,
      source,
      mediaType,
      target,
      archived,
      createdAt,
    ]
  );

  return {
    goal_id: goalId,
    rev_id: revId,
    inserted: res.changes > 0,
  };
}

/**
 * Pure: filter events by goal's source / media_type, then reuse computeYearReview
 * from `src/server/year-review.ts` for that year.
 */
export function computeGoalProgress(
  goal: {
    year: number;
    metric: string;
    source?: string | null;
    media_type?: string | null;
    target: number;
  },
  events: readonly ConsumptionEvent[],
  tz: string,
  today: string
): GoalProgress {
  // Filter events by source and media_type
  let filtered = events;
  if (goal.source !== undefined && goal.source !== null && goal.source !== "") {
    filtered = filtered.filter((e) => e.source === goal.source);
  }
  if (
    goal.media_type !== undefined &&
    goal.media_type !== null &&
    goal.media_type !== ""
  ) {
    filtered = filtered.filter((e) => e.media_type === goal.media_type);
  }

  const review = computeYearReview(filtered, tz, goal.year, today);

  let current = 0;
  if (goal.metric === "items") {
    current = review.totals.items;
  } else if (goal.metric === "hours") {
    current = review.totals.minutes / 60;
  } else if (goal.metric === "titles") {
    current = review.totals.titles;
  } else if (goal.metric === "active_days") {
    current = review.totals.active_days;
  }

  const target = goal.target;
  const percent = target > 0 ? (current / target) * 100 : 0;

  const todayYear = Number(today.slice(0, 4));
  const daysInYear = isLeapYear(goal.year) ? 366 : 365;

  let expected = 0;
  let status: GoalStatus = "not_started";

  if (goal.year === todayYear) {
    const elapsed = Math.min(daysInYear, Math.max(0, daysUpTo(today, goal.year)));
    expected = (target * elapsed) / daysInYear;
    if (current >= target) {
      status = "done";
    } else if (current >= expected) {
      status = "on_track";
    } else {
      status = "behind";
    }
  } else if (goal.year < todayYear) {
    expected = target;
    if (current >= target) {
      status = "done";
    } else {
      status = "missed";
    }
  } else {
    expected = 0;
    status = "not_started";
  }

  return {
    current,
    target,
    percent,
    expected,
    status,
  };
}

/**
 * Reads `goals_latest` (skip archived unless asked) and consumption events
 * via `getLatestConsumptionEvents`. Returns newest goal first.
 */
export function getGoals(
  db: Database,
  options: GetGoalsOptions
): GoalWithProgress[] {
  let query = "SELECT * FROM goals_latest";
  const conditions: string[] = [];
  const params: (number | string)[] = [];

  if (options.year !== undefined) {
    conditions.push("year = ?");
    params.push(options.year);
  }

  if (!options.includeArchived) {
    conditions.push("archived = 0");
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY id DESC;";

  const rows = db.query<GoalRow, (number | string)[]>(query).all(...params);
  const events = getLatestConsumptionEvents(db);

  return rows.map((row) => ({
    goal_id: row.goal_id,
    year: row.year,
    metric: row.metric as GoalMetric,
    source: row.source,
    media_type: row.media_type,
    target: row.target,
    archived: row.archived,
    created_at: row.created_at,
    progress: computeGoalProgress(row, events, options.tz, options.today),
  }));
}
