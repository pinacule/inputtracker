import type { ComponentChildren } from "preact";
import type { Category, MediaKind } from "../lib/ui-helpers";

export interface StatProps {
  label: string;
  value: ComponentChildren;
  sublabel?: ComponentChildren;
  category?: Category;
  kind?: MediaKind;
  size?: "md" | "lg";
  icon?: ComponentChildren;
  sparkline?: ComponentChildren;
  class?: string;
}

export function Stat({
  label,
  value,
  sublabel,
  category,
  kind,
  size = "md",
  icon,
  sparkline,
  class: className,
}: StatProps) {
  const accent = category ?? kind;
  const classes = [
    "ui-stat",
    size === "lg" ? "ui-stat--lg" : "",
    accent ? `ui-stat--${accent}` : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={classes}>
      <div class="ui-stat-header">
        {icon}
        <span class="ui-stat-label">{label}</span>
      </div>
      <div class="ui-stat-value-row">
        <div class="ui-stat-value tabular-nums">{value}</div>
        {sparkline && <div class="ui-stat-sparkline">{sparkline}</div>}
      </div>
      {sublabel && <div class="ui-stat-sublabel">{sublabel}</div>}
    </div>
  );
}
