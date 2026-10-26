import { describe, expect, test } from "bun:test";
import { contrastRatio, relativeLuminance } from "../web/src/lib/theme.ts";
import { LIT_SURFACES } from "../web/src/skins/thinker/flame.ts";

// Import browser controllers without adding DOM globals to the server tsconfig.
const { createMotion } = await import(new URL("../web/src/skins/thinker/motion.ts", import.meta.url).href);
const { createAmbience } = await import(new URL("../web/src/skins/thinker/ambient.ts", import.meta.url).href);
const globals = (values: Record<string, unknown>) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
};
class PaintNode {
  textContent = "42 min"; isConnected = true;
  parentElement: { children: PaintNode[] } | null = null;
  column: PaintNode | null = null;
  removed: string[] = [];
  calls: { frames: Record<string, string>[]; options: { duration: number; delay: number }; cancelled: boolean; onfinish?: () => void }[] = [];
  style = { removeProperty: (name: string) => this.removed.push(name), setProperty() {} };
  classList = { contains: (name: string) => name === "home-week-bars" };
  closest() { return this.column; }
  animate(frames: Record<string, string>[], options: { duration: number; delay: number }) {
    const call = { frames, options, cancelled: false };
    this.calls.push(call);
    return Object.assign(call, { cancel() { call.cancelled = true; } });
  }
  getTotalLength() { return 72; }
}

describe("Thinker effect lifecycle", () => {
  test("mount / route replay grows paint only, keeps exact numbers, ignores ordinary redraws", () => {
    const card = new PaintNode(), number = new PaintNode(), sparkline = new PaintNode(), chart = new PaintNode();
    const stacks = Array.from({ length: 7 }, () => new PaintNode());
    const columns = stacks.map(() => new PaintNode());
    for (let i = 0; i < stacks.length; i++) {
      stacks[i]!.column = columns[i]!;
      columns[i]!.parentElement = { children: columns };
    }
    let reduced = false, hidden = false, disconnected = 0;
    const restore = globals({
      document: { get hidden() { return hidden; }, querySelectorAll(selector: string) {
        if (selector.startsWith(".home-topbar")) return [card];
        if (selector.startsWith(".home-time--hero")) return [number];
        if (selector.startsWith(".home-week-bar-stack")) return stacks;
        if (selector.startsWith(".home-week-bars,")) return [chart];
        if (selector.startsWith(".ui-sparkline")) return [sparkline];
        return [];
      } },
      IntersectionObserver: class { observe() {} unobserve() {} disconnect() { disconnected++; } },
    });
    try {
      const motion = createMotion({ get reducedMotion() { return reduced; } });
      motion.update();
      expect(card.calls[0]!.frames[0]!["--th-arrival"]).toBe("0");
      expect(card.calls[0]!.options.duration).toBeLessThanOrEqual(420);
      for (let i = 0; i < stacks.length; i++) {
        expect(stacks[i]!.calls[0]!.options).toMatchObject({ duration: 420, delay: i * 30 });
        expect(stacks[i]!.calls[0]!.frames[0]!.transform).toBe("scaleY(0)");
      }
      expect(sparkline.calls[0]!.frames[0]!.strokeDashoffset).toBe("72");
      expect(chart.calls[0]!.options.duration).toBe(600);
      expect(chart.calls[0]!.frames[0]!.backgroundPosition).toBe("100% 0");
      expect(number.textContent).toBe("42 min");
      motion.update();
      expect(card.calls.length).toBe(1);
      expect(stacks[0]!.calls.length).toBe(1);
      expect(chart.calls.length).toBe(1);
      motion.direction(-1); number.textContent = "43 min"; motion.update();
      expect(number.calls.length).toBe(2);
      expect(number.calls[1]!.frames[0]!.textShadow).toStartWith("8px");
      motion.page(); motion.update();
      expect(stacks[6]!.calls.length).toBe(2);
      expect(chart.calls.length).toBe(2);
      expect(stacks[6]!.calls[0]!.cancelled).toBe(true);
      reduced = true; motion.stop(); motion.page(); motion.update();
      expect(stacks[0]!.calls.length).toBe(2);
      reduced = false; hidden = true; motion.page(); motion.update();
      expect(stacks[0]!.calls.length).toBe(2);
      motion.dispose();
      expect(disconnected).toBe(1);
      expect(card.removed).toContain("--th-shadow-x");
      expect(card.removed).toContain("--th-shadow-y");
    } finally { restore(); }
  });

  test("priority ember / walk beats reserve the same slot, with smaller phone bursts", () => {
    const rng = Math.random;
    Math.random = () => .5;
    const restore = globals({ document: { createElement: () => new PaintNode() } });
    try {
      for (const phone of [false, true]) {
        let job: { run(spot: object, layer: object): number; maxConcurrent: number; size: { height: number } } | undefined;
        let walks = 0, gusts = 0, removed = 0, stopped = 0;
        const children: PaintNode[] = [];
        const layer = { dataset: {} as Record<string, string>, append(node: PaintNode) { children.push(node); } };
        const ambience = createAmbience({ isPhone: phone, ambient: {
          add(effect: typeof job) { job = effect; return () => { removed++; }; }, start() {}, stop() { stopped++; },
        } }, () => { walks++; }, () => { gusts++; }, () => {});
        expect(job!.maxConcurrent).toBe(1);
        expect(job!.size.height).toBe(phone ? 190 : 280);
        ambience.tick(25_000);
        expect(ambience.priority()).toBe(true);
        expect(job!.run({}, layer)).toBe(4000);
        expect(layer.dataset.thinkerBeat).toBe("embers");
        expect(children.length).toBe(phone ? 5 : 8);
        ambience.tick(5000); expect(job!.run({}, layer)).toBe(2600); expect(gusts).toBe(1);
        ambience.tick(31_000); expect(job!.run({}, layer)).toBe(10_000); expect(walks).toBe(1);
        expect(layer.dataset.thinkerBeat).toBe("walk");
        ambience.reset(); expect(ambience.priority()).toBe(false);
        ambience.dispose(); expect(removed).toBe(1); expect(stopped).toBe(1);
      }
    } finally { restore(); Math.random = rng; }
  });

  test("even an unblurred full-opacity ignition extremum shares the cumulative +.020 limit", () => {
    for (const [base, lit] of LIT_SURFACES) {
      const blend = [1, 3, 5].map((i) => Math.round(parseInt(lit.slice(i, i + 2), 16) * (1 - 16 / 255)
        + parseInt("#f0a557".slice(i, i + 2), 16) * 16 / 255));
      const hex = "#" + blend.map((v) => v.toString(16).padStart(2, "0")).join("");
      expect(relativeLuminance(hex) - relativeLuminance(base)).toBeLessThanOrEqual(.020);
      expect(contrastRatio("#b6a895", hex)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
