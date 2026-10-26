import type { SkinEffects } from "../types.ts";
import { parseAppRoute } from "../../lib/router.ts";
import { headingWindow, sceneForRoute, type Rect } from "./scene.ts";

/** Reading ink and real control hitboxes, not the whole opaque header (which
 * intentionally contains the optional decorative window). No content copies. */
function protectedHeaderRects(header: HTMLElement): Rect[] {
  const rects: Rect[] = [];
  for (const el of header.querySelectorAll<HTMLElement>("a,button,input,select,textarea,summary,[role=button]")) {
    if (el.checkVisibility()) rects.push(el.getBoundingClientRect());
  }
  const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim() || node.parentElement?.closest('[aria-hidden="true"]')) continue;
    if (!node.parentElement?.checkVisibility()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    rects.push(...range.getClientRects());
  }
  return rects;
}

const effects: SkinEffects = {
  mount(ctx) {
    const root = document.documentElement;
    const setScene = (route: Parameters<typeof sceneForRoute>[0]) => {
      const scene = sceneForRoute(route);
      // No repeated scene switch / image fetch for work, date, filters or query.
      if (root.dataset.thinkerScene !== scene) root.dataset.thinkerScene = scene;
    };
    setScene(parseAppRoute(window.location.hash).route);

    const windows = new Map<HTMLElement, HTMLElement>();
    const resize = new ResizeObserver(() => schedule());
    let frame = 0;
    let disposed = false;
    function update() {
      frame = 0;
      if (disposed) return;
      for (const [header, crop] of windows) {
        if (!header.isConnected) {
          crop.remove();
          resize.unobserve(header);
          windows.delete(header);
        }
      }
      for (const header of document.querySelectorAll<HTMLElement>(".home-topbar,.page-header")) {
        let crop = windows.get(header);
        if (!crop) {
          crop = document.createElement("i");
          crop.className = "th-scene-window";
          crop.setAttribute("aria-hidden", "true");
          header.append(crop);
          windows.set(header, crop);
          resize.observe(header);
        }
        const bounds = header.getBoundingClientRect();
        const spot = headingWindow(bounds, protectedHeaderRects(header), ctx.isPhone);
        crop.hidden = !spot;
        if (spot) {
          crop.style.left = `${spot.left - bounds.left}px`;
          crop.style.top = `${spot.top - bounds.top}px`;
          crop.style.width = `${spot.width}px`;
          crop.style.height = `${spot.height}px`;
        }
      }
    }
    function schedule() {
      if (disposed || frame || document.hidden) return;
      // Layout/font/data changes hide the previous crop until it is remeasured.
      for (const crop of windows.values()) crop.hidden = true;
      frame = requestAnimationFrame(update);
    }
    const mutation = new MutationObserver((records) => {
      const contentChanged = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest(".th-scene-window")) return false;
        if (record.type === "characterData") return true;
        return [...record.addedNodes, ...record.removedNodes]
          .some((node) => !(node instanceof Element && node.matches(".th-scene-window")));
      });
      if (contentChanged) schedule();
    });
    const app = document.getElementById("app");
    if (app) mutation.observe(app, { subtree: true, childList: true, characterData: true });
    window.addEventListener("resize", schedule, { signal: ctx.signal });
    document.fonts.addEventListener("loadingdone", schedule, { signal: ctx.signal });
    const offPage = ctx.on("page-change", ({ to }) => { setScene(to); schedule(); });
    const offVisibility = ctx.onVisibility((visible) => {
      if (visible) schedule();
      else { cancelAnimationFrame(frame); frame = 0; }
    });
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      offPage();
      offVisibility();
      window.removeEventListener("resize", schedule);
      document.fonts.removeEventListener("loadingdone", schedule);
      for (const crop of windows.values()) crop.remove();
      windows.clear();
      root.removeAttribute("data-thinker-scene");
    };
  },
};

export default effects;
