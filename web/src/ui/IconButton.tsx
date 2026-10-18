import type { ComponentChildren } from "preact";

export type IconButtonVariant = "default" | "subtle" | "ghost" | "primary";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps {
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  active?: boolean;
  href?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  class?: string;
  children: ComponentChildren;
}

export function IconButton({
  label,
  variant = "default",
  size = "md",
  active = false,
  href,
  type = "button",
  disabled = false,
  onClick,
  class: className,
  children,
}: IconButtonProps) {
  const classes = [
    "ui-icon-btn",
    `ui-icon-btn--${variant}`,
    `ui-icon-btn--${size}`,
    active ? "ui-icon-btn--active" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (href && !disabled) {
    return (
      <a href={href} class={classes} aria-label={label} onClick={onClick}>
        {children}
      </a>
    );
  }

  return (
    <button
      type={type}
      class={classes}
      aria-label={label}
      aria-pressed={active ? true : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
