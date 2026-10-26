import { afterEach, describe, expect, test } from "bun:test";
import { createAmbientScheduler, findFreeSpot, type AmbientLayer, type AmbientClock, type AmbientEffect, type Spot, type Rect } from "../web/src/skins/ambient.ts";
import { clearSkinEventHint, emitSkinEvent, onSkinEvent } from "../web/src/skins/events.ts";

function seeded(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}
const intersects = (a: Rect, b: Rect, margin = 0) => a.x < b.x + b.width + margin && a.x + a.width > b.x - margin
  && a.y < b.y + b.height + margin && a.y + a.height > b.y - margin;

describe("ambient placement", () => {
  test("seeded fuzz never overlaps obstacles or exceeds viewport/margin bounds", () => {
    const rng = seeded(123);
    for (let i = 0; i < 800; i++) {
      const viewport = { x: 10, y: 20, width: 150 + rng() * 500, height: 200 + rng() * 500 };
      const margin = Math.round(rng() * 15);
      const size = { width: 5 + rng() * 70, height: 5 + rng() * 70 };
      const obstacles = Array.from({ length: 10 }, () => ({ x: viewport.x + rng() * viewport.width,
        y: viewport.y + rng() * viewport.height, width: rng() * 160, height: rng() * 160 }));
      const spot = findFreeSpot({ viewport, obstacles, size, margin, rng, prefer: i % 2 ? "edges" : "anywhere" });
      if (!spot) continue;
      expect(spot.left).toBeGreaterThanOrEqual(viewport.x + margin);
      expect(spot.top).toBeGreaterThanOrEqual(viewport.y + margin);
      expect(spot.right).toBeLessThanOrEqual(viewport.x + viewport.width - margin + 1e-9);
      expect(spot.bottom).toBeLessThanOrEqual(viewport.y + viewport.height - margin + 1e-9);
      expect(obstacles.some((obstacle) => intersects(spot, obstacle, margin))).toBe(false);
    }
  });
  test("full/undersized viewport returns null, and invalid sizes are rejected", () => {
    const viewport = { x: 0, y: 0, width: 100, height: 100 };
    const base = { viewport, size: { width: 20, height: 20 }, prefer: "anywhere" as const, rng: seeded(1) };
    expect(findFreeSpot({ ...base, obstacles: [viewport] })).toBeNull();
    expect(findFreeSpot({ ...base, obstacles: [], size: { width: 101, height: 20 } })).toBeNull();
    expect(findFreeSpot({ ...base, obstacles: [], size: { width: NaN, height: 20 } })).toBeNull();
  });
  test("edges placement prefers the perimeter and can fall back to an interior hole", () => {
    const viewport = { x: 0, y: 0, width: 400, height: 300 };
    const rng = seeded(7);
    for (let i = 0; i < 100; i++) {
      const spot = findFreeSpot({ viewport, obstacles: [], size: { width: 20, height: 20 }, margin: 10, rng, prefer: "edges" })!;
      expect(spot.x === 10 || spot.y === 10 || spot.right === 390 || spot.bottom === 290).toBe(true);
    }
    const obstacles = [{ x: 0, y: 0, width: 400, height: 80 }, { x: 0, y: 220, width: 400, height: 80 },
      { x: 0, y: 0, width: 80, height: 300 }, { x: 320, y: 0, width: 80, height: 300 }];
    const spot = findFreeSpot({ viewport, obstacles, size: { width: 20, height: 20 }, margin: 10, rng, prefer: "edges" });
    expect(spot).not.toBeNull();
    expect(obstacles.some((o) => intersects(spot!, o, 10))).toBe(false);
  });
});

class FakeClock implements AmbientClock {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; cb: () => void }>();
  setTimeout(cb: () => void, delay: number) { const id = ++this.next; this.tasks.set(id, { at: this.now + delay, cb }); return id; }
  clearTimeout(handle: unknown) { this.tasks.delete(handle as number); }
  tick(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at; this.tasks.delete(next[0]); next[1].cb();
    }
    this.now = end;
  }
}
function harness(rng = () => 0, maxConcurrent?: number) {
  const clock = new FakeClock();
  const nodes = new Set<AmbientLayer>();
  let hidden = false, reduced = false, obstacles: Rect[] = [];
  const scheduler = createAmbientScheduler({ clock, rng, maxConcurrent,
    viewport: () => ({ x: 0, y: 0, width: 500, height: 500 }), obstacles: () => obstacles,
    isHidden: () => hidden, reducedMotion: () => reduced,
    layer: { appendChild: (node: AmbientLayer) => { nodes.add(node); } },
    createLayer: (spot: Spot) => ({ style: {}, dataset: {}, remove() { nodes.delete(this as unknown as AmbientLayer); },
      getBoundingClientRect: () => spot }) as unknown as AmbientLayer,
  });
  let runs = 0;
  const add = (id: string, extra: Partial<AmbientEffect> = {}) => scheduler.add({ id, minDelay: 100, maxDelay: 100,
    size: { width: 20, height: 20 }, prefer: "anywhere", run: () => { runs++; return 250; }, ...extra });
  return { clock, nodes, scheduler, add, get runs() { return runs; },
    hidden(value: boolean) { hidden = value; scheduler.refresh(); },
    reduced(value: boolean) { reduced = value; scheduler.refresh(); },
    obstacles(value: Rect[]) { obstacles = value; } };
}

describe("ambient scheduling", () => {
  test("start is idempotent, delay is randomized and stop clears DOM/timers", () => {
    const h = harness(() => 0.5);
    h.add("a", { minDelay: 100, maxDelay: 300 });
    h.clock.tick(1000); expect(h.runs).toBe(0);
    h.scheduler.start(); h.scheduler.start();
    h.clock.tick(199); expect(h.runs).toBe(0);
    h.clock.tick(1); expect(h.runs).toBe(1); expect(h.nodes.size).toBe(1);
    h.scheduler.stop(); expect(h.nodes.size).toBe(0); expect(h.clock.tasks.size).toBe(0);
    h.clock.tick(5000); expect(h.runs).toBe(1);
    h.scheduler.start(); h.clock.tick(200); expect(h.runs).toBe(2); h.scheduler.stop();
  });
  test("default concurrency is one across registrations; configurable ceiling is capped at two", () => {
    for (const limit of [undefined, 2, 999]) {
      const h = harness(seeded(31), limit);
      for (const id of ["a", "b", "c"]) h.add(id);
      h.scheduler.start(); h.clock.tick(100);
      expect(h.nodes.size).toBe(limit === undefined ? 1 : 2);
      h.clock.tick(249); expect(h.nodes.size).toBe(limit === undefined ? 1 : 2);
      h.clock.tick(1); expect(h.nodes.size).toBe(0);
      h.scheduler.stop();
    }
    const h = harness(seeded(12));
    h.add("a", { maxConcurrent: 2 }); h.add("b", { maxConcurrent: 2 }); h.add("c", { maxConcurrent: 2 });
    h.scheduler.start(); h.clock.tick(100); expect(h.nodes.size).toBe(2); h.scheduler.stop();
  });
  test("rechecks obstacles on each run and skips a full viewport", () => {
    const h = harness(); h.add("a"); h.scheduler.start();
    h.obstacles([{ x: 0, y: 0, width: 500, height: 500 }]);
    h.clock.tick(100); expect(h.runs).toBe(0);
    h.obstacles([]); h.clock.tick(100); expect(h.runs).toBe(1);
    h.scheduler.stop();
  });
  test("hidden/reduced motion remove active DOM, pause timers, and resume with fresh delay", () => {
    const h = harness(); h.add("a"); h.hidden(true); h.scheduler.start();
    h.clock.tick(500); expect(h.runs).toBe(0); expect(h.clock.tasks.size).toBe(0);
    h.hidden(false); h.clock.tick(99); expect(h.runs).toBe(0);
    h.clock.tick(1); expect(h.nodes.size).toBe(1);
    h.reduced(true); expect(h.nodes.size).toBe(0); expect(h.clock.tasks.size).toBe(0);
    h.clock.tick(1000); expect(h.runs).toBe(1);
    h.reduced(false); h.clock.tick(100); expect(h.runs).toBe(2);
    h.hidden(true); expect(h.nodes.size).toBe(0);
    h.scheduler.stop(); h.hidden(false); h.clock.tick(500); expect(h.runs).toBe(2);
  });
  test("stop during run and stale removal callbacks cannot leak or remove replacement jobs", () => {
    const h = harness();
    const oldRemove = h.add("a", { run: () => { h.scheduler.stop(); return 1000; } });
    h.scheduler.start(); h.clock.tick(100);
    expect(h.nodes.size).toBe(0); expect(h.clock.tasks.size).toBe(0);
    oldRemove(); h.add("a"); oldRemove();
    h.scheduler.start(); h.clock.tick(100); expect(h.runs).toBe(1);
    h.scheduler.stop();
  });
  test("promise completion/rejection, throws and removing a job all clean up", async () => {
    const h = harness();
    let resolve!: () => void;
    const remove = h.add("a", { run: () => new Promise<void>((done) => { resolve = done; }) });
    h.scheduler.start(); h.clock.tick(100); expect(h.nodes.size).toBe(1);
    resolve(); await Promise.resolve(); expect(h.nodes.size).toBe(0);
    h.clock.tick(100); expect(h.nodes.size).toBe(1);
    remove(); expect(h.nodes.size).toBe(0); expect(h.clock.tasks.size).toBe(0);
    resolve(); await Promise.resolve();
    h.add("b", { run: () => { throw Error("synthetic"); } }); h.clock.tick(100); expect(h.nodes.size).toBe(0);
    h.add("c", { run: () => Promise.reject(Error("synthetic")) }); h.clock.tick(100);
    await Promise.resolve(); expect(h.nodes.size).toBe(0); h.scheduler.stop();
  });
});

afterEach(clearSkinEventHint);
describe("skin events", () => {
  test("typed events reach subscribers, unsubscribe is idempotent, listener faults are isolated", () => {
    const calls: string[] = [];
    const offBad = onSkinEvent("day-change", () => { throw Error("synthetic"); });
    const off = onSkinEvent("day-change", (event) => calls.push(`${event.from}/${event.to}/${event.direction}`));
    const offWeek = onSkinEvent("week-change", (event) => calls.push(`week/${event.direction}`));
    emitSkinEvent("day-change", { from: "2026-01-01", to: "2026-01-02", direction: 1 });
    emitSkinEvent("week-change", { direction: -1 });
    off(); off(); emitSkinEvent("day-change", { from: "2026-01-02", to: "2026-01-01", direction: -1 });
    expect(calls).toEqual(["2026-01-01/2026-01-02/1", "week/-1"]);
    offBad(); offWeek();
    const replacement = onSkinEvent("week-change", () => calls.push("replacement"));
    offWeek(); emitSkinEvent("week-change", { direction: 1 });
    expect(calls.at(-1)).toBe("replacement"); replacement();
  });
  test("CSS hint restarts for 700ms and clears direction on route events", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    const attrs = new Map<string, string>();
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {
      setAttribute: (key: string, value: string) => attrs.set(key, value), removeAttribute: (key: string) => attrs.delete(key),
    } } });
    try {
      emitSkinEvent("day-change", { from: "2026-01-01", to: "2026-01-02", direction: 1 });
      expect(attrs.get("data-skin-event")).toBe("day-change"); expect(attrs.get("data-skin-dir")).toBe("next");
      await Bun.sleep(400);
      emitSkinEvent("day-change", { from: "2026-01-02", to: "2026-01-01", direction: -1 });
      await Bun.sleep(400); expect(attrs.get("data-skin-dir")).toBe("prev");
      await Bun.sleep(330); expect(attrs.size).toBe(0);
      emitSkinEvent("week-change", { direction: 1 }); emitSkinEvent("page-change", { from: "calendar", to: "library" });
      expect(attrs.get("data-skin-event")).toBe("page-change"); expect(attrs.has("data-skin-dir")).toBe(false);
      clearSkinEventHint(); expect(attrs.size).toBe(0);
    } finally {
      clearSkinEventHint();
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});
