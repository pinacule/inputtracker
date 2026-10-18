import type { ComponentChildren } from "preact";
import { resolveMediaKind, type MediaKind } from "../lib/ui-helpers";

export type BadgeVariant =
  | MediaKind
  | "neutral"
  | "success"
  | "warning"
  | "danger";

export interface BadgeProps {
  variant?: BadgeVariant;
  /** Automatically resolve MediaKind variant from `source` and `mediaType`. */
  source?: string | null;
  mediaType?: string | null;
  size?: "sm" | "md";
  icon?: ComponentChildren;
  class?: string;
  children: ComponentChildren;
}

export function Badge({
  variant,
  source,
  mediaType,
  size = "md",
  icon,
  class: className,
  children,
}: BadgeProps) {
  const resolvedVariant: BadgeVariant =
    variant ?? (source || mediaType ? resolveMediaKind(source, mediaType) : "neutral");

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
