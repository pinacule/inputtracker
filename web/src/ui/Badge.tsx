import type { ComponentChildren } from "preact";
import {
  isCategory,
  resolveItemCategory,
  type Category,
  type MediaKind,
} from "../lib/ui-helpers";

export type BadgeVariant =
  | Category
  | MediaKind
  | "neutral"
  | "success"
  | "warning"
  | "danger";

export interface BadgeProps {
  variant?: BadgeVariant;
  /** Canonical v2 category (`anime`, `series`, `film`, `book`, `audiobook`, `youtube`, `podcast`, `music`, `other`). */
  category?: Category | null;
  /** Automatically resolve category/variant from `source` and `mediaType`. */
  source?: string | null;
  mediaType?: string | null;
  size?: "sm" | "md";
  icon?: ComponentChildren;
  class?: string;
  children: ComponentChildren;
}

export function Badge({
  variant,
  category,
  source,
  mediaType,
  size = "md",
  icon,
  class: className,
  children,
}: BadgeProps) {
  const resolvedVariant: BadgeVariant =
    variant ??
    (category && isCategory(category)
      ? category
      : source || mediaType
        ? resolveItemCategory({ source, media_type: mediaType })
        : "neutral");

  const classes = [
    "ui-badge",
    `ui-badge--${size}`,
    `ui-badge--${resolvedVariant}`,
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span class={classes}>
      {icon}
      <span>{children}</span>
    </span>
  );
}
