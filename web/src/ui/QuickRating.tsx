import { createPortal } from "preact/compat";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { Category } from "../api";
import { computeContextMenuPlacement } from "../lib/context-menu";
import {
  formatRating10,
  parseRating10Input,
  resolveRatingKeyAction,
  stepRating10,
} from "../lib/rating";
import {
  getWorkRatingOverride,
  performWorkEdit,
  pushToast,
  subscribeWorkEdits,
} from "../lib/work-edits";
import { Button } from "./Button";

export interface RatingInput10Props {
  rating: number | null;
  onChange: (rating: number | null) => void;
  disabled?: boolean;
  compact?: boolean;
  onCommit?: (rating: number | null) => void;
}

/**
 * 0–10 one-decimal rating control:
 * - Slider in 0.5 steps (`0..10`)
 * - Number field accepting one decimal (`8.5`)
 * - Keyboard arrows `±0.1` (`Shift+Arrow` or `PageUp`/`PageDown` `±0.5`), `Delete`/`Backspace` clear
 * - Quick step buttons (`-0.5`, `-0.1`, `+0.1`, `+0.5`) and `Clear`
 */
export function RatingInput10({
  rating,
  onChange,
  disabled = false,
  compact = false,
  onCommit,
}: RatingInput10Props) {
  const numId = useId();
  const sliderId = useId();

  const [textVal, setTextVal] = useState<string>(() =>
    rating !== null && rating !== undefined ? formatRating10(rating) : "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTextVal(
      rating !== null && rating !== undefined ? formatRating10(rating) : "",
    );
    setError(null);
  }, [rating]);

  const applyValue = (next: number | null) => {
    setError(null);
    setTextVal(next !== null ? formatRating10(next) : "");
    onChange(next);
  };

  const handleStep = (delta: number) => {
    const next = stepRating10(rating, delta);
    applyValue(next);
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
    if (e.key === "Enter" && onCommit) {
      e.preventDefault();
      const parsed = parseRating10Input(textVal);
      if (parsed.ok) {
        onCommit(parsed.rating);
      }
      return;
    }
    // Let standard text editing work inside the number input except for Up/Down arrows
    const target = e.target as HTMLElement | null;
    const isNumberInput =
      target?.tagName === "INPUT" &&
      (target as HTMLInputElement).type !== "range";

    if (
      isNumberInput &&
      (e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "Backspace" ||
        e.key === "Delete" ||
        e.key === "Home" ||
        e.key === "End")
    ) {
      return;
    }

    const action = resolveRatingKeyAction(e.key, e.shiftKey);
    if (!action) return;
    e.preventDefault();
    if (action.type === "step") {
      handleStep(action.delta);
    } else if (action.type === "set") {
      applyValue(action.value);
    } else if (action.type === "clear") {
      applyValue(null);
    }
  };

  return (
    <div
      class={compact ? "ui-rating10 ui-rating10--compact" : "ui-rating10"}
      onKeyDown={handleKeyDown}
    >
      <div class="ui-rating10-main">
        <div class="ui-rating10-slider-wrap">
          <label class="sr-only" for={sliderId}>
            Rating slider (0 to 10 in 0.5 steps)
          </label>
          <input
            id={sliderId}
            type="range"
            min="0"
            max="10"
            step="0.5"
            disabled={disabled}
            class="ui-rating10-slider"
            value={String(rating ?? 7.5)}
            onInput={(e) => {
              const v = Number((e.currentTarget as HTMLInputElement).value);
              if (Number.isFinite(v)) {
                applyValue(v);
              }
            }}
          />
          <div class="ui-rating10-ticks" aria-hidden="true">
            <span>0</span>
            <span>2.5</span>
            <span>5</span>
            <span>7.5</span>
            <span>10</span>
          </div>
        </div>

        <div class="ui-rating10-number-wrap">
          <label class="sr-only" for={numId}>
            Rating score (0 to 10, one decimal)
          </label>
          <input
            id={numId}
            type="text"
            inputMode="decimal"
            disabled={disabled}
            class="ui-input ui-rating10-input tabular-nums"
            placeholder="—"
            aria-label="Rating 0 to 10"
            value={textVal}
            onInput={(e) =>
              handleTextInput((e.currentTarget as HTMLInputElement).value)
            }
          />
          <span class="ui-rating10-denom tabular-nums">/ 10</span>
        </div>
      </div>

      <div class="ui-rating10-controls">
        <div
          class="ui-rating10-steppers"
          role="group"
          aria-label="Adjust rating"
        >
          <button
            type="button"
            class="ui-rating10-step-btn tabular-nums"
            disabled={disabled}
            onClick={() => handleStep(-0.5)}
            title="Decrease by 0.5 (Shift+ArrowDown)"
          >
            −0.5
          </button>
          <button
            type="button"
            class="ui-rating10-step-btn tabular-nums"
            disabled={disabled}
            onClick={() => handleStep(-0.1)}
            title="Decrease by 0.1 (ArrowDown)"
          >
            −0.1
          </button>
          <button
            type="button"
            class="ui-rating10-step-btn tabular-nums"
            disabled={disabled}
            onClick={() => handleStep(0.1)}
            title="Increase by 0.1 (ArrowUp)"
          >
            +0.1
          </button>
          <button
            type="button"
            class="ui-rating10-step-btn tabular-nums"
            disabled={disabled}
            onClick={() => handleStep(0.5)}
            title="Increase by 0.5 (Shift+ArrowUp)"
          >
            +0.5
          </button>
        </div>

        {rating !== null && (
          <button
            type="button"
            class="ui-rating10-clear"
            disabled={disabled}
            onClick={() => applyValue(null)}
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <p class="ui-form-error" role="alert">
          {error}
        </p>
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
 * Compact rating pill (`★ 8.5` or `☆ Rate`) reachable on Library cards, list rows,
 * Day panel rows, Review cards, and the Work page without opening the work.
 * Opens a viewport-clamped popover and saves optimistically with an Undo toast.
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
  const popoverRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    return subscribeWorkEdits(() => setTick((t) => t + 1));
  }, []);

  const effectiveRating = getWorkRatingOverride(workKey, propRating ?? null);
  const [draftRating, setDraftRating] = useState<number | null>(
    effectiveRating,
  );
  const [coords, setCoords] = useState<{ left: number; top: number }>({
    left: 16,
    top: 16,
  });

  useEffect(() => {
    if (open) {
      setDraftRating(effectiveRating ?? 8.0);
    }
  }, [open, effectiveRating]);

  const openPopover = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = triggerRef.current?.getBoundingClientRect();
    const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
    const vh = typeof window !== "undefined" ? window.innerHeight : 768;
    const anchor = rect
      ? { x: rect.left, y: rect.bottom + 6 }
      : { x: e.clientX, y: e.clientY };
    const placed = computeContextMenuPlacement(
      anchor,
      { width: 280, height: 190 },
      { width: vw, height: vh },
      12,
    );
    setCoords({ left: placed.left, top: placed.top });
    setOpen(true);
  };

  const closePopover = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePopover(true);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        popoverRef.current &&
        target &&
        !popoverRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        closePopover(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [open]);

  const commitRating = async (nextRating: number | null) => {
    const prevRating = effectiveRating;
    closePopover(true);
    onRated?.(nextRating);

    const { undo } = await performWorkEdit(
      workKey,
      { rating: nextRating },
      {
        title,
        category,
        rating: prevRating,
        source,
      },
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

  const hasRating = effectiveRating !== null && effectiveRating !== undefined;

  return (
    <span
      class={
        variant === "overlay"
          ? "ui-quick-rate-anchor ui-quick-rate-anchor--overlay"
          : "ui-quick-rate-anchor"
      }
      onClick={(e) => e.stopPropagation()}
    >
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
            ? `Rated ${formatRating10(effectiveRating)} out of 10 for ${title}. Click to change`
            : `Rate ${title}`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openPopover}
      >
        {hasRating ? `★ ${formatRating10(effectiveRating)}` : "☆ Rate"}
      </button>

      {/* Portalled to <body>: a transformed ancestor (hover lift on cards) would otherwise
          become the containing block of this position:fixed popover and shift it away. */}
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            class="ui-quick-rate-popover"
            role="dialog"
            aria-label={`Rate ${title}`}
            style={{
              left: `${coords.left}px`,
              top: `${coords.top}px`,
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <div class="ui-quick-rate-popover-header">
              <strong class="ui-quick-rate-popover-title" title={title}>
                {title}
              </strong>
              <span class="ui-quick-rate-popover-score tabular-nums">
                {draftRating !== null
                  ? `★ ${formatRating10(draftRating)}`
                  : "Unrated"}
              </span>
            </div>

            <RatingInput10
              rating={draftRating}
              onChange={setDraftRating}
              compact
              onCommit={(val) => void commitRating(val)}
            />

            <div class="ui-quick-rate-popover-actions">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void commitRating(draftRating)}
              >
                Save
              </Button>
              {hasRating && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void commitRating(null)}
                >
                  Clear
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => closePopover(true)}
              >
                Cancel
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
