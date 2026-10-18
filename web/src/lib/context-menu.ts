/**
 * Pure, DOM-free helpers for the v2.1 Context Menu:
 * - Viewport-safe menu placement (clamping & edge flipping)
 * - Contextual action generation based on item kind, category, status, and archive entry
 * - Accessible keyboard focus index stepping (`ArrowDown`, `ArrowUp`, `Home`, `End`)
 */

import type {
  ArchiveConsumed,
  ArchiveWhen,
  Category,
  WorkStatus,
} from "../api";
import { formatRating10 } from "./rating";

export interface MenuPoint {
  readonly x: number;
  readonly y: number;
}

export interface MenuDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ViewportRect {
  readonly width: number;
  readonly height: number;
}

export interface MenuPlacement {
  readonly left: number;
  readonly top: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/**
 * Computes a viewport-safe `(left, top, maxWidth, maxHeight)` placement for a context menu
 * or popover so it never overflows the screen edges on 375px phones or 1440px desktops.
 */
export function computeContextMenuPlacement(
  point: MenuPoint,
  menu: MenuDimensions,
  viewport: ViewportRect,
  padding = 12
): MenuPlacement {
  const safePadding = Math.max(4, padding);
  const vw = Math.max(240, viewport.width);
  const vh = Math.max(240, viewport.height);

  const maxWidth = Math.max(160, vw - safePadding * 2);
  const maxHeight = Math.max(160, vh - safePadding * 2);

  const effectiveWidth = Math.min(Math.max(160, menu.width), maxWidth);
  const effectiveHeight = Math.min(Math.max(80, menu.height), maxHeight);

  let left = point.x;
  if (left + effectiveWidth + safePadding > vw) {
    const flippedLeft = point.x - effectiveWidth;
    left =
      flippedLeft >= safePadding
        ? flippedLeft
        : vw - effectiveWidth - safePadding;
  }
  left = Math.max(safePadding, Math.min(left, vw - effectiveWidth - safePadding));

  let top = point.y;
  if (top + effectiveHeight + safePadding > vh) {
    const flippedTop = point.y - effectiveHeight;
    top =
      flippedTop >= safePadding
        ? flippedTop
        : vh - effectiveHeight - safePadding;
  }
  top = Math.max(safePadding, Math.min(top, vh - effectiveHeight - safePadding));

  return {
    left: Math.round(left),
    top: Math.round(top),
    maxWidth: Math.round(maxWidth),
    maxHeight: Math.round(maxHeight),
  };
}

export type ContextMenuTargetKind =
  | "work"
  | "youtube-channel"
  | "youtube-video"
  | "day-work"
  | "archive-entry";

export interface ContextMenuTarget {
  readonly kind: ContextMenuTargetKind;
  readonly workKey?: string;
  readonly title: string;
  readonly category: Category;
  readonly status?: WorkStatus;
  readonly rating?: number | null;
  readonly note?: string | null;
  readonly channel?: string | null;
  readonly topic?: string | null;
  readonly entryId?: string | null;
  readonly href?: string;
  readonly source?: string;
  readonly consumed?: ArchiveConsumed;
  readonly when?: ArchiveWhen;
}

export type ContextMenuActionId =
  | "open"
  | "rate"
  | "edit"
  | "category"
  | "topic"
  | "add_more"
  | "mark_finished"
  | "mark_in_progress"
  | "mark_planned"
  | "hide"
  | "edit_entry"
  | "delete_entry";

export interface ContextMenuAction {
  readonly id: ContextMenuActionId;
  readonly label: string;
  readonly badge?: string;
  readonly danger?: boolean;
  readonly group: "primary" | "organize" | "status" | "archive" | "danger";
}

/**
 * Builds the contextual menu actions appropriate for `target`:
 * - Rate… (with current rating badge if set)
 * - Edit… (title, category, status, metadata match, note)
 * - Change category
 * - Set topic (YouTube works/channels/videos)
 * - Add more seasons / Log again
 * - Mark planned / finished / in progress
 * - Hide
 * - Open
 * - Edit entry / Delete (archive entries only)
 */
export function buildContextMenuActions(
  target: ContextMenuTarget
): ContextMenuAction[] {
  const actions: ContextMenuAction[] = [];

  if (target.kind === "youtube-channel") {
    actions.push({
      id: "open",
      label: "Open channel",
      group: "primary",
    });
    actions.push({
      id: "topic",
      label: "Set channel topic…",
      badge: target.topic ?? undefined,
      group: "organize",
    });
    return actions;
  }

  // Open work
  if (target.href || target.workKey) {
    actions.push({
      id: "open",
      label: "Open work",
      group: "primary",
    });
  }

  // Rate (0..10 one decimal) — hidden for music tracks
  if (target.category !== "music") {
    actions.push({
      id: "rate",
      label:
        target.rating !== null && target.rating !== undefined
          ? "Change rating…"
          : "Rate…",
      badge:
        target.rating !== null && target.rating !== undefined
          ? `★ ${formatRating10(target.rating)}`
          : undefined,
      group: "primary",
    });
  }

  // Edit work (title, category, status, metadata link, note)
  actions.push({
    id: "edit",
    label: "Edit work…",
    group: "organize",
  });

  // Change category
  actions.push({
    id: "category",
    label: "Change category…",
    group: "organize",
  });

  // Set topic (for YouTube works/videos)
  if (
    target.category === "youtube" ||
    target.kind === "youtube-video" ||
    Boolean(target.channel)
  ) {
    actions.push({
      id: "topic",
      label: "Set topic…",
      badge: target.topic ?? undefined,
      group: "organize",
    });
  }

  // Add more seasons / Log again
  actions.push({
    id: "add_more",
    label:
      target.category === "anime" || target.category === "series"
        ? "Add more seasons…"
        : "Log again…",
    group: "organize",
  });

  // Status quick actions
  if (target.status !== "finished") {
    actions.push({
      id: "mark_finished",
      label: "Mark as finished",
      group: "status",
    });
  }
  if (target.status !== "in_progress") {
    actions.push({
      id: "mark_in_progress",
      label: "Mark as in progress",
      group: "status",
    });
  }
  if (target.status !== "planned") {
    actions.push({
      id: "mark_planned",
      label: "Mark as planned (watchlist)",
      group: "status",
    });
  }

  // Archive entry specific actions
  if (target.entryId) {
    actions.push({
      id: "edit_entry",
      label: "Edit archive entry…",
      group: "archive",
    });
  }

  // Hide work
  if (target.workKey || target.kind === "work" || target.kind === "day-work" || target.kind === "youtube-video") {
    actions.push({
      id: "hide",
      label: "Hide work",
      group: "danger",
    });
  }

  // Delete archive entry (archive entries only, requires confirm)
  if (target.entryId) {
    actions.push({
      id: "delete_entry",
      label: "Delete archive entry…",
      danger: true,
      group: "danger",
    });
  }

  return actions;
}

/**
 * Computes the next focused menu item index for keyboard navigation
 * (`ArrowDown`, `ArrowUp`, `Home`, `End`). Returns `null` for unhandled keys.
 */
export function nextMenuFocusIndex(
  currentIndex: number,
  total: number,
  key: string
): number | null {
  if (total <= 0) {
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return (currentIndex + 1) % total;
    case "ArrowUp":
      return (currentIndex - 1 + total) % total;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    default:
      return null;
  }
}
