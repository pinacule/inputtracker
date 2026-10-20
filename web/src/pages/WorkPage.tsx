import { useEffect, useMemo, useState } from "preact/hooks";
import {
  deleteArchiveEntry,
  getLibraryWork,
  refreshWorkMetadata,
  type ArchiveEntrySummary,
  type LibraryWorkDetail,
  type WorkStatus,
} from "../api";
import type { OpenArchiveOptions } from "../lib/archive-form";
import {
  CATEGORY_META,
  categoryLabel,
  formatCompactSeasonRow,
  formatReadableHistoryItem,
  formatWorkDetailProgress,
  formatWorkUnitLabel,
} from "../lib/categories";
import { formatLocalDay } from "../lib/format-date";
import { canRateCategory } from "../lib/rating";
import { sourceLabel } from "../lib/sources";
import { formatMinutes } from "../lib/stats";
import {
  applyWorkOverrideToDetail,
  pushToast,
  subscribeWorkEdits,
} from "../lib/work-edits";
import {
  AddIcon,
  Badge,
  Button,
  Card,
  CategoryIcon,
  CheckIcon,
  Cover,
  EditIcon,
  QuickRatingPill,
  RatingEditor,
  Skeleton,
  TrashIcon,
  bindContextMenu,
  type EditableWorkTarget,
} from "../ui";

export interface WorkPageProps {
  workKey: string;
  backHref: string;
  archiveEntries?: readonly ArchiveEntrySummary[];
  onOpenAdd?: (opts?: OpenArchiveOptions) => void;
  onOpenEditWork?: (work: EditableWorkTarget) => void;
  onChanged?: () => void;
}

export function formatWorkStatusLabel(status: WorkStatus): string {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "finished":
      return "Finished";
    case "dropped":
      return "Dropped";
    case "planned":
      return "Planned";
    case "unknown":
      return "Logged";
  }
}

export function statusBadgeVariant(
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

export function WorkPage({
  workKey,
  backHref,
  onOpenAdd,
  onOpenEditWork,
  onChanged,
}: WorkPageProps) {
  const [workDetail, setWorkDetail] = useState<LibraryWorkDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refreshingMeta, setRefreshingMeta] = useState(false);
  const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<
    string | null
  >(null);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [overrideTick, setOverrideTick] = useState(0);

  useEffect(() => {
    return subscribeWorkEdits(() => setOverrideTick((t) => t + 1));
  }, []);

  useEffect(() => {
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

  const effectiveWorkDetail = useMemo(
    () => (workDetail ? applyWorkOverrideToDetail(workDetail) : null),
    [workDetail, overrideTick]
  );

  const handleRefreshMetadata = async () => {
    if (!effectiveWorkDetail || refreshingMeta) return;
    setRefreshingMeta(true);
    try {
      const res = await refreshWorkMetadata(effectiveWorkDetail.key);
      if (
        typeof res.minutes_before === "number" &&
        typeof res.minutes_after === "number"
      ) {
        if (res.changed && res.minutes_before !== res.minutes_after) {
          pushToast({
            message: `Refreshed “${effectiveWorkDetail.title}”: ${formatMinutes(
              res.minutes_before
            )} → ${formatMinutes(res.minutes_after)}`,
            variant: "success",
          });
        } else {
          pushToast({
            message: `Metadata is up to date for “${effectiveWorkDetail.title}”`,
            variant: "info",
          });
        }
      } else {
        pushToast({
          message: `Refreshed metadata for “${effectiveWorkDetail.title}”`,
          variant: "success",
        });
      }
      setRefreshTick((t) => t + 1);
      onChanged?.();
    } catch {
      // Degrade gracefully on 404 or provider unavailability
      pushToast({
        message: "Metadata refresh is not available for this work yet",
        variant: "info",
      });
    } finally {
      setRefreshingMeta(false);
    }
  };

  const handleDeleteArchive = async (entryId: string) => {
    setDeletingEntryId(entryId);
    try {
      await deleteArchiveEntry(entryId);
      setConfirmDeleteEntryId(null);
      setRefreshTick((t) => t + 1);
      onChanged?.();
      pushToast({
        message: "Archive entry deleted",
        variant: "info",
      });
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntryId(null);
    }
  };

  const workArchiveEntryIds = Array.from(
    new Set(
      (effectiveWorkDetail?.history ?? [])
        .map((h) => h.entry_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  const detailProgressText = effectiveWorkDetail
    ? formatWorkDetailProgress(effectiveWorkDetail)
    : null;

  const detailUnitText = effectiveWorkDetail
    ? effectiveWorkDetail.category === "series" ||
      effectiveWorkDetail.category === "anime"
      ? null
      : formatWorkUnitLabel(effectiveWorkDetail)
    : null;

  const creatorName =
    effectiveWorkDetail?.creator?.trim() ||
    effectiveWorkDetail?.channel?.trim() ||
    null;

  const ratable = canRateCategory(effectiveWorkDetail?.category);

  const hasDatedActivity = useMemo(() => {
    if (!effectiveWorkDetail) return false;
    return effectiveWorkDetail.history.some((h) => h.precision !== "unknown");
  }, [effectiveWorkDetail]);

  return (
    <section
      class="page-container library-detail-page"
      aria-label={effectiveWorkDetail?.title ?? "Work Detail"}
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

      {detailLoading && !effectiveWorkDetail && (
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

      {effectiveWorkDetail && (
        <>
          {/* Work Hero Card */}
          <Card padding="lg" class="work-hero-card">
            <div
              class="work-hero-layout"
              {...bindContextMenu({
                kind: "work",
                workKey: effectiveWorkDetail.key,
                title: effectiveWorkDetail.title,
                category: effectiveWorkDetail.category,
                status: effectiveWorkDetail.status,
                rating: effectiveWorkDetail.rating,
                note: effectiveWorkDetail.note,
                topic: effectiveWorkDetail.topic,
                channel: effectiveWorkDetail.channel,
                entryId: workArchiveEntryIds[0] ?? null,
              })}
            >
              <Cover
                src={effectiveWorkDetail.cover_url}
                title={effectiveWorkDetail.title}
                category={effectiveWorkDetail.category}
                size="xl"
                aspect={
                  CATEGORY_META[effectiveWorkDetail.category].defaultAspect
                }
              />

              <div class="work-hero-body">
                {/* Top Badges & In-Place Rating */}
                <div class="work-hero-badges">
                  <Badge
                    size="md"
                    category={effectiveWorkDetail.category}
                    icon={
                      <CategoryIcon
                        category={effectiveWorkDetail.category}
                        size={13}
                      />
                    }
                  >
                    {categoryLabel(effectiveWorkDetail.category)}
                  </Badge>
                  <Badge
                    size="md"
                    variant={statusBadgeVariant(effectiveWorkDetail.status)}
                  >
                    {formatWorkStatusLabel(effectiveWorkDetail.status)}
                  </Badge>
                  {effectiveWorkDetail.topic && (
                    <Badge size="sm" variant="neutral">
                      {effectiveWorkDetail.topic}
                    </Badge>
                  )}
                  {effectiveWorkDetail.edited && (
                    <Badge size="sm" variant="neutral">
                      Edited
                    </Badge>
                  )}
                  {ratable && (
                    <QuickRatingPill
                      workKey={effectiveWorkDetail.key}
                      title={effectiveWorkDetail.title}
                      category={effectiveWorkDetail.category}
                      rating={effectiveWorkDetail.rating}
                      source={effectiveWorkDetail.sources[0] ?? "manual"}
                      variant="inline"
                      onRated={(next) =>
                        setWorkDetail((prev) =>
                          prev ? { ...prev, rating: next } : prev
                        )
                      }
                    />
                  )}
                </div>

                {/* Title & Creator / Channel / Artist */}
                <div class="work-hero-title-group">
                  <h1 class="library-work-title">
                    {effectiveWorkDetail.title}
                  </h1>
                  {creatorName && (
                    <p class="work-hero-creator">
                      {effectiveWorkDetail.category === "youtube" ? (
                        <a
                          href={`#/library?cat=youtube&channel=${encodeURIComponent(
                            creatorName
                          )}`}
                          class="ui-inline-link"
                        >
                          {creatorName}
                        </a>
                      ) : effectiveWorkDetail.category === "music" ? (
                        <a
                          href={`#/library?cat=music&q=${encodeURIComponent(
                            creatorName
                          )}`}
                          class="ui-inline-link"
                        >
                          {creatorName}
                        </a>
                      ) : (
                        creatorName
                      )}
                    </p>
                  )}
                </div>

                {/* Key Metrics Strip */}
                <div class="work-hero-metrics tabular-nums">
                  {effectiveWorkDetail.status === "planned" &&
                  effectiveWorkDetail.total_minutes === 0 ? (
                    <div class="work-metric-pill">
                      <span class="work-metric-label">Status</span>
                      <strong>Watchlist (0m)</strong>
                    </div>
                  ) : (
                    <div class="work-metric-pill">
                      <span class="work-metric-label">Total time</span>
                      <strong>
                        {formatMinutes(effectiveWorkDetail.total_minutes)}
                      </strong>
                    </div>
                  )}

                  {detailProgressText && (
                    <div class="work-metric-pill">
                      <span class="work-metric-label">Progress</span>
                      <strong>{detailProgressText}</strong>
                    </div>
                  )}

                  {detailUnitText && (
                    <div class="work-metric-pill">
                      <span class="work-metric-label">Recorded</span>
                      <strong>{detailUnitText}</strong>
                    </div>
                  )}

                  {hasDatedActivity && effectiveWorkDetail.first_at && (
                    <div class="work-metric-pill">
                      <span class="work-metric-label">Active</span>
                      <strong>
                        {formatLocalDay(
                          effectiveWorkDetail.first_at.slice(0, 10)
                        )}
                        {effectiveWorkDetail.last_at &&
                        effectiveWorkDetail.last_at.slice(0, 10) !==
                          effectiveWorkDetail.first_at.slice(0, 10)
                          ? ` – ${formatLocalDay(
                              effectiveWorkDetail.last_at.slice(0, 10)
                            )}`
                          : ""}
                      </strong>
                    </div>
                  )}

                  {effectiveWorkDetail.sources.length > 0 && (
                    <div class="work-metric-pill">
                      <span class="work-metric-label">Source</span>
                      <strong>
                        {effectiveWorkDetail.sources
                          .map((s) =>
                            s === "manual" ? "Archive" : sourceLabel(s)
                          )
                          .join(", ")}
                      </strong>
                    </div>
                  )}
                </div>

                {/* Grouped Action Bar */}
                <div class="work-actions-toolbar">
                  <div class="work-actions-group">
                    <Button
                      variant="primary"
                      size="sm"
                      leadingIcon={<AddIcon size={15} />}
                      onClick={() => {
                        if (onOpenAdd) {
                          onOpenAdd({
                            category: effectiveWorkDetail.category,
                            workKey: effectiveWorkDetail.key,
                          });
                        } else {
                          window.location.hash = `#/add?category=${
                            effectiveWorkDetail.category
                          }&q=${encodeURIComponent(effectiveWorkDetail.title)}`;
                        }
                      }}
                    >
                      {effectiveWorkDetail.category === "anime" ||
                      effectiveWorkDetail.category === "series"
                        ? "Add seasons"
                        : "Log again"}
                    </Button>

                    <Button
                      variant="secondary"
                      size="sm"
                      leadingIcon={<EditIcon size={14} />}
                      onClick={() =>
                        onOpenEditWork?.({
                          key: effectiveWorkDetail.key,
                          title: effectiveWorkDetail.title,
                          category: effectiveWorkDetail.category,
                          status: effectiveWorkDetail.status,
                          rating: effectiveWorkDetail.rating,
                          note: effectiveWorkDetail.note,
                          topic: effectiveWorkDetail.topic,
                          channel: effectiveWorkDetail.channel,
                          cover_url: effectiveWorkDetail.cover_url,
                          edited: effectiveWorkDetail.edited,
                        })
                      }
                    >
                      Edit work
                    </Button>

                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={refreshingMeta}
                      onClick={() => void handleRefreshMetadata()}
                    >
                      {refreshingMeta ? "Refreshing…" : "Refresh metadata"}
                    </Button>
                  </div>

                  {workArchiveEntryIds.length > 0 && (
                    <div class="work-actions-group work-actions-group--archive">
                      {workArchiveEntryIds.map((entryId, idx) => {
                        const isConfirming = confirmDeleteEntryId === entryId;
                        const suffix =
                          workArchiveEntryIds.length > 1
                            ? ` #${idx + 1}`
                            : "";
                        return (
                          <div key={entryId} class="work-archive-entry-btns">
                            <Button
                              variant="ghost"
                              size="sm"
                              leadingIcon={<EditIcon size={14} />}
                              onClick={() => {
                                onOpenAdd?.({
                                  category: effectiveWorkDetail.category,
                                  entryId,
                                });
                              }}
                            >
                              {`Edit entry${suffix}`}
                            </Button>

                            {isConfirming ? (
                              <>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  disabled={deletingEntryId === entryId}
                                  onClick={() =>
                                    void handleDeleteArchive(entryId)
                                  }
                                >
                                  {deletingEntryId === entryId
                                    ? "Deleting…"
                                    : "Confirm delete"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setConfirmDeleteEntryId(null)}
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="danger"
                                size="sm"
                                leadingIcon={<TrashIcon size={14} />}
                                onClick={() => setConfirmDeleteEntryId(entryId)}
                              >
                                {`Delete entry${suffix}`}
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Card>

          {/* Compact Seasons Grid (for Series & Anime) */}
          {effectiveWorkDetail.seasons.length > 0 && (
            <Card
              padding="md"
              title="Seasons"
              subtitle={
                detailProgressText ??
                `${effectiveWorkDetail.seasons.length} ${
                  effectiveWorkDetail.seasons.length === 1
                    ? "season"
                    : "seasons"
                }`
              }
            >
              <div class="work-seasons-compact-grid">
                {effectiveWorkDetail.seasons.map((season) => {
                  const row = formatCompactSeasonRow(season);
                  return (
                    <div
                      key={season.number}
                      class={
                        row.isFinished
                          ? `work-season-pill work-season-pill--finished work-season-pill--${effectiveWorkDetail.category}`
                          : row.isInProgress
                            ? `work-season-pill work-season-pill--partial work-season-pill--${effectiveWorkDetail.category}`
                            : "work-season-pill"
                      }
                    >
                      <div class="work-season-pill-top">
                        <div class="work-season-pill-title">
                          <span
                            class={
                              row.isFinished
                                ? "work-season-check work-season-check--done"
                                : "work-season-check"
                            }
                            aria-hidden="true"
                          >
                            {row.isFinished ? <CheckIcon size={12} /> : null}
                          </span>
                          <span class="work-season-summary tabular-nums">
                            <strong>{row.heading}</strong>
                            {row.meta && (
                              <span class="work-season-meta">
                                {" · "}
                                {row.meta}
                              </span>
                            )}
                          </span>
                        </div>
                        <span class="work-season-count tabular-nums">
                          {row.statusLabel}
                        </span>
                      </div>
                      <div
                        class="work-season-bar-track"
                        aria-hidden="true"
                      >
                        <div
                          class={`work-season-bar-fill work-season-bar-fill--${effectiveWorkDetail.category}`}
                          style={{
                            width: `${Math.round(row.ratio * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Two-Column Note/Rating + Readable History */}
          <div class="library-work-two-col">
            <Card
              padding="md"
              title={ratable ? "Rating & Personal Note" : "Personal Note"}
              subtitle={
                ratable
                  ? "Click the ★ badge to edit your 0–10 rating in place"
                  : "Notes are stored append-only"
              }
            >
              <RatingEditor
                workKey={effectiveWorkDetail.key}
                category={effectiveWorkDetail.category}
                source={effectiveWorkDetail.sources[0] ?? "manual"}
                title={effectiveWorkDetail.title}
                initialRating={effectiveWorkDetail.rating}
                initialNote={effectiveWorkDetail.note}
                skipFetch
                onSaved={(ann) =>
                  setWorkDetail((prev) =>
                    prev
                      ? { ...prev, rating: ann.rating, note: ann.note }
                      : prev
                  )
                }
              />
            </Card>

            <Card
              padding="md"
              title="History"
              subtitle={
                effectiveWorkDetail.history.length > 0
                  ? `${effectiveWorkDetail.history.length} recorded ${
                      effectiveWorkDetail.history.length === 1
                        ? "entry"
                        : "entries"
                    }`
                  : undefined
              }
            >
              {effectiveWorkDetail.history.length === 0 ? (
                <p class="ui-text-muted">
                  {effectiveWorkDetail.status === "planned"
                    ? "Planned on your watchlist — no activity logged yet."
                    : "No individual history items."}
                </p>
              ) : (
                <ul class="library-history-list">
                  {effectiveWorkDetail.history.map((item, idx) => {
                    const formatted = formatReadableHistoryItem(
                      item,
                      effectiveWorkDetail.title
                    );
                    return (
                      <li
                        key={`${item.started_at}-${idx}`}
                        class="library-history-row"
                      >
                        <div class="library-history-main">
                          <span class="library-history-label">
                            {formatted.label}
                          </span>
                          {formatted.metaText && (
                            <span class="library-history-meta tabular-nums">
                              {formatted.dateLabel && formatted.dateHref ? (
                                <>
                                  <a href={formatted.dateHref}>
                                    {formatted.dateLabel}
                                  </a>
                                  {formatted.sourceBadge
                                    ? ` · ${formatted.sourceBadge}`
                                    : ""}
                                </>
                              ) : (
                                formatted.metaText
                              )}
                            </span>
                          )}
                        </div>
                        <div class="library-history-right tabular-nums">
                          {formatted.minutesLabel && (
                            <span class="library-history-min">
                              {formatted.minutesLabel}
                            </span>
                          )}
                          {item.entry_id && (
                            <button
                              type="button"
                              class="ui-inline-danger-btn"
                              title="Delete archive entry"
                              aria-label="Delete archive entry"
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
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </section>
  );
}
