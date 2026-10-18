import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  deleteArchiveEntry,
  getLibrary,
  getLibraryWork,
  listArchive,
  type ArchiveConsumed,
  type ArchiveEntrySummary,
  type ArchiveWhen,
  type Category,
  type LibraryResult,
  type LibrarySort,
  type LibraryWork,
  type LibraryWorkDetail,
  type ManualWork,
  type WorkStatus,
} from "../api";
import { formatStarValue, ratingToStars } from "../lib/annotations";
import {
  formatArchiveWhen,
  formatHistoryPrecisionDate,
} from "../lib/archive-form";
import {
  CATEGORIES,
  CATEGORY_META,
  categoryLabel,
  categoryPluralLabel,
  formatCategoryUnits,
} from "../lib/categories";
import { formatLocalDay } from "../lib/format-date";
import { sourceLabel } from "../lib/sources";
import { formatMinutes } from "../lib/stats";
import { formatHours } from "../lib/year-review";
import {
  AddIcon,
  Badge,
  Button,
  Card,
  CategoryIcon,
  CategoryShareChart,
  Cover,
  EditIcon,
  EmptyState,
  ProgressBar,
  RatingEditor,
  SearchIcon,
  Skeleton,
  Stat,
  Tabs,
  TrashIcon,
  type TabOption,
} from "../ui";
import { workFromArchiveSummary } from "./Add";

export interface LibraryProps {
  initialCategory?: Category;
  initialStatus?: WorkStatus;
  initialSort?: LibrarySort;
  initialQuery?: string;
  workKey?: string;
  onOpenAdd?: (opts?: {
    category?: Category;
    work?: ManualWork;
    editingEntry?: {
      entry_id: string;
      work: ManualWork;
      consumed: ArchiveConsumed;
      when: ArchiveWhen;
      rating?: number | null;
      note?: string | null;
    };
  }) => void;
}

const STATUS_TABS: ReadonlyArray<TabOption<WorkStatus | "all">> = [
  { value: "all", label: "All Works" },
  { value: "in_progress", label: "In Progress" },
  { value: "finished", label: "Finished" },
];

const SORT_OPTIONS: ReadonlyArray<{ value: LibrarySort; label: string }> = [
  { value: "recent", label: "Recently active" },
  { value: "time", label: "Most time" },
  { value: "title", label: "Title A–Z" },
];

function formatWorkStatusLabel(status: WorkStatus): string {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "finished":
      return "Finished";
    case "dropped":
      return "Dropped";
    case "unknown":
      return "Logged";
  }
}

function statusBadgeVariant(
  status: WorkStatus
): "success" | "warning" | "neutral" {
  switch (status) {
    case "finished":
      return "success";
    case "in_progress":
      return "warning";
    default:
      return "neutral";
  }
}

function buildManualWorkFromDetail(detail: LibraryWorkDetail): ManualWork {
  return {
    provider: "manual",
    category: detail.category,
    title: detail.title,
    year: detail.seasons[0]?.year ?? null,
    creators: [],
    seasons:
      detail.seasons.length > 0
        ? detail.seasons.map((s) => ({
            number: s.number,
            title: s.title,
            year: s.year,
            episodes: s.episodes,
            episode_minutes: s.episode_minutes,
            total_minutes: s.total_minutes,
            provider_id: s.provider_id,
          }))
        : detail.category === "anime" || detail.category === "series"
          ? [
              {
                number: 1,
                title: "Season 1",
                year: null,
                episodes: Math.max(12, detail.units || 12),
                episode_minutes: 24,
                total_minutes: Math.max(12, detail.units || 12) * 24,
                provider_id: null,
              },
            ]
          : [],
    runtime_minutes:
      detail.category === "film"
        ? Math.max(90, Math.round(detail.total_minutes / Math.max(1, detail.units)))
        : null,
    pages: null,
  };
}

export function Library({
  initialCategory,
  initialStatus,
  initialSort = "recent",
  initialQuery = "",
  workKey,
  onOpenAdd,
}: LibraryProps) {
  const [category, setCategory] = useState<Category | "">(
    initialCategory ?? ""
  );
  const [statusFilter, setStatusFilter] = useState<WorkStatus | "all">(
    initialStatus ?? "all"
  );
  const [sort, setSort] = useState<LibrarySort>(initialSort);
  const [searchInput, setSearchInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const [libraryData, setLibraryData] = useState<LibraryResult | null>(null);
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntrySummary[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Work detail state (`#/library?work=<key>`)
  const [workDetail, setWorkDetail] = useState<LibraryWorkDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (initialCategory !== undefined) {
      setCategory(initialCategory);
    }
  }, [initialCategory]);

  useEffect(() => {
    if (initialStatus !== undefined) {
      setStatusFilter(initialStatus);
    }
  }, [initialStatus]);

  useEffect(() => {
    if (initialQuery !== undefined) {
      setSearchInput(initialQuery);
      setQuery(initialQuery);
    }
  }, [initialQuery]);

  // Debounce search query
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setQuery(searchInput.trim());
    }, 220);
    return () => window.clearTimeout(debounceRef.current);
  }, [searchInput]);

  // Fetch Library list + archive summaries
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      getLibrary({
        category: category || undefined,
        q: query || undefined,
        sort,
      }),
      listArchive(category || undefined).catch(() => [] as ArchiveEntrySummary[]),
    ])
      .then(([libRes, archRes]) => {
        if (cancelled) return;
        setLibraryData(libRes);
        setArchiveEntries(archRes);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [category, query, sort, refreshTick]);

  // Fetch single work detail when `workKey` is present
  useEffect(() => {
    if (!workKey) {
      setWorkDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    getLibraryWork(workKey)
      .then((res) => {
        if (cancelled) return;
        setWorkDetail(res);
        setDetailLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setDetailError(err instanceof Error ? err.message : String(err));
        setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workKey, refreshTick]);

  const categoryTabs = useMemo<TabOption<Category | "">[]>(() => {
    const catTotals = libraryData?.categories ?? [];
    const totalWorks = catTotals.reduce((acc, c) => acc + c.works, 0);
    const orderedCats = CATEGORIES.filter(
      (c) => catTotals.some((ct) => ct.category === c) || c === category
    );

    return [
      {
        value: "",
        label: "All",
        count:
          libraryData && libraryData.total_minutes > 0
            ? `${formatHours(libraryData.total_minutes)} · ${totalWorks}`
            : totalWorks || undefined,
      },
      ...orderedCats.map((cat) => {
        const entry = catTotals.find((c) => c.category === cat);
        const countStr = entry
          ? entry.total_minutes > 0
            ? `${formatHours(entry.total_minutes)} · ${entry.works}`
            : `${entry.works}`
          : undefined;
        return {
          value: cat,
          label: categoryPluralLabel(cat),
          category: cat,
          count: countStr,
        };
      }),
    ];
  }, [libraryData, category]);

  const filteredWorks = useMemo<LibraryWork[]>(() => {
    const works = libraryData?.works ?? [];
    if (statusFilter === "all") {
      return works;
    }
    return works.filter((w) => w.status === statusFilter);
  }, [libraryData, statusFilter]);

  const handleDeleteArchive = async (entryId: string) => {
    setDeletingEntryId(entryId);
    try {
      await deleteArchiveEntry(entryId);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntryId(null);
    }
  };

  // --- WORK DETAIL PAGE VIEW (`#/library?work=<key>`) ---
  if (workKey) {
    const backHref = category
      ? `#/library?category=${category}`
      : "#/library";

    const workArchiveEntryIds = Array.from(
      new Set(
        (workDetail?.history ?? [])
          .map((h) => h.entry_id)
          .filter((id): id is string => Boolean(id))
      )
    );

    return (
      <section
        class="page-container library-detail-page"
        aria-label={workDetail?.title ?? "Work Detail"}
      >
        <div class="library-back-row">
          <Button variant="ghost" size="sm" href={backHref}>
            ← Back to Library
          </Button>
        </div>

        {detailError && (
          <div class="calendar-error" role="alert">
            <span>
              <strong>Could not load work:</strong> {detailError}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRefreshTick((t) => t + 1)}
            >
              Retry
            </Button>
          </div>
        )}

        {detailLoading && !workDetail && (
          <Card padding="lg">
            <div class="library-detail-skeleton" aria-busy="true">
              <Skeleton width={120} height={180} />
              <div class="library-detail-skeleton-lines">
                <Skeleton width="60%" height={32} />
                <Skeleton width="40%" height={20} />
                <Skeleton width="80%" height={60} />
              </div>
            </div>
          </Card>
        )}

        {workDetail && (
          <>
            {/* Work Hero Card */}
            <Card padding="lg" class="library-work-hero">
              <div class="library-work-hero-layout">
                <Cover
                  src={workDetail.cover_url}
                  title={workDetail.title}
                  category={workDetail.category}
                  size="xl"
                  aspect={CATEGORY_META[workDetail.category].defaultAspect}
                />

                <div class="library-work-hero-body">
                  <div class="library-work-badges">
                    <Badge
                      size="md"
                      category={workDetail.category}
                      icon={
                        <CategoryIcon
                          category={workDetail.category}
                          size={13}
                        />
                      }
                    >
                      {categoryLabel(workDetail.category)}
                    </Badge>
                    <Badge
                      size="md"
                      variant={statusBadgeVariant(workDetail.status)}
                    >
                      {formatWorkStatusLabel(workDetail.status)}
                    </Badge>
                    {workDetail.sources.map((src) => (
                      <Badge key={src} size="sm" variant="neutral">
                        {sourceLabel(src)}
                      </Badge>
                    ))}
                  </div>

                  <h1 class="library-work-title">{workDetail.title}</h1>

                  <div class="library-work-stats-row tabular-nums">
                    <span>
                      <strong>{formatMinutes(workDetail.total_minutes)}</strong>{" "}
                      total time
                    </span>
                    <span>·</span>
                    <span>
                      <strong>
                        {formatCategoryUnits(
                          workDetail.category,
                          workDetail.units
                        )}
                      </strong>
                    </span>
                    {workDetail.first_at && (
                      <>
                        <span>·</span>
                        <span>
                          Active{" "}
                          {formatLocalDay(workDetail.first_at.slice(0, 10))}
                          {workDetail.last_at &&
                          workDetail.last_at.slice(0, 10) !==
                            workDetail.first_at.slice(0, 10)
                            ? ` – ${formatLocalDay(
                                workDetail.last_at.slice(0, 10)
                              )}`
                            : ""}
                        </span>
                      </>
                    )}
                  </div>

                  <div class="library-work-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      leadingIcon={<AddIcon size={15} />}
                      onClick={() => {
                        const manualWork = buildManualWorkFromDetail(workDetail);
                        if (onOpenAdd) {
                          onOpenAdd({
                            category: workDetail.category,
                            work: manualWork,
                          });
                        } else {
                          window.location.hash = `#/add?category=${
                            workDetail.category
                          }&q=${encodeURIComponent(workDetail.title)}`;
                        }
                      }}
                    >
                      {workDetail.category === "anime" ||
                      workDetail.category === "series"
                        ? "Add more seasons"
                        : "Add more to archive"}
                    </Button>

                    {workArchiveEntryIds.map((entryId) => {
                      const summary = archiveEntries.find(
                        (e) => e.entry_id === entryId
                      );
                      return (
                        <div key={entryId} class="library-work-archive-btns">
                          <Button
                            variant="secondary"
                            size="sm"
                            leadingIcon={<EditIcon size={14} />}
                            onClick={() => {
                              const manualWork =
                                buildManualWorkFromDetail(workDetail);
                              onOpenAdd?.({
                                category: workDetail.category,
                                editingEntry: {
                                  entry_id: entryId,
                                  work: manualWork,
                                  consumed: summary?.consumed ?? {
                                    seasons: workDetail.seasons
                                      .filter((s) => s.watched_episodes > 0)
                                      .map((s) =>
                                        s.watched_episodes < s.episodes
                                          ? {
                                              number: s.number,
                                              episodes: s.watched_episodes,
                                            }
                                          : { number: s.number }
                                      ),
                                    times: Math.max(1, workDetail.units),
                                    progress: 1,
                                  },
                                  when: summary?.when ?? {
                                    precision: "unknown",
                                  },
                                  rating: workDetail.rating,
                                  note: workDetail.note,
                                },
                              });
                            }}
                          >
                            Edit Archive Entry
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            leadingIcon={<TrashIcon size={14} />}
                            disabled={deletingEntryId === entryId}
                            onClick={() => void handleDeleteArchive(entryId)}
                          >
                            {deletingEntryId === entryId
                              ? "Deleting…"
                              : "Delete"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Card>

            {/* Seasons Progress (for Series / Anime) */}
            {workDetail.seasons.length > 0 && (
              <Card
                padding="md"
                title="Seasons Progress"
                subtitle={`${
                  workDetail.seasons.filter(
                    (s) => s.watched_episodes >= s.episodes && s.episodes > 0
                  ).length
                } of ${workDetail.seasons.length} seasons finished`}
              >
                <div class="library-seasons-grid">
                  {workDetail.seasons.map((season) => {
                    const maxEp = Math.max(1, season.episodes);
                    const watched = Math.min(maxEp, season.watched_episodes);
                    return (
                      <div key={season.number} class="library-season-row">
                        <ProgressBar
                          value={watched}
                          max={maxEp}
                          category={workDetail.category}
                          label={
                            <strong>
                              {season.title || `Season ${season.number}`}
                              {season.year ? ` (${season.year})` : ""}
                            </strong>
                          }
                          valueLabel={`${watched} / ${season.episodes} ep`}
                        />
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            <div class="library-work-two-col">
              {/* Rating & Note */}
              <Card
                padding="md"
                title="Rating & Personal Note"
                subtitle="Stored in your append-only annotations log"
              >
                <RatingEditor
                  source={workDetail.sources[0] ?? "manual"}
                  title={workDetail.title}
                  initialRating={workDetail.rating}
                  initialNote={workDetail.note}
                  skipFetch={workDetail.note !== null}
                  onSaved={(ann) =>
                    setWorkDetail((prev) =>
                      prev
                        ? { ...prev, rating: ann.rating, note: ann.note }
                        : prev
                    )
                  }
                />
              </Card>

              {/* History Timeline */}
              <Card
                padding="md"
                title="Activity & Archive History"
                subtitle={`${workDetail.history.length} recorded ${
                  workDetail.history.length === 1 ? "unit" : "units"
                }`}
              >
                {workDetail.history.length === 0 ? (
                  <p class="ui-text-muted">No individual history items.</p>
                ) : (
                  <ul class="library-history-list">
                    {workDetail.history.map((item, idx) => (
                      <li
                        key={`${item.started_at}-${idx}`}
                        class="library-history-row"
                      >
                        <div class="library-history-main">
                          <span class="library-history-label">
                            {item.label}
                          </span>
                          <span class="library-history-meta tabular-nums">
                            {item.precision === "day" ? (
                              <a
                                href={`#/calendar?date=${item.started_at.slice(
                                  0,
                                  10
                                )}`}
                              >
                                {formatHistoryPrecisionDate(
                                  item.started_at,
                                  item.precision
                                )}
                              </a>
                            ) : (
                              formatHistoryPrecisionDate(
                                item.started_at,
                                item.precision
                              )
                            )}
                            {" · "}
                            {sourceLabel(item.source)}
                            {item.entry_id ? " (Archive)" : ""}
                          </span>
                        </div>
                        <div class="library-history-right tabular-nums">
                          {item.minutes > 0 && (
                            <span class="library-history-min">
                              {formatMinutes(item.minutes)}
                            </span>
                          )}
                          {item.entry_id && (
                            <button
                              type="button"
                              class="ui-inline-danger-btn"
                              title="Delete archive entry"
                              disabled={deletingEntryId === item.entry_id}
                              onClick={() =>
                                void handleDeleteArchive(item.entry_id!)
                              }
                            >
                              <TrashIcon size={14} />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}
      </section>
    );
  }

  // --- MAIN LIBRARY SHELF VIEW (`#/library`) ---
  return (
    <section class="page-container library-page" aria-label="Library">
      <header class="page-header">
        <div class="page-header-titles">
          <span class="page-eyebrow">Curated Shelf & Archive</span>
          <h1>Library</h1>
          <p class="page-subtitle">
            Everything you have watched, read, and listened to — grouped by work
            across every source.
          </p>
        </div>
        <div class="page-header-actions">
          <Button
            variant="primary"
            size="sm"
            href={category ? `#/add?category=${category}` : "#/add"}
            onClick={
              onOpenAdd
                ? (e) => {
                    e.preventDefault();
                    onOpenAdd({ category: category || undefined });
                  }
                : undefined
            }
            leadingIcon={<AddIcon size={16} />}
          >
            Add to Archive
          </Button>
        </div>
      </header>

      {/* Category Share Overview Strip */}
      {libraryData && libraryData.categories.length > 0 && (
        <Card padding="md" class="library-overview-card">
          <div class="library-overview-grid">
            <Stat
              label="Total Library Time"
              value={formatMinutes(libraryData.total_minutes)}
              category={category || undefined}
              sublabel={`${filteredWorks.length} ${
                filteredWorks.length === 1 ? "work" : "works"
              } shown`}
            />
            <div class="library-overview-share">
              <span class="ui-stat-label">Time by Category</span>
              <CategoryShareChart
                categories={libraryData.categories}
                selectedCategory={category}
                onSelectCategory={(cat) => setCategory(cat)}
                compact
                title="Library time by category"
              />
            </div>
          </div>
        </Card>
      )}

      {/* Category Tabs */}
      <div class="library-category-tabs">
        <Tabs
          ariaLabel="Library categories"
          options={categoryTabs}
          value={category}
          onChange={(val) => setCategory(val)}
          variant="pills"
        />
      </div>

      {/* Filter, Search & Sort Controls */}
      <div class="library-controls-bar">
        <Tabs
          ariaLabel="Filter by work status"
          options={STATUS_TABS}
          value={statusFilter}
          onChange={(val) => setStatusFilter(val)}
        />

        <div class="library-controls-right">
          <div class="library-search-box">
            <span class="library-search-icon" aria-hidden="true">
              <SearchIcon size={15} />
            </span>
            <input
              type="search"
              class="ui-input library-search-input"
              placeholder="Filter works…"
              aria-label="Filter library works"
              value={searchInput}
              onInput={(e) =>
                setSearchInput((e.currentTarget as HTMLInputElement).value)
              }
            />
          </div>

          <select
            class="ui-input library-sort-select"
            aria-label="Sort library works"
            value={sort}
            onChange={(e) =>
              setSort((e.currentTarget as HTMLSelectElement).value as LibrarySort)
            }
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <Tabs
            ariaLabel="View density"
            options={[
              { value: "grid", label: "Covers" },
              { value: "list", label: "List" },
            ]}
            value={viewMode}
            onChange={(v) => setViewMode(v)}
          />
        </div>
      </div>

      {error && (
        <div class="calendar-error" role="alert">
          <span>
            <strong>Could not load library:</strong> {error}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRefreshTick((t) => t + 1)}
          >
            Retry
          </Button>
        </div>
      )}

      {loading && !libraryData ? (
        <div class="library-works-grid" aria-busy="true">
          {Array.from({ length: 8 }).map((_, idx) => (
            <Skeleton key={idx} height={240} />
          ))}
        </div>
      ) : filteredWorks.length === 0 ? (
        <EmptyState
          title={
            query
              ? `No works matching “${query}”`
              : category
                ? `No ${categoryPluralLabel(category).toLowerCase()} in your library yet`
                : "Your library is empty"
          }
          description="Look up anime, series, films, books, or audiobooks you have consumed in the past to build your personal archive."
          actions={
            <Button
              variant="primary"
              size="md"
              href={category ? `#/add?category=${category}` : "#/add"}
              onClick={
                onOpenAdd
                  ? (e) => {
                      e.preventDefault();
                      onOpenAdd({ category: category || undefined });
                    }
                  : undefined
              }
              leadingIcon={<AddIcon size={16} />}
            >
              Add to archive
            </Button>
          }
        />
      ) : viewMode === "grid" ? (
        <div class="library-works-grid">
          {filteredWorks.map((work) => {
            const stars = ratingToStars(work.rating);
            const workHref = `#/library?work=${encodeURIComponent(work.key)}${
              category ? `&category=${category}` : ""
            }`;
            return (
              <a
                key={work.key}
                href={workHref}
                class="library-work-card"
                title={work.title}
              >
                <div class="library-work-cover-wrap">
                  <Cover
                    src={work.cover_url}
                    title={work.title}
                    category={work.category}
                    size="fill"
                    aspect="poster"
                  />
                  {stars !== null && (
                    <span
                      class="library-work-rating-pill tabular-nums"
                      aria-label={`Rated ${stars} of 5 stars`}
                    >
                      ★ {formatStarValue(stars)}
                    </span>
                  )}
                  {work.status === "in_progress" && (
                    <span class="library-work-status-dot" title="In progress" />
                  )}
                </div>

                <div class="library-work-card-body">
                  <div class="library-work-card-title">{work.title}</div>
                  <div class="library-work-card-meta tabular-nums">
                    <span
                      class={`ui-tab-dot ui-tab-dot--${work.category}`}
                      aria-hidden="true"
                    />
                    <span>
                      {work.total_minutes > 0
                        ? formatMinutes(work.total_minutes)
                        : formatCategoryUnits(work.category, work.units)}
                    </span>
                    {work.total_minutes > 0 && work.units > 1 && (
                      <>
                        <span>·</span>
                        <span>
                          {formatCategoryUnits(work.category, work.units)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      ) : (
        <Card padding="none">
          <ul class="library-works-list">
            {filteredWorks.map((work) => {
              const stars = ratingToStars(work.rating);
              const workHref = `#/library?work=${encodeURIComponent(work.key)}${
                category ? `&category=${category}` : ""
              }`;
              return (
                <li key={work.key}>
                  <a href={workHref} class="library-work-list-row">
                    <Cover
                      src={work.cover_url}
                      title={work.title}
                      category={work.category}
                      size="sm"
                      aspect="square"
                    />
                    <div class="library-work-list-info">
                      <span
                        class="library-work-list-title"
                        title={work.title}
                      >
                        {work.title}
                      </span>
                      <span class="library-work-list-sub">
                        <Badge size="sm" category={work.category}>
                          {categoryLabel(work.category)}
                        </Badge>
                        <span>{formatWorkStatusLabel(work.status)}</span>
                        {work.last_at && (
                          <span class="tabular-nums">
                            · {formatLocalDay(work.last_at.slice(0, 10))}
                          </span>
                        )}
                      </span>
                    </div>
                    <div class="library-work-list-stats tabular-nums">
                      {stars !== null && (
                        <span class="library-work-list-stars">
                          ★ {formatStarValue(stars)}
                        </span>
                      )}
                      <strong>
                        {work.total_minutes > 0
                          ? formatMinutes(work.total_minutes)
                          : formatCategoryUnits(work.category, work.units)}
                      </strong>
                      <span>
                        {formatCategoryUnits(work.category, work.units)}
                      </span>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Recent Archive Entries Management Strip */}
      {archiveEntries.length > 0 && (
        <Card
          padding="md"
          title="Recent Archive Entries"
          subtitle="Entries added by hand — edit or remove any entry"
        >
          <ul class="library-archive-entries-list">
            {archiveEntries.slice(0, 8).map((entry) => (
              <li key={entry.entry_id} class="library-archive-entry-row">
                <Cover
                  src={entry.cover_url}
                  title={entry.title}
                  category={entry.category}
                  size="sm"
                  aspect="square"
                />
                <div class="library-archive-entry-info">
                  <strong>{entry.title}</strong>
                  <span class="ui-text-muted tabular-nums">
                    {categoryLabel(entry.category)} ·{" "}
                    {formatArchiveWhen(entry.when)} ·{" "}
                    {formatMinutes(entry.total_minutes)}
                  </span>
                </div>
                <div class="library-archive-entry-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<EditIcon size={14} />}
                    onClick={() => {
                      const manualWork = workFromArchiveSummary(entry);
                      onOpenAdd?.({
                        category: entry.category,
                        editingEntry: {
                          entry_id: entry.entry_id,
                          work: manualWork,
                          consumed: entry.consumed,
                          when: entry.when,
                        },
                      });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    leadingIcon={<TrashIcon size={14} />}
                    disabled={deletingEntryId === entry.entry_id}
                    onClick={() => void handleDeleteArchive(entry.entry_id)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
