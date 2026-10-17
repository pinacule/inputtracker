/**
 * Pure, unit-tested helpers for goals (F8).
 *
 * No DOM, no `fetch`: formatting labels, progress values, and building/validating
 * form inputs into SaveGoalInput payloads.
 */

import type { GoalMetric, GoalStatus, SaveGoalInput } from "../api";
import { MEDIA_TYPE_OPTIONS } from "./forms";

export const VALID_GOAL_METRICS: ReadonlySet<GoalMetric> = new Set<GoalMetric>([
  "items",
  "hours",
  "titles",
  "active_days",
]);

export const GOAL_METRIC_OPTIONS: ReadonlyArray<{
  value: GoalMetric;
  label: string;
}> = [
  { value: "items", label: "Items" },
  { value: "hours", label: "Hours" },
  { value: "titles", label: "Titles" },
  { value: "active_days", label: "Active days" },
];

const VALID_MEDIA_TYPE_SET: ReadonlySet<string> = new Set(
  MEDIA_TYPE_OPTIONS.map((opt) => opt.value)
);

export function metricLabel(metric: GoalMetric): string {
  switch (metric) {
    case "items":
      return "Items";
    case "hours":
      return "Hours";
    case "titles":
      return "Titles";
    case "active_days":
      return "Active days";
  }
}

export function goalMetricUnit(metric: GoalMetric): string {
  switch (metric) {
    case "items":
      return "items";
    case "hours":
      return "h";
    case "titles":
      return "titles";
    case "active_days":
      return "days";
  }
}

function fmtNumber(n: number): string {
  if (Number.isInteger(n)) {
    return String(n);
  }
  return (Math.round(n * 10) / 10).toString();
}

/**
 * Format goal progress value.
 * e.g. formatGoalValue("items", 12, 30) -> "12 / 30 items"
 *      formatGoalValue("hours", 48.5, 200) -> "48.5 / 200 h"
 *      formatGoalValue("items", 30) -> "30 items"
 */
export function formatGoalValue(
  metric: GoalMetric,
  current: number,
  target?: number
): string {
  const unit = goalMetricUnit(metric);
  if (target !== undefined) {
    return `${fmtNumber(current)} / ${fmtNumber(target)} ${unit}`;
  }
  return `${fmtNumber(current)} ${unit}`;
}

/**
 * Human-readable status label.
 * e.g. "On track", "Behind by 3 items", "Done", "Missed", "Not started"
 */
export function statusLabel(
  progressOrStatus:
    | { status: GoalStatus; expected?: number; current?: number }
    | GoalStatus,
  metricOrDiff?: GoalMetric | number,
  maybeMetric?: GoalMetric
): string {
  let status: GoalStatus;
  let diff: number | undefined;
  let metric: GoalMetric | undefined;

  if (typeof progressOrStatus === "object" && progressOrStatus !== null) {
    status = progressOrStatus.status;
    metric = typeof metricOrDiff === "string" ? metricOrDiff : undefined;
    if (
      progressOrStatus.expected !== undefined &&
      progressOrStatus.current !== undefined
    ) {
      diff = Math.max(0, progressOrStatus.expected - progressOrStatus.current);
    }
  } else {
    status = progressOrStatus;
    if (typeof metricOrDiff === "number") {
      diff = metricOrDiff;
      metric = maybeMetric;
    } else if (typeof metricOrDiff === "string") {
      metric = metricOrDiff;
    }
  }

  switch (status) {
    case "done":
      return "Done";
    case "on_track":
      return "On track";
    case "missed":
      return "Missed";
    case "not_started":
      return "Not started";
    case "behind": {
      if (diff !== undefined && diff > 0 && metric !== undefined) {
        if (metric === "items") {
          const rounded = Math.round(diff);
          return `Behind by ${rounded} ${rounded === 1 ? "item" : "items"}`;
        }
        if (metric === "hours") {
          return `Behind by ${fmtNumber(diff)} h`;
        }
        if (metric === "titles") {
          const rounded = Math.round(diff);
          return `Behind by ${rounded} ${rounded === 1 ? "title" : "titles"}`;
        }
        if (metric === "active_days") {
          const rounded = Math.round(diff);
          return `Behind by ${rounded} ${rounded === 1 ? "day" : "days"}`;
        }
      }
      if (diff !== undefined && diff > 0) {
        return `Behind by ${fmtNumber(diff)}`;
      }
      return "Behind";
    }
  }
}

export interface GoalFormState {
  goal_id?: string;
  rev_id?: string;
  year: number | string;
  metric: string;
  target: number | string;
  source?: string;
  media_type?: string;
  archived?: number | boolean;
}

export interface BuildGoalResult {
  errors: string[];
  input: SaveGoalInput | null;
}

/**
 * Validate raw goal form state and build the `SaveGoalInput` to POST.
 */
export function buildGoalInput(state: GoalFormState): BuildGoalResult {
  const errors: string[] = [];

  // Year
  const yearRaw = typeof state.year === "string" ? state.year.trim() : state.year;
  const yearNum = Number(yearRaw);
  if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
    errors.push("Year must be an integer between 2000 and 2100");
  }

  // Metric
  const metricTrimmed = (state.metric ?? "").trim() as GoalMetric;
  if (!VALID_GOAL_METRICS.has(metricTrimmed)) {
    errors.push("Metric must be one of: items, hours, titles, active_days");
  }

  // Target
  const targetRaw = typeof state.target === "string" ? state.target.trim() : state.target;
  const targetNum = Number(targetRaw);
  if (!Number.isFinite(targetNum) || targetNum <= 0 || targetNum > 1_000_000) {
    errors.push("Target must be a number > 0 and <= 1,000,000");
  }

  // Source (optional)
  let source: string | null = null;
  if (state.source !== undefined && state.source !== null) {
    const trimmed = state.source.trim();
    if (trimmed.length > 64) {
      errors.push("Source must be at most 64 characters");
    } else if (trimmed.length > 0) {
      source = trimmed;
    }
  }

  // Media type (optional)
  let mediaType: string | null = null;
  if (state.media_type !== undefined && state.media_type !== null) {
    const trimmed = state.media_type.trim();
    if (trimmed.length > 0) {
      if (!VALID_MEDIA_TYPE_SET.has(trimmed)) {
        errors.push(`Invalid media_type: '${trimmed}'`);
      } else {
        mediaType = trimmed;
      }
    }
  }

  // Archived
  let archived = 0;
  if (state.archived !== undefined && state.archived !== null) {
    if (typeof state.archived === "boolean") {
      archived = state.archived ? 1 : 0;
    } else if (state.archived === 0 || state.archived === 1) {
      archived = state.archived;
    }
  }

  if (errors.length > 0) {
    return { errors, input: null };
  }

  const input: SaveGoalInput = {
    year: yearNum,
    metric: metricTrimmed,
    target: targetNum,
    source,
    media_type: mediaType,
    archived,
  };

  if (state.goal_id) {
    input.goal_id = state.goal_id;
  }
  if (state.rev_id) {
    input.rev_id = state.rev_id;
  }

  return { errors: [], input };
}
