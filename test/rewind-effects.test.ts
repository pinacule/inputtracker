import { describe, expect, test } from "bun:test";
import { createAmbientScheduler } from "../web/src/skins/ambient.ts";

// Exercise the browser module through a narrow structural boundary: the server
// typecheck deliberately has no lib.dom, and these tests need no DOM dependency.
const moduleUrl = new URL("../web/src/skins/rewind/index.ts", import.meta.url).href;
const { default: effects } = await import(moduleUrl) as {
  default: { mount(context: unknown): () => void };
};

class Element {
  children = new Set<Element>();
  parent?: Element;
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  classes = new Set<string>();
  classList = { add: (...values: string[]) => values.forEach((s) => this.classes.add(s)),
    remove: (...values: string[]) => values.forEach((s) => this.classes.delete(s)) };
  className = "";
  textContent = "";
  innerHTML = "";
  style = { setProperty() {}, removeProperty() {} };
  append(el: Element) { this.children.add(el); el.parent = this; }
  appendChild(el: Element) { this.append(el); }
  remove() { this.parent?.children.delete(this); this.parent = undefined; }
  contains(el: Element | null): boolean { return !!el && (el === this || [...this.children].some((child) => child.contains(el))); }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  removeAttribute(key: string) { this.attrs.delete(key); }
  toggleAttribute(key: string, force: boolean) { if (force) this.attrs.set(key, ""); else this.attrs.delete(key); }
  querySelector(_selector: string): Element | null { return null; }
  querySelectorAll(): Element[] { return []; }
  getBoundingClientRect() { return { x: 20, y: 20, left: 20, top: 20, right: 200, bottom: 60, width: 180, height: 40 }; }
  getAnimations() { return []; }
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
  const frames = new Map<number, () => void>();
  const root = new Element(), head = new Element(), bg = new Element(), fx = new Element();
  const header = new Element(), app = new Element();
  app.append(header);
  app.querySelector = (selector) => selector === ".home-topbar" ? header : null;
  const doc = Object.assign(new EventTarget(), { documentElement: root, head, hidden: false,
    createElement: () => new Element(), getElementById: () => app,
    fonts: { load: () => Promise.resolve([]) } });
  const win = new EventTarget();
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
  replace("document", doc); replace("window", win);
  replace("navigator", { connection: { saveData: true } });
  replace("innerWidth", isPhone ? 390 : 1440); replace("innerHeight", isPhone ? 844 : 900);
  replace("IntersectionObserver", Observer); replace("MutationObserver", Observer);
  replace("setTimeout", clock.setTimeout); replace("clearTimeout", clock.clearTimeout);
  replace("requestAnimationFrame", (cb: () => void) => { const id = ++next; frames.set(id, cb); return id; });
  replace("cancelAnimationFrame", (id: number) => frames.delete(id));
  // A future accidental request must fail, rather than reaching the network.
  replace("fetch", () => { throw Error("effects must not fetch"); });
  const ambient = createAmbientScheduler({ clock, rng: () => 0, layer: fx,
    viewport: () => ({ x: 0, y: 0, width: 390, height: 844 }), obstacles: () => [],
    isHidden: () => doc.hidden, reducedMotion: () => reduced, createLayer: () => new Element() });
  const events = new Map<string, (event: { direction: number }) => void>();
  const visibility = new Set<() => void>(), motion = new Set<() => void>();
  const controller = new AbortController();
  const subscribe = (set: Set<() => void>, cb: () => void) => { set.add(cb); return () => { set.delete(cb); }; };
  const cleanup = effects.mount({ bg, fx, ambient, signal: controller.signal, isPhone, finePointer: false,
    get reducedMotion() { return reduced; }, obstacles: () => [],
    on(type: string, cb: (event: { direction: number }) => void) { events.set(type, cb); return () => events.delete(type); },
    onVisibility(cb: () => void) { return subscribe(visibility, cb); },
    onMotionChange(cb: () => void) { return subscribe(motion, cb); },
  });
  return {
    root, head, bg, fx, header, timers, frames, observers, events, visibility, motion,
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb()); },
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const task = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!task || task[1].at > end) break;
        now = task[1].at; timers.delete(task[0]); task[1].cb();
      }
      now = end;
    },
    navigate() { events.get("day-change")!({ direction: 1 }); },
    hidden(value: boolean) { doc.hidden = value; visibility.forEach((cb) => cb()); ambient.refresh(); },
    reduced(value: boolean) { reduced = value; motion.forEach((cb) => cb()); ambient.refresh(); },
    unmount() { controller.abort(); cleanup(); }, // Same order as SkinLayer.
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

describe("Rewind complete effects lifecycle", () => {
  for (const state of ["ambient", "navigation"]) test(`unmount during ${state} clears nodes, preloads, attributes and subscriptions`, async () => {
    const h = harness();
    try {
      await Promise.resolve(); h.frame();
      expect(h.header.children.size).toBe(1); // Decorative Home transport row.
      expect(h.head.children.size).toBe(2);
      h.tick(26_000); // 8s idle + 18s until the real scheduler's first dropout.
      expect(h.fx.children.size).toBeGreaterThan(0);
      if (state === "navigation") {
        h.navigate(); h.frame();
        expect(h.bg.children.size).toBe(2); // Directional wallpaper bands.
        expect(h.fx.children.size).toBeGreaterThan(0);
      }
      h.unmount();
      h.tick(100_000); h.frame(); await Promise.resolve();
      for (const el of [h.head, h.bg, h.fx, h.header]) {
        expect(el.children.size).toBe(0); expect(el.classes.size).toBe(0);
      }
      expect(h.root.attrs.size).toBe(0); expect(h.root.dataset).toEqual({});
      for (const collection of [h.timers, h.frames, h.observers, h.events, h.visibility, h.motion]) expect(collection.size).toBe(0);
    } finally { h.restore(); }
  });

  for (const phone of [false, true]) {
    test(`reduced motion stays static on ${phone ? "phone" : "desktop"} and cancels running work`, async () => {
      const h = harness(true, phone);
      try {
        await Promise.resolve(); h.frame(); h.navigate(); h.tick(120_000); h.frame();
        expect(h.root.attrs.has("data-rewind-paused")).toBe(true);
        expect(h.header.children.size).toBe(1); // Static OSD survives.
        expect(h.timers.size).toBe(0); expect(h.frames.size).toBe(0);
        expect(h.fx.children.size).toBe(0); expect(h.bg.children.size).toBe(0);
        h.reduced(false); h.frame(); h.navigate(); h.frame();
        expect(h.bg.children.size).toBeGreaterThan(0);
        h.reduced(true); h.frame(); h.tick(120_000);
        expect(h.timers.size).toBe(0); expect(h.frames.size).toBe(0);
        expect(h.fx.children.size).toBe(0); expect(h.bg.children.size).toBe(0);
      } finally { h.restore(); }
    });
  }

  test("hidden tabs cancel pending frames and timers; visible tabs start fresh", () => {
    const h = harness();
    try {
      h.frame(); h.navigate();
      expect(h.timers.size).toBeGreaterThan(0);
      h.hidden(true); h.tick(120_000);
      expect(h.root.attrs.has("data-rewind-paused")).toBe(true);
      expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0);
      expect(h.bg.children.size).toBe(0); expect(h.fx.children.size).toBe(0);
      h.hidden(false); h.frame();
      expect(h.root.attrs.has("data-rewind-paused")).toBe(false);
      expect(h.timers.size).toBe(1); // Fresh idle delay, no queued navigation.
      expect(h.bg.children.size).toBe(0); expect(h.fx.children.size).toBe(0);
    } finally { h.restore(); }
  });
});
