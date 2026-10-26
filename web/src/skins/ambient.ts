/** Geometry and an injectable timer scheduler; no DOM is accessed at import time. */
export interface Rect { x: number; y: number; width: number; height: number }
export interface Spot extends Rect { left: number; top: number; right: number; bottom: number }
export interface Size { width: number; height: number }
export type Placement = "edges" | "anywhere";
export interface FreeSpotOptions {
  viewport: Rect;
  obstacles: readonly Rect[];
  size: Size;
  margin?: number;
  rng?: () => number;
  prefer: Placement;
}
const random = (rng: () => number) => Math.max(0, Math.min(1 - Number.EPSILON, rng()));
export function findFreeSpot({ viewport: v, obstacles, size, margin = 8, rng = Math.random, prefer }: FreeSpotOptions): Spot | null {
  if (![v.x, v.y, v.width, v.height, size.width, size.height, margin].every(Number.isFinite)
    || size.width <= 0 || size.height <= 0 || margin < 0) return null;
  const left = v.x + margin, top = v.y + margin;
  const right = v.x + v.width - size.width - margin;
  const bottom = v.y + v.height - size.height - margin;
  if (right < left || bottom < top) return null;
  const candidate = (x: number, y: number): Spot | null => {
    const spot = { x, y, ...size, left: x, top: y, right: x + size.width, bottom: y + size.height };
    return obstacles.some((o) => spot.left < o.x + o.width + margin && spot.right > o.x - margin
      && spot.top < o.y + o.height + margin && spot.bottom > o.y - margin) ? null : spot;
  };
  // Try the perimeter first. Interior placement is a fallback if every edge is occupied.
  if (prefer === "edges") {
    for (let i = 0; i < 64; i++) {
      const edge = Math.floor(random(rng) * 4);
      const t = random(rng);
      const spot = candidate(edge < 2 ? (edge === 0 ? left : right) : left + (right - left) * t,
        edge >= 2 ? (edge === 2 ? top : bottom) : top + (bottom - top) * t);
      if (spot) return spot;
    }
  }
  for (let i = 0; i < 96; i++) {
    const spot = candidate(left + (right - left) * random(rng), top + (bottom - top) * random(rng));
    if (spot) return spot;
  }
  // Obstacle boundaries find narrow gaps that random sampling can miss.
  const xs = new Set([left, right, ...obstacles.flatMap((o) => [o.x - size.width - margin, o.x + o.width + margin])]);
  for (const x of xs) {
    if (x < left || x > right) continue;
    // Merge blocked vertical intervals for this x instead of a cubic x/y/obstacle search.
    const intervals = obstacles.filter((o) => x < o.x + o.width + margin && x + size.width > o.x - margin)
      .map((o) => [o.y - size.height - margin, o.y + o.height + margin] as const)
      .sort((a, b) => a[0] - b[0]);
    let y = top;
    for (const [start, end] of intervals) {
      if (end <= y) continue;
      if (start >= y) break;
      y = end;
    }
    if (y > bottom) continue;
    const spot = candidate(x, y);
    if (spot) return spot;
  }
  return null;
}

export interface AmbientClock {
  setTimeout(cb: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
/** Minimal structural node surface keeps geometry/scheduler usable without lib.dom. */
export interface AmbientLayer {
  style: object;
  dataset: { [key: string]: string | undefined };
  remove(): void;
  getBoundingClientRect(): Rect;
}
export interface AmbientEffect<Layer extends AmbientLayer = AmbientLayer> {
  id: string;
  minDelay: number;
  maxDelay: number;
  /** A skin-wide ceiling for this run; default 1, hard cap 2. */
  maxConcurrent?: number;
  size: Size;
  prefer: Placement;
  margin?: number;
  /** Layer is a positioned, size-constrained child of ctx.fx, removed on completion. */
  run(spot: Spot, layer: Layer): number | Promise<void>;
}
export interface AmbientOptions<Layer extends AmbientLayer = AmbientLayer> {
  clock?: AmbientClock;
  rng?: () => number;
  maxConcurrent?: number;
  layer?: { appendChild(node: Layer): unknown };
  viewport?: () => Rect;
  obstacles?: () => readonly Rect[];
  isHidden?: () => boolean;
  reducedMotion?: () => boolean;
  /** Injectable for DOM-free unit tests. */
  createLayer?: (spot: Spot) => Layer;
}
export interface AmbientScheduler<Layer extends AmbientLayer = AmbientLayer> {
  add(effect: AmbientEffect<Layer>): () => void;
  start(): void;
  stop(): void;
  /** Called by the host on visibility/motion changes; resume starts fresh delays. */
  refresh(): void;
}
interface Job<Layer extends AmbientLayer> { effect: AmbientEffect<Layer>; timer?: unknown }
interface Active<Layer extends AmbientLayer> { job: Job<Layer>; node: Layer; timer?: unknown; limit: number }

export function createAmbientScheduler<Layer extends AmbientLayer = AmbientLayer>(options: AmbientOptions<Layer> = {}): AmbientScheduler<Layer> {
  // Narrow browser adapter avoids pulling lib.dom into the server's test typecheck.
  const browser = globalThis as unknown as {
    document?: { hidden: boolean; createElement(name: string): Layer; body: { appendChild(node: Layer): unknown };
      addEventListener(type: string, cb: () => void): void; removeEventListener(type: string, cb: () => void): void };
    innerWidth?: number; innerHeight?: number;
    matchMedia?(query: string): { matches: boolean; addEventListener(type: string, cb: () => void): void;
      removeEventListener(type: string, cb: () => void): void };
  };
  const clock = options.clock ?? {
    setTimeout: (cb, delay) => setTimeout(cb, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const rng = options.rng ?? Math.random;
  const jobs = new Map<string, Job<Layer>>();
  const active = new Set<Active<Layer>>();
  let started = false;
  let paused = false;
  const unavailable = () => (options.isHidden?.() ?? (browser.document?.hidden ?? false))
    || (options.reducedMotion?.() ?? (browser.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false));
  const finish = (item: Active<Layer>) => {
    if (item.timer !== undefined) clock.clearTimeout(item.timer);
    item.node.remove();
    active.delete(item);
  };
  const cancel = () => {
    for (const job of jobs.values()) {
      if (job.timer !== undefined) clock.clearTimeout(job.timer);
      job.timer = undefined;
    }
    for (const item of [...active]) finish(item);
  };
  const schedule = (job: Job<Layer>) => {
    if (!started || paused || jobs.get(job.effect.id) !== job) return;
    const min = Math.max(1, job.effect.minDelay);
    const max = Math.max(min, job.effect.maxDelay);
    job.timer = clock.setTimeout(() => {
      job.timer = undefined;
      if (!started) return;
      if (unavailable()) { paused = true; cancel(); return; }
      const limit = Math.max(1, Math.min(2, job.effect.maxConcurrent ?? options.maxConcurrent ?? 1));
      const cap = Math.min(limit, ...[...active].map((item) => item.limit));
      if (active.size < cap) {
        const viewport = options.viewport?.() ?? { x: 0, y: 0, width: browser.innerWidth ?? 0, height: browser.innerHeight ?? 0 };
        const spot = findFreeSpot({ viewport, obstacles: [...(options.obstacles?.() ?? []), ...[...active].map((item) => item.node.getBoundingClientRect())],
          size: job.effect.size, margin: job.effect.margin, rng, prefer: job.effect.prefer });
        if (spot) {
          const node = options.createLayer?.(spot) ?? browser.document?.createElement("div");
          if (!node) { schedule(job); return; }
          Object.assign(node.style, { position: "absolute", left: `${spot.x}px`, top: `${spot.y}px`, width: `${spot.width}px`, height: `${spot.height}px`, overflow: "hidden" });
          node.dataset.ambientEffect = job.effect.id;
          (options.layer ?? browser.document?.body)?.appendChild(node);
          const item: Active<Layer> = { job, node, limit };
          active.add(item);
          try {
            const result = job.effect.run(spot, node);
            if (typeof result === "number") {
              if (!started || !active.has(item)) { finish(item); return; }
              item.timer = clock.setTimeout(() => finish(item), Number.isFinite(result) ? Math.max(0, result) : 0);
            } else {
              void Promise.resolve(result).then(() => finish(item), () => finish(item));
            }
          } catch { finish(item); }
        }
      }
      schedule(job);
    }, min + random(rng) * (max - min));
  };
  let unwatch: (() => void) | undefined;
  const refresh = () => {
    if (!started) return;
    const next = Boolean(unavailable());
    if (next === paused) return;
    paused = next;
    cancel();
    if (!paused) for (const job of jobs.values()) schedule(job);
  };
  return {
    add(effect) {
      if (jobs.has(effect.id)) throw new Error(`Duplicate ambient effect: ${effect.id}`);
      if (![effect.minDelay, effect.maxDelay].every(Number.isFinite)) throw new Error("Ambient delays must be finite");
      const job: Job<Layer> = { effect };
      jobs.set(effect.id, job);
      schedule(job);
      return () => {
        if (jobs.get(effect.id) !== job) return;
        if (job.timer !== undefined) clock.clearTimeout(job.timer);
        jobs.delete(effect.id);
        for (const item of [...active]) if (item.job === job) finish(item);
      };
    },
    start() {
      if (started) return;
      started = true;
      paused = Boolean(unavailable());
      if (browser.document) {
        const motion = browser.matchMedia?.("(prefers-reduced-motion: reduce)");
        browser.document.addEventListener("visibilitychange", refresh);
        motion?.addEventListener("change", refresh);
        unwatch = () => { browser.document?.removeEventListener("visibilitychange", refresh); motion?.removeEventListener("change", refresh); };
      }
      if (!paused) for (const job of jobs.values()) schedule(job);
    },
    stop() { started = false; cancel(); unwatch?.(); unwatch = undefined; },
    refresh,
  };
}
