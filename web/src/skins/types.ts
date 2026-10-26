import type { AmbientScheduler } from "./ambient.ts";
import type { SkinEventType, SkinListener } from "./events.ts";

export interface SkinContext {
  readonly bg: HTMLElement;
  readonly fx: HTMLElement;
  /** Live getters, not snapshots. */
  readonly reducedMotion: boolean;
  readonly finePointer: boolean;
  readonly isPhone: boolean;
  readonly signal: AbortSignal;
  /** Receives true when visible, false when hidden. Automatically unsubscribed. */
  onVisibility(cb: (visible: boolean) => void): () => void;
  onMotionChange(cb: (reduced: boolean) => void): () => void;
  on<K extends SkinEventType>(type: K, cb: SkinListener<K>): () => void;
  obstacles(): DOMRect[];
  readonly ambient: AmbientScheduler<HTMLElement>;
}
export interface SkinEffects { mount(ctx: SkinContext): () => void }
