import { useEffect, useState } from "preact/hooks";
import { addEvent, type ManualEventInput } from "../api";
import {
  buildEventInput,
  MEDIA_TYPE_OPTIONS,
  type AddFormState,
} from "../lib/forms";
import {
  classifySendError,
  enqueueEntry,
  flushQueue,
  getDefaultStore,
  newClientId,
  putQueuedEntry,
  removeQueuedEntry,
  subscribeQueue,
  type QueuedEntry,
} from "../lib/offline-queue";

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

const QUEUED_NOTICE =
  "Saved on this phone — it will be sent when the server is reachable.";

const COULD_NOT_SAVE_OFFLINE =
  "This entry could not be saved offline (storage is unavailable), so nothing was kept. Try again when the server is reachable.";

/** Form state for re-editing a queued entry's body. */
function formStateFromBody(body: ManualEventInput): AddFormState {
  return {
    media_type: body.media_type,
    title: body.title,
    parent_title: body.parent_title ?? "",
    season:
      body.season === null || body.season === undefined ? "" : String(body.season),
    episode:
      body.episode === null || body.episode === undefined
        ? ""
        : String(body.episode),
    started_at: body.started_at,
    duration_min:
      body.duration_seconds === null || body.duration_seconds === undefined
        ? ""
        : String(body.duration_seconds / 60),
    ended_at: body.ended_at ?? "",
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function Add() {
  const [form, setForm] = useState<AddFormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [queue, setQueue] = useState<QueuedEntry[]>([]);
  const [editingEntry, setEditingEntry] = useState<QueuedEntry | null>(null);
  const [sendingAll, setSendingAll] = useState(false);

  // Live view of the unsent entries on this phone.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const store = await getDefaultStore();
      if (store === null || cancelled) {
        return;
      }
      const entries = await store.list();
      if (!cancelled) {
        setQueue(entries);
      }
    };
    void refresh();
    const unsubscribe = subscribeQueue(() => void refresh());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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
    setQueueNotice(null);

    const built = buildEventInput(form);
    if (built.input === null) {
      setErrors(built.errors);
      return;
    }

    const editing = editingEntry;
    // A fresh submit gets a new id; an edited waiting entry keeps its old one,
    // so replacing it can never duplicate the row on the server.
    const body: ManualEventInput = {
      ...built.input,
      client_id: editing !== null ? editing.client_id : newClientId(),
    };

    setSubmitting(true);
    try {
      const store = await getDefaultStore();

      const queueIt = async (failedAttempt: unknown | null) => {
        if (store === null) {
          setServerError(COULD_NOT_SAVE_OFFLINE);
          return;
        }
        const attempted = failedAttempt !== null;
        if (editing !== null) {
          await putQueuedEntry(store, {
            ...editing,
            body,
            attempts: attempted ? 1 : 0,
            last_attempt_at: attempted ? new Date().toISOString() : null,
            last_error: attempted ? errorMessage(failedAttempt) : null,
            status: "pending",
          });
        } else {
          await enqueueEntry(store, body, {
            attempts: attempted ? 1 : 0,
            lastError: attempted ? errorMessage(failedAttempt) : null,
            lastAttemptAt: attempted ? new Date().toISOString() : null,
          });
        }
        setQueueNotice(QUEUED_NOTICE);
        setForm(INITIAL_FORM);
        setEditingEntry(null);
      };

      if (navigator.onLine === false) {
        await queueIt(null);
        return;
      }

      try {
        const result = await addEvent(body);
        if (editing !== null && store !== null) {
          await removeQueuedEntry(store, editing.client_id);
        }
        setSuccess(
          result.inserted === 1
            ? `Added "${body.title}"`
            : `Already recorded: "${body.title}"`
        );
        setForm(INITIAL_FORM);
        setEditingEntry(null);
      } catch (err) {
        if (classifySendError(err) === "rejected") {
          // The server answered and refused the entry: show its message and
          // leave the form filled so it can be fixed.
          setServerError(errorMessage(err));
          if (editing !== null && store !== null) {
            await putQueuedEntry(store, {
              ...editing,
              body,
              attempts: editing.attempts + 1,
              last_attempt_at: new Date().toISOString(),
              last_error: errorMessage(err),
              status: "rejected",
            });
          }
          return;
        }
        // Network failure or timeout: keep the entry on this phone.
        await queueIt(err);
      }
    } catch (err) {
      // Queue storage itself failed: never pretend the entry was kept.
      setServerError(`${COULD_NOT_SAVE_OFFLINE} (${errorMessage(err)})`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendNow = async () => {
    setSendingAll(true);
    try {
      const store = await getDefaultStore();
      if (store !== null) {
        await flushQueue(store, (queuedBody) => addEvent(queuedBody));
      }
    } catch {
      // Per-entry errors are recorded on the entries; a storage failure here
      // is retried by the next trigger.
    } finally {
      setSendingAll(false);
    }
  };

  const handleEdit = (entry: QueuedEntry) => {
    setEditingEntry(entry);
    setForm(formStateFromBody(entry.body));
    setSuccess(null);
    setServerError(null);
    setQueueNotice(null);
  };

  const cancelEdit = () => {
    setEditingEntry(null);
    setForm(INITIAL_FORM);
  };

  const handleRemove = async (entry: QueuedEntry) => {
    if (
      !confirm(
        "Remove this waiting entry? Only the unsent copy on this phone is deleted."
      )
    ) {
      return;
    }
    const store = await getDefaultStore();
    if (store !== null) {
      await removeQueuedEntry(store, entry.client_id);
    }
    if (editingEntry?.client_id === entry.client_id) {
      setEditingEntry(null);
    }
  };

  return (
    <section class="page stack">
      <h1>Add</h1>
      <p class="muted">Manually record something you watched, read or listened to.</p>

      {queue.length > 0 && (
        <section class="card queue-card" aria-label="Entries waiting to send">
          <div class="queue-header">
            <h2 class="card-title">Waiting to send ({queue.length})</h2>
            <button
              type="button"
              class="btn btn-secondary queue-btn"
              onClick={handleSendNow}
              disabled={sendingAll}
            >
              {sendingAll ? "Sending…" : "Send now"}
            </button>
          </div>
          <ul class="queue-list">
            {queue.map((entry) => (
              <li key={entry.client_id} class="queue-item">
                <div class="queue-item-main">
                  <span class="queue-item-title">{entry.body.title}</span>
                  <span class="queue-item-meta">
                    {entry.status === "rejected"
                      ? "Rejected — needs fixing"
                      : "Waiting to send"}{" "}
                    · started {entry.body.started_at}
                  </span>
                  {entry.last_error !== null && (
                    <span class="queue-item-error">
                      {entry.attempts > 0 ? `Attempt ${entry.attempts}: ` : ""}
                      {entry.last_error}
                    </span>
                  )}
                </div>
                <div class="queue-item-actions">
                  {entry.status === "rejected" && (
                    <button
                      type="button"
                      class="btn btn-secondary queue-btn"
                      onClick={() => handleEdit(entry)}
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    class="btn btn-secondary queue-btn"
                    onClick={() => handleRemove(entry)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p class="form-hint">
            These entries are only on this phone; the server has not recorded
            them yet. Removing one changes nothing on the server.
          </p>
        </section>
      )}

      <form class="card" onSubmit={handleSubmit} noValidate>
        {editingEntry !== null && (
          <div class="queue-editing-note" role="status">
            <span>
              Editing the waiting entry “{editingEntry.body.title}”. Submitting
              updates it.
            </span>
            <button
              type="button"
              class="btn btn-secondary queue-btn"
              onClick={cancelEdit}
            >
              Cancel
            </button>
          </div>
        )}

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

        {queueNotice && (
          <p class="alert alert-success" role="status">
            {queueNotice}
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
