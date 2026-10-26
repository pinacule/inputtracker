import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createAmbientScheduler } from "../web/src/skins/ambient.ts";
import { THEMES, THEME_REGISTRY } from "../web/src/lib/theme.ts";

const moduleUrl = new URL("../web/src/skins/thinker/index.ts", import.meta.url).href;
const { default: effects } = await import(moduleUrl) as {
  default: { mount(context: unknown): () => void };
};

const css = readFileSync(new URL("../web/src/styles/themes/thinker.css", import.meta.url), "utf8");

class Element {
  children = new Set<Element>();
  parent?: Element;
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  classes = new Set<string>();
  classList = {
    add: (...values: string[]) => values.forEach((s) => this.classes.add(s)),
    remove: (...values: string[]) => values.forEach((s) => this.classes.delete(s)),
    contains: (s: string) => this.classes.has(s),
  };
  className = "";
  textContent = "";
  innerHTML = "";
  styleProps = new Map<string, string>();
  style = {
    setProperty: (k: string, v: string) => { this.styleProps.set(k, v); },
    removeProperty: (k: string) => { this.styleProps.delete(k); },
    getPropertyValue: (k: string) => this.styleProps.get(k) ?? "",
  };
  append(el: Element) { this.children.add(el); el.parent = this; }
  appendChild(el: Element) { this.append(el); }
  remove() { this.parent?.children.delete(this); this.parent = undefined; }
  contains(el: Element | null): boolean { return !!el && (el === this || [...this.children].some((child) => child.contains(el))); }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  removeAttribute(key: string) {
    this.attrs.delete(key);
    if (key.startsWith("data-")) {
      const camel = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this.dataset[camel];
    }
  }
  toggleAttribute(key: string, force: boolean) { if (force) this.attrs.set(key, ""); else this.attrs.delete(key); }
  matches(_sel: string) { return false; }
  checkVisibility() { return true; }
  closest(_sel: string): Element | null { return null; }
  querySelector(_selector: string): Element | null { return null; }
  querySelectorAll(_sel?: string): Element[] { return []; }
  getBoundingClientRect() { return { x: 20, y: 20, left: 20, top: 20, right: 200, bottom: 60, width: 180, height: 40 }; }
  getAnimations() { return []; }
  animate(_frames?: unknown, _opts?: unknown) {
    return { cancel() {}, finish() {} };
  }
}

function harness(initialReduced = false, isPhone = false) {
  const originalRandom = Math.random;
  Math.random = () => 0;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let now = 0, next = 0, reduced = initialReduced;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const frames = new Map<number, (time: number) => void>();
  const root = new Element(), head = new Element(), bg = new Element(), fx = new Element();
  const header = new Element(), app = new Element();
  header.className = "home-topbar";
  app.append(header);

  const doc = Object.assign(new EventTarget(), {
    documentElement: root, head, hidden: false,
    createElement: () => new Element(),
    getElementById: (id: string) => id === "app" ? app : null,
    querySelectorAll: (sel: string) => sel.includes(".home-topbar") ? [header] : [],
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
    fonts: Object.assign(new EventTarget(), { load: () => Promise.resolve([]) }),
  });
  const win = Object.assign(new EventTarget(), {
    location: { hash: "#/calendar" },
    innerWidth: isPhone ? 390 : 1440,
    innerHeight: isPhone ? 844 : 900,
  });

  const observers = new Set<object>();
  class Observer {
    constructor(_callback: unknown) { observers.add(this); }
    observe() {}
    unobserve() {}
    disconnect() { observers.delete(this); }
  }

  const clock = {
    setTimeout(cb: () => void, delay: number) { const id = ++next; timers.set(id, { at: now + delay, cb }); return id; },
    clearTimeout(id: unknown) { timers.delete(id as number); },
  };

  replace("NodeFilter", { SHOW_TEXT: 4 });
  replace("document", doc);
  replace("window", win);
  replace("IntersectionObserver", Observer);
  replace("ResizeObserver", Observer);
  replace("MutationObserver", Observer);
  replace("setTimeout", clock.setTimeout);
  replace("clearTimeout", clock.clearTimeout);
  replace("requestAnimationFrame", (cb: (time: number) => void) => { const id = ++next; frames.set(id, cb); return id; });
  replace("cancelAnimationFrame", (id: number) => frames.delete(id));
  replace("fetch", () => { throw Error("effects must not fetch"); });

  const ambient = createAmbientScheduler({
    clock, rng: () => 0, layer: fx,
    viewport: () => ({ x: 0, y: 0, width: isPhone ? 390 : 1440, height: isPhone ? 844 : 900 }),
    obstacles: () => [],
    isHidden: () => doc.hidden,
    reducedMotion: () => reduced,
    createLayer: () => new Element(),
  });

  const events = new Map<string, (event: { direction?: number; to?: string }) => void>();
  const visibility = new Set<(v: boolean) => void>();
  const motion = new Set<() => void>();
  const controller = new AbortController();
  const subscribe = <T>(set: Set<T>, cb: T) => { set.add(cb); return () => { set.delete(cb); }; };

  const cleanup = effects.mount({
    bg, fx, ambient, signal: controller.signal, isPhone, finePointer: false,
    get reducedMotion() { return reduced; }, obstacles: () => [],
    on(type: string, cb: (event: { direction?: number; to?: string }) => void) {
      events.set(type, cb);
      return () => events.delete(type);
    },
    onVisibility(cb: (v: boolean) => void) { return subscribe(visibility, cb); },
    onMotionChange(cb: () => void) { return subscribe(motion, cb); },
  });

  return {
    root, head, bg, fx, header, timers, frames, observers, events, visibility, motion,
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(now)); },
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const task = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!task || task[1].at > end) break;
        now = task[1].at; timers.delete(task[0]); task[1].cb();
      }
      now = end;
    },
    navigate() { events.get("day-change")?.({ direction: 1 }); },
    route(to: string) { events.get("page-change")?.({ to }); },
    hidden(value: boolean) { doc.hidden = value; visibility.forEach((cb) => cb(!value)); ambient.refresh(); },
    reduced(value: boolean) { reduced = value; motion.forEach((cb) => cb()); ambient.refresh(); },
    unmount() { controller.abort(); cleanup(); },
    restore() {
      controller.abort(); cleanup();
      Math.random = originalRandom;
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

describe("Thinker complete effects lifecycle", () => {
  for (const state of ["ambient", "navigation"]) {
    test(`unmount during ${state} clears nodes, attributes, style properties and observers`, async () => {
      const h = harness();
      try {
        expect(h.bg.children.size).toBe(6); // Statue, lights, wall and shadows
        expect(h.root.dataset.thinkerScene).toBe("thinker");
        expect(h.root.styleProps.size).toBeGreaterThan(0);

        h.frame(); // Run initial schedule() layout pass
        expect(h.header.children.size).toBe(1); // th-scene-window crop

        if (state === "navigation") {
          h.navigate();
          h.frame();
          expect(h.root.dataset.thinkerTorch).toBeDefined();
        } else {
          h.frame();
          h.tick(25_000);
        }

        h.unmount();
        h.tick(50_000);
        h.frame();

        expect(h.bg.children.size).toBe(0);
        expect(h.header.children.size).toBe(0);
        expect(h.fx.children.size).toBe(0);
        expect(h.root.dataset).toEqual({});
        expect(h.root.styleProps.size).toBe(0);
        expect(h.observers.size).toBe(0);
        expect(h.frames.size).toBe(0);
        expect(h.events.size).toBe(0);
      } finally {
        h.restore();
      }
    });
  }

  for (const phone of [false, true]) {
    test(`reduced motion stays static on ${phone ? "phone" : "desktop"} with no running animation frames`, async () => {
      const h = harness(true, phone);
      try {
        expect(h.root.dataset.thinkerPaused).toBe("true");
        h.frame(); // Drain initial layout pass
        // No fire animation frames queued when reduced motion is true
        expect(h.frames.size).toBe(0);
        h.navigate();
        h.frame();
        expect(h.frames.size).toBe(0);
        h.tick(30_000);
        expect(h.frames.size).toBe(0);

        // Disabling reduced motion starts frames
        h.reduced(false);
        expect(h.root.dataset.thinkerPaused).toBe("false");
        expect(h.frames.size).toBeGreaterThan(0);

        // Re-enabling reduced motion pauses and cancels running loops
        h.reduced(true);
        expect(h.root.dataset.thinkerPaused).toBe("true");
        h.frame(); // Process any one-shot layout remeasurement
        expect(h.frames.size).toBe(0);
        h.tick(30_000);
        expect(h.frames.size).toBe(0);
      } finally {
        h.restore();
      }
    });
  }

  test("hidden tabs pause effects and cancel animation frames; visible tabs resume", () => {
    const h = harness();
    try {
      expect(h.frames.size).toBeGreaterThan(0);
      h.hidden(true);
      expect(h.root.dataset.thinkerPaused).toBe("true");
      expect(h.frames.size).toBe(0);

      h.tick(60_000);
      expect(h.frames.size).toBe(0);

      h.hidden(false);
      expect(h.root.dataset.thinkerPaused).toBe("false");
      expect(h.frames.size).toBeGreaterThan(0);
    } finally {
      h.restore();
    }
  });

  test("route switching updates scene attribute and adapts to scene changes", () => {
    const h = harness();
    try {
      expect(h.root.dataset.thinkerScene).toBe("thinker");
      h.route("library");
      expect(h.root.dataset.thinkerScene).toBe("hugo");
      h.route("insights");
      expect(h.root.dataset.thinkerScene).toBe("plato");
      h.route("calendar");
      expect(h.root.dataset.thinkerScene).toBe("thinker");
    } finally {
      h.restore();
    }
  });

  test("preview tile CSS is defined with stone plinth, warm rim, statue art, and interactive states", () => {
    expect(THEMES.find((theme) => theme.id === "thinker")).toBe(THEME_REGISTRY.thinker);
    expect(THEME_REGISTRY.thinker?.label).toBe("Thinker");

    const preview = css.slice(
      css.indexOf("/* A static, self-contained Thinker miniature"),
      css.indexOf("/* Outer page is a gutter"),
    );

    expect(preview).toContain('.theme-preview[data-theme="thinker"]');
    expect(preview).toContain('.theme-preview[data-theme="thinker"] .theme-preview-window');
    expect(preview).toContain('.theme-preview[data-theme="thinker"] .theme-preview-titlebar');
    expect(preview).toContain('.theme-preview[data-theme="thinker"] .theme-preview-heading');
    expect(preview).toContain('.theme-preview[data-theme="thinker"] .theme-preview-bars');

    for (const token of ["thinker-detail.webp", "veins.svg", "--font-serif", "--font-numbers", "#f0bb79", "--accent-primary"]) {
      expect(preview).toContain(token);
    }

    for (const state of [".theme-tile:hover", ":checked", ":focus-visible"]) {
      expect(preview).toContain(state);
    }

    // Static: no live animations, keyframes, or external URLs in preview
    expect(preview).not.toMatch(/animation\s*:|@keyframes/);
    expect(preview).not.toMatch(/https?:\/\//);
  });
});
