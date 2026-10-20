import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { MostPlayed } from "../ui/MostPlayed";
import {
  deleteArchiveEntry,
  getLibrary,
  getYoutubeOverview,
  getYoutubeVideos,
  listArchive,
  type ArchiveEntrySummary,
  type Category,
  type LibraryResult,
  type LibrarySort,
  type LibraryWork,
  type WorkStatus,
  type YoutubeOverview,
  type YoutubeVideo,
  type YoutubeVideoSort,
} from "../api";
import { formatArchiveWhen } from "../lib/archive-form";
import type { OpenArchiveOptions } from "../lib/archive-form";
import {
  CATEGORY_META,
  categoryLabel,
  categoryPluralLabel,
  formatWorkCardMeta,
  formatWorkUnitLabel,
} from "../lib/categories";
import {
  buildLibraryCategoryFilterParams,
  matchesLibraryCategorySelection,
} from "../lib/category-filter";
import { formatLocalDay } from "../lib/format-date";
import { canRateCategory } from "../lib/rating";
import { formatMinutes } from "../lib/stats";
import {
  applyWorkOverridesToList,
  getChannelTopicOverride,
  performSetChannelTopic,
  pushToast,
  subscribeWorkEdits,
} from "../lib/work-edits";
import {
  UNCATEGORISED_TOPIC,
  buildYoutubeOverviewFromWorks,
  buildYoutubeVideosFromWorks,
  collectYoutubeTopics,
  groupYoutubeVideos,
  sortLibraryWorks,
  sortYoutubeVideos,
  type YoutubeVideoGroupBy,
} from "../lib/youtube";
import {
  AddIcon,
  Badge,
  Button,
  Card,
  CategoryChips,
  CategoryShareChart,
  Cover,
  EditIcon,
  EmptyState,
  MoreIcon,
  QuickRatingPill,
  SearchIcon,
  Skeleton,
  Stat,
  Tabs,
  TrashIcon,
  bindContextMenu,
  openContextMenu,
  type EditableWorkTarget,
  type TabOption,
} from "../ui";
import { WorkPage, formatWorkStatusLabel } from "./WorkPage";

export interface LibraryProps {
  initialCategory?: Category;
  initialCategories?: readonly Category[];
  initialStatus?: WorkStatus;
  initialSort?: LibrarySort;
  initialQuery?: string;
  initialChannel?: string;
  initialTopic?: string;
  workKey?: string;
  /** @deprecated Kept for callers that still pass it; Library "All" always excludes YouTube and Music. */
  includeYoutubeInAll?: boolean;
  onOpenAdd?: (opts?: OpenArchiveOptions) => void;
  onOpenEditWork?: (work: EditableWorkTarget) => void;
}

const STATUS_TABS: ReadonlyArray<TabOption<WorkStatus | "all">> = [
  { value: "all", label: "All Works" },
  { value: "in_progress", label: "In Progress" },
  { value: "finished", label: "Finished" },
  { value: "planned", label: "Planned" },
  { value: "dropped", label: "Dropped" },
];

const YOUTUBE_SORT_TABS: ReadonlyArray<TabOption<YoutubeVideoSort>> = [
  { value: "plays", label: "Most played" },
  { value: "recent", label: "Recent" },
  { value: "time", label: "Watch time" },
  { value: "topic", label: "Category / Topic" },
];

const YOUTUBE_GROUP_TABS: ReadonlyArray<TabOption<YoutubeVideoGroupBy>> = [
  { value: "none", label: "Videos" },
  { value: "topic", label: "Group by topic" },
  { value: "channel", label: "Group by channel" },
];

function buildSortOptions(
  singleCategory?: Category
): ReadonlyArray<{ value: LibrarySort; label: string }> {
  if (singleCategory === "music") {
    return [
      { value: "plays", label: "Most played" },
      { value: "recent", label: "Recent" },
      { value: "time", label: "Watch / listen time" },
      { value: "creator", label: "Artist" },
      { value: "title", label: "Title A–Z" },
    ];
  }
  const creatorLabel =
    singleCategory === "book" || singleCategory === "audiobook"
      ? "Author"
      : "Creator / Artist";
  return [
    { value: "recent", label: "Recently active" },
    { value: "time", label: "Watch / read time" },
    { value: "category", label: "Category" },
    { value: "creator", label: creatorLabel },
    { value: "title", label: "Title A–Z" },
  ];
}

interface YoutubeLibrarySectionProps {
  fallbackWorks: readonly LibraryWork[];
  initialChannel?: string;
  initialTopic?: string;
  initialQuery?: string;
}

function YoutubeLibrarySection({
  fallbackWorks,
  initialChannel,
  initialTopic,
  initialQuery = "",
}: YoutubeLibrarySectionProps) {
  const [overview, setOverview] = useState<YoutubeOverview | null>(null);
  const [rawVideos, setRawVideos] = useState<YoutubeVideo[]>([]);
  const [videosTotal, setVideosTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [selectedTopic, setSelectedTopic] = useState<string | null>(
    initialTopic ?? null
  );
  const [selectedChannel, setSelectedChannel] = useState<string | null>(
    initialChannel ?? null
  );
  const [ytSort, setYtSort] = useState<YoutubeVideoSort>("plays");
  const [groupBy, setGroupBy] = useState<YoutubeVideoGroupBy>("none");
  const [searchInput, setSearchInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);

  // Quick "Set Topic" editor for a channel
  const [editingChannelTopic, setEditingChannelTopic] = useState<string | null>(
    null
  );
  const [topicInput, setTopicInput] = useState("");
  const [, setOverrideTick] = useState(0);

  useEffect(() => {
    return subscribeWorkEdits(() => setOverrideTick((t) => t + 1));
  }, []);

  useEffect(() => {
    if (initialChannel !== undefined) {
      setSelectedChannel(initialChannel || null);
    }
  }, [initialChannel]);

  useEffect(() => {
    if (initialTopic !== undefined) {
      setSelectedTopic(initialTopic || null);
    }
  }, [initialTopic]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchInput.trim());
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Fetch /api/youtube overview (fallback gracefully on 404)
  useEffect(() => {
    let cancelled = false;

    getYoutubeOverview()
      .then((res) => {
        if (cancelled) return;
        setOverview(res);
      })
      .catch(() => {
        if (cancelled) return;
        setOverview(buildYoutubeOverviewFromWorks(fallbackWorks));
      });

    return () => {
      cancelled = true;
    };
  }, [fallbackWorks]);

  // Always fetch YouTube videos for the YouTube chip view
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const reqParams = {
      channel: selectedChannel ?? undefined,
      topic:
        selectedTopic && selectedTopic !== UNCATEGORISED_TOPIC
          ? selectedTopic
          : undefined,
      q: query || undefined,
      sort: ytSort,
      limit: 200,
    };

    getYoutubeVideos(reqParams)
      .catch(() =>
        getYoutubeVideos({
          channel: reqParams.channel,
          topic: reqParams.topic,
          q: reqParams.q,
          limit: reqParams.limit,
        })
      )
      .then((res) => {
        if (cancelled) return;
        const list = res.videos ?? [];
        setRawVideos(list);
        setVideosTotal(res.total ?? list.length);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = buildYoutubeVideosFromWorks(fallbackWorks, {
          channel: selectedChannel ?? undefined,
          topic: selectedTopic ?? undefined,
          q: query || undefined,
          sort: ytSort,
        });
        setRawVideos(fallback.videos);
        setVideosTotal(fallback.total);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedChannel, selectedTopic, query, ytSort, fallbackWorks]);

  const effectiveOverview = useMemo<YoutubeOverview>(() => {
    const base = overview ?? buildYoutubeOverviewFromWorks(fallbackWorks);
    const updatedChannels = (base.channels ?? []).map((ch) => ({
      ...ch,
      topic: getChannelTopicOverride(ch.channel, ch.topic),
    }));
    return {
      ...base,
      channels: updatedChannels,
    };
  }, [overview, fallbackWorks]);

  const sortedVideos = useMemo(() => {
    const withOverrides = rawVideos.map((v) => ({
      ...v,
      topic: v.channel
        ? getChannelTopicOverride(v.channel, v.topic)
        : v.topic,
    }));
    return sortYoutubeVideos(withOverrides, ytSort);
  }, [rawVideos, ytSort]);

  const groupedVideos = useMemo(() => {
    if (groupBy === "none") return [];
    return groupYoutubeVideos(sortedVideos, groupBy, ytSort);
  }, [sortedVideos, groupBy, ytSort]);

  const availableTopics = useMemo(
    () => collectYoutubeTopics(effectiveOverview),
    [effectiveOverview]
  );

  const totalShownMinutes = useMemo(
    () =>
      sortedVideos.reduce((acc, v) => acc + Math.max(0, v.watched_minutes), 0),
    [sortedVideos]
  );

  const maxVideoMin = useMemo(
    () => sortedVideos.reduce((m, v) => Math.max(m, v.watched_minutes), 1),
    [sortedVideos]
  );

  const handleSaveChannelTopic = async (
    channelName: string,
    nextTopic: string | null
  ) => {
    const prevTopic =
      effectiveOverview.channels.find((c) => c.channel === channelName)?.topic ??
      null;
    setEditingChannelTopic(null);
    const { undo } = await performSetChannelTopic(
      channelName,
      nextTopic,
      prevTopic
    );
    pushToast({
      message: nextTopic
        ? `Set topic for “${channelName}” to ${nextTopic}`
        : `Cleared topic for “${channelName}”`,
      variant: "success",
      actionLabel: "Undo",
      onAction: () => {
        void undo();
      },
    });
  };

  const renderVideoRow = (v: YoutubeVideo) => {
    const pct = Math.max(
      6,
      Math.round((v.watched_minutes / maxVideoMin) * 100)
    );
    const playsCount = Math.max(1, v.plays || 1);
    const playsLabel = `${playsCount} ${playsCount === 1 ? "play" : "plays"}`;
    const menuTarget = {
      kind: "youtube-video" as const,
      workKey: v.key,
      title: v.title,
      category: "youtube" as const,
      channel: v.channel,
      topic: v.topic,
      href: `#/library?work=${encodeURIComponent(v.key)}&cat=youtube`,
    };

    return (
      <li
        key={v.key}
        class="yt-video-row"
        tabIndex={0}
        {...bindContextMenu(menuTarget)}
      >
        {v.thumbnail_url && (
          <Cover
            src={v.thumbnail_url}
            title={v.title}
            category="youtube"
            size="sm"
            aspect="wide"
          />
        )}
        <div class="yt-video-main">
          <a
            href={`#/library?work=${encodeURIComponent(v.key)}&cat=youtube`}
            class="yt-video-title"
          >
            {v.title}
          </a>
          <div class="yt-video-meta tabular-nums">
            {v.channel && (
              <>
                <button
                  type="button"
                  class="ui-inline-link"
                  onClick={() => {
                    setSelectedChannel(v.channel);
                    window.history.replaceState(
                      null,
                      "",
                      `#/library?cat=youtube&channel=${encodeURIComponent(
                        v.channel!
                      )}`
                    );
                  }}
                >
                  {v.channel}
                </button>
                <span>·</span>
              </>
            )}
            <span>{formatLocalDay(v.last_at.slice(0, 10))}</span>
            <span>·</span>
            <span>{playsLabel}</span>
            {v.topic && (
              <button
                type="button"
                class="ui-cat-chip yt-set-topic-btn"
                onClick={() => {
                  setSelectedTopic(v.topic);
                  window.history.replaceState(
                    null,
                    "",
                    `#/library?cat=youtube&topic=${encodeURIComponent(
                      v.topic!
                    )}`
                  );
                }}
              >
                {v.topic}
              </button>
            )}
          </div>
          <div class="yt-bar-track">
            <div class="yt-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div class="calendar-compact-right tabular-nums">
          <strong>{formatMinutes(v.watched_minutes)}</strong>
          <QuickRatingPill
            workKey={v.key}
            title={v.title}
            category="youtube"
            rating={null}
            source="youtube"
          />
          <button
            type="button"
            class="ui-row-menu-btn"
            aria-label={`More actions for ${v.title}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const rect = (
                e.currentTarget as HTMLElement
              ).getBoundingClientRect();
              openContextMenu(
                menuTarget,
                { x: rect.left, y: rect.bottom + 4 },
                e.currentTarget as HTMLElement
              );
            }}
          >
            <MoreIcon size={16} />
          </button>
        </div>
      </li>
    );
  };

  return (
    <div class="yt-view-stack">
      {/* YouTube Overview KPI, Sort, Group & Search */}
      <Card padding="md">
        <div class="yt-overview-top">
          <div class="yt-overview-stats">
            <Stat
              label="YouTube Watch Time"
              value={formatMinutes(
                selectedChannel || selectedTopic || query
                  ? totalShownMinutes
                  : effectiveOverview.total_minutes || totalShownMinutes
              )}
              category="youtube"
              sublabel={`${
                videosTotal || sortedVideos.length
              } videos · ${effectiveOverview.channels.length} channels`}
            />
            {effectiveOverview.short_plays_hidden > 0 && (
              <span class="yt-short-plays-note tabular-nums">
                {effectiveOverview.short_plays_hidden} short{" "}
                {effectiveOverview.short_plays_hidden === 1 ? "play" : "plays"}{" "}
                (&lt; {effectiveOverview.min_watch_minutes}m) hidden
              </span>
            )}
          </div>

          <div class="yt-search-wrap">
            <span class="library-search-icon" aria-hidden="true">
              <SearchIcon size={15} />
            </span>
            <input
              type="search"
              class="ui-input library-search-input"
              placeholder="Search YouTube videos, channels, or topics…"
              aria-label="Search within YouTube"
              value={searchInput}
              onInput={(e) =>
                setSearchInput((e.currentTarget as HTMLInputElement).value)
              }
            />
          </div>
        </div>
      </Card>

      {/* Active Channel / Topic Filter Banner */}
      {(selectedChannel || selectedTopic) && (
        <div class="yt-active-filters-bar">
          <div class="ui-cat-chips">
            {selectedChannel && (
              <Badge size="md" category="youtube">
                Channel: {selectedChannel}
              </Badge>
            )}
            {selectedTopic && (
              <Badge size="md" variant="neutral">
                Topic: {selectedTopic}
              </Badge>
            )}
          </div>
          <div class="ui-form-actions">
            {selectedChannel && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const chInfo = effectiveOverview.channels.find(
                    (c) =>
                      c.channel.toLowerCase() === selectedChannel.toLowerCase()
                  );
                  setTopicInput(chInfo?.topic ?? "");
                  setEditingChannelTopic(
                    editingChannelTopic === selectedChannel
                      ? null
                      : selectedChannel
                  );
                }}
              >
                Set channel topic…
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedChannel(null);
                setSelectedTopic(null);
                window.history.replaceState(null, "", "#/library?cat=youtube");
              }}
            >
              × Clear filter
            </Button>
          </div>
        </div>
      )}

      {selectedChannel && editingChannelTopic === selectedChannel && (
        <Card padding="sm">
          <div class="yt-topic-editor-bar">
            <input
              type="text"
              class="ui-input"
              placeholder={`Topic for ${selectedChannel}…`}
              value={topicInput}
              onInput={(e) =>
                setTopicInput((e.currentTarget as HTMLInputElement).value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveChannelTopic(selectedChannel, topicInput);
                }
              }}
            />
            <div class="ui-cat-chips">
              {availableTopics.slice(0, 8).map((t) => (
                <button
                  key={t}
                  type="button"
                  class="ui-cat-chip"
                  onClick={() =>
                    void handleSaveChannelTopic(selectedChannel, t)
                  }
                >
                  {t}
                </button>
              ))}
            </div>
            <div class="ui-form-actions">
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  void handleSaveChannelTopic(selectedChannel, topicInput)
                }
              >
                Save Topic
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleSaveChannelTopic(selectedChannel, null)}
              >
                Clear
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingChannelTopic(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Sort & Group Controls */}
      <div class="library-controls-bar">
        <Tabs
          ariaLabel="Sort YouTube videos"
          options={YOUTUBE_SORT_TABS}
          value={ytSort}
          onChange={(v) => setYtSort(v)}
        />
        <Tabs
          ariaLabel="Group YouTube videos"
          options={YOUTUBE_GROUP_TABS}
          value={groupBy}
          onChange={(v) => setGroupBy(v)}
        />
      </div>

      {loading && rawVideos.length === 0 ? (
        <Skeleton height={220} />
      ) : sortedVideos.length === 0 ? (
        <EmptyState
          compact
          title={
            query
              ? `No YouTube videos matching “${query}”`
              : "No YouTube videos recorded yet"
          }
          description="YouTube videos above your minimum watch time appear here, sortable by recent, watch time, or topic."
        />
      ) : groupBy === "none" ? (
        <Card
          padding="md"
          title={`Videos (${sortedVideos.length})`}
          subtitle={`${formatMinutes(totalShownMinutes)} total watch time`}
        >
          <ul class="yt-videos-list">{sortedVideos.map(renderVideoRow)}</ul>
        </Card>
      ) : (
        <div class="yt-topics-stack">
          {groupedVideos.map((group) => {
            const isEditingCh =
              group.kind === "channel" && editingChannelTopic === group.label;
            return (
              <Card key={group.key} padding="md" class="yt-topic-card">
                <div class="yt-topic-header">
                  <div class="yt-topic-title-col">
                    <div class="yt-topic-title-row">
                      <span
                        class="ui-tab-dot ui-tab-dot--youtube"
                        aria-hidden="true"
                      />
                      <h3 class="yt-topic-name">{group.label}</h3>
                      {group.kind === "channel" && group.topic && (
                        <Badge size="sm" variant="neutral">
                          {group.topic}
                        </Badge>
                      )}
                      <span class="yt-topic-counts tabular-nums">
                        {group.videosCount}{" "}
                        {group.videosCount === 1 ? "video" : "videos"}
                      </span>
                    </div>
                    <div class="yt-bar-track yt-bar-track--topic">
                      <div
                        class="yt-bar-fill"
                        style={{
                          width: `${Math.round(group.barRatio * 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div class="yt-topic-figures tabular-nums">
                    <strong>{formatMinutes(group.totalMinutes)}</strong>
                    <span class="ui-text-muted">{group.sharePct}%</span>
                    {group.kind === "channel" && (
                      <button
                        type="button"
                        class="ui-cat-chip yt-set-topic-btn"
                        onClick={() => {
                          setTopicInput(group.topic ?? "");
                          setEditingChannelTopic(
                            isEditingCh ? null : group.label
                          );
                        }}
                      >
                        {group.topic ? "Edit topic" : "Set topic…"}
                      </button>
                    )}
                  </div>
                </div>

                {isEditingCh && (
                  <div class="yt-topic-editor-bar">
                    <input
                      type="text"
                      class="ui-input"
                      placeholder={`Topic for ${group.label}…`}
                      value={topicInput}
                      onInput={(e) =>
                        setTopicInput(
                          (e.currentTarget as HTMLInputElement).value
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleSaveChannelTopic(group.label, topicInput);
                        }
                      }}
                    />
                    <div class="ui-cat-chips">
                      {availableTopics.slice(0, 6).map((t) => (
                        <button
                          key={t}
                          type="button"
                          class="ui-cat-chip"
                          onClick={() =>
                            void handleSaveChannelTopic(group.label, t)
                          }
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <div class="ui-form-actions">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() =>
                          void handleSaveChannelTopic(group.label, topicInput)
                        }
                      >
                        Save
                      </Button>
                      {group.topic && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            void handleSaveChannelTopic(group.label, null)
                          }
                        >
                          Clear
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingChannelTopic(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                <ul class="yt-videos-list">
                  {group.videos.map(renderVideoRow)}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Library({
  initialCategory,
  initialCategories,
  initialStatus,
  initialSort,
  initialQuery = "",
  initialChannel,
  initialTopic,
  workKey,
  onOpenAdd,
  onOpenEditWork,
}: LibraryProps) {
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(
    () => {
      if (initialCategories && initialCategories.length > 0) {
        return [...initialCategories];
      }
      if (initialCategory) {
        return [initialCategory];
      }
      return [];
    }
  );
  const [statusFilter, setStatusFilter] = useState<WorkStatus | "all">(
    initialStatus ?? "all"
  );
  const [sort, setSort] = useState<LibrarySort>(initialSort ?? ((initialCategories?.[0] ?? initialCategory) === "music" ? "plays" : "recent"));
  const [searchInput, setSearchInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [viewMode, setViewMode] = useState<"grid" | "list">((initialCategories?.[0] ?? initialCategory) === "music" ? "list" : "grid");

  const [libraryData, setLibraryData] = useState<LibraryResult | null>(null);
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntrySummary[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<
    string | null
  >(null);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [overrideTick, setOverrideTick] = useState(0);

  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return subscribeWorkEdits(() => setOverrideTick((t) => t + 1));
  }, []);

  useEffect(() => {
    if (initialCategories !== undefined) {
      setSelectedCategories([...initialCategories]);
    } else if (initialCategory !== undefined) {
      setSelectedCategories(initialCategory ? [initialCategory] : []);
    }
  }, [initialCategory, initialCategories]);

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

  // Fetch Library list + archive summaries (Library "All" excludes YouTube and Music)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const filterParams = buildLibraryCategoryFilterParams(selectedCategories);

    const fetchLib = getLibrary({
      category: filterParams.category,
      exclude: filterParams.exclude,
      q: query || undefined,
      sort,
    }).catch(() =>
      // Fallback if backend doesn't yet accept v2.2 sort values (`category`/`creator`)
      getLibrary({
        category: filterParams.category,
        exclude: filterParams.exclude,
        q: query || undefined,
        sort:
          sort === "recent" || sort === "time" || sort === "title"
            ? sort
            : "recent",
      }).catch(() =>
        getLibrary({
          q: query || undefined,
          sort: "recent",
        })
      )
    );

    const fetchArch = listArchive({
      category: filterParams.category,
      exclude: filterParams.exclude,
    }).catch(() => listArchive().catch(() => [] as ArchiveEntrySummary[]));

    Promise.all([fetchLib, fetchArch])
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
  }, [selectedCategories, query, sort, refreshTick]);

  const effectiveWorks = useMemo(
    () => applyWorkOverridesToList(libraryData?.works ?? []),
    [libraryData, overrideTick]
  );

  const filteredWorks = useMemo<LibraryWork[]>(() => {
    const matched = effectiveWorks.filter((w) => {
      if (!matchesLibraryCategorySelection(w.category, selectedCategories)) {
        return false;
      }
      if (statusFilter !== "all" && w.status !== statusFilter) {
        return false;
      }
      if (query) {
        const qNorm = query.toLowerCase();
        const inTitle = w.title.toLowerCase().includes(qNorm);
        const inCreator = (w.creator ?? w.channel ?? "")
          .toLowerCase()
          .includes(qNorm);
        if (!inTitle && !inCreator) {
          return false;
        }
      }
      return true;
    });
    return sortLibraryWorks(matched, sort);
  }, [effectiveWorks, selectedCategories, statusFilter, query, sort]);

  const handleDeleteArchive = async (entryId: string) => {
    setDeletingEntryId(entryId);
    try {
      await deleteArchiveEntry(entryId);
      setConfirmDeleteEntryId(null);
      setRefreshTick((t) => t + 1);
      pushToast({
        message: "Archive entry deleted",
        variant: "info",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntryId(null);
    }
  };

  const singleCategory =
    selectedCategories.length === 1 ? selectedCategories[0] : undefined;
  const isYoutubeView = singleCategory === "youtube";
  const isMusicView = singleCategory === "music";
  const rankMax = Math.max(1, ...filteredWorks.map((w) => sort === "plays" ? w.units : w.total_minutes));
  useEffect(() => {
    if (initialSort) setSort(initialSort);
    else setSort(isMusicView ? "plays" : "recent");
    if (isMusicView) setViewMode("list");
  }, [isMusicView, initialSort]);
  const sortOptions = useMemo(
    () => buildSortOptions(singleCategory),
    [singleCategory]
  );

  // --- WORK DETAIL PAGE VIEW (`#/library?work=<key>`) ---
  if (workKey) {
    const backHref =
      selectedCategories.length > 0
        ? `#/library?cat=${selectedCategories.join(",")}`
        : "#/library";

    return (
      <WorkPage
        workKey={workKey}
        backHref={backHref}
        archiveEntries={archiveEntries}
        onOpenAdd={onOpenAdd}
        onOpenEditWork={onOpenEditWork}
        onChanged={() => setRefreshTick((t) => t + 1)}
      />
    );
  }

  // --- MAIN LIBRARY SHELF VIEW (`#/library`) ---
  return (
    <section class="page-container library-page" aria-label="Library">
      {(isMusicView || isYoutubeView) && <MostPlayed initialRange="all" categories={[isMusicView ? "music" : "youtube"]} />}
      <header class="page-header">
        <div class="page-header-titles">
          <h1>Library</h1>
          <p class="page-subtitle">
            {isYoutubeView
              ? "YouTube videos watched — sort by plays, watch time, recent, or topic, and group by topic or channel."
              : isMusicView
                ? "Music tracks played — sort by recent, listen time, or artist."
                : "Books, audiobooks, films, series, anime, and podcasts across every source."}
          </p>
        </div>
        <div class="page-header-actions">
          <Button
            variant="primary"
            size="sm"
            href={singleCategory ? `#/add?category=${singleCategory}` : "#/add"}
            onClick={
              onOpenAdd
                ? (e) => {
                    e.preventDefault();
                    onOpenAdd({ category: singleCategory });
                  }
                : undefined
            }
            leadingIcon={<AddIcon size={16} />}
          >
            Add to Archive
          </Button>
        </div>
      </header>

      {/* Multi-Select Category Chips (YouTube & Music chips live here; "All" excludes both) */}
      <CategoryChips
        selected={selectedCategories}
        onChange={setSelectedCategories}
        totals={libraryData?.categories ?? []}
        scope="library"
        ariaLabel="Library categories"
        showCounts="hours-works"
      />

      {/* Library › YouTube Videos View when the YouTube chip is active */}
      {isYoutubeView ? (
        <YoutubeLibrarySection
          fallbackWorks={effectiveWorks}
          initialChannel={initialChannel}
          initialTopic={initialTopic}
          initialQuery={initialQuery}
        />
      ) : (
        <>
          {/* Category Share Overview Strip */}
          {libraryData && libraryData.categories.length > 0 && (
            <Card padding="md" class="library-overview-card">
              <div class="library-overview-grid">
                <Stat
                  label={isMusicView ? "Music Listening Time" : "Library Time"}
                  value={formatMinutes(
                    filteredWorks.reduce((acc, w) => acc + w.total_minutes, 0)
                  )}
                  category={singleCategory}
                  sublabel={`${filteredWorks.length} ${
                    isMusicView
                      ? filteredWorks.length === 1
                        ? "track"
                        : "tracks"
                      : filteredWorks.length === 1
                        ? "work"
                        : "works"
                  } shown`}
                />
                <div class="library-overview-share">
                  <span class="ui-stat-label">Time by Category</span>
                  <CategoryShareChart
                    categories={libraryData.categories.filter((c) =>
                      matchesLibraryCategorySelection(
                        c.category,
                        selectedCategories
                      )
                    )}
                    selectedCategory={singleCategory ?? ""}
                    onSelectCategory={(cat) =>
                      setSelectedCategories(cat ? [cat] : [])
                    }
                    compact
                    title="Library time by category"
                  />
                </div>
              </div>
            </Card>
          )}

          {/* Filter, Search & Sort Controls */}
          <div class="library-controls-bar">
            {!isMusicView ? (
              <Tabs
                ariaLabel="Filter by work status"
                options={STATUS_TABS}
                value={statusFilter}
                onChange={(val) => setStatusFilter(val)}
              />
            ) : (
              <Tabs
                ariaLabel="Sort music tracks"
                options={[
                  { value: "recent" as LibrarySort, label: "Recent" },
                  { value: "time" as LibrarySort, label: "Watch / listen time" },
                  { value: "creator" as LibrarySort, label: "Artist" },
                ]}
                value={
                  sort === "recent" || sort === "time" || sort === "creator"
                    ? sort
                    : "recent"
                }
                onChange={(val) => setSort(val)}
              />
            )}

            <div class="library-controls-right">
              <div class="library-search-box">
                <span class="library-search-icon" aria-hidden="true">
                  <SearchIcon size={15} />
                </span>
                <input
                  type="search"
                  class="ui-input library-search-input"
                  placeholder={
                    isMusicView ? "Filter tracks or artists…" : "Filter works…"
                  }
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
                  setSort(
                    (e.currentTarget as HTMLSelectElement).value as LibrarySort
                  )
                }
              >
                {sortOptions.map((opt) => (
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
                  : statusFilter === "planned"
                    ? "Your watchlist is empty"
                    : singleCategory
                      ? `No ${categoryPluralLabel(
                          singleCategory
                        ).toLowerCase()} in your library yet`
                      : "No works match the current filters"
              }
              description="Look up anime, series, films, books, or audiobooks to archive or add to your planned watchlist."
              actions={
                <Button
                  variant="primary"
                  size="md"
                  href={
                    singleCategory ? `#/add?category=${singleCategory}` : "#/add"
                  }
                  onClick={
                    onOpenAdd
                      ? (e) => {
                          e.preventDefault();
                          onOpenAdd({ category: singleCategory });
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
                const catQuery =
                  selectedCategories.length > 0
                    ? `&cat=${selectedCategories.join(",")}`
                    : "";
                const workHref = `#/library?work=${encodeURIComponent(
                  work.key
                )}${catQuery}`;
                const creatorText = work.creator ?? work.channel ?? null;
                const cardMetaText = formatWorkCardMeta(work);
                const ratable = canRateCategory(work.category);
                const menuTarget = {
                  kind: "work" as const,
                  workKey: work.key,
                  title: work.title,
                  category: work.category,
                  status: work.status,
                  rating: work.rating,
                  channel: work.channel,
                  topic: work.topic,
                  href: workHref,
                  source: work.sources[0] ?? "manual",
                };

                return (
                  <div
                    key={work.key}
                    class="library-work-card"
                    tabIndex={0}
                    {...bindContextMenu(menuTarget)}
                  >
                    <div class="library-work-cover-wrap">
                      <a href={workHref} class="library-work-cover-link">
                        <Cover
                          src={work.cover_url}
                          title={work.title}
                          category={work.category}
                          size="fill"
                          aspect={
                            work.category === "music" ||
                            work.category === "audiobook" ||
                            work.category === "podcast"
                              ? "square"
                              : "poster"
                          }
                        />
                      </a>
                      {ratable && (
                        <QuickRatingPill
                          workKey={work.key}
                          title={work.title}
                          category={work.category}
                          rating={work.rating}
                          source={work.sources[0] ?? "manual"}
                          variant="overlay"
                        />
                      )}
                      {work.status === "in_progress" && (
                        <span
                          class="library-work-status-dot"
                          title="In progress"
                        />
                      )}
                      {work.status === "planned" && (
                        <span
                          class="library-work-planned-badge"
                          title="Planned (Watchlist)"
                        >
                          Planned
                        </span>
                      )}
                    </div>

                    <div class="library-work-card-body">
                      <a
                        href={workHref}
                        class="library-work-card-title"
                        title={work.title}
                      >
                        {work.title}
                      </a>
                      {creatorText && (
                        <span
                          class="library-work-card-creator"
                          title={creatorText}
                        >
                          {creatorText}
                        </span>
                      )}
                      <div class="library-work-card-meta tabular-nums">
                        <span
                          class={`ui-tab-dot ui-tab-dot--${work.category}`}
                          aria-hidden="true"
                        />
                        <span>{cardMetaText}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Card padding="none">
              <ul class="library-works-list">
                {filteredWorks.map((work, rank) => {
                  const catQuery =
                    selectedCategories.length > 0
                      ? `&cat=${selectedCategories.join(",")}`
                      : "";
                  const workHref = `#/library?work=${encodeURIComponent(
                    work.key
                  )}${catQuery}`;
                  const creatorText = work.creator ?? work.channel ?? null;
                  const unitLabel = formatWorkUnitLabel(work);
                  const ratable = canRateCategory(work.category);
                  const menuTarget = {
                    kind: "work" as const,
                    workKey: work.key,
                    title: work.title,
                    category: work.category,
                    status: work.status,
                    rating: work.rating,
                    channel: work.channel,
                    topic: work.topic,
                    href: workHref,
                    source: work.sources[0] ?? "manual",
                  };

                  return (
                    <li
                      key={work.key}
                      class="library-work-list-row"
                      tabIndex={0}
                      {...bindContextMenu(menuTarget)}
                    >
                      <a href={workHref} class="library-work-list-main">
                        <Cover
                          src={work.cover_url}
                          title={work.title}
                          category={work.category}
                          size="sm"
                          aspect={
                            CATEGORY_META[work.category].defaultAspect ===
                            "poster"
                              ? "poster"
                              : "square"
                          }
                        />
                        <div class="library-work-list-info">
                          <span
                            class="library-work-list-title"
                            title={work.title}
                          >
                            {isMusicView && (sort === "plays" || sort === "time") ? `${rank + 1}. ` : ""}{work.title}
                          </span>
                          {isMusicView && (sort === "plays" || sort === "time") && <div class="yt-bar-track" aria-hidden="true"><div class="yt-bar-fill" style={{ backgroundColor: "var(--cat-music-solid)", width: `${100 * (sort === "plays" ? work.units : work.total_minutes) / rankMax}%` }} /></div>}
                          <span class="library-work-list-sub">
                            <Badge size="sm" category={work.category}>
                              {categoryLabel(work.category)}
                            </Badge>
                            {creatorText && (
                              <span class="library-work-list-creator">
                                {creatorText}
                              </span>
                            )}
                            {work.category !== "music" && (
                              <span>{formatWorkStatusLabel(work.status)}</span>
                            )}
                            {work.last_at && (
                              <span class="tabular-nums">
                                · {formatLocalDay(work.last_at.slice(0, 10))}
                              </span>
                            )}
                          </span>
                        </div>
                      </a>
                      <div class="library-work-list-right tabular-nums">
                        {ratable && (
                          <QuickRatingPill
                            workKey={work.key}
                            title={work.title}
                            category={work.category}
                            rating={work.rating}
                            source={work.sources[0] ?? "manual"}
                            variant="inline"
                          />
                        )}
                        <div class="library-work-list-stats">
                          <strong>
                            {work.status === "planned"
                              ? unitLabel ?? "Planned"
                              : work.total_minutes > 0
                                ? formatMinutes(work.total_minutes)
                                : unitLabel ??
                                  formatWorkStatusLabel(work.status)}
                          </strong>
                          {work.status !== "planned" &&
                            work.total_minutes > 0 &&
                            unitLabel && <span>{unitLabel}</span>}
                        </div>
                        <button
                          type="button"
                          class="ui-row-menu-btn"
                          aria-label={`More actions for ${work.title}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const rect = (
                              e.currentTarget as HTMLElement
                            ).getBoundingClientRect();
                            openContextMenu(
                              menuTarget,
                              { x: rect.left, y: rect.bottom + 4 },
                              e.currentTarget as HTMLElement
                            );
                          }}
                        >
                          <MoreIcon size={16} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {/* Recent Archive Entries Management Strip */}
          {archiveEntries.length > 0 && !isMusicView && (
            <Card
              padding="md"
              title="Archive & Imported Entries"
              subtitle="Entries added by hand or imported — edit seasons/dates or remove any entry"
            >
              <ul class="library-archive-entries-list">
                {archiveEntries.slice(0, 10).map((entry) => {
                  const isConfirming = confirmDeleteEntryId === entry.entry_id;
                  const menuTarget = {
                    kind: "archive-entry" as const,
                    workKey: `${entry.category}:${entry.title.toLowerCase()}`,
                    title: entry.title,
                    category: entry.category,
                    entryId: entry.entry_id,
                    consumed: entry.consumed,
                    when: entry.when,
                  };
                  return (
                    <li
                      key={entry.entry_id}
                      class="library-archive-entry-row"
                      tabIndex={0}
                      {...bindContextMenu(menuTarget)}
                    >
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
                            onOpenAdd?.({
                              category: entry.category,
                              entryId: entry.entry_id,
                            });
                          }}
                        >
                          Edit Entry
                        </Button>
                        {isConfirming ? (
                          <>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={deletingEntryId === entry.entry_id}
                              onClick={() =>
                                void handleDeleteArchive(entry.entry_id)
                              }
                            >
                              {deletingEntryId === entry.entry_id
                                ? "Deleting…"
                                : "Confirm"}
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
                            onClick={() =>
                              setConfirmDeleteEntryId(entry.entry_id)
                            }
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
