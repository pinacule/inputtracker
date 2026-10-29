import { useEffect, useState } from "preact/hooks";
import {
  lookupSearch,
  type Category,
  type LibraryWorkDetail,
  type LookupHit,
  type MetaProvider,
  type WorkEdit,
  type WorkStatus,
} from "../api";
import { CATEGORIES, CATEGORY_META, categoryLabel, timesLabel } from "../lib/categories";
import { validateRating10 } from "../lib/rating";
import { performWorkEdit, pushToast } from "../lib/work-edits";
import { COMMON_YOUTUBE_TOPICS } from "../lib/youtube";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Cover } from "./Cover";
import { CategoryIcon, CheckIcon, SearchIcon, TrashIcon } from "./icons";
import { RatingInput10 } from "./QuickRating";
import { Sheet } from "./Sheet";

export interface EditableWorkTarget {
  key: string;
  title: string;
  category: Category;
  status?: WorkStatus;
  rating?: number | null;
  note?: string | null;
  topic?: string | null;
  times?: number | null;
  channel?: string | null;
  cover_url?: string | null;
  edited?: boolean;
}

export interface EditWorkSheetProps {
  open: boolean;
  work: EditableWorkTarget | null;
  onClose: () => void;
  onSaved?: (detail: LibraryWorkDetail | null, edit: WorkEdit) => void;
}

const STATUS_CHOICES: ReadonlyArray<{ value: WorkStatus; label: string }> = [
  { value: "finished", label: "Finished" },
  { value: "in_progress", label: "In progress" },
  { value: "planned", label: "Planned (Watchlist)" },
  { value: "dropped", label: "Dropped" },
  { value: "unknown", label: "Logged" },
];

export function EditWorkSheet({
  open,
  work,
  onClose,
  onSaved,
}: EditWorkSheetProps) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>("other");
  const [status, setStatus] = useState<WorkStatus>("finished");
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [topic, setTopic] = useState("");
  const [times, setTimes] = useState("");
  const [selectedMeta, setSelectedMeta] = useState<{
    provider: MetaProvider;
    provider_id: string;
    title: string;
    cover_url: string | null;
  } | null>(null);
  const [clearMeta, setClearMeta] = useState(false);

  // Metadata lookup picker state
  const [showMetaPicker, setShowMetaPicker] = useState(false);
  const [metaQuery, setMetaQuery] = useState("");
  const [metaResults, setMetaResults] = useState<LookupHit[] | null>(null);
  const [metaSearching, setMetaSearching] = useState(false);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (work && open) {
      setTitle(work.title);
      setCategory(work.category);
      setStatus(work.status ?? "finished");
      setRating(work.rating ?? null);
      setNote(work.note ?? "");
      setTopic(work.topic ?? "");
      setTimes(work.times != null ? String(work.times) : "");
      setSelectedMeta(null);
      setClearMeta(false);
      setShowMetaPicker(false);
      setMetaQuery(work.title);
      setMetaResults(null);
      setErrors([]);
    }
  }, [work, open]);

  if (!open || !work) {
    return null;
  }

  const runMetaSearch = async () => {
    const q = metaQuery.trim();
    if (q.length < 2) return;
    setMetaSearching(true);
    try {
      const res = await lookupSearch(q, category);
      setMetaResults(res.results ?? []);
    } catch {
      setMetaResults([]);
    } finally {
      setMetaSearching(false);
    }
  };

  const handleSave = async (e: Event) => {
    e.preventDefault();
    const errs: string[] = [];
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      errs.push("Title cannot be empty.");
    }
    const rCheck =
      category !== "music"
        ? validateRating10(rating)
        : { ok: true as const, rating: null };
    if (!rCheck.ok) {
      errs.push(rCheck.error);
    }
    const timesValue = times.trim() === "" ? null : Number(times.trim());
    if (timesValue !== null && (!Number.isInteger(timesValue) || timesValue < 0 || timesValue > 999)) {
      errs.push(`${timesLabel(category)} must be a whole number from 0 to 999.`);
    }
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }

    const editPayload: WorkEdit = {
      title: trimmedTitle,
      category,
      status,
      ...(category !== "music"
        ? { rating: rCheck.ok ? rCheck.rating : null }
        : {}),
      note: note.trim() ? note.trim() : null,
      times: timesValue,
    };

    if (category === "youtube" || work.channel || topic.trim() !== "") {
      editPayload.topic = topic.trim() || null;
    }

    if (selectedMeta) {
      editPayload.meta = {
        provider: selectedMeta.provider,
        provider_id: selectedMeta.provider_id,
      };
    } else if (clearMeta) {
      editPayload.meta = null;
    }

    setSaving(true);
    try {
      const { detail, undo } = await performWorkEdit(work.key, editPayload, {
        title: work.title,
        category: work.category,
        status: work.status,
        rating: work.rating,
        note: work.note,
        topic: work.topic,
        times: work.times ?? null,
        cover_url: selectedMeta?.cover_url ?? work.cover_url,
      });

      onSaved?.(detail, editPayload);
      onClose();

      pushToast({
        message: `Updated “${trimmedTitle}”`,
        variant: "success",
        actionLabel: "Undo",
        onAction: () => {
          void undo();
        },
      });
    } finally {
      setSaving(false);
    }
  };

  const handleHideWork = async () => {
    setSaving(true);
    try {
      const { detail, undo } = await performWorkEdit(
        work.key,
        { hidden: true },
        {
          title: work.title,
          category: work.category,
          status: work.status,
          rating: work.rating,
          cover_url: work.cover_url,
        }
      );
      onSaved?.(detail, { hidden: true });
      onClose();
      pushToast({
        message: `Hidden “${work.title}” (restore anytime in Settings)`,
        variant: "info",
        actionLabel: "Undo",
        onAction: () => {
          void undo();
        },
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResetOverrides = async () => {
    setSaving(true);
    try {
      const resetEdit: WorkEdit = {
        title: null,
        category: null,
        status: null,
        topic: null,
      };
      const { detail, undo } = await performWorkEdit(work.key, resetEdit, {
        title: work.title,
        category: work.category,
        status: work.status,
      });
      onSaved?.(detail, resetEdit);
      onClose();
      pushToast({
        message: `Reset overrides for “${work.title}”`,
        variant: "info",
        actionLabel: "Undo",
        onAction: () => {
          void undo();
        },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={`Edit Work — ${work.title}`}
      subtitle="Overrides are stored append-only; source history rows never change"
    >
      <form class="ui-form-stack" onSubmit={(e) => void handleSave(e)}>
        {/* Title & Category */}
        <div class="ui-form-grid-2">
          <div class="ui-form-field">
            <label class="ui-form-label" for="edit-work-title">
              Title
            </label>
            <input
              id="edit-work-title"
              type="text"
              class="ui-input"
              required
              value={title}
              onInput={(e) =>
                setTitle((e.currentTarget as HTMLInputElement).value)
              }
            />
          </div>

          <div class="ui-form-field">
            <label class="ui-form-label" for="edit-work-category">
              Category
            </label>
            <select
              id="edit-work-category"
              class="ui-input"
              value={category}
              onChange={(e) =>
                setCategory(
                  (e.currentTarget as HTMLSelectElement).value as Category
                )
              }
            >
              {CATEGORIES.filter((cat) => cat !== "shortform").map((cat) => (
                <option key={cat} value={cat}>
                  {CATEGORY_META[cat].pluralLabel}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Status */}
        <div class="ui-form-field">
          <span class="ui-form-label">Status</span>
          <div class="ui-cat-chips" role="group" aria-label="Work status">
            {STATUS_CHOICES.map((opt) => {
              const active = status === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  class={
                    active
                      ? "ui-cat-chip ui-cat-chip--active"
                      : "ui-cat-chip"
                  }
                  aria-pressed={active}
                  onClick={() => setStatus(opt.value)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Topic (for YouTube works) */}
        {(category === "youtube" || Boolean(work.channel)) && (
          <div class="ui-form-field">
            <label class="ui-form-label" for="edit-work-topic">
              YouTube Topic
            </label>
            <input
              id="edit-work-topic"
              type="text"
              class="ui-input"
              list="edit-work-topic-suggestions"
              placeholder="e.g. Science & Technology, History, Essays…"
              value={topic}
              onInput={(e) =>
                setTopic((e.currentTarget as HTMLInputElement).value)
              }
            />
            <datalist id="edit-work-topic-suggestions">
              {COMMON_YOUTUBE_TOPICS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
        )}

        {/* Rating 0..10 one decimal (hidden for music) */}
        {category !== "music" && (
          <div class="ui-form-field">
            <span class="ui-form-label">Rating (0–10, one decimal)</span>
            <RatingInput10
              rating={rating}
              onChange={setRating}
              category={category}
            />
          </div>
        )}

        <div class="ui-form-field">
          <label class="ui-form-label" for="edit-work-times">
            {timesLabel(category)}
          </label>
          <input
            id="edit-work-times"
            type="number"
            class="ui-input tabular-nums"
            min="0"
            max="999"
            step="1"
            inputMode="numeric"
            placeholder="Not set"
            value={times}
            onInput={(e) => setTimes((e.currentTarget as HTMLInputElement).value)}
          />
        </div>

        {/* Personal Note */}
        <div class="ui-form-field">
          <label class="ui-form-label" for="edit-work-note">
            Personal Note
          </label>
          <textarea
            id="edit-work-note"
            class="ui-input ui-textarea"
            rows={3}
            placeholder="Reflections, favourite moments, or who recommended it…"
            value={note}
            onInput={(e) =>
              setNote((e.currentTarget as HTMLTextAreaElement).value)
            }
          />
        </div>

        {/* Metadata Match Link Picker */}
        <div class="ui-form-field">
          <div class="settings-row-between">
            <div>
              <span class="ui-form-label">Metadata Match (Cover, Seasons & Runtime)</span>
              <p class="ui-form-hint">
                Link this work to AniList, TVmaze, Cinemeta, Open Library, or TMDB.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowMetaPicker((v) => !v);
                if (!showMetaPicker && !metaResults && metaQuery.trim().length >= 2) {
                  void runMetaSearch();
                }
              }}
            >
              {showMetaPicker ? "Hide Search" : "Link Metadata Match…"}
            </Button>
          </div>

          {selectedMeta && (
            <div class="add-saved-banner">
              <div class="add-saved-banner-info">
                <CheckIcon size={16} />
                <span>
                  Linked to <strong>{selectedMeta.title}</strong> (
                  {selectedMeta.provider}:{selectedMeta.provider_id})
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedMeta(null)}
              >
                Change
              </Button>
            </div>
          )}

          {showMetaPicker && (
            <div class="ui-meta-picker-box">
              <div class="add-lookup-input-wrap">
                <span class="add-lookup-icon" aria-hidden="true">
                  <SearchIcon size={16} />
                </span>
                <input
                  type="search"
                  class="ui-input add-lookup-input"
                  placeholder="Search metadata provider…"
                  aria-label="Search metadata match"
                  value={metaQuery}
                  onInput={(e) =>
                    setMetaQuery((e.currentTarget as HTMLInputElement).value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void runMetaSearch();
                    }
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={metaSearching}
                  onClick={() => void runMetaSearch()}
                >
                  {metaSearching ? "Searching…" : "Search"}
                </Button>
              </div>

              {metaResults && metaResults.length > 0 && (
                <ul class="add-lookup-results" aria-label="Metadata match results">
                  {metaResults.slice(0, 8).map((hit) => (
                    <li key={`${hit.provider}:${hit.provider_id}`}>
                      <button
                        type="button"
                        class="add-lookup-hit"
                        onClick={() => {
                          setSelectedMeta({
                            provider: hit.provider,
                            provider_id: hit.provider_id,
                            title: hit.title,
                            cover_url: hit.cover_url,
                          });
                          setClearMeta(false);
                          setShowMetaPicker(false);
                        }}
                      >
                        <Cover
                          src={hit.cover_url}
                          title={hit.title}
                          category={hit.category}
                          size="sm"
                          aspect="poster"
                        />
                        <div class="add-lookup-hit-body">
                          <div class="add-lookup-hit-title">{hit.title}</div>
                          <div class="add-lookup-hit-meta">
                            <Badge
                              size="sm"
                              category={hit.category}
                              icon={
                                <CategoryIcon category={hit.category} size={11} />
                              }
                            >
                              {categoryLabel(hit.category)}
                            </Badge>
                            <Badge size="sm" variant="neutral">
                              {hit.provider}
                            </Badge>
                            {hit.subtitle ? (
                              <span>{hit.subtitle}</span>
                            ) : hit.year ? (
                              <span>{hit.year}</span>
                            ) : null}
                          </div>
                        </div>
                        <span class="add-lookup-hit-action">Link →</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {metaResults && metaResults.length === 0 && !metaSearching && (
                <p class="ui-text-muted">No provider matches found.</p>
              )}
            </div>
          )}
        </div>

        {errors.length > 0 && (
          <ul class="ui-form-error-list" role="alert">
            {errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}

        <div class="settings-row-between edit-work-footer">
          <div class="ui-form-actions">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          </div>

          <div class="ui-form-actions">
            {work.edited && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleResetOverrides()}
                disabled={saving}
              >
                Reset Overrides
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              leadingIcon={<TrashIcon size={14} />}
              onClick={() => void handleHideWork()}
              disabled={saving}
            >
              Hide Work
            </Button>
          </div>
        </div>
      </form>
    </Sheet>
  );
}
