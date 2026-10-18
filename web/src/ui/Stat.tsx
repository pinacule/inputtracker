import type { ComponentChildren } from "preact";
import type { MediaKind } from "../lib/ui-helpers";

export interface StatProps {
  label: string;
  value: ComponentChildren;
  sublabel?: ComponentChildren;
  kind?: MediaKind;
  size?: "md" | "lg";
  icon?: ComponentChildren;
  class?: string;
}

export function Stat({
  label,
  value,
  sublabel,
  kind,
  size = "md",
  icon,
  class: className,
}: StatProps) {
  const classes = [
    "ui-stat",
    size === "lg" ? "ui-stat--lg" : "",
    kind ? `ui-stat--${kind}` : "",
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
      <div class="ui-stat-value tabular-nums">{value}</div>
      {sublabel && <div class="ui-stat-sublabel">{sublabel}</div>}
    </div>
  );
}
