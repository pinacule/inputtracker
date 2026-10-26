import type { AppRoute } from "../lib/router.ts";

export interface SkinEvents {
  "page-change": { from: AppRoute; to: AppRoute };
  "day-change": { from: string; to: string; direction: -1 | 1 };
  "week-change": { direction: -1 | 1 };
  "month-change": { direction: -1 | 1 };
}
export type SkinEventType = keyof SkinEvents;
export type SkinListener<K extends SkinEventType> = (event: SkinEvents[K]) => void;
const listeners = new Map<SkinEventType, Set<(event: never) => void>>();
const rootElement = () => (globalThis as unknown as { document?: { documentElement: {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
} } }).document?.documentElement;
let resetTimer: ReturnType<typeof setTimeout> | undefined;

export function onSkinEvent<K extends SkinEventType>(type: K, cb: SkinListener<K>): () => void {
  let group = listeners.get(type);
  if (!group) listeners.set(type, group = new Set());
  const listener = cb as (event: never) => void;
  group.add(listener);
  return () => {
    if (!group.delete(listener)) return;
    if (!group.size && listeners.get(type) === group) listeners.delete(type);
  };
}

export function clearSkinEventHint(): void {
  clearTimeout(resetTimer);
  resetTimer = undefined;
  const root = rootElement();
  root?.removeAttribute("data-skin-event");
  root?.removeAttribute("data-skin-dir");
}

export function emitSkinEvent<K extends SkinEventType>(type: K, event: SkinEvents[K]): void {
  const root = rootElement();
  if (root) {
    clearSkinEventHint();
    root.setAttribute("data-skin-event", type);
    if ("direction" in event) root.setAttribute("data-skin-dir", event.direction === 1 ? "next" : "prev");
    resetTimer = setTimeout(clearSkinEventHint, 700);
  }
  for (const listener of [...(listeners.get(type) ?? [])]) {
    // A decorative listener must never interrupt navigation or other listeners.
    try { listener(event as never); } catch { /* Skin reactions are optional. */ }
  }
}
