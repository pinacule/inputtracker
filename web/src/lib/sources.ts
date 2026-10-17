/**
 * Shared source list for the web UI.
 *
 * Single source of truth for the source id → label / icon / colour mapping, so
 * a new source (e.g. YouTube, task Y03) is one entry in `SOURCES`. No DOM
 * dependencies; safe to run under Bun or in the browser.
 */

export interface SourceOption {
  /** Source id as stored on events (e.g. `simkl`). */
  readonly value: string;
  /** Human-readable name shown to the user. */
  readonly label: string;
  /** Emoji icon used as a fallback when an item has no cover. */
  readonly icon: string;
  /** Chart colour (hex). */
  readonly color: string;
}

/** Ordered list of the sources the UI knows about. */
export const SOURCES: readonly SourceOption[] = [
  { value: "audiobookshelf", label: "Audiobookshelf", icon: "🎧", color: "#8b5cf6" },
  { value: "simkl", label: "Simkl", icon: "🎬", color: "#f59e0b" },
  { value: "youtube", label: "YouTube", icon: "▶️", color: "#ef4444" },
  { value: "manual", label: "Manual", icon: "📝", color: "#10b981" },
];

/** Fallback colour for a source that is not in `SOURCES`. */
export const UNKNOWN_SOURCE_COLOR = "#3b82f6";

/**
 * Human-readable labels for ingest-run sources that are not event sources.
 * These must never appear in `SOURCES` (and therefore not in the filters).
 */
const INGEST_SOURCE_LABELS: Readonly<Record<string, string>> = {
  "youtube-takeout": "YouTube Takeout",
  "native-import": "Import",
};

/** Alternative ids accepted for a source (e.g. the ABS short form). */
const SOURCE_ALIASES: Readonly<Record<string, string>> = {
  abs: "audiobookshelf",
};

function normalizeSource(value: string): string {
  const trimmed = String(value ?? "")
    .toLowerCase()
    .trim();
  return SOURCE_ALIASES[trimmed] ?? trimmed;
}

/** The `SOURCES` entry for `value` (alias-aware), or `undefined` if unknown. */
export function sourceEntry(value: string): SourceOption | undefined {
  const normalized = normalizeSource(value);
  return SOURCES.find((source) => source.value === normalized);
}

/**
 * Human-readable label for a source id. Ingest-run sources that are not event
 * sources (e.g. `youtube-takeout`) are labelled from a separate map. Unknown
 * sources fall back to the trimmed raw value so nothing is hidden from the user.
 */
export function sourceLabel(value: string): string {
  const entry = sourceEntry(value);
  if (entry !== undefined) {
    return entry.label;
  }
  const ingest = INGEST_SOURCE_LABELS[normalizeSource(value)];
  if (ingest !== undefined) {
    return ingest;
  }
  return String(value ?? "").trim();
}

/** Chart colour for a source id; unknown sources get the fallback blue. */
export function sourceColor(value: string): string {
  return sourceEntry(value)?.color ?? UNKNOWN_SOURCE_COLOR;
}
