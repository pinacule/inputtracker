/**
 * Pure helpers for the Search page. No DOM dependencies; safe to run under Bun
 * or in the browser.
 *
 * Matching is case- and diacritics-insensitive using the same normalization
 * idea as the server (`src/server/search.ts`): lowercase, Unicode NFD with
 * combining marks removed, whitespace collapsed, trimmed.
 */

import type { SearchHit } from "../api";
import { formatLocalDay } from "./format-date";
import { formatHours } from "./year-review";

/** Minimum query length (after normalization) before a search is performed. */
export const MIN_QUERY_LENGTH = 2;

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Lowercase, Unicode NFD with combining marks removed, whitespace collapsed,
 * trimmed — the web-side twin of the server's `normalizeForSearch`.
 */
export function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The media types the server accepts on `/api/search`. */
export const SEARCH_MEDIA_TYPES: readonly string[] = [
  "audiobook",
  "podcast_episode",
  "movie",
  "episode",
  "video",
  "music",
  "book",
  "other",
];

/** One contiguous piece of `highlightParts` output. */
export interface HighlightPart {
  text: string;
  match: boolean;
}

/** Normalized form of a single character ("" when it normalizes away). */
function normalizeChar(ch: string): string {
  return ch.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "");
}

interface NormalizedText {
  /** Normalized characters (whitespace collapsed, trimmed). */
  chars: string[];
  /** For each normalized character, the index of the original character it came from. */
  origins: number[];
}

/**
 * Normalizes `text` char by char while remembering where each normalized
 * character came from, so match positions can be mapped back onto the
 * original string with its original characters.
 */
function normalizeWithOrigins(text: string): NormalizedText {
  const chars: string[] = [];
  const origins: number[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const normalized of normalizeChar(text[i]!)) {
      if (/\s/.test(normalized)) {
        // Collapse whitespace runs to a single space (like the server).
        if (chars.length > 0 && chars[chars.length - 1] === " ") {
          continue;
        }
        chars.push(" ");
      } else {
        chars.push(normalized);
      }
      origins.push(i);
    }
  }
  let start = 0;
  let end = chars.length;
  while (start < end && chars[start] === " ") {
    start++;
  }
  while (end > start && chars[end - 1] === " ") {
    end--;
  }
  return {
    chars: chars.slice(start, end),
    origins: origins.slice(start, end),
  };
}

/**
 * Splits `text` into segments for highlighting: every part of `text` that
 * matches a word of `query` (case- and diacritics-insensitive, whitespace
 * collapsed) gets `match: true`. The original characters of `text` are kept
 * byte for byte; normalization only decides WHERE the matches are. No match
 * (or an empty query) yields one non-matching part covering all of `text`.
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  if (text === "") {
    return [];
  }
  const normalized = normalizeWithOrigins(text);
  const haystack = normalized.chars.join("");
  const words = normalizeForSearch(query).split(" ").filter((w) => w !== "");
  if (haystack === "" || words.length === 0) {
    return [{ text, match: false }];
  }

  // All match intervals in normalized coordinates (every word occurrence).
  const intervals: Array<[number, number]> = [];
  for (const word of words) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(word, from);
      if (at === -1) {
        break;
      }
      intervals.push([at, at + word.length]);
      from = at + 1;
    }
  }
  if (intervals.length === 0) {
    return [{ text, match: false }];
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Merge overlapping intervals.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  // Map the normalized intervals back onto the original characters.
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const [nStart, nEnd] of merged) {
    const startOrig = normalized.origins[nStart] ?? text.length;
    const endOrig =
      (normalized.origins[nEnd - 1] ?? text.length - 1) + 1;
    if (startOrig > cursor) {
      parts.push({ text: text.slice(cursor, startOrig), match: false });
    }
    parts.push({ text: text.slice(startOrig, endOrig), match: true });
    cursor = endOrig;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), match: false });
  }
  return parts;
}

/** Count as "1 play" / "12 plays", or "views" for YouTube (no durations). */
export function countLabel(source: string, count: number): string {
  const unit = source === "youtube" ? "view" : "play";
  return `${count} ${count === 1 ? unit : `${unit}s`}`;
}

/**
 * Meta line for a hit: "12 plays · 34 h · 03.05.2026 – 17.10.2026".
 * YouTube hits count views; a single date is shown when first = last.
 */
export function formatHitMeta(
  hit: Pick<SearchHit, "source" | "count" | "minutes" | "first_date" | "last_date">
): string {
  const dates =
    hit.first_date === hit.last_date
      ? formatLocalDay(hit.first_date)
      : `${formatLocalDay(hit.first_date)} – ${formatLocalDay(hit.last_date)}`;
  return `${countLabel(hit.source, hit.count)} · ${formatHours(hit.minutes)} · ${dates}`;
}
