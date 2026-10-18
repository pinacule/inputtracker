import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { IconButton } from "./IconButton";
import { CloseIcon } from "./icons";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}

/**
 * Responsive dialog: renders as a bottom sheet on phones (< 768px)
 * and a centred modal dialog on desktop (>= 768px).
 */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  class: className,
}: SheetProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      class="ui-sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        class={`ui-sheet ${className ?? ""}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Details"}
      >
        <div class="ui-sheet-handle-bar" aria-hidden="true" />
        <div class="ui-sheet-header">
          <div class="ui-sheet-titles">
            <h2 class="ui-sheet-title">{title}</h2>
            {subtitle && <div class="ui-sheet-subtitle">{subtitle}</div>}
          </div>
          <IconButton
            label="Close dialog"
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            <CloseIcon size={18} />
          </IconButton>
        </div>
        <div class="ui-sheet-body">{children}</div>
      </div>
    </div>
  );
}

export const Modal = Sheet;
