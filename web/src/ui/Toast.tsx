import type { ComponentChildren } from "preact";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { CloseIcon } from "./icons";

export type ToastVariant = "info" | "success" | "warning" | "danger";

export interface ToastItem {
  id: string;
  message: ComponentChildren;
  variant?: ToastVariant;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ToastProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

export function Toast({ item, onDismiss }: ToastProps) {
  const variant = item.variant ?? "info";
  return (
    <div
      class={`ui-toast ui-toast--${variant}`}
      role={variant === "danger" ? "alert" : "status"}
      aria-live={variant === "danger" ? "assertive" : "polite"}
    >
      <span class="ui-toast-message">{item.message}</span>
      <div class="ui-toast-actions">
        {item.actionLabel && item.onAction && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              item.onAction?.();
              onDismiss(item.id);
            }}
          >
            {item.actionLabel}
          </Button>
        )}
        <IconButton
          label="Dismiss notification"
          variant="ghost"
          size="sm"
          onClick={() => onDismiss(item.id)}
        >
          <CloseIcon size={15} />
        </IconButton>
      </div>
    </div>
  );
}

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: readonly ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div class="ui-toast-viewport" aria-label="Notifications">
      {toasts.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
