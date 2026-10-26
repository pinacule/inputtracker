import { useEffect, useRef, useState } from "preact/hooks";
import { CheckIcon, ChevronDownIcon, SortDirectionIcon } from "./icons";

export interface SortOption<T extends string = string> {
  value: T;
  label: string;
  /** What the default direction shows, e.g. "Highest first". */
  forwardHint: string;
  /** What the flipped direction shows, e.g. "Lowest first". */
  reversedHint: string;
}

export interface SortControlProps<T extends string = string> {
  options: ReadonlyArray<SortOption<T>>;
  value: T;
  reversed: boolean;
  onChange: (value: T) => void;
  onReverse: (reversed: boolean) => void;
  ariaLabel?: string;
}

/**
 * Sort dropdown + direction flip, styled as one segmented control so it sits
 * next to the status and view tabs instead of looking like a native `<select>`.
 */
export function SortControl<T extends string = string>({
  options,
  value,
  reversed,
  onChange,
  onReverse,
  ariaLabel = "Sort",
}: SortControlProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value) ?? options[0];
  const hint = current
    ? reversed
      ? current.reversedHint
      : current.forwardHint
    : "";

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const moveFocus = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []
    );
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(idx + step + items.length) % items.length]?.focus();
  };

  return (
    <div class="ui-tabs ui-sort-control" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        class="ui-tab ui-tab--active ui-sort-trigger"
        aria-label={`${ariaLabel}: ${current?.label ?? ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span class="ui-sort-trigger-label">{current?.label}</span>
        <ChevronDownIcon size={14} class="ui-sort-chevron" />
      </button>
      <button
        type="button"
        class={reversed ? "ui-tab ui-sort-flip ui-sort-flip--reversed" : "ui-tab ui-sort-flip"}
        aria-pressed={reversed}
        aria-label={`Reverse order (now ${hint.toLowerCase()})`}
        title={hint}
        onClick={() => onReverse(!reversed)}
      >
        <SortDirectionIcon size={15} />
      </button>

      {open && (
        <div
          ref={menuRef}
          class="ui-sort-menu"
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={moveFocus}
        >
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                class={
                  selected
                    ? "ui-context-menu-item ui-context-menu-item--active"
                    : "ui-context-menu-item"
                }
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span class="ui-sort-menu-text">
                  <span>{opt.label}</span>
                  <span class="ui-sort-menu-hint">{opt.forwardHint}</span>
                </span>
                {selected && <CheckIcon size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
