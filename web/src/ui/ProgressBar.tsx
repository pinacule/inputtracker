import type { ComponentChildren } from "preact";
import type { Category, MediaKind } from "../lib/ui-helpers";

export interface ProgressBarProps {
  /** Progress value between 0 and 100 (or `max`). */
  value: number;
  max?: number;
  label?: ComponentChildren;
  valueLabel?: ComponentChildren;
  ariaLabel?: string;
  category?: Category;
  kind?: MediaKind;
  size?: "sm" | "md" | "lg";
  class?: string;
}

export function ProgressBar({
  value,
  max = 100,
  label,
  valueLabel,
  ariaLabel,
  category,
  kind,
  size = "md",
  class: className,
}: ProgressBarProps) {
  const safeMax = max > 0 ? max : 100;
  const clamped = Math.max(0, Math.min(safeMax, Number.isNaN(value) ? 0 : value));
  const percent = Math.round((clamped / safeMax) * 1000) / 10;
  const accent = category ?? kind;

  const classes = [
    "ui-progress",
    `ui-progress--${size}`,
    accent ? `ui-progress--${accent}` : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={classes}>
      {(label || valueLabel) && (
        <div class="ui-progress-header">
          {label && <span>{label}</span>}
          {valueLabel && <span class="tabular-nums">{valueLabel}</span>}
        </div>
      )}
      <div
        class="ui-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={Math.round(clamped)}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : "Progress")}
      >
        <div class="ui-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
