import type { ComponentChildren } from "preact";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  href?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  leadingIcon?: ComponentChildren;
  trailingIcon?: ComponentChildren;
  ariaLabel?: string;
  class?: string;
  children: ComponentChildren;
}

export function Button({
  variant = "secondary",
  size = "md",
  fullWidth = false,
  href,
  type = "button",
  disabled = false,
  onClick,
  leadingIcon,
  trailingIcon,
  ariaLabel,
  class: className,
  children,
}: ButtonProps) {
  const classes = [
    "ui-btn",
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    fullWidth ? "ui-btn--full" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (href && !disabled) {
    return (
      <a
        href={href}
        class={classes}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        {leadingIcon && <span class="ui-btn-icon">{leadingIcon}</span>}
        <span>{children}</span>
        {trailingIcon && <span class="ui-btn-icon">{trailingIcon}</span>}
      </a>
    );
  }

  return (
    <button
      type={type}
      class={classes}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {leadingIcon && <span class="ui-btn-icon">{leadingIcon}</span>}
      <span>{children}</span>
      {trailingIcon && <span class="ui-btn-icon">{trailingIcon}</span>}
    </button>
  );
}
