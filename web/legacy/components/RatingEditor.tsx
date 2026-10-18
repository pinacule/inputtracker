import { useEffect, useId, useRef, useState } from "preact/hooks";
import {
  getAnnotation,
  saveAnnotation,
  type Annotation,
} from "../api";
import {
  buildAnnotationBody,
  formatNoteCounter,
  formatRating,
  ratingToStars,
  starsToRating,
} from "../lib/annotations";

export interface RatingEditorProps {
  /** Annotation key: the Search grouping (`source` + `getSeriesOrTitle`). */
  source: string;
  /** Annotation key: the group title, as shown. */
  title: string;
  /** Rating shown before the current annotation loads. */
  initialRating: number | null;
  onSaved?: (annotation: Annotation) => void;
  onCancel?: () => void;
}

/** The ten selectable half-star values, 0.5 … 5. */
const HALF_VALUES: readonly number[] = [
  0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5,
];

/**
 * Star rating (5 stars, halves) + free-text note editor for one title.
 *
 * - Tap a star's left half for a half star; tap the current value again to
 *   clear the rating.
 * - Keyboard: arrow keys move in half-star steps (left from 0.5 clears),
 *   Home/End jump to the ends, Delete/Backspace clears.
 */
export function RatingEditor({
  source,
  title,
  initialRating,
  onSaved,
  onCancel,
}: RatingEditorProps) {
  const [rating, setRating] = useState<number | null>(initialRating);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  /** `rev_id` for the in-flight save: generated once, reused on retry. */
  const revIdRef = useRef<string | null>(null);
  const halfRefs = useRef(new Map<number, HTMLButtonElement>());
  const noteId = useId();
  const counterId = useId();

  const stars = ratingToStars(rating);

  // Load the current annotation (mainly for the note; confirms the rating).
  useEffect(() => {
    let cancelled = false;
    revIdRef.current = null;
    setLoading(true);
    setLoadError(null);
    setSaved(false);
    getAnnotation(source, title)
      .then((ann) => {
        if (cancelled) {
          return;
        }
        setRating(ann.rating);
        setNote(ann.note ?? "");
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, title]);

  function focusHalf(value: number): void {
    halfRefs.current.get(value)?.focus();
  }

  function selectHalf(value: number): void {
    const next = starsToRating(value);
    setRating((prev) => (prev === next ? null : next));
    setSaved(false);
    setServerError(null);
  }

  function stepStars(delta: number): void {
    const current = stars ?? 0;
    const next = Math.round((current + delta) * 2) / 2;
    if (next <= 0) {
      setRating(null);
      setSaved(false);
      setServerError(null);
      return;
    }
    const clamped = Math.min(5, Math.max(0.5, next));
    setRating(starsToRating(clamped));
    setSaved(false);
    setServerError(null);
    focusHalf(clamped);
  }

  function handleStarsKeyDown(event: KeyboardEvent): void {
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
        setRating(starsToRating(0.5));
        setSaved(false);
        focusHalf(0.5);
        break;
      case "End":
        event.preventDefault();
        setRating(starsToRating(5));
        setSaved(false);
        focusHalf(5);
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        setRating(null);
        setSaved(false);
        break;
      default:
        break;
    }
  }

  function handleNoteInput(event: Event): void {
    const el = event.currentTarget as HTMLTextAreaElement;
    setNote(el.value);
    setSaved(false);
    setServerError(null);
  }

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
      // This save is done: the next save is a new revision.
      revIdRef.current = null;
      setRating(result.annotation.rating);
      setNote(result.annotation.note ?? "");
      setSaved(true);
      if (onSaved) {
        onSaved(result.annotation);
      }
    } catch (err) {
      // Keep revIdRef.current: retrying the same save reuses the rev_id.
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function halfClass(value: number, index: number): string {
    const filled = stars !== null && value <= stars;
    const side = index % 2 === 0 ? "rating-half-left" : "rating-half-right";
    return `rating-half ${side}${filled ? " rating-half-filled" : ""}`;
  }

  return (
    <div class="rating-editor">
      {loadError !== null && (
        <p class="rating-error" role="alert">
          Couldn&apos;t load the current rating: {loadError}
        </p>
      )}

      <div
        class="rating-stars"
        role="radiogroup"
        aria-label={`Rating: ${formatRating(rating)}`}
        onKeyDown={handleStarsKeyDown}
      >
        {[0, 1, 2, 3, 4].map((star) => (
          <span class="rating-star" key={star}>
            {[0, 1].map((half) => {
              const value = HALF_VALUES[star * 2 + half]!;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={stars === value}
                  aria-label={`${value} of 5 stars`}
                  class={halfClass(value, half)}
                  disabled={loading || saving}
                  onClick={() => selectHalf(value)}
                  ref={(el) => {
                    if (el) {
                      halfRefs.current.set(value, el);
                    } else {
                      halfRefs.current.delete(value);
                    }
                  }}
                >
                  <span class="rating-half-glyph" aria-hidden="true">
                    ★
                  </span>
                </button>
              );
            })}
          </span>
        ))}
      </div>

      <div class="rating-note-row">
        <label class="rating-note-label" for={noteId}>
          Note
        </label>
        <span class="rating-counter" id={counterId}>
          {formatNoteCounter(note)}
        </span>
      </div>
      <textarea
        id={noteId}
        class="rating-note"
        rows={3}
        value={note}
        disabled={loading || saving}
        placeholder="What did you think?"
        aria-describedby={counterId}
        onInput={handleNoteInput}
      />

      {validationErrors.length > 0 && (
        <ul class="rating-error" role="alert">
          {validationErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {serverError !== null && (
        <p class="rating-error" role="alert">
          Couldn&apos;t save: {serverError}
        </p>
      )}
      {saved && (
        <p class="rating-saved" role="status">
          Saved
        </p>
      )}

      <div class="rating-actions">
        <button
          type="button"
          class="rating-save"
          disabled={loading || saving}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {onCancel && (
          <button
            type="button"
            class="rating-cancel"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
