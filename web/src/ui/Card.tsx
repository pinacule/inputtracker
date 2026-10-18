import type { ComponentChildren } from "preact";

export type CardVariant = "default" | "elevated" | "subtle" | "interactive";
export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps {
  variant?: CardVariant;
  padding?: CardPadding;
  title?: ComponentChildren;
  subtitle?: ComponentChildren;
  actions?: ComponentChildren;
  class?: string;
  children: ComponentChildren;
}

export function Card({
  variant = "default",
  padding = "md",
  title,
  subtitle,
  actions,
  class: className,
  children,
}: CardProps) {
  const classes = [
    "ui-card",
    variant !== "default" ? `ui-card--${variant}` : "",
    `ui-card--pad-${padding}`,
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={classes}>
      {(title || subtitle || actions) && (
        <div class="ui-card-header">
          <div class="ui-card-titles">
            {title && <h3 class="ui-card-title">{title}</h3>}
            {subtitle && <div class="ui-card-subtitle">{subtitle}</div>}
          </div>
          {actions && <div class="ui-card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
