import type { SkinContext } from "../types.ts";

type Beat = "embers" | "hearth" | "dust" | "soot" | "glint" | "gust";
const cooldowns: Record<Beat, [number, number]> = {
  embers: [14, 24], hearth: [20, 36], dust: [25, 45],
  soot: [35, 55], glint: [28, 48], gust: [18, 32],
};
const randomDelay = (min: number, max: number) => (min + Math.random() * (max - min)) * 1000;

/** One priority conductor reserves an ambient slot for the walking background
 * figure / embers. Small full-swept gutter boxes fit even on a 390px phone. The
 * big walking silhouette uses bg (opaque-card occlusion), never the fx slot. */
export function createAmbience(ctx: SkinContext, startWalk: () => void, gust: () => void, glint: () => void) {
  let clock = 0;
  let nextWalk = randomDelay(40, 80);
  const due = {} as Record<Beat, number>;
  const reset = () => {
    clock = 0; nextWalk = randomDelay(40, 80);
    for (const beat of Object.keys(cooldowns) as Beat[]) {
      const [min, max] = cooldowns[beat];
      due[beat] = randomDelay(min + (ctx.isPhone ? 4 : 0), max + (ctx.isPhone ? 6 : 0));
    }
  };
  reset();
  // Scheduler owns lifetimes, collision rechecks, concurrency, pause and cleanup.
  const remove = ctx.ambient.add({
    id: "th-hearth-beats", minDelay: 1000, maxDelay: 1300,
    maxConcurrent: 1, size: { width: 12, height: ctx.isPhone ? 190 : 280 },
    prefer: "edges", margin: 0,
    run(_spot, layer) {
      if (clock >= nextWalk) {
        layer.dataset.thinkerBeat = "walk";
        startWalk(); nextWalk = clock + randomDelay(40, 80);
        return 10_000;
      }
      const priority: Beat[] = ["embers", "gust", "dust", "hearth", "soot", "glint"];
      const beat = priority.find((name) => clock >= due[name]);
      if (!beat) return 0;
      layer.dataset.thinkerBeat = beat;
      const [min, max] = cooldowns[beat];
      due[beat] = clock + randomDelay(min + (ctx.isPhone ? 4 : 0), max + (ctx.isPhone ? 6 : 0));
      if (beat === "gust") { gust(); return 2600; }
      if (beat === "glint") { glint(); return 2000; }
      const count = beat === "embers" ? (ctx.isPhone ? 5 : 8) : beat === "dust" ? 6 : beat === "hearth" ? 3 : 1;
      for (let i = 0; i < count; i++) {
        const sprite = document.createElement("i");
        sprite.className = `th-ambient th-${beat}`;
        sprite.style.setProperty("--i", String(i));
        sprite.style.setProperty("--drift", `${(i % 3 - 1) * 3}px`);
        sprite.style.left = `${2 + (i * 3) % 8}px`;
        layer.append(sprite);
      }
      return beat === "dust" ? 6000 : beat === "hearth" ? 2800 : beat === "soot" ? 5000 : 4000;
    },
  });
  ctx.ambient.start();
  return {
    tick(dt: number) { clock += dt; },
    priority() { return clock >= nextWalk - 7000 || clock >= due.embers - 4000; },
    reset,
    dispose() { remove(); ctx.ambient.stop(); },
  };
}
