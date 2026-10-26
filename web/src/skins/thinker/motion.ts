import type { SkinContext } from "../types.ts";

export const CARD_SELECTOR = ".home-topbar,.home-category-index,.home-day-overview,.home-day-entries,.home-week-card,.home-rhythm-card,.ui-card,.insights-goal-item,.insights-otd-card,.library-work-card,.library-work-list-row,.yt-topic-card,.review-poster,.theme-tile";
const NUMBER_SELECTOR = ".home-time--hero,.home-time--week,.home-time--month,.ui-stat-value,.work-metric-pill strong,.home-rhythm-stat strong";
const ease = "cubic-bezier(.22,1,.36,1)";

/** Paint-only entrances, independently timed from S0's event hint. Every actual
 * mount is observed, including async data and reused DOM on route transitions. */
export function createMotion(ctx: SkinContext) {
  let generation = 0;
  let direction = 1;
  const seen = new WeakMap<Element, number>();
  const numbers = new WeakMap<Element, string>();
  const running = new Map<Element, Animation>();
  const visible = new Set<HTMLElement>();
  const tracked = new Set<HTMLElement>();
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target as HTMLElement);
      else visible.delete(entry.target as HTMLElement);
    }
  }, { rootMargin: "20px" });
  const animate = (el: Element, frames: Keyframe[], duration: number, delay = 0) => {
    if (ctx.reducedMotion || document.hidden) return;
    running.get(el)?.cancel();
    const animation = el.animate(frames, { duration, delay, easing: ease, fill: "backwards" });
    running.set(el, animation);
    animation.onfinish = () => { if (running.get(el) === animation) running.delete(el); };
  };
  const fresh = (el: Element) => {
    if (seen.get(el) === generation) return false;
    seen.set(el, generation);
    return true;
  };
  function update() {
    for (const card of tracked) {
      if (!card.isConnected) {
        intersection.unobserve(card);
        visible.delete(card);
        tracked.delete(card);
        running.get(card)?.cancel();
        running.delete(card);
      }
    }
    let order = 0;
    for (const card of document.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
      if (!tracked.has(card)) { tracked.add(card); intersection.observe(card); }
      if (!fresh(card)) continue;
      // No opacity on reading ink; the slab rises, while its edge receives light.
      animate(card, [{ transform: "translateY(8px)", borderColor: "#393027", "--th-arrival": "0" },
        { transform: "translateY(0)", borderColor: "#94704f", "--th-arrival": "1" }], 360, Math.min(order++, 5) * 12);
    }
    for (const number of document.querySelectorAll<HTMLElement>(NUMBER_SELECTOR)) {
      const key = `${generation}:${number.textContent}`;
      if (numbers.get(number) === key) continue;
      numbers.set(number, key);
      // Glyph-shaped light behind the actual exact digits, never a text copy.
      animate(number, [{ textShadow: `${-8 * direction}px 0 7px #f0a55700` },
        { textShadow: "0 0 9px #f0a55710", offset: .42 },
        { textShadow: `${8 * direction}px 0 7px #f0a55700` }], 460);
    }
    for (const chart of document.querySelectorAll<HTMLElement>(".home-week-bars,.home-skyline,.ui-chart-svg-wrap")) {
      if (!fresh(chart)) continue;
      // Same audited stone endpoint beneath labels, replayed on route mounts
      // even when Preact reuses the plot node. Mineral fill colours stay exact.
      animate(chart, [{ backgroundPosition: "100% 0" }, { backgroundPosition: "0% 0" }],
        chart.classList.contains("home-week-bars") ? 600 : 1320);
    }
    for (const stack of document.querySelectorAll<HTMLElement>(".home-week-bar-stack,.home-skyline-stack")) {
      if (!fresh(stack)) continue;
      const column = stack.closest(".home-week-day,.home-skyline-col");
      const index = column?.parentElement ? [...column.parentElement.children].indexOf(column) : 0;
      animate(stack, [{ transform: "scaleY(0)", transformOrigin: "50% 100%" },
        { transform: "scaleY(1)", transformOrigin: "50% 100%" }], 420, index * 30);
    }
    // Insights/Review SVG series: transform the paint segments about the shared
    // data baseline, not the group containing labels, focus and full hit targets.
    for (const group of document.querySelectorAll<SVGGElement>(".ui-chart-bar-group")) {
      const segments = [...group.querySelectorAll<SVGRectElement>(".ui-chart-segment")];
      const baseline = Math.max(...segments.map((s) => Number(s.getAttribute("y")) + Number(s.getAttribute("height"))));
      const index = group.parentElement ? [...group.parentElement.querySelectorAll(".ui-chart-bar-group")].indexOf(group) : 0;
      for (const segment of segments) {
        if (!fresh(segment)) continue;
        const origin = `0px ${baseline}px`;
        animate(segment, [{ transform: "scaleY(0)", transformOrigin: origin, transformBox: "view-box" },
          { transform: "scaleY(1)", transformOrigin: origin, transformBox: "view-box" }], 420, index * 30);
      }
    }
    for (const path of document.querySelectorAll<SVGGeometryElement>(".ui-sparkline :is(path[stroke],polyline)")) {
      if (!fresh(path)) continue;
      const length = path.getTotalLength();
      animate(path, [{ strokeDasharray: `${length} ${length}`, strokeDashoffset: `${length}` },
        { strokeDasharray: `${length} ${length}`, strokeDashoffset: "0" }], 420);
    }
  }
  function stop() {
    for (const animation of running.values()) animation.cancel();
    running.clear();
  }
  return {
    update, visible,
    page() { generation++; },
    direction(value: -1 | 1) { direction = value; },
    stop,
    dispose() {
      stop(); intersection.disconnect();
      for (const card of tracked) {
        card.style.removeProperty("--th-shadow-x"); card.style.removeProperty("--th-shadow-y");
      }
      tracked.clear(); visible.clear();
    },
  };
}
