import { useEffect, useId, useRef, useState } from "preact/hooks";
import { getAnnotation, saveAnnotation, type Annotation } from "../api";
import {
  formatNoteCounter,
  isNoteTooLong,
} from "../lib/annotations";
import { formatRating10, validateRating10 } from "../lib/rating";
import { performWorkEdit, pushToast } from "../lib/work-edits";
import { Button } from "./Button";
import { RatingInput10 } from "./QuickRating";

export interface StarRatingInputProps {
  rating: number | null;
  onChange: (rating: number | null) => void;
  disabled?: boolean;
}

/**
 * 0–10 one-decimal rating picker (replaces the old 5-star editor in v2.1).
 */
export function StarRatingInput({
  rating,
  onChange,
  disabled = false,
}: StarRatingInputProps) {
  return (
    <RatingInput10 rating={rating} onChange={onChange} disabled={disabled} />
  );
}

export interface RatingEditorProps {
  workKey?: string;
  source: string;
  title: string;
  initialRating: number | null;
  initialNote?: string | null;
  skipFetch?: boolean;
  onSaved?: (annotation: { rating: number | null; note: string | null } & Partial<Annotation>) => void;
  onCancel?: () => void;
}

/**
 * Full Rating (0..10 one decimal) + Note editor wired to `/api/library/work/edit`
 * (and falling back to `/api/annotations` when `workKey` is omitted or 404).
 */
export function RatingEditor({
  workKey,
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
  const [loading, setLoading] = useState(!skipFetch && !workKey);
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
    if (skipFetch || workKey) {
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
  }, [source, title, skipFetch, workKey]);

  async function handleSave(): Promise<void> {
    const errors: string[] = [];
    const rCheck = validateRating10(rating);
    if (!rCheck.ok) {
      errors.push(rCheck.error);
    }
    if (isNoteTooLong(note)) {
      errors.push("Note is too long (maximum 5000 characters).");
    }
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }

    const cleanRating = rCheck.ok ? rCheck.rating : null;
    const cleanNote = note.trimEnd().length > 0 ? note.trimEnd() : null;

    setValidationErrors([]);
    setServerError(null);
    setSaved(false);
    setSaving(true);

    try {
      const targetKey = workKey ?? `${source}:${title.toLowerCase().trim()}`;
      const { undo } = await performWorkEdit(
        targetKey,
        {
          rating: cleanRating,
          note: cleanNote,
        },
        {
          title,
          rating: initialRating,
          note: initialNote ?? null,
          source,
        }
      );

      if (!workKey) {
        if (revIdRef.current === null) {
          revIdRef.current = crypto.randomUUID();
        }
        const intRating =
          cleanRating !== null
            ? Math.max(1, Math.min(10, Math.round(cleanRating)))
            : null;
        await saveAnnotation({
          source,
          title,
          rating: intRating,
          note: cleanNote,
          rev_id: revIdRef.current,
        }).catch(() => null);
        revIdRef.current = null;
      }

      setRating(cleanRating);
      setNote(cleanNote ?? "");
      setSaved(true);
      onSaved?.({ rating: cleanRating, note: cleanNote });

      pushToast({
        message:
          cleanRating !== null
            ? `Saved rating (${formatRating10(cleanRating)} / 10) for “${title}”`
            : `Updated note for “${title}”`,
        variant: "success",
        actionLabel: "Undo",
        onAction: () => {
          setRating(initialRating);
          setNote(initialNote ?? "");
          onSaved?.({ rating: initialRating, note: initialNote ?? null });
          void undo();
        },
      });
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

      <RatingInput10
        rating={rating}
        onChange={(next) => {
          setRating(next);
          setSaved(false);
          setServerError(null);
        }}
        disabled={loading || saving}
        onCommit={() => void handleSave()}
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
          onClick={() => void handleSave()}
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
