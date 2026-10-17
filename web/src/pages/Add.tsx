import { useState } from "preact/hooks";
import { addEvent } from "../api";
import {
  buildEventInput,
  MEDIA_TYPE_OPTIONS,
  type AddFormState,
} from "../lib/forms";

const INITIAL_FORM: AddFormState = {
  media_type: "movie",
  title: "",
  parent_title: "",
  season: "",
  episode: "",
  started_at: "",
  duration_min: "",
  ended_at: "",
};

export function Add() {
  const [form, setForm] = useState<AddFormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update =
    (field: keyof AddFormState) =>
    (event: Event) => {
      const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
      setForm((prev) => ({ ...prev, [field]: value }));
    };

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    setErrors([]);
    setSuccess(null);
    setServerError(null);

    const built = buildEventInput(form);
    if (built.input === null) {
      setErrors(built.errors);
      return;
    }

    setSubmitting(true);
    try {
      const result = await addEvent(built.input);
      setSuccess(
        result.inserted === 1
          ? `Added "${built.input.title}"`
          : `Already recorded: "${built.input.title}"`
      );
      setForm(INITIAL_FORM);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section class="page stack">
      <h1>Add</h1>
      <p class="muted">Manually record something you watched, read or listened to.</p>

      <form class="card" onSubmit={handleSubmit} noValidate>
        <div class="form-field">
          <label class="form-label" for="add-media-type">
            Media type
          </label>
          <select
            id="add-media-type"
            class="form-select"
            value={form.media_type}
            onChange={update("media_type")}
            required
          >
            {MEDIA_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div class="form-field">
          <label class="form-label" for="add-title">
            Title
          </label>
          <input
            id="add-title"
            class="form-input"
            type="text"
            value={form.title}
            onInput={update("title")}
            required
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="add-parent-title">
            Parent title (optional)
          </label>
          <input
            id="add-parent-title"
            class="form-input"
            type="text"
            value={form.parent_title}
            onInput={update("parent_title")}
          />
        </div>

        <div class="form-grid">
          <div class="form-field">
            <label class="form-label" for="add-season">
              Season (optional)
            </label>
            <input
              id="add-season"
              class="form-input"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={form.season}
              onInput={update("season")}
            />
          </div>

          <div class="form-field">
            <label class="form-label" for="add-episode">
              Episode (optional)
            </label>
            <input
              id="add-episode"
              class="form-input"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={form.episode}
              onInput={update("episode")}
            />
          </div>
        </div>

        <div class="form-field">
          <label class="form-label" for="add-started-at">
            Started at
          </label>
          <input
            id="add-started-at"
            class="form-input"
            type="datetime-local"
            value={form.started_at}
            onInput={update("started_at")}
            required
          />
          <span class="form-hint">Local time in the configured timezone.</span>
        </div>

        <div class="form-field">
          <label class="form-label" for="add-duration">
            Duration (minutes, optional)
          </label>
          <input
            id="add-duration"
            class="form-input"
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={form.duration_min}
            onInput={update("duration_min")}
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="add-ended-at">
            Ended at (optional)
          </label>
          <input
            id="add-ended-at"
            class="form-input"
            type="datetime-local"
            value={form.ended_at}
            onInput={update("ended_at")}
          />
        </div>

        {errors.length > 0 && (
          <ul class="error-list" role="alert">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}

        {serverError && (
          <p class="alert alert-error" role="alert">
            {serverError}
          </p>
        )}

        {success && (
          <p class="alert alert-success" role="status">
            {success}
          </p>
        )}

        <button type="submit" class="btn btn-primary" disabled={submitting}>
          {submitting ? "Adding…" : "Add"}
        </button>
      </form>
    </section>
  );
}
