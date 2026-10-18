import type { ComponentChildren } from "preact";
import { SparkleIcon } from "./icons";

export interface EmptyStateProps {
  title: ComponentChildren;
  description?: ComponentChildren;
  icon?: ComponentChildren;
  actions?: ComponentChildren;
  compact?: boolean;
  class?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  actions,
  compact = false,
  class: className,
}: EmptyStateProps) {
  const classes = [
    "ui-empty-state",
    compact ? "ui-empty-state--compact" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={classes}>
      <div class="ui-empty-icon" aria-hidden="true">
        {icon ?? <SparkleIcon size={24} />}
      </div>
      <h3 class="ui-empty-title">{title}</h3>
      {description && <p class="ui-empty-description">{description}</p>}
      {actions && <div class="ui-empty-actions">{actions}</div>}
    </div>
  );
}
