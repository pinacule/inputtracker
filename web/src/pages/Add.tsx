import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  addEvent,
  lookupSearch,
  lookupWork,
  saveArchiveEntry,
  type ArchiveConsumed,
  type ArchiveRequest,
  type ArchiveResult,
  type ArchiveWhen,
  type Category,
  type DatePrecision,
  type LookupHit,
  type ManualEventInput,
  type ManualWork,
  type MetaProvider,
  type WorkDetails,
} from "../api";
import {
  buildArchiveRequest,
  buildManualWork,
  computeArchivePreview,
  type ManualWorkDraft,
} from "../lib/archive-form";
import {
  CATEGORIES,
  CATEGORY_META,
  categoryLabel,
  categoryPluralLabel,
} from "../lib/categories";
import {
  MEDIA_TYPE_OPTIONS,
  buildEventInput,
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
import { formatMinutes } from "../lib/stats";
import {
  Badge,
  Button,
  Card,
  CategoryIcon,
  CheckIcon,
  Cover,
  EmptyState,
  RatingInput10,
  SearchIcon,
  Skeleton,
  Tabs,
  type TabOption,
} from "../ui";

export interface AddProps {
  /** Initial search query (`#/add?q=...`). */
  initialQuery?: string;
  /** Initial category filter (`#/add?category=...`). */
  initialCategory?: Category;
  /** Initial date for `when` (`#/add?date=YYYY-MM-DD`). */
  initialDate?: string;
  /** Pre-selected work (e.g. from "Add more seasons" on a Work page). */
  initialWork?: WorkDetails | ManualWork | null;
  /** Pre-loaded archive entry to edit (`entry_id` reused on save). */
  editingArchiveEntry?: ArchiveRequest | null;
  /** Compact mode when rendered inside a desktop Sheet dialog. */
  inSheet?: boolean;
  /** Called after an archive entry is saved. */
  onSavedArchive?: (result: ArchiveResult, request: ArchiveRequest) => void;
  /** Optional status note for offline queue. */
  queryNote?: string;
}

type AddTabMode = "archive" | "quick";

const LOOKUP_CATEGORIES: ReadonlyArray<TabOption<Category | "any">> = [
  { value: "any", label: "All" },
  { value: "anime", label: "Anime", category: "anime" },
  { value: "series", label: "Series", category: "series" },
  { value: "film", label: "Films", category: "film" },
  { value: "book", label: "Books", category: "book" },
  { value: "audiobook", label: "Audiobooks", category: "audiobook" },
];

const PRECISION_TABS: ReadonlyArray<TabOption<DatePrecision>> = [
  { value: "day", label: "Exact day" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
  { value: "unknown", label: "Don't know" },
];

const INITIAL_QUICK_FORM: AddFormState = {
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
  "Saved on this device — it will be sent automatically when the server is reachable.";

const COULD_NOT_SAVE_OFFLINE =
  "This entry could not be saved offline (storage is unavailable). Try again when connected.";

function getTodayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function defaultConsumedForWork(work: WorkDetails | ManualWork): ArchiveConsumed {
  if (
    (work.category === "anime" || work.category === "series") &&
    work.seasons.length > 0
  ) {
    // Default to Season 1 selected (or all seasons if ≤ 2)
    const defaultSeasons =
      work.seasons.length <= 2
        ? work.seasons.map((s) => ({ number: s.number }))
        : [{ number: work.seasons[0]!.number }];
    return { seasons: defaultSeasons };
  }
  if (
    work.category === "film" ||
    work.category === "anime" ||
    work.category === "series"
  ) {
    return { times: 1 };
  }
  return { progress: 1 };
}

function formStateFromBody(body: ManualEventInput): AddFormState {
  return {
    media_type: body.media_type,
    title: body.title,
    parent_title: body.parent_title ?? "",
    season:
      body.season === null || body.season === undefined
        ? ""
        : String(body.season),
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

export function Add({
  initialQuery = "",
  initialCategory,
  initialDate,
  initialWork = null,
  editingArchiveEntry = null,
  inSheet = false,
  onSavedArchive,
}: AddProps) {
  const todayStr = getTodayStr();
  const [tabMode, setTabMode] = useState<AddTabMode>("archive");

  // --- Archive Lookup State ---
  const [searchInput, setSearchInput] = useState(initialQuery);
  const [lookupCat, setLookupCat] = useState<Category | "any">(
    initialCategory ?? "any"
  );
  const [lookupResults, setLookupResults] = useState<LookupHit[] | null>(null);
  const [failedProviders, setFailedProviders] = useState<MetaProvider[]>([]);
  const [searching, setSearching] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [loadingWorkId, setLoadingWorkId] = useState<string | null>(null);

  // --- Manual Work Builder State ---
  const [showManualBuilder, setShowManualBuilder] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManualWorkDraft>({
    category: initialCategory ?? "anime",
    title: initialQuery,
    year: "",
    creators: "",
    runtime_minutes: "120",
    pages: "320",
    seasons_count: "1",
    episodes_per_season: "12",
    episode_minutes: "24",
  });
  const [manualErrors, setManualErrors] = useState<string[]>([]);

  // --- Selected Work & Consumed Configuration State ---
  const [entryId, setEntryId] = useState<string | undefined>(
    editingArchiveEntry?.entry_id
  );
  const [selectedWork, setSelectedWork] = useState<
    WorkDetails | ManualWork | null
  >(editingArchiveEntry?.work ?? initialWork);

  const [consumed, setConsumed] = useState<ArchiveConsumed>(() => {
    if (editingArchiveEntry) {
      return editingArchiveEntry.consumed;
    }
    if (initialWork) {
      return defaultConsumedForWork(initialWork);
    }
    return { times: 1, progress: 1 };
  });

  const [overrideHours, setOverrideHours] = useState<string>(() => {
    const m = editingArchiveEntry?.consumed.minutes_override;
    return m !== undefined ? String(m / 60) : "";
  });

  const [when, setWhen] = useState<ArchiveWhen>(() => {
    if (editingArchiveEntry) {
      return editingArchiveEntry.when;
    }
    if (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)) {
      return { precision: "day", date: initialDate };
    }
    return { precision: "month", date: todayStr.slice(0, 7) };
  });
  const [showEndDate, setShowEndDate] = useState<boolean>(
    Boolean(editingArchiveEntry?.when.end_date)
  );

  const [rating, setRating] = useState<number | null>(
    editingArchiveEntry?.rating ?? null
  );
  const [note, setNote] = useState<string>(editingArchiveEntry?.note ?? "");
  const [ratingChanged, setRatingChanged] = useState(false);
  const [noteChanged, setNoteChanged] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState<
    ArchiveRequest["status"]
  >(editingArchiveEntry ? editingArchiveEntry.status : "finished");

  const [archiveErrors, setArchiveErrors] = useState<string[]>([]);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const [savedBanner, setSavedBanner] = useState<{
    title: string;
    category: Category;
    totalMinutes: number;
    units: number;
  } | null>(null);

  const searchSeqRef = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);

  // Sync props when opened with a pre-selected work or editing entry
  useEffect(() => {
    if (editingArchiveEntry) {
      setEntryId(editingArchiveEntry.entry_id);
      setSelectedWork(editingArchiveEntry.work);
      setConsumed(editingArchiveEntry.consumed);
      const m = editingArchiveEntry.consumed.minutes_override;
      setOverrideHours(m !== undefined ? String(m / 60) : "");
      setWhen(editingArchiveEntry.when);
      setShowEndDate(Boolean(editingArchiveEntry.when.end_date));
      setRating(editingArchiveEntry.rating ?? null);
      setNote(editingArchiveEntry.note ?? "");
      setRatingChanged(false);
      setNoteChanged(false);
      setArchiveStatus(editingArchiveEntry.status);
      setSavedBanner(null);
    } else if (initialWork) {
      setEntryId(undefined);
      setSelectedWork(initialWork);
      setConsumed(defaultConsumedForWork(initialWork));
      setOverrideHours("");
      setArchiveStatus("finished");
      setSavedBanner(null);
    }
  }, [editingArchiveEntry, initialWork]);

  // Perform metadata lookup search
  const runLookupSearch = (q: string, cat: Category | "any") => {
    const trimmed = q.trim();
    const seq = ++searchSeqRef.current;
    if (trimmed.length < 2) {
      setLookupResults(null);
      setFailedProviders([]);
      setSearching(false);
      setLookupError(null);
      return;
    }

    setSearching(true);
    setLookupError(null);
    lookupSearch(trimmed, cat)
      .then((res) => {
        if (searchSeqRef.current !== seq) return;
        setLookupResults(res.results ?? []);
        setFailedProviders(res.failed_providers ?? []);
        setSearching(false);
      })
      .catch((err) => {
        if (searchSeqRef.current !== seq) return;
        setLookupError(err instanceof Error ? err.message : String(err));
        setLookupResults([]);
        setSearching(false);
      });
  };

  useEffect(() => {
    if (selectedWork || showManualBuilder) return;
    window.clearTimeout(debounceRef.current);
    const trimmed = searchInput.trim();
    if (trimmed.length < 2) {
      setLookupResults(null);
      setSearching(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      runLookupSearch(trimmed, lookupCat);
    }, 260);
    return () => window.clearTimeout(debounceRef.current);
  }, [searchInput, lookupCat, selectedWork, showManualBuilder]);

  const handlePickHit = async (hit: LookupHit) => {
    const key = `${hit.provider}:${hit.provider_id}`;
    setLoadingWorkId(key);
    setLookupError(null);
    setSavedBanner(null);
    try {
      const details = await lookupWork(hit.provider, hit.provider_id);
      setSelectedWork(details);
      setConsumed(defaultConsumedForWork(details));
      setOverrideHours("");
      setArchiveErrors([]);
    } catch {
      setLookupError("Could not load full metadata. Retry or explicitly add a manual work instead.");
    } finally {
      setLoadingWorkId(null);
    }
  };

  const handleCreateManualWork = (e: Event) => {
    e.preventDefault();
    const built = buildManualWork(manualDraft);
    if (!built.ok) {
      setManualErrors(built.errors);
      return;
    }
    setManualErrors([]);
    setSelectedWork(built.work);
    setConsumed(defaultConsumedForWork(built.work));
    setOverrideHours("");
    setShowManualBuilder(false);
    setSavedBanner(null);
  };

  // Sync manual hours override into `consumed.minutes_override`
  const effectiveConsumed = useMemo<ArchiveConsumed>(() => {
    const next: ArchiveConsumed = { ...consumed };
    const trimmedH = overrideHours.trim();
    const storedMinutes = editingArchiveEntry?.consumed.minutes_override;
    if (storedMinutes !== undefined && trimmedH === String(storedMinutes / 60)) {
      next.minutes_override = storedMinutes;
    } else if (trimmedH !== "") {
      const h = Number(trimmedH);
      if (Number.isFinite(h) && h >= 0) {
        next.minutes_override = Math.round(h * 60);
      } else {
        delete next.minutes_override;
      }
    } else {
      delete next.minutes_override;
    }
    return next;
  }, [consumed, overrideHours, editingArchiveEntry]);

  const timePreview = useMemo(() => {
    if (!selectedWork) return null;
    return computeArchivePreview(selectedWork, effectiveConsumed, archiveStatus);
  }, [selectedWork, effectiveConsumed, archiveStatus]);

  const handleToggleSeason = (seasonNumber: number) => {
    setConsumed((prev) => {
      const current = prev.seasons ?? [];
      const exists = current.some((s) => s.number === seasonNumber);
      const nextSeasons = exists
        ? current.filter((s) => s.number !== seasonNumber)
        : [...current, { number: seasonNumber }].sort(
            (a, b) => a.number - b.number
          );
      return { ...prev, seasons: nextSeasons };
    });
  };

  const handleSeasonEpisodesChange = (
    seasonNumber: number,
    maxEp: number,
    rawVal: string
  ) => {
    const parsed = Number.parseInt(rawVal, 10);
    setConsumed((prev) => {
      const current = prev.seasons ?? [];
      const nextSeasons = current.map((s) => {
        if (s.number !== seasonNumber) return s;
        if (Number.isNaN(parsed) || parsed >= maxEp) {
          return { number: s.number };
        }
        return { number: s.number, episodes: Math.max(1, parsed) };
      });
      return { ...prev, seasons: nextSeasons };
    });
  };

  const handlePrecisionChange = (nextPrecision: DatePrecision) => {
    setWhen((prev) => {
      if (nextPrecision === "unknown") {
        return { precision: "unknown" };
      }
      if (nextPrecision === "day") {
        const d =
          prev.date && /^\d{4}-\d{2}-\d{2}$/.test(prev.date)
            ? prev.date
            : todayStr;
        return { precision: "day", date: d };
      }
      if (nextPrecision === "month") {
        const m =
          prev.date && /^\d{4}-\d{2}/.test(prev.date)
            ? prev.date.slice(0, 7)
            : todayStr.slice(0, 7);
        return { precision: "month", date: m };
      }
      const y =
        prev.date && /^\d{4}/.test(prev.date)
          ? prev.date.slice(0, 4)
          : todayStr.slice(0, 4);
      return { precision: "year", date: y };
    });
  };

  const handleSaveArchive = async (e: Event) => {
    e.preventDefault();
    setArchiveErrors([]);

    const built = buildArchiveRequest({
      previous: editingArchiveEntry ?? undefined,
      entry_id: entryId,
      work: selectedWork,
      consumed: effectiveConsumed,
      when: showEndDate ? when : { precision: when.precision, date: when.date },
      rating: ratingChanged ? rating : undefined,
      note: noteChanged ? note : undefined,
      status: archiveStatus,
    });

    if (!built.ok) {
      setArchiveErrors(built.errors);
      return;
    }

    setArchiveSaving(true);
    try {
      const result = await saveArchiveEntry(built.request);
      setSavedBanner({
        title: built.request.work.title,
        category: built.request.work.category,
        totalMinutes: result.total_minutes,
        units: result.units,
      });
      setSelectedWork(null);
      setEntryId(undefined);
      setSearchInput("");
      setRating(null);
      setNote("");
      setRatingChanged(false);
      setNoteChanged(false);
      onSavedArchive?.(result, built.request);
    } catch (err) {
      setArchiveErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setArchiveSaving(false);
    }
  };

  // --- Quick Offline Session Log State (preserves `lib/offline-queue.ts`) ---
  const [quickForm, setQuickForm] = useState<AddFormState>(INITIAL_QUICK_FORM);
  const [quickErrors, setQuickErrors] = useState<string[]>([]);
  const [quickSuccess, setQuickSuccess] = useState<string | null>(null);
  const [quickServerError, setQuickServerError] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [queue, setQueue] = useState<QueuedEntry[]>([]);
  const [editingQueued, setEditingQueued] = useState<QueuedEntry | null>(null);
  const [sendingAll, setSendingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const store = await getDefaultStore();
      if (store === null || cancelled) return;
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

  const handleQuickSubmit = async (e: Event) => {
    e.preventDefault();
    setQuickErrors([]);
    setQuickSuccess(null);
    setQuickServerError(null);
    setQueueNotice(null);

    const built = buildEventInput(quickForm);
    if (built.input === null) {
      setQuickErrors(built.errors);
      return;
    }

    const editing = editingQueued;
    const body: ManualEventInput = {
      ...built.input,
      client_id: editing !== null ? editing.client_id : newClientId(),
    };

    setQuickSubmitting(true);
    try {
      const store = await getDefaultStore();
      const queueIt = async (failedAttempt: unknown | null) => {
        if (store === null) {
          setQuickServerError(COULD_NOT_SAVE_OFFLINE);
          return;
        }
        const attempted = failedAttempt !== null;
        const errMsg =
          failedAttempt instanceof Error
            ? failedAttempt.message
            : failedAttempt
              ? String(failedAttempt)
              : null;
        if (editing !== null) {
          await putQueuedEntry(store, {
            ...editing,
            body,
            attempts: attempted ? 1 : 0,
            last_attempt_at: attempted ? new Date().toISOString() : null,
            last_error: errMsg,
            status: "pending",
          });
        } else {
          await enqueueEntry(store, body, {
            attempts: attempted ? 1 : 0,
            lastError: errMsg,
            lastAttemptAt: attempted ? new Date().toISOString() : null,
          });
        }
        setQueueNotice(QUEUED_NOTICE);
        setQuickForm(INITIAL_QUICK_FORM);
        setEditingQueued(null);
      };

      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await queueIt(null);
        return;
      }

      try {
        const result = await addEvent(body);
        if (editing !== null && store !== null) {
          await removeQueuedEntry(store, editing.client_id);
        }
        setQuickSuccess(
          result.inserted === 1
            ? `Logged "${body.title}"`
            : `Already recorded: "${body.title}"`
        );
        setQuickForm(INITIAL_QUICK_FORM);
        setEditingQueued(null);
      } catch (err) {
        if (classifySendError(err) === "rejected") {
          const msg = err instanceof Error ? err.message : String(err);
          setQuickServerError(msg);
          if (editing !== null && store !== null) {
            await putQueuedEntry(store, {
              ...editing,
              body,
              attempts: editing.attempts + 1,
              last_attempt_at: new Date().toISOString(),
              last_error: msg,
              status: "rejected",
            });
          }
          return;
        }
        await queueIt(err);
      }
    } finally {
      setQuickSubmitting(false);
    }
  };

  const handleSendQueueNow = async () => {
    setSendingAll(true);
    try {
      const store = await getDefaultStore();
      if (store !== null) {
        await flushQueue(store, (queuedBody) => addEvent(queuedBody));
      }
    } finally {
      setSendingAll(false);
    }
  };

  return (
    <section
      class={inSheet ? "add-sheet-container" : "page-container add-page"}
      aria-label="Add to Archive"
    >
      {!inSheet && (
        <header class="page-header">
          <div class="page-header-titles">
            <span class="page-eyebrow">Personal Archive</span>
            <h1>Add to Archive</h1>
            <p class="page-subtitle">
              Look up anime, series, films, books, or audiobooks from the past —
              or log a single offline-ready session.
            </p>
          </div>
          <div class="page-header-actions">
            <Tabs
              ariaLabel="Entry mode"
              options={[
                { value: "archive", label: "Lookup & Archive" },
                {
                  value: "quick",
                  label: "Quick Session",
                  count: queue.length > 0 ? queue.length : undefined,
                },
              ]}
              value={tabMode}
              onChange={(v) => setTabMode(v)}
            />
          </div>
        </header>
      )}

      {inSheet && (
        <div class="add-sheet-mode-bar">
          <Tabs
            ariaLabel="Entry mode"
            options={[
              { value: "archive", label: "Lookup & Archive" },
              {
                value: "quick",
                label: "Quick Session (Offline)",
                count: queue.length > 0 ? queue.length : undefined,
              },
            ]}
            value={tabMode}
            onChange={(v) => setTabMode(v)}
          />
        </div>
      )}

      {/* Saved Confirmation Banner */}
      {savedBanner && (
        <div class="add-saved-banner" role="status">
          <div class="add-saved-banner-info">
            <CheckIcon size={18} />
            <div>
              <strong>Archived “{savedBanner.title}”</strong> in{" "}
              <Badge size="sm" category={savedBanner.category}>
                {categoryPluralLabel(savedBanner.category)}
              </Badge>{" "}
              ({formatMinutes(savedBanner.totalMinutes)})
            </div>
          </div>
          <div class="add-saved-banner-actions">
            <Button
              variant="secondary"
              size="sm"
              href={`#/library?category=${savedBanner.category}`}
            >
              Open in Library
            </Button>
          </div>
        </div>
      )}

      {tabMode === "archive" ? (
        <div class="add-archive-flow">
          {/* STEP 1: Lookup Search (shown when no work is selected and manual builder is closed) */}
          {!selectedWork && !showManualBuilder && (
            <Card padding="md" class="add-lookup-card">
              <form
                class="add-lookup-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  window.clearTimeout(debounceRef.current);
                  runLookupSearch(searchInput, lookupCat);
                }}
              >
                <div class="add-lookup-input-wrap">
                  <span class="add-lookup-icon" aria-hidden="true">
                    <SearchIcon size={18} />
                  </span>
                  <input
                    type="search"
                    class="ui-input add-lookup-input"
                    placeholder="Type a title (e.g. Vinland Saga, Dune, Spirited Away)…"
                    aria-label="Search title to archive"
                    value={searchInput}
                    onInput={(e) =>
                      setSearchInput((e.currentTarget as HTMLInputElement).value)
                    }
                    autofocus
                  />
                  <Button type="submit" variant="primary" size="sm">
                    Search
                  </Button>
                </div>

                <Tabs
                  ariaLabel="Filter lookup by category"
                  options={LOOKUP_CATEGORIES}
                  value={lookupCat}
                  onChange={(val) => setLookupCat(val)}
                  variant="pills"
                />
              </form>

              {failedProviders.length > 0 && (
                <p class="add-provider-warning" role="status">
                  Note: {failedProviders.join(", ")} did not respond in time;
                  showing matches from other providers.
                </p>
              )}

              {lookupError && (
                <div class="ui-form-error" role="alert">
                  <span>Lookup unavailable: {lookupError}. </span>
                  <button
                    type="button"
                    class="ui-inline-link"
                    onClick={() => {
                      setManualDraft((d) => ({
                        ...d,
                        title: searchInput.trim() || d.title,
                        category:
                          lookupCat !== "any" ? lookupCat : d.category,
                      }));
                      setShowManualBuilder(true);
                    }}
                  >
                    Add by hand instead →
                  </button>
                </div>
              )}

              {searching && (
                <div class="add-lookup-skeletons" aria-busy="true">
                  <Skeleton height={68} />
                  <Skeleton height={68} />
                  <Skeleton height={68} />
                </div>
              )}

              {!searching &&
                lookupResults !== null &&
                lookupResults.length > 0 && (
                  <ul
                    class="add-lookup-results"
                    aria-label="Metadata search results"
                  >
                    {lookupResults.map((hit) => {
                      const hitKey = `${hit.provider}:${hit.provider_id}`;
                      const isLoadingThis = loadingWorkId === hitKey;
                      return (
                        <li key={hitKey}>
                          <button
                            type="button"
                            class="add-lookup-hit"
                            disabled={loadingWorkId !== null}
                            onClick={() => void handlePickHit(hit)}
                          >
                            <Cover
                              src={hit.cover_url}
                              title={hit.title}
                              category={hit.category}
                              size="md"
                              aspect="poster"
                            />
                            <div class="add-lookup-hit-body">
                              <div class="add-lookup-hit-title">
                                {hit.title}
                              </div>
                              <div class="add-lookup-hit-meta">
                                <Badge
                                  size="sm"
                                  category={hit.category}
                                  icon={
                                    <CategoryIcon
                                      category={hit.category}
                                      size={11}
                                    />
                                  }
                                >
                                  {categoryLabel(hit.category)}
                                </Badge>
                                {hit.subtitle ? (
                                  <span>{hit.subtitle}</span>
                                ) : hit.year ? (
                                  <span>{hit.year}</span>
                                ) : null}
                              </div>
                            </div>
                            <span class="add-lookup-hit-action">
                              {isLoadingThis ? "Loading…" : "Select →"}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

              {!searching &&
                lookupResults !== null &&
                lookupResults.length === 0 && (
                  <EmptyState
                    compact
                    title={`No provider matches for “${searchInput.trim()}”`}
                    description="You can add any work by hand with its category, seasons, or runtime."
                    actions={
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setManualDraft((d) => ({
                            ...d,
                            title: searchInput.trim(),
                            category:
                              lookupCat !== "any" ? lookupCat : d.category,
                          }));
                          setShowManualBuilder(true);
                        }}
                      >
                        Add “{searchInput.trim() || "Work"}” by hand
                      </Button>
                    }
                  />
                )}

              <div class="add-lookup-footer">
                <span class="ui-text-muted">
                  Can&apos;t find a title or adding something obscure?
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setManualDraft((d) => ({
                      ...d,
                      title: searchInput.trim() || d.title,
                      category: lookupCat !== "any" ? lookupCat : d.category,
                    }));
                    setShowManualBuilder(true);
                  }}
                >
                  Add work by hand →
                </Button>
              </div>
            </Card>
          )}

          {/* STEP 1B: Manual Work Builder (for things no provider knows) */}
          {showManualBuilder && !selectedWork && (
            <Card
              padding="md"
              title="Add Work by Hand"
              subtitle="Create a custom archive work when no metadata provider has it"
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowManualBuilder(false)}
                >
                  ← Back to lookup
                </Button>
              }
            >
              <form class="ui-form-stack" onSubmit={handleCreateManualWork}>
                <div class="ui-form-grid-2">
                  <div class="ui-form-field">
                    <label class="ui-form-label" for="manual-work-title">
                      Title *
                    </label>
                    <input
                      id="manual-work-title"
                      type="text"
                      class="ui-input"
                      required
                      value={manualDraft.title}
                      onInput={(e) =>
                        setManualDraft((d) => ({
                          ...d,
                          title: (e.currentTarget as HTMLInputElement).value,
                        }))
                      }
                      placeholder="e.g. Local Theatre Recording"
                    />
                  </div>

                  <div class="ui-form-field">
                    <label class="ui-form-label" for="manual-work-cat">
                      Category *
                    </label>
                    <select
                      id="manual-work-cat"
                      class="ui-input"
                      value={manualDraft.category}
                      onChange={(e) =>
                        setManualDraft((d) => ({
                          ...d,
                          category: (e.currentTarget as HTMLSelectElement)
                            .value as Category,
                        }))
                      }
                    >
                      {CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {CATEGORY_META[cat].pluralLabel}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div class="ui-form-grid-2">
                  <div class="ui-form-field">
                    <label class="ui-form-label" for="manual-work-year">
                      Release Year (optional)
                    </label>
                    <input
                      id="manual-work-year"
                      type="number"
                      class="ui-input"
                      min="1850"
                      max="2035"
                      value={String(manualDraft.year ?? "")}
                      onInput={(e) =>
                        setManualDraft((d) => ({
                          ...d,
                          year: (e.currentTarget as HTMLInputElement).value,
                        }))
                      }
                      placeholder="e.g. 2019"
                    />
                  </div>

                  <div class="ui-form-field">
                    <label class="ui-form-label" for="manual-work-creator">
                      Author / Director / Studio (optional)
                    </label>
                    <input
                      id="manual-work-creator"
                      type="text"
                      class="ui-input"
                      value={
                        Array.isArray(manualDraft.creators)
                          ? manualDraft.creators.join(", ")
                          : manualDraft.creators ?? ""
                      }
                      onInput={(e) =>
                        setManualDraft((d) => ({
                          ...d,
                          creators: (e.currentTarget as HTMLInputElement).value,
                        }))
                      }
                      placeholder="e.g. Makoto Yukimura"
                    />
                  </div>
                </div>

                {(manualDraft.category === "anime" ||
                  manualDraft.category === "series") && (
                  <div class="ui-form-grid-3">
                    <div class="ui-form-field">
                      <label class="ui-form-label" for="manual-seasons-count">
                        Seasons
                      </label>
                      <input
                        id="manual-seasons-count"
                        type="number"
                        class="ui-input"
                        min="1"
                        max="50"
                        value={String(manualDraft.seasons_count ?? "1")}
                        onInput={(e) =>
                          setManualDraft((d) => ({
                            ...d,
                            seasons_count: (e.currentTarget as HTMLInputElement)
                              .value,
                          }))
                        }
                      />
                    </div>
                    <div class="ui-form-field">
                      <label class="ui-form-label" for="manual-ep-count">
                        Episodes / Season
                      </label>
                      <input
                        id="manual-ep-count"
                        type="number"
                        class="ui-input"
                        min="1"
                        max="500"
                        value={String(manualDraft.episodes_per_season ?? "12")}
                        onInput={(e) =>
                          setManualDraft((d) => ({
                            ...d,
                            episodes_per_season: (
                              e.currentTarget as HTMLInputElement
                            ).value,
                          }))
                        }
                      />
                    </div>
                    <div class="ui-form-field">
                      <label class="ui-form-label" for="manual-ep-min">
                        Min / Episode
                      </label>
                      <input
                        id="manual-ep-min"
                        type="number"
                        class="ui-input"
                        min="1"
                        max="300"
                        value={String(manualDraft.episode_minutes ?? "24")}
                        onInput={(e) =>
                          setManualDraft((d) => ({
                            ...d,
                            episode_minutes: (
                              e.currentTarget as HTMLInputElement
                            ).value,
                          }))
                        }
                      />
                    </div>
                  </div>
                )}

                {manualDraft.category === "film" && (
                  <div class="ui-form-field">
                    <label class="ui-form-label" for="manual-film-runtime">
                      Film Runtime (minutes)
                    </label>
                    <input
                      id="manual-film-runtime"
                      type="number"
                      class="ui-input"
                      min="1"
                      max="1000"
                      value={String(manualDraft.runtime_minutes ?? "120")}
                      onInput={(e) =>
                        setManualDraft((d) => ({
                          ...d,
                          runtime_minutes: (e.currentTarget as HTMLInputElement)
                            .value,
                        }))
                      }
                    />
                  </div>
                )}

                {manualDraft.category === "book" && (
                  <div class="ui-form-field">
                    <label class="ui-form-label" for="manual-book-pages">
                      Pages (optional, used to estimate reading time)
                    </label>
                    <input
                      id="manual-book-pages"
                      type="number"
                      class="ui-input"
                      min="1"
                      max="10000"
                      value={String(manualDraft.pages ?? "320")}
                      onInput={(e) =>
                        setManualDraft((d) => ({
                          ...d,
                          pages: (e.currentTarget as HTMLInputElement).value,
                        }))
                      }
                    />
                  </div>
                )}

                {manualErrors.length > 0 && (
                  <ul class="ui-form-error-list" role="alert">
                    {manualErrors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                )}

                <div class="ui-form-actions">
                  <Button type="submit" variant="primary">
                    Continue to Archive Details →
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {/* STEP 2: Configure Selected Work (Seasons / Times / Progress + When + Rating/Note) */}
          {selectedWork && (
            <form
              class="add-configure-form"
              onSubmit={(e) => void handleSaveArchive(e)}
            >
              {/* Selected Work Hero Card */}
              <Card padding="md" class="add-selected-work-card">
                <div class="add-selected-work-header">
                  <Cover
                    src={
                      "cover_url" in selectedWork
                        ? selectedWork.cover_url
                        : null
                    }
                    title={selectedWork.title}
                    category={selectedWork.category}
                    size="lg"
                    aspect="poster"
                  />
                  <div class="add-selected-work-info">
                    <div class="add-selected-work-badges">
                      <Badge
                        size="sm"
                        category={selectedWork.category}
                        icon={
                          <CategoryIcon
                            category={selectedWork.category}
                            size={11}
                          />
                        }
                      >
                        {categoryLabel(selectedWork.category)}
                      </Badge>
                      {selectedWork.year && (
                        <Badge size="sm" variant="neutral">
                          {selectedWork.year}
                        </Badge>
                      )}
                      {selectedWork.seasons.length > 0 && (
                        <Badge size="sm" variant="neutral">
                          {selectedWork.seasons.length}{" "}
                          {selectedWork.seasons.length === 1
                            ? "season"
                            : "seasons"}
                        </Badge>
                      )}
                    </div>
                    <h2 class="add-selected-work-title">
                      {selectedWork.title}
                    </h2>
                    {selectedWork.creators.length > 0 && (
                      <p class="add-selected-work-creators">
                        {selectedWork.creators.join(", ")}
                      </p>
                    )}
                    {"description" in selectedWork &&
                      selectedWork.description && (
                        <p class="add-selected-work-desc">
                          {selectedWork.description}
                        </p>
                      )}
                  </div>
                  {!editingArchiveEntry && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelectedWork(null);
                        setArchiveErrors([]);
                      }}
                    >
                      Change
                    </Button>
                  )}
                </div>
              </Card>

              {/* 1. Status & What was consumed */}
              <Card
                padding="md"
                title="1. Status & what you watched, read, or listened to"
              >
                <div class="ui-form-stack">
                  <div class="ui-form-field">
                    <span class="ui-form-label">Status</span>
                    <Tabs
                      ariaLabel="Archive work status"
                      options={[
                        { value: "finished", label: "Finished" },
                        { value: "in_progress", label: "In Progress" },
                        { value: "planned", label: "Planned (Watchlist)" },
                        { value: "dropped", label: "Dropped" },
                      ]}
                      value={archiveStatus ?? "finished"}
                      onChange={(v) => setArchiveStatus(v)}
                    />
                  </div>

                  {archiveStatus === "planned" ? (
                    <p class="ui-form-hint">
                      Planned works are added to your Library watchlist with 0
                      minutes and are excluded from calendar and time totals
                      until you start or finish them.
                    </p>
                  ) : (selectedWork.category === "anime" ||
                  selectedWork.category === "series") &&
                selectedWork.seasons.length > 0 ? (
                  <div class="add-seasons-section">
                    <div class="add-seasons-toolbar">
                      <span class="ui-form-hint">
                        Tick the seasons you watched. You can also set a partial
                        episode count for any season.
                      </span>
                      <div class="add-seasons-bulk">
                        <button
                          type="button"
                          class="ui-inline-link"
                          onClick={() =>
                            setConsumed((prev) => ({
                              ...prev,
                              seasons: selectedWork.seasons.map((s) => ({
                                number: s.number,
                              })),
                            }))
                          }
                        >
                          Select all
                        </button>
                        <span>·</span>
                        <button
                          type="button"
                          class="ui-inline-link"
                          onClick={() =>
                            setConsumed((prev) => ({ ...prev, seasons: [] }))
                          }
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    <div class="add-season-chips">
                      {selectedWork.seasons.map((season) => {
                        const sel = (consumed.seasons ?? []).find(
                          (s) => s.number === season.number
                        );
                        const isChecked = Boolean(sel);
                        const watchedEps = sel?.episodes ?? season.episodes;

                        return (
                          <div
                            key={season.number}
                            class={
                              isChecked
                                ? `add-season-card add-season-card--selected add-season-card--${selectedWork.category}`
                                : "add-season-card"
                            }
                          >
                            <button
                              type="button"
                              class="add-season-chip-btn"
                              aria-pressed={isChecked}
                              onClick={() => handleToggleSeason(season.number)}
                            >
                              <span class="add-season-check" aria-hidden="true">
                                {isChecked ? <CheckIcon size={14} /> : null}
                              </span>
                              <div class="add-season-chip-text">
                                <strong>{`Season ${season.number}`}</strong>
                                <span class="tabular-nums">
                                  {season.year ? `${season.year} · ` : ""}
                                  {season.episodes} ep
                                  {season.total_minutes
                                    ? ` · ${formatMinutes(season.total_minutes)}`
                                    : ""}
                                </span>
                              </div>
                            </button>

                            {isChecked && season.episodes > 1 && (
                              <div class="add-season-partial">
                                <label
                                  class="add-season-partial-label"
                                  for={`season-ep-${season.number}`}
                                >
                                  Episodes watched:
                                </label>
                                <input
                                  id={`season-ep-${season.number}`}
                                  type="number"
                                  min="1"
                                  max={season.episodes}
                                  class="ui-input add-season-ep-input tabular-nums"
                                  value={String(watchedEps)}
                                  onInput={(e) =>
                                    handleSeasonEpisodesChange(
                                      season.number,
                                      season.episodes,
                                      (e.currentTarget as HTMLInputElement)
                                        .value
                                    )
                                  }
                                />
                                <span class="tabular-nums">
                                  / {season.episodes}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : selectedWork.category === "film" ||
                  selectedWork.category === "anime" ||
                  selectedWork.category === "series" ? (
                  <div class="ui-form-grid-2">
                    <div class="ui-form-field">
                      <label class="ui-form-label" for="archive-times-watched">
                        Times watched
                      </label>
                      <div class="add-stepper-row">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setConsumed((p) => ({
                              ...p,
                              times: Math.max(1, (p.times ?? 1) - 1),
                            }))
                          }
                        >
                          −
                        </Button>
                        <input
                          id="archive-times-watched"
                          type="number"
                          min="1"
                          max="100"
                          class="ui-input add-stepper-input tabular-nums"
                          value={String(consumed.times ?? 1)}
                          onInput={(e) =>
                            setConsumed((p) => ({
                              ...p,
                              times: Math.max(
                                1,
                                Number.parseInt(
                                  (e.currentTarget as HTMLInputElement).value,
                                  10
                                ) || 1
                              ),
                            }))
                          }
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setConsumed((p) => ({
                              ...p,
                              times: (p.times ?? 1) + 1,
                            }))
                          }
                        >
                          +
                        </Button>
                      </div>
                    </div>

                    <div class="ui-form-field">
                      <label class="ui-form-label" for="archive-override-hours">
                        Total hours override (optional)
                      </label>
                      <input
                        id="archive-override-hours"
                        type="number"
                        step="0.25"
                        min="0"
                        class="ui-input tabular-nums"
                        placeholder={
                          selectedWork.runtime_minutes
                            ? `Default: ${formatMinutes(
                                selectedWork.runtime_minutes
                              )} per viewing`
                            : "e.g. 2"
                        }
                        value={overrideHours}
                        onInput={(e) =>
                          setOverrideHours(
                            (e.currentTarget as HTMLInputElement).value
                          )
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <div class="ui-form-stack">
                    <div class="ui-form-field">
                      <label class="ui-form-label" for="archive-progress-range">
                        Progress ({Math.round((consumed.progress ?? 1) * 100)}%)
                      </label>
                      <div class="add-progress-presets">
                        {[1, 0.75, 0.5, 0.25].map((pct) => (
                          <Button
                            key={pct}
                            variant={
                              Math.abs((consumed.progress ?? 1) - pct) < 0.02
                                ? "primary"
                                : "secondary"
                            }
                            size="sm"
                            onClick={() =>
                              setConsumed((p) => ({ ...p, progress: pct }))
                            }
                          >
                            {pct === 1 ? "Finished (100%)" : `${pct * 100}%`}
                          </Button>
                        ))}
                      </div>
                      <input
                        id="archive-progress-range"
                        type="range"
                        min="5"
                        max="100"
                        step="5"
                        value={String(
                          Math.round((consumed.progress ?? 1) * 100)
                        )}
                        onInput={(e) =>
                          setConsumed((p) => ({
                            ...p,
                            progress:
                              Number(
                                (e.currentTarget as HTMLInputElement).value
                              ) / 100,
                          }))
                        }
                      />
                    </div>

                    <div class="ui-form-field">
                      <label
                        class="ui-form-label"
                        for="archive-book-hours-override"
                      >
                        {selectedWork.category === "audiobook"
                          ? "Listening time in hours"
                          : "Reading time in hours (optional — leave blank to estimate from pages)"}
                      </label>
                      <input
                        id="archive-book-hours-override"
                        type="number"
                        step="0.25"
                        min="0"
                        class="ui-input tabular-nums"
                        placeholder={
                          selectedWork.pages
                            ? `Estimated from ${selectedWork.pages} pages: ≈ ${Math.round(
                                (selectedWork.pages * 1.5) / 60
                              )} h`
                            : "e.g. 9.5"
                        }
                        value={overrideHours}
                        onInput={(e) =>
                          setOverrideHours(
                            (e.currentTarget as HTMLInputElement).value
                          )
                        }
                      />
                    </div>
                  </div>
                )}
                </div>
              </Card>

              {/* 2. When */}
              <Card padding="md" title="2. Roughly when?">
                <div class="ui-form-stack">
                  <Tabs
                    ariaLabel="Date precision"
                    options={PRECISION_TABS}
                    value={when.precision}
                    onChange={handlePrecisionChange}
                  />

                  {when.precision === "unknown" ? (
                    <p class="ui-form-hint">
                      Stored without a calendar date. It will appear in your{" "}
                      <strong>
                        {categoryPluralLabel(selectedWork.category)}
                      </strong>{" "}
                      Library and count toward all-time totals.
                    </p>
                  ) : (
                    <div class="ui-form-grid-2">
                      <div class="ui-form-field">
                        <label class="ui-form-label" for="archive-when-date">
                          {when.precision === "day"
                            ? "Date"
                            : when.precision === "month"
                              ? "Month (YYYY-MM)"
                              : "Year (YYYY)"}
                        </label>
                        {when.precision === "day" && (
                          <input
                            id="archive-when-date"
                            type="date"
                            class="ui-input tabular-nums"
                            value={when.date ?? todayStr}
                            onInput={(e) =>
                              setWhen((w) => ({
                                ...w,
                                date: (e.currentTarget as HTMLInputElement)
                                  .value,
                              }))
                            }
                          />
                        )}
                        {when.precision === "month" && (
                          <input
                            id="archive-when-date"
                            type="month"
                            class="ui-input tabular-nums"
                            value={when.date ?? todayStr.slice(0, 7)}
                            onInput={(e) =>
                              setWhen((w) => ({
                                ...w,
                                date: (e.currentTarget as HTMLInputElement)
                                  .value,
                              }))
                            }
                          />
                        )}
                        {when.precision === "year" && (
                          <input
                            id="archive-when-date"
                            type="number"
                            min="1950"
                            max="2035"
                            class="ui-input tabular-nums"
                            value={when.date ?? todayStr.slice(0, 4)}
                            onInput={(e) =>
                              setWhen((w) => ({
                                ...w,
                                date: (e.currentTarget as HTMLInputElement)
                                  .value,
                              }))
                            }
                          />
                        )}
                      </div>

                      {showEndDate ? (
                        <div class="ui-form-field">
                          <label
                            class="ui-form-label"
                            for="archive-when-end-date"
                          >
                            End {when.precision} (optional)
                          </label>
                          {when.precision === "day" && (
                            <input
                              id="archive-when-end-date"
                              type="date"
                              class="ui-input tabular-nums"
                              value={when.end_date ?? when.date ?? ""}
                              onInput={(e) =>
                                setWhen((w) => ({
                                  ...w,
                                  end_date: (e.currentTarget as HTMLInputElement)
                                    .value,
                                }))
                              }
                            />
                          )}
                          {when.precision === "month" && (
                            <input
                              id="archive-when-end-date"
                              type="month"
                              class="ui-input tabular-nums"
                              value={when.end_date ?? when.date ?? ""}
                              onInput={(e) =>
                                setWhen((w) => ({
                                  ...w,
                                  end_date: (e.currentTarget as HTMLInputElement)
                                    .value,
                                }))
                              }
                            />
                          )}
                          {when.precision === "year" && (
                            <input
                              id="archive-when-end-date"
                              type="number"
                              min="1950"
                              max="2035"
                              class="ui-input tabular-nums"
                              value={when.end_date ?? when.date ?? ""}
                              onInput={(e) =>
                                setWhen((w) => ({
                                  ...w,
                                  end_date: (e.currentTarget as HTMLInputElement)
                                    .value,
                                }))
                              }
                            />
                          )}
                        </div>
                      ) : (
                        <div class="ui-form-field add-range-toggle-wrap">
                          <button
                            type="button"
                            class="ui-inline-link"
                            onClick={() => setShowEndDate(true)}
                          >
                            + Spread across a date range
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Card>

              {/* 3. Optional Rating & Note (Rating hidden for music) */}
              <Card
                padding="md"
                title={
                  selectedWork.category === "music"
                    ? "3. Note (optional)"
                    : "3. Rating (0–10, one decimal) & Note (optional)"
                }
              >
                <div class="ui-form-stack">
                  {selectedWork.category !== "music" && (
                    <RatingInput10
                      rating={rating}
                      onChange={(value) => { setRating(value); setRatingChanged(true); }}
                      category={selectedWork.category}
                    />
                  )}
                  <div class="ui-form-field">
                    <label class="ui-form-label" for="archive-note-input">
                      Note
                    </label>
                    <textarea
                      id="archive-note-input"
                      class="ui-input ui-textarea"
                      rows={2}
                      placeholder="Optional note or memory…"
                      value={note}
                      onInput={(e) => {
                        setNote((e.currentTarget as HTMLTextAreaElement).value);
                        setNoteChanged(true);
                      }}
                    />
                  </div>
                </div>
              </Card>

              {archiveErrors.length > 0 && (
                <ul class="ui-form-error-list" role="alert">
                  {archiveErrors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}

              {/* Computed Time Preview Summary Bar before saving */}
              {timePreview && (
                <div
                  class="add-computed-preview"
                  role="status"
                  aria-live="polite"
                >
                  <div class="add-computed-preview-main">
                    <span class="add-computed-preview-eyebrow">
                      Computed Archive Time
                    </span>
                    <strong class="add-computed-preview-summary tabular-nums">
                      {timePreview.summaryText}
                    </strong>
                  </div>
                  <div class="add-computed-preview-actions">
                    <Badge
                      size="md"
                      category={selectedWork.category}
                      icon={
                        <CategoryIcon
                          category={selectedWork.category}
                          size={13}
                        />
                      }
                    >
                      {categoryPluralLabel(selectedWork.category)}
                    </Badge>
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      disabled={archiveSaving}
                    >
                      {archiveSaving
                        ? "Saving…"
                        : entryId
                          ? "Update Archive Entry"
                          : "Save to Archive"}
                    </Button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>
      ) : (
        /* QUICK SESSION LOG (Offline Queue) */
        <div class="add-quick-flow">
          {queue.length > 0 && (
            <Card
              padding="md"
              title={`Waiting to send (${queue.length})`}
              subtitle="Stored locally on this device until the server is reachable"
              actions={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleSendQueueNow()}
                  disabled={sendingAll}
                >
                  {sendingAll ? "Sending…" : "Send now"}
                </Button>
              }
            >
              <ul class="add-queue-list">
                {queue.map((entry) => (
                  <li key={entry.client_id} class="add-queue-item">
                    <div class="add-queue-item-info">
                      <strong>{entry.body.title}</strong>
                      <span class="ui-text-muted tabular-nums">
                        {entry.status === "rejected"
                          ? "Rejected — needs fixing"
                          : "Pending"}{" "}
                        · {entry.body.started_at}
                      </span>
                      {entry.last_error && (
                        <span class="ui-form-error">{entry.last_error}</span>
                      )}
                    </div>
                    <div class="add-queue-item-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingQueued(entry);
                          setQuickForm(formStateFromBody(entry.body));
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={async () => {
                          const store = await getDefaultStore();
                          if (store) {
                            await removeQueuedEntry(store, entry.client_id);
                          }
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card
            padding="md"
            title={
              editingQueued
                ? `Editing “${editingQueued.body.title}”`
                : "Quick Session Entry"
            }
            subtitle="Logs a single timestamped event (works offline)"
          >
            <form
              class="ui-form-stack"
              onSubmit={(e) => void handleQuickSubmit(e)}
              noValidate
            >
              <div class="ui-form-grid-2">
                <div class="ui-form-field">
                  <label class="ui-form-label" for="quick-media-type">
                    Media type
                  </label>
                  <select
                    id="quick-media-type"
                    class="ui-input"
                    value={quickForm.media_type}
                    onChange={(e) =>
                      setQuickForm((f) => ({
                        ...f,
                        media_type: (e.currentTarget as HTMLSelectElement).value,
                      }))
                    }
                  >
                    {MEDIA_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div class="ui-form-field">
                  <label class="ui-form-label" for="quick-title">
                    Title *
                  </label>
                  <input
                    id="quick-title"
                    type="text"
                    class="ui-input"
                    required
                    value={quickForm.title}
                    onInput={(e) =>
                      setQuickForm((f) => ({
                        ...f,
                        title: (e.currentTarget as HTMLInputElement).value,
                      }))
                    }
                  />
                </div>
              </div>

              <div class="ui-form-grid-3">
                <div class="ui-form-field">
                  <label class="ui-form-label" for="quick-parent">
                    Series / Author (optional)
                  </label>
                  <input
                    id="quick-parent"
                    type="text"
                    class="ui-input"
                    value={quickForm.parent_title}
                    onInput={(e) =>
                      setQuickForm((f) => ({
                        ...f,
                        parent_title: (e.currentTarget as HTMLInputElement)
                          .value,
                      }))
                    }
                  />
                </div>
                <div class="ui-form-field">
                  <label class="ui-form-label" for="quick-season">
                    Season
                  </label>
                  <input
                    id="quick-season"
                    type="number"
                    min="0"
                    class="ui-input tabular-nums"
                    value={quickForm.season}
                    onInput={(e) =>
                      setQuickForm((f) => ({
                        ...f,
                        season: (e.currentTarget as HTMLInputElement).value,
                      }))
                    }
                  />
                </div>
                <div class="ui-form-field">
                  <label class="ui-form-label" for="quick-episode">
                    Episode
                  </label>
                  <input
                    id="quick-episode"
                    type="number"
                    min="0"
                    class="ui-input tabular-nums"
                    value={quickForm.episode}
                    onInput={(e) =>
                      setQuickForm((f) => ({
                        ...f,
                        episode: (e.currentTarget as HTMLInputElement).value,
                      }))
                    }
                  />
                </div>
              </div>

              <div class="ui-form-grid-2">
                <div class="ui-form-field">
                  <label class="ui-form-label" for="quick-started-at">
                    Started at *
                  </label>
                  <input
                    id="quick-started-at"
                    type="datetime-local"
                    class="ui-input tabular-nums"
                    required
                    value={quickForm.started_at}
                    onInput={(e) =>
                      setQuickForm((f) => ({
                        ...f,
                        started_at: (e.currentTarget as HTMLInputElement).value,
                      }))
                    }
                  />
                </div>
                <div class="ui-form-field">
                  <label class="ui-form-label" for="quick-duration">
                    Duration (minutes)
                  </label>
                  <input
                    id="quick-duration"
                    type="number"
                    min="0"
                    step="any"
                    class="ui-input tabular-nums"
                    value={quickForm.duration_min}
                    onInput={(e) =>
                      setQuickForm((f) => ({
                        ...f,
                        duration_min: (e.currentTarget as HTMLInputElement)
                          .value,
                      }))
                    }
                  />
                </div>
              </div>

              {quickErrors.length > 0 && (
                <ul class="ui-form-error-list" role="alert">
                  {quickErrors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}

              {quickServerError && (
                <p class="ui-form-error" role="alert">
                  {quickServerError}
                </p>
              )}

              {queueNotice && (
                <p class="add-saved-banner" role="status">
                  {queueNotice}
                </p>
              )}

              {quickSuccess && (
                <p class="add-saved-banner" role="status">
                  {quickSuccess}
                </p>
              )}

              <div class="ui-form-actions">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={quickSubmitting}
                >
                  {quickSubmitting ? "Logging…" : "Log Session"}
                </Button>
                {editingQueued && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditingQueued(null);
                      setQuickForm(INITIAL_QUICK_FORM);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          </Card>
        </div>
      )}
    </section>
  );
}
