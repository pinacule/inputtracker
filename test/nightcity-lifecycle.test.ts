import { describe, expect, test } from "bun:test";
import { createAmbientScheduler } from "../web/src/skins/ambient.ts";

// The server test tsconfig has no lib.dom. Exercise the real browser module
// through a structural boundary, with synthetic nodes and a deterministic clock.
const { default: effects } = await import(new URL("../web/src/skins/nightcity/index.ts", import.meta.url).href) as {
  default: { mount(context: unknown): () => void };
};

class PaintNode {
  children = new Set<PaintNode>();
  parent?: PaintNode;
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  innerHTML = "";
  hidden = false;
  width = 0;
  height = 0;
  styleProps = new Map<string, string>();
  style = {
    setProperty: (k: string, v: string) => { this.styleProps.set(k, v); },
    get opacity() { return this.getPropertyValue("opacity"); },
    set opacity(v: string) { this.setProperty("opacity", v); },
    getPropertyValue: (k: string) => this.styleProps.get(k) ?? "",
  };
  classList = { add: (...names: string[]) => { this.className += ` ${names.join(" ")}`; } };
  isConnected = true;
  append(node: PaintNode) { this.children.add(node); node.parent = this; }
  appendChild(node: PaintNode) { this.append(node); }
  remove() { this.parent?.children.delete(this); this.parent = undefined; this.isConnected = false; }
  contains(node: PaintNode): boolean { return node === this || [...this.children].some(child => child.contains(node)); }
  matches(selector: string) { return selector.split(",").some(s => this.className.split(" ").includes(s.trim().slice(1))); }
  querySelectorAll(selector: string): PaintNode[] {
    return [...this.children].flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) {
    // The frame SVG contains these paths. No HTML parser is needed for the fake.
    const name = selector.slice(1);
    if (!this.querySelectorAll(selector).length && this.innerHTML.includes(`class="${name}"`)) {
      const path = new PaintNode(); path.className = name; this.append(path);
    }
    return this.querySelectorAll(selector)[0] ?? null;
  }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return k === "style" ? [...this.styleProps].filter(([, v]) => v).join(";") : this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return k === "style" ? !!this.getAttribute(k) : this.attrs.has(k); }
  removeAttribute(k: string) { this.attrs.delete(k); if (k === "style") this.styleProps.clear(); }
  cloneNode() { const copy = new PaintNode(); copy.className = this.className; copy.textContent = this.textContent; return copy; }
  getBoundingClientRect() { return { x: 20, y: 20, left: 20, top: 20, width: 180, height: 80, right: 200, bottom: 100 }; }
  animations = new Set<{ cancel(): void; onfinish?: () => void }>();
  animate() {
    const animation = { cancel: () => { this.animations.delete(animation); } };
    this.animations.add(animation); return animation;
  }
}

function harness(initialReduced = false, phone = false) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let now = 0, next = 0, reduced = initialReduced, strokes = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const frames = new Map<number, (time: number) => void>();
  const clock = {
    setTimeout(cb: () => void, delay: number) { const id = ++next; timers.set(id, { at: now + delay, cb }); return id; },
    clearTimeout(id: unknown) { timers.delete(id as number); },
  };
  const root = new PaintNode(), app = new PaintNode(), bg = new PaintNode(), fx = new PaintNode();
  const card = new PaintNode(), number = new PaintNode();
  card.className = "ui-card"; number.className = "ui-stat-value"; number.textContent = "2h 48m";
  app.append(card); app.append(number);
  const created: PaintNode[] = [];
  const make = () => { const node = new PaintNode(); created.push(node); return node; };
  const graphics = { setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes++; } };
  const doc = Object.assign(new EventTarget(), {
    hidden: false, documentElement: root, fonts: new EventTarget(),
    getElementById: (id: string) => id === "app" ? app : null,
    querySelectorAll: () => [],
    createElement: () => Object.assign(make(), { getContext: () => graphics }),
    createElementNS: () => make(),
    createTreeWalker: (node: PaintNode) => {
      let visited = false;
      return { currentNode: node, nextNode() { if (visited || !node.textContent) return false; visited = true; return true; } };
    },
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
  });
  const observers = new Set<Observer>();
  class Observer {
    targets = new Set<PaintNode>();
    constructor(readonly callback: (entries: { target: PaintNode; isIntersecting: boolean }[]) => void) { observers.add(this); }
    observe(node: PaintNode) { this.targets.add(node); }
    unobserve(node: PaintNode) { this.targets.delete(node); }
    disconnect() { observers.delete(this); }
  }
  class Intersection extends Observer {}
  const media = Object.assign(new EventTarget(), { matches: false });
  replace("document", doc); replace("window", new EventTarget());
  replace("HTMLElement", PaintNode); replace("Element", PaintNode);
  replace("NodeFilter", { SHOW_TEXT: 4 });
  replace("innerWidth", phone ? 390 : 1440); replace("innerHeight", phone ? 844 : 900);
  replace("devicePixelRatio", 3); replace("performance", { now: () => now });
  replace("matchMedia", () => media);
  replace("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  replace("IntersectionObserver", Intersection); replace("MutationObserver", Observer); replace("ResizeObserver", Observer);
  replace("setTimeout", clock.setTimeout); replace("clearTimeout", clock.clearTimeout);
  replace("requestAnimationFrame", (cb: (time: number) => void) => { const id = ++next; frames.set(id, cb); return id; });
  replace("cancelAnimationFrame", (id: number) => frames.delete(id));
  replace("fetch", () => { throw Error("Night City effects must not fetch"); });
  const ambient = createAmbientScheduler({
    clock, rng: () => 0, layer: fx, createLayer: make,
    viewport: () => ({ x: 0, y: 0, width: phone ? 390 : 1440, height: phone ? 844 : 900 }),
    obstacles: () => [], isHidden: () => doc.hidden, reducedMotion: () => reduced,
  });
  const events = new Map<string, Set<(event: { direction: number }) => void>>();
  const visibility = new Set<() => void>(), motion = new Set<() => void>();
  const subscribe = <T>(set: Set<T>, cb: T) => { set.add(cb); return () => { set.delete(cb); }; };
  const controller = new AbortController();
  const cleanup = effects.mount({
    bg, fx, ambient, signal: controller.signal, isPhone: phone, finePointer: false,
    get reducedMotion() { return reduced; }, obstacles: () => [],
    on(type: string, cb: (event: { direction: number }) => void) {
      if (!events.has(type)) events.set(type, new Set());
      return subscribe(events.get(type)!, cb);
    },
    onVisibility: (cb: () => void) => subscribe(visibility, cb),
    onMotionChange: (cb: () => void) => subscribe(motion, cb),
  });
  const emit = (type: string) => events.get(type)?.forEach(cb => cb({ direction: 1 }));
  return {
    root, app, bg, fx, card, number, created, frames, timers, observers, events, visibility, motion,
    get strokes() { return strokes; },
    enter() {
      for (const observer of observers) if (observer instanceof Intersection) {
        observer.callback([...observer.targets].map(target => ({ target, isIntersecting: true })));
      }
    },
    frame() { now += 50; const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(now)); },
    tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const task = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!task || task[1].at > end) break;
        now = task[1].at; timers.delete(task[0]); task[1].cb();
      }
      now = end;
    },
    navigate() { emit("page-change"); emit("day-change"); },
    hidden(value: boolean) { doc.hidden = value; visibility.forEach(cb => cb()); ambient.refresh(); },
    reduced(value: boolean) { reduced = value; motion.forEach(cb => cb()); ambient.refresh(); },
    unmount() { controller.abort(); cleanup(); },
    restore() {
      controller.abort(); cleanup();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

describe("Night City complete effects lifecycle", () => {
  for (const state of ["entrance", "ambient", "navigation"]) {
    test(`unmount during ${state} clears nodes, attributes, observers and pending work`, () => {
      const h = harness();
      try {
        h.enter(); h.frame();
        expect(h.number.textContent).toBe("2h 48m");
        expect(h.number.style.opacity).toBe("0");
        expect(h.card.animations.size).toBeGreaterThan(0);
        expect(h.strokes).toBeGreaterThan(0);
        if (state === "ambient") {
          h.tick(24_000);
          expect([...h.fx.children].some(node => node.dataset.ambientEffect === "nc-buzz")).toBe(true);
        }
        if (state === "navigation") h.navigate();
        h.unmount(); h.tick(90_000); h.frame();
        expect(h.bg.children.size).toBe(0); expect(h.fx.children.size).toBe(0);
        expect(h.app.children.size).toBe(2);
        expect(h.number.hasAttribute("style")).toBe(false);
        expect(h.number.textContent).toBe("2h 48m");
        expect(h.root.attrs.size).toBe(0); expect(h.root.dataset).toEqual({});
        expect(h.card.attrs.size).toBe(0); expect(h.card.animations.size).toBe(0);
        expect(h.created.every(node => node.animations.size === 0)).toBe(true);
        expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0); expect(h.observers.size).toBe(0);
        expect([...h.events.values()].every(listeners => listeners.size === 0)).toBe(true);
        expect(h.visibility.size).toBe(0); expect(h.motion.size).toBe(0);
      } finally { h.restore(); }
    });
  }

  for (const phone of [false, true]) {
    test(`reduced motion starts static and stops active loops on ${phone ? "phone" : "desktop"}`, () => {
      const h = harness(true, phone);
      try {
        h.enter(); h.navigate(); h.tick(90_000); h.frame();
        expect(h.bg.children.size).toBe(2); // Static city and an idle rain canvas.
        expect(h.number.hasAttribute("style")).toBe(false);
        expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0);
        expect(h.fx.children.size).toBe(1); // Hidden cursor heel only.
        expect(h.created.every(node => node.animations.size === 0)).toBe(true);
        h.reduced(false);
        expect(h.frames.size).toBe(1); expect(h.timers.size).toBeGreaterThan(0);
        h.frame(); expect(h.strokes).toBeGreaterThan(0);
        h.reduced(true); h.tick(90_000); h.frame();
        expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0);
        expect(h.fx.children.size).toBe(1);
      } finally { h.restore(); }
    });
  }

  test("hidden tabs cancel live copies and clocks; visibility resumes fresh rain and delays", () => {
    const h = harness();
    try {
      h.enter(); h.tick(430);
      expect(h.fx.children.size).toBeGreaterThan(1);
      h.hidden(true); h.navigate(); h.tick(90_000);
      expect(h.number.hasAttribute("style")).toBe(false);
      expect(h.frames.size).toBe(0); expect(h.timers.size).toBe(0);
      expect(h.fx.children.size).toBe(1);
      h.hidden(false);
      expect(h.frames.size).toBe(1); expect(h.timers.size).toBeGreaterThan(0);
      h.tick(100);
      expect(h.fx.children.size).toBe(1); // No backlog of ambient sprites.
    } finally { h.restore(); }
  });
});
