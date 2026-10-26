import { useEffect } from "preact/hooks";
import type { ThemeId } from "../lib/theme.ts";
import { createAmbientScheduler } from "./ambient.ts";
import { clearSkinEventHint, onSkinEvent } from "./events.ts";
import { SKIN_EFFECTS } from "./registry.ts";
import type { SkinContext } from "./types.ts";

/** Recomputed at run time, so scroll, disclosure and route changes need no cache. */
export function visibleObstacles(): DOMRect[] {
  const rects: DOMRect[] = [];
  const visible = (rect: DOMRect) => rect.width > 0 && rect.height > 0 && rect.right > 0
    && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
  const hidden = (el: Element) => {
    const style = getComputedStyle(el);
    return style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0;
  };
  const selector = 'a,button,input,select,textarea,label,summary,[role="button"],[role="tab"],[contenteditable],nav,aside,header,.ui-card,.skin-card,.home-day-overview,.home-day-entries,.home-week-card,.home-rhythm-card,.home-category-index,.library-work-card,.library-work-list-row,.review-poster';
  for (const el of document.querySelectorAll(selector)) {
    if (el.closest("[data-skin-layer]") || hidden(el)) continue;
    const rect = el.getBoundingClientRect();
    if (visible(rect)) rects.push(rect);
  }
  // Text nodes also protect uncased/plain text outside cards (including SVG labels).
  const walker = document.createTreeWalker(document.getElementById("app") ?? document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!node.textContent?.trim() || !el || el.closest("[data-skin-layer],script,style") || hidden(el)) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (visible(rect)) rects.push(rect);
  }
  return rects;
}

/** Owns all shared subscriptions and guards async imports against rapid switches. */
export function SkinLayer({ theme }: { theme: ThemeId }) {
  useEffect(() => {
    const load = SKIN_EFFECTS[theme];
    if (!load) return;
    const controller = new AbortController();
    const cleanups = new Set<() => void>();
    const track = (cleanup: () => void) => {
      const off = () => { cleanup(); cleanups.delete(off); };
      cleanups.add(off);
      return off;
    };
    const bg = document.createElement("div");
    const fx = document.createElement("div");
    for (const [node, name] of [[bg, "bg"], [fx, "fx"]] as const) {
      node.setAttribute("aria-hidden", "true");
      node.dataset.skinLayer = name;
      node.dataset.skin = theme;
      document.body.appendChild(node);
    }
    document.documentElement.setAttribute("data-skin-effects", theme);
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = matchMedia("(pointer: fine)");
    const phone = matchMedia("(max-width: 767px)");
    const ambient = createAmbientScheduler<HTMLElement>({ layer: fx, obstacles: visibleObstacles,
      isHidden: () => document.hidden, reducedMotion: () => motion.matches });
    const ctx: SkinContext = {
      bg, fx, signal: controller.signal, ambient,
      get reducedMotion() { return motion.matches; },
      get finePointer() { return pointer.matches; },
      get isPhone() { return phone.matches; },
      obstacles: visibleObstacles,
      on(type, cb) { return track(onSkinEvent(type, cb)); },
      onVisibility(cb) {
        const listener = () => cb(!document.hidden);
        document.addEventListener("visibilitychange", listener);
        return track(() => document.removeEventListener("visibilitychange", listener));
      },
      onMotionChange(cb) {
        const subscription = matchMedia("(prefers-reduced-motion: reduce)");
        const listener = () => cb(subscription.matches);
        subscription.addEventListener("change", listener);
        return track(() => subscription.removeEventListener("change", listener));
      },
    };
    let unmount: (() => void) | undefined;
    const dispose = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      try { unmount?.(); } catch { /* Decorative cleanup must not interrupt the app. */ } finally {
        ambient.stop();
        for (const cleanup of [...cleanups]) cleanup();
        bg.remove();
        fx.remove();
        document.documentElement.removeAttribute("data-skin-effects");
        clearSkinEventHint();
      }
    };
    void load().then(({ default: effects }) => {
      if (controller.signal.aborted) return;
      unmount = effects.mount(ctx);
    }).catch(() => { dispose(); });
    return dispose;
  }, [theme]);
  return null;
}
