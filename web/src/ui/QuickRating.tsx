import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { Category } from "../api";
import {
  canRateCategory,
  commitInlineRatingInput,
  formatRating10,
  nudgeRatingText,
  parseRating10Input,
  resolveRatingKeyAction,
  resolveRatingWheelDelta,
} from "../lib/rating";
import {
  getWorkRatingOverride,
  performWorkEdit,
  pushToast,
  subscribeWorkEdits,
} from "../lib/work-edits";

export interface RatingInput10Props {
  rating: number | null;
  onChange: (rating: number | null) => void;
  category?: Category;
  disabled?: boolean;
  compact?: boolean;
  autoFocus?: boolean;
  onCommit?: (rating: number | null) => void;
  onCancel?: () => void;
}

/**
 * 0–10 one-decimal inline rating text input (no slider, no popover):
 * - Type `8.5`, Enter commits, Esc cancels
 * - ↑/↓ and mouse wheel nudge by `±0.1` (`Shift`: `±1.0`)
 * - Invalid input shows a short inline hint and does not save
 * - Hidden for music (`category === "music"`)
 */
export function RatingInput10({
  rating,
  onChange,
  category,
  disabled = false,
  compact = false,
  autoFocus = false,
  onCommit,
  onCancel,
}: RatingInput10Props) {
  const numId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [textVal, setTextVal] = useState<string>(() =>
    rating !== null && rating !== undefined ? formatRating10(rating) : ""
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTextVal(
      rating !== null && rating !== undefined ? formatRating10(rating) : ""
    );
    setError(null);
  }, [rating]);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

  if (!canRateCategory(category)) {
    return null;
  }

  const applyNudge = (delta: number) => {
    const nudged = nudgeRatingText(textVal, rating, delta);
    setError(null);
    setTextVal(nudged.text);
    onChange(nudged.rating);
  };

  const handleTextInput = (raw: string) => {
    setTextVal(raw);
    if (raw.trim() === "") {
      setError(null);
      onChange(null);
      return;
    }
    const parsed = parseRating10Input(raw);
    if (parsed.ok) {
      setError(null);
      onChange(parsed.rating);
    } else {
      setError(parsed.error);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const action = resolveRatingKeyAction(e.key, e.shiftKey);
    if (!action) return;

    if (action.type === "commit") {
      if (!onCommit) return;
      e.preventDefault();
      e.stopPropagation();
      const parsed = parseRating10Input(textVal);
      if (parsed.ok) {
        setError(null);
        onChange(parsed.rating);
        onCommit(parsed.rating);
      } else {
        setError(parsed.error);
      }
      return;
    }

    if (action.type === "cancel") {
      e.preventDefault();
      e.stopPropagation();
      setError(null);
      setTextVal(
        rating !== null && rating !== undefined ? formatRating10(rating) : ""
      );
      onCancel?.();
      return;
    }

    if (action.type === "step") {
      e.preventDefault();
      e.stopPropagation();
      applyNudge(action.delta);
    }
  };

  const handleWheel = (e: WheelEvent) => {
    if (disabled) return;
    const delta = resolveRatingWheelDelta(e.deltaY, e.shiftKey);
    if (delta === 0) return;
    e.preventDefault();
    e.stopPropagation();
    applyNudge(delta);
  };

  return (
    <div
      class={compact ? "ui-rating10 ui-rating10--compact" : "ui-rating10"}
      onKeyDown={handleKeyDown}
    >
      <div class="ui-rating10-inline-row">
        <label class="sr-only" for={numId}>
          Rating score (0 to 10, one decimal)
        </label>
        <div
          class={
            error
              ? "ui-rating10-field ui-rating10-field--invalid"
              : "ui-rating10-field"
          }
          onWheel={handleWheel}
        >
          <span class="ui-rating10-star" aria-hidden="true">
            ★
          </span>
          <input
            ref={inputRef}
            id={numId}
            type="text"
            inputMode="decimal"
            disabled={disabled}
            class="ui-rating10-input tabular-nums"
            placeholder="8.5"
            aria-label="Rating 0 to 10"
            aria-invalid={error ? "true" : undefined}
            value={textVal}
            onInput={(e) =>
              handleTextInput((e.currentTarget as HTMLInputElement).value)
            }
          />
          <span class="ui-rating10-denom tabular-nums">/ 10</span>
        </div>

        {(rating !== null || textVal.trim() !== "") && (
          <button
            type="button"
            class="ui-rating10-clear"
            disabled={disabled}
            onClick={() => {
              setError(null);
              setTextVal("");
              onChange(null);
            }}
          >
            Clear
          </button>
        )}

        <span class="ui-rating10-hint-meta">
          ↑/↓ or scroll ±0.1 · Shift ±1
        </span>
      </div>

      {error && (
        <span class="ui-quick-rate-hint" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export interface QuickRatingPillProps {
  workKey: string;
  title: string;
  category?: Category;
  rating: number | null | undefined;
  source?: string;
  variant?: "overlay" | "inline";
  onRated?: (rating: number | null) => void;
}

/**
 * In-place rating badge (`★ 8.5` or `☆ Rate`).
 * - Click the badge and it turns in place into a small text field showing the current value.
 * - Type `8.5`, Enter saves, Esc cancels, blur saves if valid.
 * - ↑/↓ and mouse wheel nudge by `0.1` (`Shift`: `1.0`).
 * - Invalid input shows a short inline hint and does not save.
 * - Saves optimistically through `WorkEdit.rating` with an Undo toast.
 * - Hidden for music (`category === "music"`).
 */
export function QuickRatingPill({
  workKey,
  title,
  category,
  rating: propRating,
  source,
  variant = "inline",
  onRated,
}: QuickRatingPillProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [editing, setEditing] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    return subscribeWorkEdits(() => setTick((t) => t + 1));
  }, []);

  const effectiveRating = getWorkRatingOverride(workKey, propRating ?? null);
  const [textVal, setTextVal] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // No ratings for music tracks
  if (
    !canRateCategory(category) ||
    workKey.trim().toLowerCase().startsWith("music:")
  ) {
    return null;
  }

  const hasRating = effectiveRating !== null && effectiveRating !== undefined;

  const startEditing = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    setTextVal(hasRating ? formatRating10(effectiveRating) : "");
    setError(null);
    setEditing(true);
  };

  const cancelEditing = (restoreFocus = true) => {
    setEditing(false);
    setError(null);
    setTextVal(hasRating ? formatRating10(effectiveRating) : "");
    if (restoreFocus) {
      queueMicrotask(() => {
        triggerRef.current?.focus();
      });
    }
  };

  const saveRating = async (nextRating: number | null, restoreFocus = true) => {
    const prevRating = effectiveRating;
    setEditing(false);
    setError(null);
    onRated?.(nextRating);
    if (restoreFocus) {
      queueMicrotask(() => {
        triggerRef.current?.focus();
      });
    }

    const { undo } = await performWorkEdit(
      workKey,
      { rating: nextRating },
      {
        title,
        category,
        rating: prevRating,
        source,
      }
    );

    pushToast({
      message:
        nextRating !== null
          ? `Rated “${title}” ${formatRating10(nextRating)}`
          : `Cleared rating for “${title}”`,
      variant: "success",
      actionLabel: "Undo",
      onAction: () => {
        onRated?.(prevRating);
        void undo();
      },
    });
  };

  const handleCommitAttempt = (restoreFocus: boolean) => {
    const res = commitInlineRatingInput(textVal, effectiveRating);
    if (res.action === "noop") {
      cancelEditing(restoreFocus);
      return;
    }
    if (res.action === "invalid") {
      setError(res.error);
      return;
    }
    void saveRating(res.rating, restoreFocus);
  };

  const handleNudge = (delta: number) => {
    const nudged = nudgeRatingText(textVal, effectiveRating, delta);
    setError(null);
    setTextVal(nudged.text);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const action = resolveRatingKeyAction(e.key, e.shiftKey);
    if (!action) return;

    if (action.type === "commit") {
      e.preventDefault();
      e.stopPropagation();
      handleCommitAttempt(true);
      return;
    }

    if (action.type === "cancel") {
      e.preventDefault();
      e.stopPropagation();
      cancelEditing(true);
      return;
    }

    if (action.type === "step") {
      e.preventDefault();
      e.stopPropagation();
      handleNudge(action.delta);
    }
  };

  const handleWheel = (e: WheelEvent) => {
    const delta = resolveRatingWheelDelta(e.deltaY, e.shiftKey);
    if (delta === 0) return;
    e.preventDefault();
    e.stopPropagation();
    handleNudge(delta);
  };

  return (
    <span
      class={
        variant === "overlay"
          ? "ui-quick-rate-anchor ui-quick-rate-anchor--overlay"
          : "ui-quick-rate-anchor"
      }
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        if (editing) {
          e.stopPropagation();
        }
      }}
    >
      {!editing ? (
        <button
          ref={triggerRef}
          type="button"
          class={
            hasRating
              ? `ui-quick-rate-pill ui-quick-rate-pill--rated ui-quick-rate-pill--${variant} tabular-nums`
              : `ui-quick-rate-pill ui-quick-rate-pill--unrated ui-quick-rate-pill--${variant}`
          }
          aria-label={
            hasRating
              ? `Rated ${formatRating10(effectiveRating)} out of 10 for ${title}. Click to edit rating in place`
              : `Rate ${title}`
          }
          onClick={startEditing}
        >
          <span class="ui-quick-rate-pill-star" aria-hidden="true">
            {hasRating ? "★" : "☆"}
          </span>
          <span class="ui-quick-rate-pill-value">
            {hasRating ? formatRating10(effectiveRating) : "Rate"}
          </span>
        </button>
      ) : (
        <span
          class={
            error
              ? `ui-quick-rate-inline ui-quick-rate-inline--${variant} ui-quick-rate-inline--invalid`
              : `ui-quick-rate-inline ui-quick-rate-inline--${variant}`
          }
          onWheel={handleWheel}
        >
          <span class="ui-quick-rate-inline-star" aria-hidden="true">
            ★
          </span>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            class="ui-quick-rate-input tabular-nums"
            placeholder="8.5"
            aria-label={`Rating 0 to 10 for ${title}`}
            aria-invalid={error ? "true" : undefined}
            value={textVal}
            onInput={(e) => {
              const raw = (e.currentTarget as HTMLInputElement).value;
              setTextVal(raw);
              if (raw.trim() === "") {
                setError(null);
              } else {
                const check = parseRating10Input(raw);
                setError(check.ok ? null : check.error);
              }
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => handleCommitAttempt(false)}
          />
          {hasRating && (
            <button
              type="button"
              class="ui-quick-rate-clear-btn"
              title="Clear rating"
              aria-label={`Clear rating for ${title}`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void saveRating(null, true);
              }}
            >
              ×
            </button>
          )}
          {error && (
            <span class="ui-quick-rate-hint" role="alert">
              {error}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
