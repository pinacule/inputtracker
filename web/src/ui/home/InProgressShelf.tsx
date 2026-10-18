import type { Category, ManualWork } from "../../api";
import { categoryPluralLabel } from "../../lib/categories";
import type { ContextMenuTarget } from "../../lib/context-menu";
import type { HomeInProgressWork } from "../../lib/home";
import { bindContextMenu, openContextMenu } from "../ContextMenu";
import { AddIcon, MoreIcon } from "../icons";
import { ProgressBar } from "../ProgressBar";
import { QuickRatingPill } from "../QuickRating";
import { HomeWorkThumb } from "./HomeWorkThumb";

export interface InProgressShelfProps {
  readonly works: readonly HomeInProgressWork[];
  readonly selectedDate: string;
  readonly onOpenAdd?: (prefill?: {
    date?: string;
    category?: Category;
    work?: ManualWork;
  }) => void;
}

/**
 * "In the middle of" shelf:
 * Shows active `in_progress` works with real cover art (when available),
 * explicit v2.2 season/episode progress, quick rating pill, and 1-tap "+ Log".
 */
export function InProgressShelf({
  works,
  selectedDate,
  onOpenAdd,
}: InProgressShelfProps) {
  if (works.length === 0) {
    return null;
  }

  return (
    <section
      class="home-card home-progress-section"
      aria-label="In the middle of"
    >
      <div class="home-section-header">
        <div class="home-section-titles">
          <h2 class="home-section-title">In the middle of</h2>
          <span class="home-section-count tabular-nums">
            {works.length} {works.length === 1 ? "work" : "works"}
          </span>
        </div>
        <a
          href="#/library?status=in_progress"
          class="home-section-link"
        >
          Library →
        </a>
      </div>

      <div class="home-progress-grid">
        {works.map((w) => {
          const menuTarget: ContextMenuTarget = {
            kind: "work",
            workKey: w.key,
            title: w.title,
            category: w.category,
            status: "in_progress",
            rating: w.rating,
            href: `#/library?work=${encodeURIComponent(w.key)}`,
          };

          return (
            <article
              key={w.key}
              class="home-progress-item"
              tabIndex={0}
              {...bindContextMenu(menuTarget)}
            >
              <a
                href={`#/library?work=${encodeURIComponent(w.key)}`}
                class="home-progress-thumb-link"
                tabIndex={-1}
                aria-hidden="true"
              >
                <HomeWorkThumb
                  coverUrl={w.coverUrl}
                  category={w.category}
                  size="md"
                />
              </a>

              <div class="home-progress-body">
                <div class="home-progress-top">
                  <a
                    href={`#/library?work=${encodeURIComponent(w.key)}`}
                    class="home-progress-title"
                    title={w.title}
                  >
                    {w.title}
                  </a>

                  <button
                    type="button"
                    class="ui-row-menu-btn"
                    aria-label={`Actions for ${w.title}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const btn = e.currentTarget as HTMLElement | null;
                      const rect = btn?.getBoundingClientRect();
                      const pt = rect
                        ? { x: rect.right - 8, y: rect.bottom + 4 }
                        : { x: e.clientX, y: e.clientY };
                      openContextMenu(menuTarget, pt, btn);
                    }}
                  >
                    <MoreIcon size={15} />
                  </button>
                </div>

                <div class="home-progress-meta">
                  <span
                    class={`ui-tab-dot ui-tab-dot--${w.category}`}
                    aria-hidden="true"
                  />
                  <span>
                    {w.creator ?? categoryPluralLabel(w.category)}
                  </span>
                </div>

                <div class="home-progress-status tabular-nums">
                  <span>{w.progressLabel}</span>
                </div>

                {w.progressPercent !== null && (
                  <ProgressBar
                    value={w.progressPercent}
                    size="sm"
                    category={w.category}
                    ariaLabel={`Progress for ${w.title}: ${w.progressPercent}%`}
                  />
                )}

                <div class="home-progress-actions">
                  {w.canRate && (
                    <QuickRatingPill
                      workKey={w.key}
                      title={w.title}
                      category={w.category}
                      rating={w.rating}
                    />
                  )}
                  {onOpenAdd && (
                    <button
                      type="button"
                      class="home-progress-log-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenAdd({
                          date: selectedDate,
                          category: w.category,
                          work: w.manualWorkPrefill,
                        });
                      }}
                    >
                      <AddIcon size={13} />
                      <span>Log</span>
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
