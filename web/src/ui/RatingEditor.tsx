import { useEffect, useId, useRef, useState } from "preact/hooks";
import { getAnnotation, saveAnnotation, type Annotation } from "../api";
import {
  buildAnnotationBody,
  formatNoteCounter,
  formatRating,
  ratingToStars,
  starsToRating,
} from "../lib/annotations";
import { Button } from "./Button";

const HALF_VALUES: readonly number[] = [
  0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5,
];

export interface StarRatingInputProps {
  rating: number | null;
  onChange: (rating: number | null) => void;
  disabled?: boolean;
}

/**
 * Controlled half-star rating picker (`1..10` internal = `0.5..5` stars).
 * Keyboard accessible (`ArrowLeft`/`ArrowRight`, `Home`, `End`, `Backspace`/`Delete`).
 */
export function StarRatingInput({
  rating,
  onChange,
  disabled = false,
}: StarRatingInputProps) {
  const halfRefs = useRef(new Map<number, HTMLButtonElement>());
  const stars = ratingToStars(rating);

  function focusHalf(value: number): void {
    halfRefs.current.get(value)?.focus();
  }

  function selectHalf(value: number): void {
    const next = starsToRating(value);
    onChange(rating === next ? null : next);
  }

  function stepStars(delta: number): void {
    const current = stars ?? 0;
    const next = Math.round((current + delta) * 2) / 2;
    if (next <= 0) {
      onChange(null);
      return;
    }
    const clamped = Math.min(5, Math.max(0.5, next));
    onChange(starsToRating(clamped));
    focusHalf(clamped);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        event.preventDefault();
        stepStars(0.5);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        event.preventDefault();
        stepStars(-0.5);
        break;
      case "Home":
        event.preventDefault();
        onChange(starsToRating(0.5));
        focusHalf(0.5);
        break;
      case "End":
        event.preventDefault();
        onChange(starsToRating(5));
        focusHalf(5);
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        onChange(null);
        break;
      default:
        break;
    }
  }

  return (
    <div class="ui-star-picker-row">
      <div
        class="ui-star-group"
        role="radiogroup"
        aria-label={`Rating: ${formatRating(rating)}`}
        onKeyDown={handleKeyDown}
      >
        {[0, 1, 2, 3, 4].map((star) => (
          <span class="ui-star-unit" key={star}>
            {[0, 1].map((half) => {
              const value = HALF_VALUES[star * 2 + half]!;
              const filled = stars !== null && value <= stars;
              const side =
                half === 0 ? "ui-star-half--left" : "ui-star-half--right";
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={stars === value}
                  aria-label={`${value} of 5 stars`}
                  class={`ui-star-half ${side}${
                    filled ? " ui-star-half--filled" : ""
                  }`}
                  disabled={disabled}
                  onClick={() => selectHalf(value)}
                  ref={(el) => {
                    if (el) {
                      halfRefs.current.set(value, el);
                    } else {
                      halfRefs.current.delete(value);
                    }
                  }}
                >
                  <span class="ui-star-glyph" aria-hidden="true">
                    ★
                  </span>
                </button>
              );
            })}
          </span>
        ))}
      </div>
      <span class="ui-star-label tabular-nums">{formatRating(rating)}</span>
      {rating !== null && (
        <button
          type="button"
          class="ui-star-clear"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          Clear
        </button>
      )}
    </div>
  );
}

export interface RatingEditorProps {
  source: string;
  title: string;
  initialRating: number | null;
  initialNote?: string | null;
  skipFetch?: boolean;
  onSaved?: (annotation: Annotation) => void;
  onCancel?: () => void;
}

/**
 * Full Rating + Note editor wired to `/api/annotations`.
 */
export function RatingEditor({
  source,
  title,
  initialRating,
  initialNote,
  skipFetch = false,
  onSaved,
  onCancel,
}: RatingEditorProps) {
  const [rating, setRating] = useState<number | null>(initialRating);
  const [note, setNote] = useState(initialNote ?? "");
  const [loading, setLoading] = useState(!skipFetch);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const revIdRef = useRef<string | null>(null);
  const noteId = useId();
  const counterId = useId();

  useEffect(() => {
    setRating(initialRating);
    if (initialNote !== undefined) {
      setNote(initialNote ?? "");
    }
  }, [initialRating, initialNote]);

  useEffect(() => {
    if (skipFetch) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    revIdRef.current = null;
    setLoading(true);
    setLoadError(null);
    setSaved(false);

    getAnnotation(source, title)
      .then((ann) => {
        if (cancelled) return;
        setRating(ann.rating);
        setNote(ann.note ?? "");
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [source, title, skipFetch]);

  async function handleSave(): Promise<void> {
    const built = buildAnnotationBody({ source, title, rating, note });
    if (!built.ok) {
      setValidationErrors(built.errors);
      return;
    }
    setValidationErrors([]);
    setServerError(null);
    setSaved(false);
    if (revIdRef.current === null) {
      revIdRef.current = crypto.randomUUID();
    }
    setSaving(true);
    try {
      const result = await saveAnnotation({
        ...built.body,
        rev_id: revIdRef.current,
      });
      revIdRef.current = null;
      setRating(result.annotation.rating);
      setNote(result.annotation.note ?? "");
      setSaved(true);
      onSaved?.(result.annotation);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="ui-rating-editor">
      {loadError !== null && (
        <p class="ui-form-error" role="alert">
          Could not load current annotation: {loadError}
        </p>
      )}

      <StarRatingInput
        rating={rating}
        onChange={(next) => {
          setRating(next);
          setSaved(false);
          setServerError(null);
        }}
        disabled={loading || saving}
      />

      <div class="ui-rating-note-field">
        <div class="ui-rating-note-header">
          <label class="ui-form-label" for={noteId}>
            Personal Note
          </label>
          <span class="ui-rating-counter tabular-nums" id={counterId}>
            {formatNoteCounter(note)}
          </span>
        </div>
        <textarea
          id={noteId}
          class="ui-input ui-textarea"
          rows={3}
          value={note}
          disabled={loading || saving}
          placeholder="Reflections, favourite moments, or who recommended it…"
          aria-describedby={counterId}
          onInput={(e) => {
            setNote((e.currentTarget as HTMLTextAreaElement).value);
            setSaved(false);
            setServerError(null);
          }}
        />
      </div>

      {validationErrors.length > 0 && (
        <ul class="ui-form-error-list" role="alert">
          {validationErrors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}

      {serverError !== null && (
        <p class="ui-form-error" role="alert">
          Could not save: {serverError}
        </p>
      )}

      <div class="ui-rating-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={loading || saving}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save Rating & Note"}
        </Button>
        {onCancel && (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
        {saved && (
          <span class="ui-rating-saved-pill" role="status">
            Saved
          </span>
        )}
      </div>
    </div>
  );
}
