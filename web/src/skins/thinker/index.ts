import type { SkinEffects } from "../types.ts";
import { parseAppRoute } from "../../lib/router.ts";
import { headingBackdrop, headingWindow, sceneForRoute, type Rect } from "./scene.ts";
import { createMotion } from "./motion.ts";
import { createAmbience } from "./ambient.ts";
import { LIT_SURFACES, litSurface, sampleFlame } from "./flame.ts";

/** Reading ink and real control hitboxes, not the whole opaque header (which
 * intentionally contains the optional decorative window). No content copies. */
function protectedHeaderRects(header: HTMLElement): Rect[] {
  const rects: Rect[] = [];
  for (const el of header.querySelectorAll<HTMLElement>("a,button,input,select,textarea,summary,[role=button]")) {
    if (el.checkVisibility()) rects.push(el.getBoundingClientRect());
  }
  // A work's authoritative artwork/metadata is never a statue window. On a
  // phone only the vacant area beside its real cover is eligible.
  if (header.matches(".work-hero-card")) {
    for (const el of header.querySelectorAll<HTMLElement>(".work-hero-layout > :not(.work-hero-body),.work-hero-body")) {
      rects.push(el.getBoundingClientRect());
    }
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

    const node = (className: string) => {
      const el = document.createElement("i");
      el.className = className;
      ctx.bg.append(el);
      return el;
    };
    const wall = node("th-wall-light");
    const statueShadow = node("th-statue-shadow");
    const figure = node("th-figure-shadow");
    const statue = node("th-statue");
    const statueLight = node("th-statue-light");
    const marbleGlint = node("th-marble-glint");
    const motion = createMotion(ctx);
    let elapsed = 0;
    let walkStart = -Infinity;
    let gustStart = -Infinity;
    let glintStart = -Infinity;
    const ambience = createAmbience(ctx, () => { walkStart = elapsed; }, () => { gustStart = elapsed; }, () => { glintStart = elapsed; });
    let torchStart = -Infinity;
    let torchDirection = 1;
    let lastCrest = -Infinity;
    const ownedTokens = new Set<string>();
    const token = (name: string, value: string) => {
      ownedTokens.add(name); root.style.setProperty(name, value);
    };
    function light() {
      const flame = sampleFlame(elapsed);
      const pass = elapsed - torchStart;
      const lean = pass < 650 ? Math.sin(Math.PI * pass / 1300) : pass < 1550 ? 1 - (pass - 650) / 900 : 0;
      const x = flame.x + torchDirection * lean;
      const f = flame.intensity;
      token("--th-flame", f.toFixed(3));
      token("--th-flame-x", flame.x.toFixed(3));
      token("--th-flame-y", flame.y.toFixed(3));
      token("--th-rim", (.25 + f * .40).toFixed(3));
      token("--th-edge-lit", litSurface(...LIT_SURFACES[0], f));
      token("--th-raised-edge", litSurface(...LIT_SURFACES[1], f));
      token("--th-subtle-edge", litSurface(...LIT_SURFACES[2], f));
      token("--th-photo-light", (.66 + f * .90).toFixed(3));
      token("--th-warmth", (.13 + f * .60).toFixed(3));
      token("--th-fire-angle", `${64 + x * 56 + flame.y * 22}deg`);
      token("--th-gust", elapsed - gustStart < 2600 ? String(.18 * Math.sin(Math.PI * (elapsed - gustStart) / 2600)) : "0");
      const glint = elapsed - glintStart;
      marbleGlint.style.opacity = glint < 2000 ? String(.55 * Math.sin(Math.PI * glint / 2000)) : "0";
      marbleGlint.style.setProperty("--th-glint-position", `${Math.min(100, glint / 20)}%`);
      const sway = ctx.isPhone ? 12 : 24;
      const rotation = ctx.isPhone ? 1.5 : 2;
      const stretch = flame.stretch + (elapsed - gustStart < 2600 ? .13 * Math.sin(Math.PI * (elapsed - gustStart) / 2600) : 0);
      statueShadow.style.transform = `translate(${x * sway}px,${flame.y * 8}px) rotate(${flame.x * rotation}deg) scaleX(${stretch})`;
      const walk = elapsed - walkStart;
      const walking = walk < 10_000;
      const travel = walking ? Math.sin(Math.PI * walk / 10_000) * window.innerWidth * .55 : 0;
      figure.style.transform = `translate(${travel + x * sway}px,${flame.y * 6}px) rotate(${-flame.x * rotation}deg) scaleX(${stretch})`;
      figure.style.opacity = String(.42 + f * .18);
      wall.style.opacity = String(.18 + f * .78);
      wall.style.transform = `translateX(${x * sway}px)`;
      // Only visible cards receive moving shadow offsets, at 10/8fps. The
      // background colour/light updates are shared, not per-card geometry reads.
      for (const card of motion.visible) {
        const raised = card.classList.contains("ui-card--elevated");
        card.style.setProperty("--th-shadow-x", `${-Math.max(-1, Math.min(1, x)) * (raised ? 8 : 6)}px`);
        card.style.setProperty("--th-shadow-y", `${(raised ? 18 : 12) + flame.y * (raised ? 4 : 3)}px`);
      }
    }
    let fireFrame = 0;
    let lastFrame = 0;
    let lastLight = 0;
    function tick(now: number) {
      fireFrame = 0;
      if (disposed || document.hidden || ctx.reducedMotion) return;
      if (lastFrame && now - lastFrame < 1000 / 30) {
        fireFrame = requestAnimationFrame(tick); return;
      }
      const dt = lastFrame ? Math.min(100, now - lastFrame) : 0;
      elapsed += dt; ambience.tick(dt); lastFrame = now;
      if (now - lastLight >= (ctx.isPhone ? 125 : 100)) { light(); lastLight = now; }
      fireFrame = requestAnimationFrame(tick);
    }
    function resume() {
      root.dataset.thinkerPaused = String(document.hidden || ctx.reducedMotion);
      cancelAnimationFrame(fireFrame); fireFrame = 0;
      lastFrame = 0; lastLight = 0;
      motion.stop(); walkStart = -Infinity; gustStart = -Infinity; glintStart = -Infinity; torchStart = -Infinity;
      ambience.reset();
      if (ctx.reducedMotion) elapsed = 0;
      light();
      if (!document.hidden && !ctx.reducedMotion) fireFrame = requestAnimationFrame(tick);
    }

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
      for (const header of document.querySelectorAll<HTMLElement>(".home-topbar,.page-header,.work-hero-card")) {
        let crop = windows.get(header);
        if (!crop) {
          crop = document.createElement("i");
          crop.className = "th-scene-window";
          crop.setAttribute("aria-hidden", "true");
          header.append(crop);
          windows.set(header, crop);
          const photo = document.createElement("i");
          photo.className = "th-window-photo";
          crop.append(photo);
          const illumination = document.createElement("i");
          illumination.className = "th-window-light";
          photo.append(illumination);
          resize.observe(header);
        }
        const bounds = header.getBoundingClientRect();
        const protectedRects = protectedHeaderRects(header);
        // Never backdrop a work's authoritative artwork/metadata. Other
        // headers use a compact right-side statue with local opaque ink scrims.
        const backdrop = !header.matches(".work-hero-card");
        const spot = backdrop ? headingBackdrop(bounds, ctx.isPhone) : headingWindow(bounds, protectedRects, ctx.isPhone);
        crop.hidden = !spot;
        for (const scrim of crop.querySelectorAll(".th-ink-scrim")) scrim.remove();
        if (spot) {
          crop.style.left = `${spot.left - bounds.left}px`;
          crop.style.top = `${spot.top - bounds.top}px`;
          crop.style.width = `${spot.width}px`;
          crop.style.height = `${spot.height}px`;
          if (backdrop) for (const rect of protectedRects) {
            if (rect.left >= spot.left + spot.width || rect.left + rect.width <= spot.left ||
              rect.top >= spot.top + spot.height || rect.top + rect.height <= spot.top) continue;
            const scrim = document.createElement("i");
            scrim.className = "th-ink-scrim";
            scrim.style.left = `${rect.left - spot.left - 3}px`;
            scrim.style.top = `${rect.top - spot.top - 3}px`;
            scrim.style.width = `${rect.width + 6}px`;
            scrim.style.height = `${rect.height + 6}px`;
            crop.append(scrim);
          }
        }
      }
      motion.update();
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
      if (contentChanged) {
        motion.update(); // start paint reveals before the very next browser paint
        clearTransients();
        schedule();
      }
    });
    const app = document.getElementById("app");
    if (app) mutation.observe(app, { subtree: true, childList: true, characterData: true });
    window.addEventListener("resize", schedule, { signal: ctx.signal });
    // Cancel transient free-space paths if scrolling, menus or layout change
    // could invalidate their complete swept bounds. Scheduler resumes fresh.
    const clearTransients = () => {
      // Background beats also own a transient slot. If its scheduler lease is
      // cancelled, return it to base sway before a new foreground beat can run.
      walkStart = -Infinity; gustStart = -Infinity; glintStart = -Infinity;
      ctx.ambient.stop(); ctx.ambient.start();
    };
    window.addEventListener("scroll", clearTransients, { signal: ctx.signal, passive: true });
    window.addEventListener("resize", clearTransients, { signal: ctx.signal });
    document.fonts.addEventListener("loadingdone", schedule, { signal: ctx.signal });
    const offPage = ctx.on("page-change", ({ to }) => {
      setScene(to); motion.stop(); motion.page(); clearTransients(); schedule();
      if (!ctx.reducedMotion && !document.hidden) { torchStart = elapsed; torchDirection = 1; }
    });
    const pass = (direction: -1 | 1) => {
      if (ctx.reducedMotion || document.hidden) return;
      torchDirection = direction; torchStart = elapsed;
      motion.direction(direction);
      // Rapid navigation replaces decoration, never stacks broad light crests.
      root.dataset.thinkerTorch = elapsed - lastCrest >= 1000 ? "lit" : "quiet";
      if (elapsed - lastCrest >= 1000) lastCrest = elapsed;
      schedule(); clearTransients();
    };
    const offs = [ctx.on("day-change", ({ direction }) => pass(direction)),
      ctx.on("week-change", ({ direction }) => pass(direction)),
      ctx.on("month-change", ({ direction }) => pass(direction))];
    const offVisibility = ctx.onVisibility((visible) => {
      resume();
      if (visible) schedule();
      else { cancelAnimationFrame(frame); frame = 0; }
    });
    const offMotion = ctx.onMotionChange(() => { resume(); schedule(); });
    const offCursor = mountCursor(ctx, () => ambience.priority());
    resume();
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(fireFrame);
      ambience.dispose(); motion.dispose(); offCursor();
      mutation.disconnect();
      resize.disconnect();
      offPage();
      offVisibility();
      offMotion(); for (const off of offs) off();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("resize", clearTransients);
      window.removeEventListener("scroll", clearTransients);
      document.fonts.removeEventListener("loadingdone", schedule);
      for (const crop of windows.values()) crop.remove();
      windows.clear();
      root.removeAttribute("data-thinker-scene");
      root.removeAttribute("data-thinker-paused");
      root.removeAttribute("data-thinker-torch");
      for (const name of ownedTokens) root.style.removeProperty(name);
      for (const el of [wall, statueShadow, figure, statue, statueLight, marbleGlint]) el.remove();
    };
  },
};

export default effects;

/** Native cursors do the targeting; one scheduler-owned ember is only ever
 * placed on vacant wall, >=14px away. It consumes the same transient slot. */
function mountCursor(ctx: Parameters<SkinEffects["mount"]>[0], priority: () => boolean): () => void {
  let pointer: { x: number; y: number; time: number } | undefined;
  let remove: (() => void) | undefined;
  const stop = () => { remove?.(); remove = undefined; };
  const move = (event: PointerEvent) => {
    if (!ctx.finePointer || ctx.reducedMotion || event.buttons || document.hidden ||
      (event.target instanceof Element && event.target.closest("a,button,input,textarea,select,[contenteditable],label,summary"))) {
      pointer = undefined; stop(); return;
    }
    pointer = { x: event.clientX - 17, y: event.clientY + 15, time: performance.now() };
    // No idle 8Hz obstacle/tree measurements. Register only during eligible
    // pointer movement; one scheduler attempt removes an expired registration.
    if (!remove) remove = ctx.ambient.add(emberEffect);
  };
  window.addEventListener("pointermove", move, { signal: ctx.signal, passive: true });
  const emberEffect = {
    id: "th-cursor-ember", minDelay: 120, maxDelay: 160, maxConcurrent: 1,
    size: { width: 4, height: 4 }, prefer: "anywhere" as const, margin: 0,
    run(_spot: unknown, layer: HTMLElement) {
      if (priority() || !pointer || performance.now() - pointer.time > 160 || !ctx.finePointer || document.getSelection()?.toString()) {
        stop(); return 0;
      }
      const { x, y } = pointer;
      if (x < 0 || y < 0 || x + 4 > innerWidth || y + 4 > innerHeight || ctx.obstacles().some((r) =>
        x < r.right + 8 && x + 4 > r.left - 8 && y < r.bottom + 8 && y + 4 > r.top - 8)) return 0;
      layer.style.left = `${x}px`; layer.style.top = `${y}px`;
      const ember = document.createElement("i"); ember.className = "th-cursor-ember";
      layer.append(ember); return 320;
    },
  };
  return () => { stop(); window.removeEventListener("pointermove", move); };
}
