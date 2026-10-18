import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  deleteArchiveEntry,
  getLibrary,
  getLibraryWork,
  getYoutubeOverview,
  getYoutubeVideos,
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
  type YoutubeOverview,
  type YoutubeVideo,
} from "../api";
import {
  formatArchiveWhen,
  formatHistoryPrecisionDate,
} from "../lib/archive-form";
import {
  CATEGORY_META,
  categoryLabel,
  categoryPluralLabel,
  formatCategoryUnits,
} from "../lib/categories";
import {
  buildCategoryFilterParams,
  matchesCategorySelection,
} from "../lib/category-filter";
import { formatLocalDay } from "../lib/format-date";
import { sourceLabel } from "../lib/sources";
import { formatMinutes } from "../lib/stats";
import {
  applyWorkOverrideToDetail,
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
  groupYoutubeByTopic,
} from "../lib/youtube";
import {
  AddIcon,
  Badge,
  Button,
  Card,
  CategoryChips,
  CategoryIcon,
  CategoryShareChart,
  Cover,
  EditIcon,
  EmptyState,
  MoreIcon,
  ProgressBar,
  QuickRatingPill,
  RatingEditor,
  SearchIcon,
  Skeleton,
  Stat,
  Tabs,
  TrashIcon,
  YoutubeIcon,
  bindContextMenu,
  openContextMenu,
  type EditableWorkTarget,
  type TabOption,
} from "../ui";
import { workFromArchiveSummary } from "./Add";

export interface LibraryProps {
  initialCategory?: Category;
  initialCategories?: readonly Category[];
  initialStatus?: WorkStatus;
  initialSort?: LibrarySort;
  initialQuery?: string;
  initialChannel?: string;
  initialTopic?: string;
  workKey?: string;
  includeYoutubeInAll?: boolean;
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
  onOpenEditWork?: (work: EditableWorkTarget) => void;
}

const STATUS_TABS: ReadonlyArray<TabOption<WorkStatus | "all">> = [
  { value: "all", label: "All Works" },
  { value: "in_progress", label: "In Progress" },
  { value: "finished", label: "Finished" },
  { value: "planned", label: "Planned" },
  { value: "dropped", label: "Dropped" },
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
    case "planned":
      return "Planned";
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
        ? Math.max(
            90,
            Math.round(detail.total_minutes / Math.max(1, detail.units))
          )
        : null,
    pages: null,
  };
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
  const [videos, setVideos] = useState<YoutubeVideo[]>([]);
  const [videosTotal, setVideosTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [selectedTopic, setSelectedTopic] = useState<string | null>(
    initialTopic ?? null
  );
  const [selectedChannel, setSelectedChannel] = useState<string | null>(
    initialChannel ?? null
  );
  const [searchInput, setSearchInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [expandedTopics, setExpandedTopics] = useState<Record<string, boolean>>(
    {}
  );

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
    setLoading(true);

    getYoutubeOverview()
      .then((res) => {
        if (cancelled) return;
        setOverview(res);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setOverview(buildYoutubeOverviewFromWorks(fallbackWorks));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fallbackWorks]);

  // Fetch /api/youtube/videos when channel, topic, or search query is active
  useEffect(() => {
    let cancelled = false;
    if (!selectedChannel && !selectedTopic && !query) {
      setVideos([]);
      setVideosTotal(0);
      return;
    }

    getYoutubeVideos({
      channel: selectedChannel ?? undefined,
      topic:
        selectedTopic && selectedTopic !== UNCATEGORISED_TOPIC
          ? selectedTopic
          : undefined,
      q: query || undefined,
      limit: 60,
    })
      .then((res) => {
        if (cancelled) return;
        setVideos(res.videos ?? []);
        setVideosTotal(res.total ?? (res.videos ?? []).length);
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = buildYoutubeVideosFromWorks(fallbackWorks, {
          channel: selectedChannel ?? undefined,
          topic: selectedTopic ?? undefined,
          q: query || undefined,
        });
        setVideos(fallback.videos);
        setVideosTotal(fallback.total);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedChannel, selectedTopic, query, fallbackWorks]);

  // Apply optimistic channel topic overrides to overview
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

  const topicGroups = useMemo(
    () => groupYoutubeByTopic(effectiveOverview, query),
    [effectiveOverview, query]
  );

  const availableTopics = useMemo(
    () => collectYoutubeTopics(effectiveOverview),
    [effectiveOverview]
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

  // --- CHANNEL PAGE VIEW ---
  if (selectedChannel) {
    const chInfo = effectiveOverview.channels.find(
      (c) => c.channel.toLowerCase() === selectedChannel.toLowerCase()
    );
    const currentTopic = chInfo?.topic ?? null;
    const maxVideoMin = videos.reduce(
      (m, v) => Math.max(m, v.watched_minutes),
      1
    );

    return (
      <div class="yt-view-stack">
        <div class="library-back-row">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedChannel(null);
              window.history.replaceState(null, "", "#/library?cat=youtube");
            }}
          >
            ← Back to YouTube Topics & Channels
          </Button>
        </div>

        <Card padding="lg" class="yt-channel-hero">
          <div class="settings-row-between">
            <div class="ui-form-field">
              <div class="library-work-badges">
                <Badge
                  size="sm"
                  category="youtube"
                  icon={<YoutubeIcon size={12} />}
                >
                  YouTube Channel
                </Badge>
                <Badge size="sm" variant="neutral">
                  {currentTopic ?? UNCATEGORISED_TOPIC}
                </Badge>
              </div>
              <h2 class="library-work-title">{selectedChannel}</h2>
              <div class="library-work-stats-row tabular-nums">
                {chInfo && (
                  <>
                    <span>
                      <strong>{formatMinutes(chInfo.total_minutes)}</strong>{" "}
                      watched
                    </span>
                    <span>·</span>
                    <span>
                      <strong>{chInfo.videos}</strong>{" "}
                      {chInfo.videos === 1 ? "video" : "videos"}
                    </span>
                    {chInfo.last_at && (
                      <>
                        <span>·</span>
                        <span>
                          Last active {formatLocalDay(chInfo.last_at.slice(0, 10))}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            <div class="ui-form-actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setTopicInput(currentTopic ?? "");
                  setEditingChannelTopic(
                    editingChannelTopic === selectedChannel
                      ? null
                      : selectedChannel
                  );
                }}
              >
                {currentTopic ? `Topic: ${currentTopic} (Edit)` : "+ Set Topic"}
              </Button>
            </div>
          </div>

          {editingChannelTopic === selectedChannel && (
            <div class="yt-topic-editor-bar">
              <input
                type="text"
                class="ui-input"
                placeholder="Type or choose a topic…"
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
                    class={
                      t === currentTopic
                        ? "ui-cat-chip ui-cat-chip--active"
                        : "ui-cat-chip"
                    }
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
                {currentTopic && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void handleSaveChannelTopic(selectedChannel, null)
                    }
                  >
                    Clear Topic
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
        </Card>

        <Card
          padding="md"
          title={`Videos from ${selectedChannel}`}
          subtitle={`${videosTotal || videos.length} recorded videos`}
        >
          {videos.length === 0 ? (
            <p class="ui-text-muted">No individual videos found for this channel.</p>
          ) : (
            <ul class="yt-videos-list">
              {videos.map((v) => {
                const pct = Math.max(
                  6,
                  Math.round((v.watched_minutes / maxVideoMin) * 100)
                );
                const menuTarget = {
                  kind: "youtube-video" as const,
                  workKey: v.key,
                  title: v.title,
                  category: "youtube" as const,
                  channel: v.channel ?? selectedChannel,
                  topic: v.topic ?? currentTopic,
                  href: `#/library?work=${encodeURIComponent(v.key)}`,
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
                        href={`#/library?work=${encodeURIComponent(v.key)}`}
                        class="yt-video-title"
                      >
                        {v.title}
                      </a>
                      <div class="yt-video-meta tabular-nums">
                        <span>
                          {formatLocalDay(v.last_at.slice(0, 10))}
                        </span>
                        {v.plays > 1 && <span>· {v.plays} plays</span>}
                        {(v.topic ?? currentTopic) && (
                          <Badge size="sm" variant="neutral">
                            {v.topic ?? currentTopic}
                          </Badge>
                        )}
                      </div>
                      <div class="yt-bar-track">
                        <div
                          class="yt-bar-fill"
                          style={{ width: `${pct}%` }}
                        />
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
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    );
  }

  // --- TOPICS -> CHANNELS -> VIDEOS HIERARCHY VIEW ---
  return (
    <div class="yt-view-stack">
      {/* YouTube Overview KPI & Search */}
      <Card padding="md">
        <div class="yt-overview-top">
          <div class="yt-overview-stats">
            <Stat
              label="YouTube Watch Time"
              value={formatMinutes(effectiveOverview.total_minutes)}
              category="youtube"
              sublabel={`${effectiveOverview.videos} videos across ${effectiveOverview.channels.length} channels & ${topicGroups.length} topics`}
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
              placeholder="Search YouTube topics, channels, or videos…"
              aria-label="Search within YouTube"
              value={searchInput}
              onInput={(e) =>
                setSearchInput((e.currentTarget as HTMLInputElement).value)
              }
            />
          </div>
        </div>
      </Card>

      {loading && !overview ? (
        <Skeleton height={220} />
      ) : topicGroups.length === 0 && videos.length === 0 ? (
        <EmptyState
          compact
          title={
            query
              ? `No YouTube channels or videos matching “${query}”`
              : "No YouTube watch history yet"
          }
          description="YouTube plays above your minimum watch time are automatically grouped by topic and channel."
        />
      ) : (
        <>
          {/* Topics -> Channels List with Time Bars */}
          <div class="yt-topics-stack">
            {topicGroups.map((group) => {
              const isExpanded =
                expandedTopics[group.topic] ??
                (selectedTopic === group.topic ||
                  Boolean(query) ||
                  topicGroups.length <= 4);

              return (
                <Card key={group.topic} padding="md" class="yt-topic-card">
                  <button
                    type="button"
                    class="yt-topic-header"
                    aria-expanded={isExpanded}
                    onClick={() =>
                      setExpandedTopics((prev) => ({
                        ...prev,
                        [group.topic]: !isExpanded,
                      }))
                    }
                  >
                    <div class="yt-topic-title-col">
                      <div class="yt-topic-title-row">
                        <span
                          class="ui-tab-dot ui-tab-dot--youtube"
                          aria-hidden="true"
                        />
                        <h3 class="yt-topic-name">{group.topic}</h3>
                        <span class="yt-topic-counts tabular-nums">
                          {group.channelsCount}{" "}
                          {group.channelsCount === 1 ? "channel" : "channels"} ·{" "}
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
                      <span class="yt-topic-chevron">
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </div>
                  </button>

                  {isExpanded && group.channels.length > 0 && (
                    <ul class="yt-channels-list">
                      {group.channels.map((ch) => {
                        const isEditingThis =
                          editingChannelTopic === ch.channel;
                        const menuTarget = {
                          kind: "youtube-channel" as const,
                          title: ch.channel,
                          category: "youtube" as const,
                          channel: ch.channel,
                          topic: ch.topic,
                        };
                        return (
                          <li
                            key={ch.channel}
                            class="yt-channel-row-wrap"
                            {...bindContextMenu(menuTarget)}
                          >
                            <div class="yt-channel-row">
                              <div class="yt-channel-main">
                                <div class="yt-channel-top">
                                  <button
                                    type="button"
                                    class="yt-channel-link"
                                    onClick={() => {
                                      setSelectedChannel(ch.channel);
                                      window.history.replaceState(
                                        null,
                                        "",
                                        `#/library?cat=youtube&channel=${encodeURIComponent(
                                          ch.channel
                                        )}`
                                      );
                                    }}
                                  >
                                    {ch.channel}
                                  </button>
                                  <span class="yt-channel-meta tabular-nums">
                                    {ch.videos}{" "}
                                    {ch.videos === 1 ? "video" : "videos"}
                                  </span>
                                </div>
                                <div class="yt-bar-track">
                                  <div
                                    class="yt-bar-fill"
                                    style={{
                                      width: `${Math.round(ch.barRatio * 100)}%`,
                                    }}
                                  />
                                </div>
                              </div>

                              <div class="yt-channel-actions tabular-nums">
                                <strong>
                                  {formatMinutes(ch.total_minutes)}
                                </strong>
                                <button
                                  type="button"
                                  class="ui-cat-chip yt-set-topic-btn"
                                  title={`Set topic for ${ch.channel}`}
                                  onClick={() => {
                                    setTopicInput(ch.topic ?? "");
                                    setEditingChannelTopic(
                                      isEditingThis ? null : ch.channel
                                    );
                                  }}
                                >
                                  {ch.topic ? ch.topic : "Set topic…"}
                                </button>
                              </div>
                            </div>

                            {isEditingThis && (
                              <div class="yt-topic-editor-bar">
                                <input
                                  type="text"
                                  class="ui-input"
                                  placeholder="Topic for this channel…"
                                  value={topicInput}
                                  onInput={(e) =>
                                    setTopicInput(
                                      (e.currentTarget as HTMLInputElement).value
                                    )
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void handleSaveChannelTopic(
                                        ch.channel,
                                        topicInput
                                      );
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
                                        void handleSaveChannelTopic(
                                          ch.channel,
                                          t
                                        )
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
                                      void handleSaveChannelTopic(
                                        ch.channel,
                                        topicInput
                                      )
                                    }
                                  >
                                    Save
                                  </Button>
                                  {ch.topic && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        void handleSaveChannelTopic(
                                          ch.channel,
                                          null
                                        )
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
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>

          {/* Matching Videos when searching within YouTube */}
          {query && videos.length > 0 && (
            <Card
              padding="md"
              title={`Videos matching “${query}” (${videosTotal})`}
            >
              <ul class="yt-videos-list">
                {videos.map((v) => (
                  <li
                    key={v.key}
                    class="yt-video-row"
                    tabIndex={0}
                    {...bindContextMenu({
                      kind: "youtube-video",
                      workKey: v.key,
                      title: v.title,
                      category: "youtube",
                      channel: v.channel,
                      topic: v.topic,
                      href: `#/library?work=${encodeURIComponent(v.key)}`,
                    })}
                  >
                    <div class="yt-video-main">
                      <a
                        href={`#/library?work=${encodeURIComponent(v.key)}`}
                        class="yt-video-title"
                      >
                        {v.title}
                      </a>
                      <div class="yt-video-meta tabular-nums">
                        {v.channel && (
                          <button
                            type="button"
                            class="ui-inline-link"
                            onClick={() => setSelectedChannel(v.channel)}
                          >
                            {v.channel}
                          </button>
                        )}
                        <span>
                          · {formatLocalDay(v.last_at.slice(0, 10))}
                        </span>
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
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export function Library({
  initialCategory,
  initialCategories,
  initialStatus,
  initialSort = "recent",
  initialQuery = "",
  initialChannel,
  initialTopic,
  workKey,
  includeYoutubeInAll = false,
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

  // Fetch Library list + archive summaries
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const filterParams = buildCategoryFilterParams(
      selectedCategories,
      includeYoutubeInAll
    );

    const fetchLib = getLibrary({
      category: filterParams.category,
      exclude: filterParams.exclude,
      q: query || undefined,
      sort,
    }).catch(() =>
      // Fallback if server doesn't yet support multi-category / exclude query params
      getLibrary({
        q: query || undefined,
        sort,
      })
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
  }, [selectedCategories, includeYoutubeInAll, query, sort, refreshTick]);

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

  const effectiveWorkDetail = useMemo(
    () => (workDetail ? applyWorkOverrideToDetail(workDetail) : null),
    [workDetail, overrideTick]
  );

  const effectiveWorks = useMemo(
    () => applyWorkOverridesToList(libraryData?.works ?? []),
    [libraryData, overrideTick]
  );

  const filteredWorks = useMemo<LibraryWork[]>(() => {
    return effectiveWorks.filter((w) => {
      if (
        !matchesCategorySelection(
          w.category,
          selectedCategories,
          includeYoutubeInAll
        )
      ) {
        return false;
      }
      if (statusFilter !== "all" && w.status !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [effectiveWorks, selectedCategories, includeYoutubeInAll, statusFilter]);

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
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntryId(null);
    }
  };

  const singleCategory =
    selectedCategories.length === 1 ? selectedCategories[0] : undefined;
  const isYoutubeView =
    selectedCategories.length === 1 && selectedCategories[0] === "youtube";

  // --- WORK DETAIL PAGE VIEW (`#/library?work=<key>`) ---
  if (workKey) {
    const backHref =
      selectedCategories.length > 0
        ? `#/library?cat=${selectedCategories.join(",")}`
        : "#/library";

    const workArchiveEntryIds = Array.from(
      new Set(
        (effectiveWorkDetail?.history ?? [])
          .map((h) => h.entry_id)
          .filter((id): id is string => Boolean(id))
      )
    );

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
            <Card padding="lg" class="library-work-hero">
              <div
                class="library-work-hero-layout"
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

                <div class="library-work-hero-body">
                  <div class="library-work-badges">
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
                    {effectiveWorkDetail.edited && (
                      <Badge size="sm" variant="neutral">
                        Edited
                      </Badge>
                    )}
                    {effectiveWorkDetail.topic && (
                      <Badge size="sm" variant="neutral">
                        {effectiveWorkDetail.topic}
                      </Badge>
                    )}
                    {effectiveWorkDetail.sources.map((src) => (
                      <Badge key={src} size="sm" variant="neutral">
                        {sourceLabel(src)}
                      </Badge>
                    ))}
                    <QuickRatingPill
                      workKey={effectiveWorkDetail.key}
                      title={effectiveWorkDetail.title}
                      category={effectiveWorkDetail.category}
                      rating={effectiveWorkDetail.rating}
                      source={effectiveWorkDetail.sources[0] ?? "manual"}
                      onRated={(next) =>
                        setWorkDetail((prev) =>
                          prev ? { ...prev, rating: next } : prev
                        )
                      }
                    />
                  </div>

                  <h1 class="library-work-title">
                    {effectiveWorkDetail.title}
                  </h1>

                  <div class="library-work-stats-row tabular-nums">
                    <span>
                      <strong>
                        {formatMinutes(effectiveWorkDetail.total_minutes)}
                      </strong>{" "}
                      total time
                    </span>
                    <span>·</span>
                    <span>
                      <strong>
                        {formatCategoryUnits(
                          effectiveWorkDetail.category,
                          effectiveWorkDetail.units
                        )}
                      </strong>
                    </span>
                    {effectiveWorkDetail.first_at && (
                      <>
                        <span>·</span>
                        <span>
                          Active{" "}
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
                        </span>
                      </>
                    )}
                  </div>

                  <div class="library-work-actions">
                    {/* Edit Work (title, category, status, metadata match, rating, note, hide) */}
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
                      Edit Work
                    </Button>

                    <Button
                      variant="primary"
                      size="sm"
                      leadingIcon={<AddIcon size={15} />}
                      onClick={() => {
                        const manualWork =
                          buildManualWorkFromDetail(effectiveWorkDetail);
                        if (onOpenAdd) {
                          onOpenAdd({
                            category: effectiveWorkDetail.category,
                            work: manualWork,
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
                        ? "Add more seasons"
                        : "Log again"}
                    </Button>

                    {/* Archive / imported entry actions ("Edit entry" and "Delete entry") */}
                    {workArchiveEntryIds.map((entryId) => {
                      const summary = archiveEntries.find(
                        (e) => e.entry_id === entryId
                      );
                      const isConfirming = confirmDeleteEntryId === entryId;
                      return (
                        <div key={entryId} class="library-work-archive-btns">
                          <Button
                            variant="secondary"
                            size="sm"
                            leadingIcon={<EditIcon size={14} />}
                            onClick={() => {
                              const manualWork =
                                buildManualWorkFromDetail(effectiveWorkDetail);
                              onOpenAdd?.({
                                category: effectiveWorkDetail.category,
                                editingEntry: {
                                  entry_id: entryId,
                                  work: manualWork,
                                  consumed: summary?.consumed ?? {
                                    seasons: effectiveWorkDetail.seasons
                                      .filter((s) => s.watched_episodes > 0)
                                      .map((s) =>
                                        s.watched_episodes < s.episodes
                                          ? {
                                              number: s.number,
                                              episodes: s.watched_episodes,
                                            }
                                          : { number: s.number }
                                      ),
                                    times: Math.max(
                                      1,
                                      effectiveWorkDetail.units
                                    ),
                                    progress: 1,
                                  },
                                  when: summary?.when ?? {
                                    precision: "unknown",
                                  },
                                  rating: effectiveWorkDetail.rating,
                                  note: effectiveWorkDetail.note,
                                },
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
                                disabled={deletingEntryId === entryId}
                                onClick={() =>
                                  void handleDeleteArchive(entryId)
                                }
                              >
                                {deletingEntryId === entryId
                                  ? "Deleting…"
                                  : "Confirm Delete"}
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
                              Delete Entry
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Card>

            {/* Seasons Progress (for Series / Anime) */}
            {effectiveWorkDetail.seasons.length > 0 && (
              <Card
                padding="md"
                title="Seasons Progress"
                subtitle={`${
                  effectiveWorkDetail.seasons.filter(
                    (s) => s.watched_episodes >= s.episodes && s.episodes > 0
                  ).length
                } of ${effectiveWorkDetail.seasons.length} seasons finished`}
              >
                <div class="library-seasons-grid">
                  {effectiveWorkDetail.seasons.map((season) => {
                    const maxEp = Math.max(1, season.episodes);
                    const watched = Math.min(maxEp, season.watched_episodes);
                    return (
                      <div key={season.number} class="library-season-row">
                        <ProgressBar
                          value={watched}
                          max={maxEp}
                          category={effectiveWorkDetail.category}
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
              {/* Rating 0–10 & Personal Note */}
              <Card
                padding="md"
                title="Rating & Personal Note"
                subtitle="Rated 0–10 with one decimal; stored append-only"
              >
                <RatingEditor
                  workKey={effectiveWorkDetail.key}
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

              {/* History Timeline */}
              <Card
                padding="md"
                title="Activity & Archive History"
                subtitle={`${effectiveWorkDetail.history.length} recorded ${
                  effectiveWorkDetail.history.length === 1 ? "unit" : "units"
                }`}
              >
                {effectiveWorkDetail.history.length === 0 ? (
                  <p class="ui-text-muted">No individual history items.</p>
                ) : (
                  <ul class="library-history-list">
                    {effectiveWorkDetail.history.map((item, idx) => (
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
          <h1>Library</h1>
          <p class="page-subtitle">
            Everything you have watched, read, and listened to — grouped by work
            across every source. Right-click any work for quick actions.
          </p>
        </div>
        <div class="page-header-actions">
          <Button
            variant={isYoutubeView ? "primary" : "secondary"}
            size="sm"
            leadingIcon={<YoutubeIcon size={15} />}
            onClick={() => {
              const next: Category[] = isYoutubeView ? [] : ["youtube"];
              setSelectedCategories(next);
              window.history.replaceState(
                null,
                "",
                next.length > 0 ? "#/library?cat=youtube" : "#/library"
              );
            }}
          >
            YouTube by Topic & Channel
          </Button>
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

      {/* Multi-Select Category Chips */}
      <CategoryChips
        selected={selectedCategories}
        onChange={setSelectedCategories}
        totals={libraryData?.categories ?? []}
        includeYoutubeInAll={includeYoutubeInAll}
        ariaLabel="Library categories"
        showCounts="hours-works"
      />

      {/* Dedicated Library › YouTube View when YouTube is selected */}
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
                  label="Library Time"
                  value={formatMinutes(
                    filteredWorks.reduce((acc, w) => acc + w.total_minutes, 0)
                  )}
                  category={singleCategory}
                  sublabel={`${filteredWorks.length} ${
                    filteredWorks.length === 1 ? "work" : "works"
                  } shown`}
                />
                <div class="library-overview-share">
                  <span class="ui-stat-label">Time by Category</span>
                  <CategoryShareChart
                    categories={libraryData.categories.filter((c) =>
                      matchesCategorySelection(
                        c.category,
                        selectedCategories,
                        includeYoutubeInAll
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

          {/* Filter (including Planned / Watchlist), Search & Sort Controls */}
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
                  setSort(
                    (e.currentTarget as HTMLSelectElement).value as LibrarySort
                  )
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
                          aspect="poster"
                        />
                      </a>
                      <QuickRatingPill
                        workKey={work.key}
                        title={work.title}
                        category={work.category}
                        rating={work.rating}
                        source={work.sources[0] ?? "manual"}
                        variant="overlay"
                      />
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
                      <div class="library-work-card-meta tabular-nums">
                        <span
                          class={`ui-tab-dot ui-tab-dot--${work.category}`}
                          aria-hidden="true"
                        />
                        <span>
                          {work.status === "planned"
                            ? "Planned"
                            : work.total_minutes > 0
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
                  </div>
                );
              })}
            </div>
          ) : (
            <Card padding="none">
              <ul class="library-works-list">
                {filteredWorks.map((work) => {
                  const catQuery =
                    selectedCategories.length > 0
                      ? `&cat=${selectedCategories.join(",")}`
                      : "";
                  const workHref = `#/library?work=${encodeURIComponent(
                    work.key
                  )}${catQuery}`;
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
                      </a>
                      <div class="library-work-list-right tabular-nums">
                        <QuickRatingPill
                          workKey={work.key}
                          title={work.title}
                          category={work.category}
                          rating={work.rating}
                          source={work.sources[0] ?? "manual"}
                          variant="inline"
                        />
                        <div class="library-work-list-stats">
                          <strong>
                            {work.status === "planned"
                              ? "Planned"
                              : work.total_minutes > 0
                                ? formatMinutes(work.total_minutes)
                                : formatCategoryUnits(
                                    work.category,
                                    work.units
                                  )}
                          </strong>
                          {work.status !== "planned" && (
                            <span>
                              {formatCategoryUnits(work.category, work.units)}
                            </span>
                          )}
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
          {archiveEntries.length > 0 && (
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
