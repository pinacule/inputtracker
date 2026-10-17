import { useEffect, useState } from "preact/hooks";
import {
  getProgress,
  type Annotation,
  type ProgressItem,
  type ProgressLists,
} from "../api";
import { RatingEditor } from "../components/RatingEditor";
import { formatStarValue, ratingToStars } from "../lib/annotations";
import { sourceIcon } from "../lib/calendar";
import { sourceLabel } from "../lib/sources";
import { DEFAULT_TIMEZONE, formatDateTime } from "../lib/format-date";

/** All dates are stored UTC and shown in the configured local timezone. */
function formatTimestamp(iso: string | null): string {
  if (iso === null || iso === "") {
    return "—";
  }
  const formatted = formatDateTime(iso, DEFAULT_TIMEZONE);
  // `formatDateTime` returns its input unchanged for invalid input.
  return formatted === iso ? "—" : formatted;
}

function formatPercent(progress: number | null): string {
  if (progress === null) {
    return "—";
  }
  const clamped = Math.min(1, Math.max(0, progress));
  return `${Math.round(clamped * 100)}%`;
}

/** Cover thumbnail with a source-icon fallback when missing or broken. */
function ProgressThumbnail({ item }: { item: ProgressItem }) {
  const [failed, setFailed] = useState(false);

  if (item.cover_url && !failed) {
    return (
      <img
        class="progress-item-cover"
        src={item.cover_url}
        alt=""
        width={48}
        height={48}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span class="progress-item-icon-badge" aria-hidden="true">
      {sourceIcon(item.source)}
    </span>
  );
}

function ProgressBar({ progress }: { progress: number | null }) {
  const ratio = progress === null ? 0 : Math.min(1, Math.max(0, progress));
  const pct = Math.round(ratio * 100);
  return (
    <div
      class="progress-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={`${pct}% complete`}
    >
      <div class="progress-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function ProgressRow({
  item,
  onAnnotationSaved,
}: {
  item: ProgressItem;
  onAnnotationSaved: (itemId: number, annotation: Annotation) => void;
}) {
  const title = item.title?.trim() || "Untitled";
  const dateLabel = item.is_finished
    ? `Finished ${formatTimestamp(item.finished_at ?? item.last_update)}`
    : `Updated ${formatTimestamp(item.last_update)}`;
  const [editorOpen, setEditorOpen] = useState(false);
  const stars = ratingToStars(item.rating);

  return (
    <li class="progress-item">
      <ProgressThumbnail item={item} />
      <div class="progress-item-body">
        {item.parent_title && (
          <div class="progress-item-parent">{item.parent_title}</div>
        )}
        <div class="progress-item-title">{title}</div>
        {!item.is_finished && (
          <div class="progress-item-progress">
            <ProgressBar progress={item.progress} />
            <span class="progress-item-percent">
              {formatPercent(item.progress)}
            </span>
          </div>
        )}
        <div class="progress-item-meta">
          <span class="progress-item-source">
            {sourceLabel(item.source)}
          </span>
          <span class="progress-item-bullet">·</span>
          <span class="progress-item-date">{dateLabel}</span>
          {stars !== null && (
            <>
              <span class="progress-item-bullet">·</span>
              <span class="rating-badge" aria-label={`Rated ${stars} of 5 stars`}>
                <span class="rating-badge-star" aria-hidden="true">★</span>
                {formatStarValue(stars)}
              </span>
            </>
          )}
          <span class="progress-item-bullet">·</span>
          <button
            type="button"
            class="progress-rate-button"
            aria-expanded={editorOpen}
            onClick={() => setEditorOpen((open) => !open)}
          >
            {editorOpen ? "Close" : "Rate"}
          </button>
        </div>
        {editorOpen && (
          <RatingEditor
            source={item.source}
            title={item.group_title}
            initialRating={item.rating}
            onSaved={(annotation) => {
              onAnnotationSaved(item.id, annotation);
              setEditorOpen(false);
            }}
            onCancel={() => setEditorOpen(false)}
          />
        )}
      </div>
    </li>
  );
}

export function Progress() {
  const [data, setData] = useState<ProgressLists | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getProgress()
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const inProgress = data?.in_progress ?? [];
  const finished = data?.finished ?? [];

  function handleAnnotationSaved(itemId: number, annotation: Annotation): void {
    setData((prev) => {
      if (prev === null) {
        return prev;
      }
      const update = (item: ProgressItem): ProgressItem =>
        item.id === itemId ? { ...item, rating: annotation.rating } : item;
      return {
        in_progress: prev.in_progress.map(update),
        finished: prev.finished.map(update),
      };
    });
  }

  return (
    <section class="page progress-page">
      <header class="progress-header">
        <h1>Progress</h1>
        <p class="muted">
          Items you are part-way through, and what you have finished.
        </p>
        <a class="search-header-link" href="#/search">
          🔍 Search
        </a>
      </header>

      {error && (
        <div class="alert alert-error" role="alert">
          <strong>Error loading progress:</strong> {error}
        </div>
      )}

      <section
        class="card progress-section"
        aria-labelledby="progress-in-progress-heading"
      >
        <h2 id="progress-in-progress-heading" class="card-title">
          In progress
          <span class="progress-count">{inProgress.length}</span>
        </h2>
        {loading ? (
          <p class="muted progress-empty">Loading…</p>
        ) : inProgress.length === 0 ? (
          <p class="muted progress-empty">Nothing in progress.</p>
        ) : (
          <ul class="progress-list">
            {inProgress.map((item) => (
              <ProgressRow
                key={item.id}
                item={item}
                onAnnotationSaved={handleAnnotationSaved}
              />
            ))}
          </ul>
        )}
      </section>

      <section
        class="card progress-section"
        aria-labelledby="progress-finished-heading"
      >
        <h2 id="progress-finished-heading" class="card-title">
          Finished
          <span class="progress-count">{finished.length}</span>
        </h2>
        {loading ? (
          <p class="muted progress-empty">Loading…</p>
        ) : finished.length === 0 ? (
          <p class="muted progress-empty">Nothing finished yet.</p>
        ) : (
          <ul class="progress-list">
            {finished.map((item) => (
              <ProgressRow
                key={item.id}
                item={item}
                onAnnotationSaved={handleAnnotationSaved}
              />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
