import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  deleteArchiveEntry,
  type ArchiveConsumed,
  type ArchiveWhen,
  type Category,
  type ManualWork,
  type WorkStatus,
} from "../api";
import { CATEGORIES, CATEGORY_META, categoryLabel } from "../lib/categories";
import {
  buildContextMenuActions,
  computeContextMenuPlacement,
  nextMenuFocusIndex,
  type ContextMenuActionId,
  type ContextMenuTarget,
  type MenuPoint,
} from "../lib/context-menu";
import { formatRating10 } from "../lib/rating";
import {
  performSetChannelTopic,
  performWorkEdit,
  pushToast,
} from "../lib/work-edits";
import { COMMON_YOUTUBE_TOPICS } from "../lib/youtube";
import { Button } from "./Button";
import type { EditableWorkTarget } from "./EditWorkSheet";
import { RatingInput10 } from "./QuickRating";

export interface OpenMenuState {
  target: ContextMenuTarget;
  point: MenuPoint;
  triggerEl: HTMLElement | null;
}

type MenuListener = (state: OpenMenuState | null) => void;
const menuListeners = new Set<MenuListener>();
let currentMenuState: OpenMenuState | null = null;

export function openContextMenu(
  target: ContextMenuTarget,
  point: MenuPoint,
  triggerEl: HTMLElement | null = null
): void {
  currentMenuState = { target, point, triggerEl };
  for (const fn of menuListeners) {
    fn(currentMenuState);
  }
}

export function closeContextMenu(restoreFocus = true): void {
  const prevTrigger = currentMenuState?.triggerEl;
  currentMenuState = null;
  for (const fn of menuListeners) {
    fn(null);
  }
  if (restoreFocus && prevTrigger && typeof prevTrigger.focus === "function") {
    try {
      prevTrigger.focus();
    } catch {
      // Ignore focus errors.
    }
  }
}

export function subscribeContextMenu(listener: MenuListener): () => void {
  menuListeners.add(listener);
  return () => {
    menuListeners.delete(listener);
  };
}

/**
 * Returns event handlers (`onContextMenu`, `onKeyDown`, `onTouchStart`,
 * `onTouchMove`, `onTouchEnd`) to attach the accessible context menu to any
 * work card, row, day panel item, or channel.
 */
export function bindContextMenu(target: ContextMenuTarget) {
  let touchTimer: ReturnType<typeof setTimeout> | undefined;
  let startX = 0;
  let startY = 0;

  return {
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(
        target,
        { x: e.clientX, y: e.clientY },
        e.currentTarget as HTMLElement | null
      );
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement | null;
        const rect = el?.getBoundingClientRect();
        const pt = rect
          ? { x: rect.left + Math.min(40, rect.width / 2), y: rect.bottom + 4 }
          : { x: 120, y: 120 };
        openContextMenu(target, pt, el);
      }
    },
    onTouchStart: (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      const el = e.currentTarget as HTMLElement | null;
      clearTimeout(touchTimer);
      touchTimer = setTimeout(() => {
        openContextMenu(target, { x: startX, y: startY }, el);
      }, 480);
    },
    onTouchMove: (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      if (
        Math.abs(touch.clientX - startX) > 10 ||
        Math.abs(touch.clientY - startY) > 10
      ) {
        clearTimeout(touchTimer);
      }
    },
    onTouchEnd: () => {
      clearTimeout(touchTimer);
    },
  };
}

export interface ContextMenuHostProps {
  onOpenEditWork: (work: EditableWorkTarget) => void;
  onOpenAdd: (opts: {
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
  onDeletedArchiveEntry?: (entryId: string) => void;
}

type SubPanelMode = "main" | "rate" | "category" | "topic" | "confirm-delete";

export function ContextMenuHost({
  onOpenEditWork,
  onOpenAdd,
  onDeletedArchiveEntry,
}: ContextMenuHostProps) {
  const [menuState, setMenuState] = useState<OpenMenuState | null>(null);
  const [subPanel, setSubPanel] = useState<SubPanelMode>("main");
  const [focusIdx, setFocusIdx] = useState(0);

  const [draftRating, setDraftRating] = useState<number | null>(8.0);
  const [draftTopic, setDraftTopic] = useState("");
  const [deleting, setDeleting] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    return subscribeContextMenu((st) => {
      setMenuState(st);
      setSubPanel("main");
      setFocusIdx(0);
      if (st) {
        setDraftRating(st.target.rating ?? 8.0);
        setDraftTopic(st.target.topic ?? "");
      }
    });
  }, []);

  const actions = useMemo(
    () => (menuState ? buildContextMenuActions(menuState.target) : []),
    [menuState]
  );

  useEffect(() => {
    if (!menuState || subPanel !== "main") return;
    const btn = itemRefs.current[focusIdx];
    btn?.focus();
  }, [menuState, focusIdx, subPanel]);

  useEffect(() => {
    if (!menuState) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (subPanel !== "main") {
          setSubPanel("main");
        } else {
          closeContextMenu(true);
        }
        return;
      }

      if (subPanel === "main") {
        const nextIdx = nextMenuFocusIndex(focusIdx, actions.length, e.key);
        if (nextIdx !== null) {
          e.preventDefault();
          e.stopPropagation();
          setFocusIdx(nextIdx);
        }
      }
    };

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current && target && !menuRef.current.contains(target)) {
        closeContextMenu(false);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [menuState, subPanel, focusIdx, actions.length]);

  if (!menuState) {
    return null;
  }

  const { target, point } = menuState;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const estimatedHeight =
    subPanel === "main" ? Math.min(420, actions.length * 36 + 64) : 260;
  const placement = computeContextMenuPlacement(
    point,
    { width: 270, height: estimatedHeight },
    { width: vw, height: vh },
    12
  );

  const effectiveWorkKey =
    target.workKey ?? `${target.category}:${target.title.toLowerCase().trim()}`;

  const handleStatusChange = async (nextStatus: WorkStatus) => {
    const prevStatus = target.status;
    closeContextMenu(true);
    const { undo } = await performWorkEdit(
      effectiveWorkKey,
      { status: nextStatus },
      {
        title: target.title,
        category: target.category,
        status: prevStatus,
        rating: target.rating,
      }
    );
    pushToast({
      message: `Marked “${target.title}” as ${nextStatus.replace("_", " ")}`,
      variant: "success",
      actionLabel: "Undo",
      onAction: () => {
        void undo();
      },
    });
  };

  const handleHide = async () => {
    closeContextMenu(true);
    const { undo } = await performWorkEdit(
      effectiveWorkKey,
      { hidden: true },
      {
        title: target.title,
        category: target.category,
        status: target.status,
        rating: target.rating,
      }
    );
    pushToast({
      message: `Hidden “${target.title}”`,
      variant: "info",
      actionLabel: "Undo",
      onAction: () => {
        void undo();
      },
    });
  };

  const handleActionClick = (actionId: ContextMenuActionId) => {
    switch (actionId) {
      case "open": {
        closeContextMenu(false);
        if (target.kind === "youtube-channel") {
          window.location.hash = `#/library?cat=youtube&channel=${encodeURIComponent(
            target.channel ?? target.title
          )}`;
        } else if (target.href) {
          window.location.hash = target.href;
        } else if (target.workKey) {
          window.location.hash = `#/library?work=${encodeURIComponent(
            target.workKey
          )}`;
        } else {
          window.location.hash = `#/library?q=${encodeURIComponent(
            target.title
          )}`;
        }
        break;
      }
      case "rate":
        setSubPanel("rate");
        break;
      case "category":
        setSubPanel("category");
        break;
      case "topic":
        setSubPanel("topic");
        break;
      case "edit": {
        closeContextMenu(false);
        onOpenEditWork({
          key: effectiveWorkKey,
          title: target.title,
          category: target.category,
          status: target.status,
          rating: target.rating,
          note: target.note,
          topic: target.topic,
          channel: target.channel,
        });
        break;
      }
      case "add_more": {
        closeContextMenu(false);
        const manualWork: ManualWork = {
          provider: "manual",
          category: target.category,
          title: target.title,
          year: null,
          creators: [],
          seasons:
            target.category === "anime" || target.category === "series"
              ? [
                  {
                    number: 1,
                    title: "Season 1",
                    year: null,
                    episodes: 12,
                    episode_minutes: 24,
                    total_minutes: 288,
                    provider_id: null,
                  },
                ]
              : [],
          runtime_minutes: target.category === "film" ? 120 : null,
          pages: target.category === "book" ? 300 : null,
        };
        onOpenAdd({
          category: target.category,
          work: manualWork,
        });
        break;
      }
      case "mark_finished":
        void handleStatusChange("finished");
        break;
      case "mark_in_progress":
        void handleStatusChange("in_progress");
        break;
      case "mark_planned":
        void handleStatusChange("planned");
        break;
      case "hide":
        void handleHide();
        break;
      case "edit_entry": {
        if (!target.entryId) break;
        closeContextMenu(false);
        const manualWork: ManualWork = {
          provider: "manual",
          category: target.category,
          title: target.title,
          year: null,
          creators: [],
          seasons: (target.consumed?.seasons ?? []).map((s) => ({
            number: s.number,
            title: `Season ${s.number}`,
            year: null,
            episodes: s.episodes ?? 12,
            episode_minutes: 24,
            total_minutes: (s.episodes ?? 12) * 24,
            provider_id: null,
          })),
          runtime_minutes: target.category === "film" ? 120 : null,
          pages: null,
        };
        onOpenAdd({
          category: target.category,
          editingEntry: {
            entry_id: target.entryId,
            work: manualWork,
            consumed: target.consumed ?? { times: 1, progress: 1 },
            when: target.when ?? { precision: "unknown" },
            rating: target.rating,
            note: target.note,
          },
        });
        break;
      }
      case "delete_entry":
        setSubPanel("confirm-delete");
        break;
    }
  };

  const handleSaveRating = async (nextRating: number | null) => {
    const prevRating = target.rating ?? null;
    closeContextMenu(true);
    const { undo } = await performWorkEdit(
      effectiveWorkKey,
      { rating: nextRating },
      {
        title: target.title,
        category: target.category,
        rating: prevRating,
        source: target.source,
      }
    );
    pushToast({
      message:
        nextRating !== null
          ? `Rated “${target.title}” ${formatRating10(nextRating)}`
          : `Cleared rating for “${target.title}”`,
      variant: "success",
      actionLabel: "Undo",
      onAction: () => {
        void undo();
      },
    });
  };

  const handleSelectCategory = async (nextCat: Category) => {
    const prevCat = target.category;
    closeContextMenu(true);
    const { undo } = await performWorkEdit(
      effectiveWorkKey,
      { category: nextCat },
      {
        title: target.title,
        category: prevCat,
      }
    );
    pushToast({
      message: `Moved “${target.title}” to ${categoryLabel(nextCat)}`,
      variant: "success",
      actionLabel: "Undo",
      onAction: () => {
        void undo();
      },
    });
  };

  const handleSaveTopic = async (nextTopic: string | null) => {
    const prevTopic = target.topic ?? null;
    const cleanTopic =
      nextTopic && nextTopic.trim() !== "" ? nextTopic.trim() : null;
    closeContextMenu(true);

    if (target.kind === "youtube-channel" || (!target.workKey && target.channel)) {
      const chName = target.channel ?? target.title;
      const { undo } = await performSetChannelTopic(
        chName,
        cleanTopic,
        prevTopic
      );
      pushToast({
        message: cleanTopic
          ? `Set topic for “${chName}” to ${cleanTopic}`
          : `Cleared topic for “${chName}”`,
        variant: "success",
        actionLabel: "Undo",
        onAction: () => {
          void undo();
        },
      });
    } else {
      const { undo } = await performWorkEdit(
        effectiveWorkKey,
        { topic: cleanTopic },
        {
          title: target.title,
          category: target.category,
          topic: prevTopic,
        }
      );
      pushToast({
        message: cleanTopic
          ? `Set topic for “${target.title}” to ${cleanTopic}`
          : `Cleared topic for “${target.title}”`,
        variant: "success",
        actionLabel: "Undo",
        onAction: () => {
          void undo();
        },
      });
    }
  };

  const handleConfirmDeleteEntry = async () => {
    if (!target.entryId) return;
    setDeleting(true);
    try {
      await deleteArchiveEntry(target.entryId);
      const deletedId = target.entryId;
      closeContextMenu(true);
      onDeletedArchiveEntry?.(deletedId);
      pushToast({
        message: `Deleted archive entry “${target.title}”`,
        variant: "info",
      });
    } catch (err) {
      pushToast({
        message: `Could not delete: ${
          err instanceof Error ? err.message : String(err)
        }`,
        variant: "danger",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      ref={menuRef}
      class="ui-context-menu"
      role="menu"
      aria-label={`Actions for ${target.title}`}
      style={{
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        maxWidth: `${placement.maxWidth}px`,
        maxHeight: `${placement.maxHeight}px`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div class="ui-context-menu-header">
        <span
          class={`ui-tab-dot ui-tab-dot--${target.category}`}
          aria-hidden="true"
        />
        <span class="ui-context-menu-title" title={target.title}>
          {target.title}
        </span>
      </div>

      {subPanel === "main" && (
        <div class="ui-context-menu-items">
          {actions.map((act, idx) => {
            const prevGroup = idx > 0 ? actions[idx - 1]?.group : act.group;
            const showDivider = idx > 0 && prevGroup !== act.group;
            return (
              <div key={act.id}>
                {showDivider && (
                  <div class="ui-context-menu-divider" role="separator" />
                )}
                <button
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={focusIdx === idx ? 0 : -1}
                  class={
                    act.danger
                      ? "ui-context-menu-item ui-context-menu-item--danger"
                      : "ui-context-menu-item"
                  }
                  onMouseEnter={() => setFocusIdx(idx)}
                  onClick={() => handleActionClick(act.id)}
                >
                  <span>{act.label}</span>
                  {act.badge && (
                    <span class="ui-context-menu-badge tabular-nums">
                      {act.badge}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {subPanel === "rate" && target.category !== "music" && (
        <div class="ui-context-menu-subpanel">
          <RatingInput10
            rating={draftRating}
            onChange={setDraftRating}
            category={target.category}
            compact
            autoFocus
            onCommit={(val) => void handleSaveRating(val)}
            onCancel={() => setSubPanel("main")}
          />
          <div class="ui-quick-rate-popover-actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSaveRating(draftRating)}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleSaveRating(null)}
            >
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSubPanel("main")}
            >
              ← Back
            </Button>
          </div>
        </div>
      )}

      {subPanel === "category" && (
        <div class="ui-context-menu-subpanel">
          <div class="ui-context-menu-cat-grid">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                role="menuitem"
                class={
                  cat === target.category
                    ? "ui-context-menu-item ui-context-menu-item--active"
                    : "ui-context-menu-item"
                }
                onClick={() => void handleSelectCategory(cat)}
              >
                <span class="ui-context-menu-cat-label">
                  <span class={`ui-tab-dot ui-tab-dot--${cat}`} />
                  <span>{CATEGORY_META[cat].pluralLabel}</span>
                </span>
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSubPanel("main")}
          >
            ← Back
          </Button>
        </div>
      )}

      {subPanel === "topic" && (
        <div class="ui-context-menu-subpanel">
          <input
            type="text"
            class="ui-input"
            placeholder="Custom topic…"
            value={draftTopic}
            onInput={(e) =>
              setDraftTopic((e.currentTarget as HTMLInputElement).value)
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSaveTopic(draftTopic);
              }
            }}
            autofocus
          />
          <div class="ui-context-menu-topic-chips">
            {COMMON_YOUTUBE_TOPICS.slice(0, 7).map((t) => (
              <button
                key={t}
                type="button"
                class="ui-cat-chip"
                onClick={() => void handleSaveTopic(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div class="ui-quick-rate-popover-actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSaveTopic(draftTopic)}
            >
              Save Topic
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleSaveTopic(null)}
            >
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSubPanel("main")}
            >
              ← Back
            </Button>
          </div>
        </div>
      )}

      {subPanel === "confirm-delete" && (
        <div class="ui-context-menu-subpanel">
          <p class="ui-text-muted">
            Delete archive entry for <strong>{target.title}</strong>? This
            writes a tombstone so its units no longer count in totals.
          </p>
          <div class="ui-quick-rate-popover-actions">
            <Button
              variant="danger"
              size="sm"
              disabled={deleting}
              onClick={() => void handleConfirmDeleteEntry()}
            >
              {deleting ? "Deleting…" : "Confirm Delete"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSubPanel("main")}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
