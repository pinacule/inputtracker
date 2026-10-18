import type { ComponentChildren } from "preact";
import type { MediaKind } from "../lib/ui-helpers";

export interface TabOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number;
  readonly kind?: MediaKind;
  readonly icon?: ComponentChildren;
}

export interface TabsProps<T extends string = string> {
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  variant?: "segmented" | "pills";
  class?: string;
}

export function Tabs<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  variant = "segmented",
  class: className,
}: TabsProps<T>) {
  const classes = [
    "ui-tabs",
    variant === "pills" ? "ui-tabs--pills" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={classes} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isSelected}
            class={isSelected ? "ui-tab ui-tab--active" : "ui-tab"}
            onClick={() => onChange(option.value)}
          >
            {option.kind && (
              <span
                class={`ui-tab-dot ui-tab-dot--${option.kind}`}
                aria-hidden="true"
              />
            )}
            {option.icon}
            <span>{option.label}</span>
            {option.count !== undefined && (
              <span class="ui-tab-count">({option.count})</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export const SegmentedControl = Tabs;
