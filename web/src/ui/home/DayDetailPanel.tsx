import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Category } from "../../api";
import {
  categoryCssColor,
  categoryPluralLabel,
} from "../../lib/categories";
import type { ContextMenuTarget } from "../../lib/context-menu";
import {
  shiftDateStr,
  type HomeDayDetailModel,
  type HomeDayWorkRow,
  type HomeMusicTrackItem,
} from "../../lib/home";
import { formatMinutes } from "../../lib/stats";
import { Button } from "../Button";
import { bindContextMenu, openContextMenu } from "../ContextMenu";
import { IconButton } from "../IconButton";
import {
  AddIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreIcon,
  MusicIcon,
  YoutubeIcon,
} from "../icons";
import { QuickRatingPill } from "../QuickRating";
import { HomeWorkThumb } from "./HomeWorkThumb";
import { CategoryLegend } from "./CategoryLegend";
import { HomeTimeDisplay } from "./HomeTimeDisplay";
import { NormComparison } from "./NormComparison";

export interface DayDetailPanelProps {
  readonly model: HomeDayDetailModel;
  /** The day's usual time, or null while history is incomplete (no comparison shown). */
  readonly usualMinutes: number | null;
  readonly weekGraph?: ComponentChildren;
  readonly singleCategory?: Category;
  readonly onSelectDate: (date: string) => void;
  readonly todayStr?: string;
  readonly onOpenAdd?: (prefill?: { date?: string; category?: Category }) => void;
}

function openRowMenuFromButton(e: MouseEvent, target: ContextMenuTarget) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.currentTarget as HTMLElement | null;
  const rect = btn?.getBoundingClientRect();
  const pt = rect
    ? { x: rect.right - 8, y: rect.bottom + 4 }
    : { x: e.clientX, y: e.clientY };
  openContextMenu(target, pt, btn);
}

function MusicTrackRow({ track }: { track: HomeMusicTrackItem }) {
  const menuTarget: ContextMenuTarget = {
    kind: "day-work",
    workKey: track.workKey,
    title: track.title,
    category: "music",
    href: `#/library?work=${encodeURIComponent(track.workKey)}`,
    source: "youtube",
  };

  return (
    <li
      class="home-day-row home-day-row--music"
      tabIndex={0}
      {...bindContextMenu(menuTarget)}
    >
      <HomeWorkThumb
        coverUrl={track.coverUrl}
        category="music"
        size="sm"
        aspect="square"
      />

      <div class="home-day-row-body">
        <div class="home-day-row-top">
          <a
            href={`#/library?work=${encodeURIComponent(track.workKey)}`}
            class="home-day-row-title"
          >
            {track.title}
          </a>
        </div>
        {track.artist && (
          <div class="home-day-row-sub">
            <span>{track.artist}</span>
          </div>
        )}
      </div>

      {/* Music tracks never show a rating control (spec section 15) */}
      <div class="home-day-row-right tabular-nums">
        <span class="home-day-row-duration">{track.durationLabel}</span>
        <button
          type="button"
          class="ui-row-menu-btn"
          aria-label={`Actions for ${track.title}`}
          onClick={(e) => openRowMenuFromButton(e, menuTarget)}
        >
          <MoreIcon size={15} />
        </button>
      </div>
    </li>
  );
}

function DayWorkItemRow({ row }: { row: HomeDayWorkRow }) {
  const menuTarget: ContextMenuTarget = {
    kind: row.entryId ? "archive-entry" : "day-work",
    workKey: row.workKey,
    title: row.title,
    category: row.category,
    status: row.status,
    rating: row.rating,
    entryId: row.entryId,
    consumed: row.archiveConsumed,
    when: row.archiveWhen,
    href: `#/library?work=${encodeURIComponent(row.workKey)}`,
    source: row.source,
  };

  return (
    <li
      class={`home-day-row home-tone--${row.category}`}
      tabIndex={0}
      {...bindContextMenu(menuTarget)}
    >
      <HomeWorkThumb
        coverUrl={row.coverUrl}
        category={row.category}
        size="sm"
      />

      <div class="home-day-row-body">
        <div class="home-day-row-top">
          <a
            href={`#/library?work=${encodeURIComponent(row.workKey)}`}
            class="home-day-row-title"
          >
            {row.title}
          </a>
        </div>

        <div class="home-day-row-sub">
          <span
            class={`ui-tab-dot ui-tab-dot--${row.category}`}
            aria-hidden="true"
          />
          <span>
            <span class="home-row-category">{categoryPluralLabel(row.category)}{row.subtitle ? " / " : ""}</span>
            {row.subtitle}
          </span>
        </div>

        <div class="home-day-row-bar-track" aria-hidden="true">
          <div
            class="home-day-row-bar-fill"
            style={{
              width: `${Math.round(row.barRatio * 100)}%`,
              backgroundColor: categoryCssColor(row.category),
            }}
          />
        </div>
      </div>

      <div class="home-day-row-right tabular-nums">
        <strong class="home-day-row-duration">{row.durationLabel}</strong>
        {row.canRate && (
          <QuickRatingPill
            workKey={row.workKey}
            title={row.title}
            category={row.category}
            rating={row.rating}
            source={row.source}
          />
        )}
        <button
          type="button"
          class="ui-row-menu-btn"
          aria-label={`Actions for ${row.title}`}
          onClick={(e) => openRowMenuFromButton(e, menuTarget)}
        >
          <MoreIcon size={15} />
        </button>
      </div>
    </li>
  );
}

/**
 * Selected Day Detail Panel:
 * - Single clean plain-words day heading ("Today", "Yesterday", "Saturday 17 October")
 *   with no duplicate numeric date above it.
 * - Exact time headline with a visual norm comparison and the seven-day strip.
 * - Work-grouped items with real covers only where they exist.
 * - YouTube plays collapsed into one calm expandable line ("12 videos · 48m").
 * - Music plays without ratings, always collapsed into one expandable line.
 */
export function DayDetailPanel({
  model,
  usualMinutes,
  weekGraph,
  singleCategory,
  onSelectDate,
  todayStr,
  onOpenAdd,
}: DayDetailPanelProps) {
  const [ytExpanded, setYtExpanded] = useState(false);
  const [musicExpanded, setMusicExpanded] = useState(false);

  // Reset expanded drawers when switching days
  useEffect(() => {
    setYtExpanded(false);
    setMusicExpanded(false);
  }, [model.date]);

  const prevDate = shiftDateStr(model.date, -1);
  const nextDate = shiftDateStr(model.date, 1);

  return (
    <section
      class="home-day-panel"
      aria-label={`Activity for ${model.heading}`}
    >
      {/* Contents in the Editorial spread; an opaque pane in wallpaper skins. */}
      <div class="home-day-overview">
      {/* Clean single-line plain words day header */}
      <div class="home-day-header">
        <div class="home-day-heading-group">
          <div class="home-day-step-btns">
            <IconButton
              label="Previous day"
              variant="ghost"
              size="sm"
              onClick={() => onSelectDate(prevDate)}
            >
              <ChevronLeftIcon size={16} />
            </IconButton>
            <IconButton
              label="Next day"
              disabled={todayStr !== undefined && nextDate > todayStr}
              variant="ghost"
              size="sm"
              onClick={() => onSelectDate(nextDate)}
            >
              <ChevronRightIcon size={16} />
            </IconButton>
          </div>
          <h2 class="home-day-title">{model.heading}</h2>
        </div>

      </div>

      <div key={model.date} class="home-day-hero" aria-live="polite" aria-atomic="true">
        <HomeTimeDisplay minutes={model.totalMinutes} class="home-time--hero" />
        <span class="home-kicker">Time on the record</span>
        {usualMinutes !== null && (
          <NormComparison actual={model.totalMinutes} norm={usualMinutes} label={model.heading} />
        )}
      </div>
      </div>
      {weekGraph}

      <div class="home-day-entries">
      {/* Day Category Proportion Bar (when the day has activity) */}
      {model.segments.length > 0 && (
        <div class="home-day-cat-strip">
          <div
            class="home-share-bar"
            role="img"
            aria-label={`Category split for ${model.heading}`}
          >
            {model.segments.map((seg) => (
              <span
                key={seg.category}
                 class={`home-share-bar-seg home-tone--${seg.category}`}
                style={{
                   flexGrow: seg.sharePct,
                   flexBasis: 0,
                  backgroundColor: categoryCssColor(seg.category),
                }}
                title={`${categoryPluralLabel(seg.category)}: ${
                  seg.minutes > 0
                    ? formatMinutes(seg.minutes)
                    : `${seg.count} items`
                }`}
              />
            ))}
          </div>
          <CategoryLegend entries={model.segments} label={`${model.heading} by category`} />
        </div>
      )}

      {/* Day Body */}
      {model.isEmpty ? (
        <div class="home-day-empty">
          <p class="home-day-empty-text">Nothing logged on this day.</p>
          {onOpenAdd && (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<AddIcon size={14} />}
              onClick={() =>
                onOpenAdd({
                  date: model.date,
                  category: singleCategory,
                })
              }
            >
              Add to {model.heading}
            </Button>
          )}
        </div>
      ) : (
        <ul class="home-day-list">
          {model.shortformMinutes > 0 && (
             <li class="home-day-row home-day-row--shortform">
                <HomeWorkThumb coverUrl={null} category="shortform" size="sm" />
                <span class="home-day-row-body home-day-row-title">Short-form</span>
                <strong class="home-day-row-duration">{Math.round(model.shortformMinutes)} min</strong>
            </li>
          )}
          {/* 1. Long-form / Story Works */}
          {model.works.map((row) => (
            <DayWorkItemRow key={row.key} row={row} />
          ))}

          {/* Music always folds into one line, just like YouTube. */}
          {model.music && (
            <li class="home-day-collapse-item">
              <button
                type="button"
                class={
                  musicExpanded
                    ? "home-day-collapse-trigger home-day-collapse-trigger--open"
                    : "home-day-collapse-trigger"
                }
                 aria-expanded={musicExpanded}
                 aria-controls={`home-music-${model.date}`}
                onClick={() => setMusicExpanded((v) => !v)}
              >
                <span
                  class="home-cat-badge home-cat-badge--sm home-cat-badge--music"
                  aria-hidden="true"
                >
                  <MusicIcon size={15} />
                </span>

                <span class="home-day-collapse-main">
                  <span class="home-day-collapse-title-row">
                    <span class="home-day-row-title">Music</span>
                    <span class="home-day-collapse-pill tabular-nums">
                      {model.music.summaryLabel}
                    </span>
                  </span>
                  {model.music.artistsPreview && (
                    <span class="home-day-row-sub">
                      {model.music.artistsPreview}
                    </span>
                  )}
                </span>

                <span class="home-day-collapse-chevron" aria-hidden="true">
                  <ChevronRightIcon
                    size={16}
                    class={
                      musicExpanded
                        ? "home-chevron home-chevron--open"
                        : "home-chevron"
                    }
                  />
                </span>
              </button>

              {musicExpanded && (
                <ul id={`home-music-${model.date}`} class="home-day-drawer-list">
                  {model.music.tracks.map((track) => (
                    <MusicTrackRow key={track.workKey} track={track} />
                  ))}
                </ul>
              )}
            </li>
          )}

          {/* 3. YouTube: One calm expandable line ("12 videos · 48m") */}
          {model.youtube && (
            <li class="home-day-collapse-item">
              <button
                type="button"
                class={
                  ytExpanded
                    ? "home-day-collapse-trigger home-day-collapse-trigger--open"
                    : "home-day-collapse-trigger"
                }
                 aria-expanded={ytExpanded}
                 aria-controls={`home-youtube-${model.date}`}
                onClick={() => setYtExpanded((v) => !v)}
              >
                <span
                  class="home-cat-badge home-cat-badge--sm home-cat-badge--youtube"
                  aria-hidden="true"
                >
                  <YoutubeIcon size={15} />
                </span>

                <span class="home-day-collapse-main">
                  <span class="home-day-collapse-title-row">
                    <span class="home-day-row-title">YouTube</span>
                    <span class="home-day-collapse-pill tabular-nums">
                      {model.youtube.summaryLabel}
                    </span>
                  </span>
                  {model.youtube.channelsPreview && (
                    <span class="home-day-row-sub">
                      {model.youtube.channelsPreview}
                    </span>
                  )}
                </span>

                <span class="home-day-collapse-chevron" aria-hidden="true">
                  <ChevronRightIcon
                    size={16}
                    class={
                      ytExpanded
                        ? "home-chevron home-chevron--open"
                        : "home-chevron"
                    }
                  />
                </span>
              </button>

              {ytExpanded && (
                <div id={`home-youtube-${model.date}`} class="home-yt-drawer">
                  {model.youtube.channels.map((ch) => {
                    const chMenuTarget: ContextMenuTarget = {
                      kind: "youtube-channel",
                      title: ch.channel,
                      channel: ch.channel,
                      category: "youtube",
                    };
                    return (
                      <div key={ch.channel} class="home-yt-channel-block">
                        <div
                          class="home-yt-channel-header"
                          tabIndex={0}
                          {...bindContextMenu(chMenuTarget)}
                        >
                          <div class="home-yt-channel-info">
                            <a
                              href={`#/library?cat=youtube&channel=${encodeURIComponent(
                                ch.channel
                              )}`}
                              class="home-yt-channel-name"
                            >
                              {ch.channel}
                            </a>
                            <span class="home-yt-channel-meta tabular-nums">
                              {ch.count} {ch.count === 1 ? "video" : "videos"} ·{" "}
                              {ch.durationLabel}
                            </span>
                          </div>
                          <div
                            class="home-yt-channel-bar-track"
                            aria-hidden="true"
                          >
                            <div
                              class="home-yt-channel-bar-fill"
                              style={{
                                width: `${Math.round(ch.barRatio * 100)}%`,
                              }}
                            />
                          </div>
                        </div>

                        <ul class="home-yt-video-list">
                          {ch.videos.map((v) => {
                            const vTarget: ContextMenuTarget = {
                              kind: "youtube-video",
                              workKey: v.workKey,
                              title: v.title,
                              channel: v.channel,
                              category: "youtube",
                              rating: v.rating,
                              href: `#/library?work=${encodeURIComponent(
                                v.workKey
                              )}`,
                              source: "youtube",
                            };
                            return (
                              <li
                                key={v.id}
                                class="home-yt-video-row"
                                tabIndex={0}
                                {...bindContextMenu(vTarget)}
                              >
                                <a
                                  href={`#/library?work=${encodeURIComponent(
                                    v.workKey
                                  )}`}
                                  class="home-yt-video-title"
                                  title={v.title}
                                >
                                  {v.title}
                                </a>
                                <div class="home-yt-video-right tabular-nums">
                                  <span class="home-yt-video-dur">
                                    {v.durationLabel}
                                  </span>
                                  <QuickRatingPill
                                    workKey={v.workKey}
                                    title={v.title}
                                    category="youtube"
                                    rating={v.rating}
                                    source="youtube"
                                  />
                                  <button
                                    type="button"
                                    class="ui-row-menu-btn"
                                    aria-label={`Actions for ${v.title}`}
                                    onClick={(e) =>
                                      openRowMenuFromButton(e, vTarget)
                                    }
                                  >
                                    <MoreIcon size={14} />
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          )}
        </ul>
      )}
      </div>
    </section>
  );
}
