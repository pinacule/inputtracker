import type { SkinContext } from "../types.ts";
import { cards, protectedRects, safeMask, svgElement, visible } from "./dom.ts";
import { scramble } from "./geometry.ts";
import { clearSkinEventHint } from "../events.ts";

const ease = "cubic-bezier(.16,1,.3,1)";
export function mountMotion(ctx: SkinContext) {
  let seen = new WeakSet<Element>();
  let values = new WeakMap<Element, string>();
  const decodes = new Map<Element, () => void>();
  const pending = new Set<Element>();
  const measured = new Set<Element>();
  const sizes = new WeakMap<Element, string>();
  const active = new Set<() => void>();
  const overlays = new Map<
    () => void,
    { source: Element; node: HTMLElement | SVGElement; rect: DOMRect; text: string }
  >();
  const owners = new Map<() => void, Element>();
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let rangeTimer: ReturnType<typeof setTimeout> | undefined;
  let rangeExpiry = 0;
  const rangeTargets = new Map<string, -1 | 1>();
  let disposed = false;
  const quiet = () => disposed || ctx.reducedMotion || document.hidden;
  const animate = (el: Element, frames: Keyframe[], timing: KeyframeAnimationOptions, finish?: () => void) => {
    const a = el.animate(frames, timing);
    const cleanup = () => {
      a.cancel();
      active.delete(cleanup);
      owners.delete(cleanup);
      finish?.();
    };
    active.add(cleanup);
    owners.set(cleanup, el);
    a.onfinish = cleanup;
    return cleanup;
  };
  const clear = () => {
    for (const cleanup of [...active]) cleanup();
  };
  const clearOverlays = () => {
    for (const cleanup of [...overlays.keys()]) cleanup();
  };
  const watchOverlay = (source: Element, node: Element, finish?: () => void) => {
    const cleanup = () => {
      active.delete(cleanup);
      overlays.delete(cleanup);
      finish?.();
      for (const [off, owner] of [...owners]) if (node.contains(owner)) off();
      node.remove();
    };
    overlays.set(cleanup, {
      source,
      node: node as HTMLElement | SVGElement,
      rect: source.getBoundingClientRect(),
      text: source.textContent ?? "",
    });
    active.add(cleanup);
    return cleanup;
  };
  const validate = () => {
    // Ignore unrelated hydration/tooltip updates. Only stale measured overlays
    // are invalidated; native chart animations retain their full 380ms timeline.
    let retry = false;
    for (const [cleanup, entry] of [...overlays]) {
      const r = entry.source.getBoundingClientRect(),
        old = entry.rect;
      if (
        !entry.source.isConnected ||
        entry.text !== entry.source.textContent ||
        Math.abs(r.width - old.width) > 0.5 ||
        Math.abs(r.height - old.height) > 0.5
      ) {
        cleanup();
        values.delete(entry.source);
        seen.delete(entry.source);
        retry = true;
      } else if (r.left !== old.left || r.top !== old.top) {
        // Async sections above a card can move it without changing its local
        // glyph mask. Follow that translation instead of killing its entrance.
        entry.node.style.left = `${r.left}px`;
        entry.node.style.top = `${r.top}px`;
        entry.rect = r;
      }
    }
    for (const [cleanup, owner] of [...owners]) if (!owner.isConnected) cleanup();
    if (retry) schedule();
  };
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const size = `${entry.contentRect.width.toFixed(1)}:${entry.contentRect.height.toFixed(1)}`;
      const previous = sizes.get(entry.target);
      if (previous !== undefined && previous !== size) validate();
      sizes.set(entry.target, size);
    }
  });
  const frame = (el: Element, delay = 0, direction?: -1 | 1) => {
    if (quiet() || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (!visible(r)) return;
    const protectedBounds = protectedRects(el);
    const mask = safeMask(r, protectedBounds);
    const w = r.width,
      h = r.height,
      b = ctx.isPhone ? 8 : 12;
    // Frame occupies existing 3px-inset brackets; the scan crosses ONLY padding
    // after glyphs and whole controls have been subtracted with 8px clearance.
    const svg = svgElement(
      `${mask.markup}<g mask="url(#${mask.id})"><path class="nc-power-rail" d="M3 3H${w - 3}V${h - 3}H3Z M3 ${b + 3}V3H${b + 3} M${w - b - 3} 3H${w - 3}V${b + 3} M3 ${h - b - 3}V${h - 3}H${b + 3} M${w - b - 3} ${h - 3}H${w - 3}V${h - b - 3}" fill="none" stroke="#9df2ff" stroke-width="2"/><path class="nc-power-scan" d="M12 0H${w - 12}" fill="none" stroke="#67e8f9" stroke-opacity=".6" stroke-width="2"/>${direction ? `<path class="nc-direction-rail" d="M0 1h${Math.min(90, w / 3)} M0 ${h - 1}h${Math.min(90, w / 3)}" fill="none" stroke="#b6f5ff" stroke-width="3"/>` : ""}</g>`,
      r,
      "nc-power",
    );
    ctx.fx.append(svg);
    const remove = watchOverlay(el, svg);
    const flicker: Keyframe[] = [
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: 0.16 },
      { opacity: 0.08, offset: 0.2 },
      { opacity: 0.08, offset: 0.29 },
      { opacity: 1, offset: 0.34 },
      { opacity: 1, offset: 0.54 },
      { opacity: 0.08, offset: 0.57 },
      { opacity: 0.08, offset: 0.66 },
      { opacity: 1, offset: 0.72 },
      { opacity: 1 },
    ];
    // Dip the actual static corner strokes too, rather than dipping an overlay
    // while the identical cyan corners underneath remain fully lit.
    animate(el, flicker, { duration: 420, delay, pseudoElement: "::after", fill: "backwards" });
    animate(svg.querySelector(".nc-power-rail")!, [...flicker], { duration: 420, delay, fill: "backwards" }, remove);
    animate(
      svg.querySelector(".nc-power-scan")!,
      [{ transform: "translateY(8px)" }, { transform: `translateY(${h - 8}px)` }],
      { duration: 420, delay, easing: "linear", fill: "backwards" },
    );
    const rail = svg.querySelector(".nc-direction-rail");
    if (rail)
      animate(
        rail,
        [
          { transform: `translateX(${direction === 1 ? -90 : w}px)`, opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { transform: `translateX(${direction === 1 ? w : -90}px)`, opacity: 0 },
        ],
        { duration: 260, delay: 100, easing: ease },
      );
  };
  const scanMap = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (!visible(r)) return;
    const mask = safeMask(r, protectedRects(el));
    // Clip to actual noninteractive tile fills; glyph holes include map labels.
    const fills = [...el.querySelectorAll(".home-map-tile-inner,.home-map-fill")]
      .map((tile) => {
        const t = tile.getBoundingClientRect();
        return `<rect x="${t.left - r.left}" y="${t.top - r.top}" width="${t.width}" height="${t.height}"/>`;
      })
      .join("");
    // Map cells are buttons, so use glyph protection for this data-only scan.
    const glyphMask = safeMask(
      r,
      protectedRects(el).filter(
        (p) =>
          ![...el.querySelectorAll("button,a")].some((c) => {
            const q = c.getBoundingClientRect();
            return p.left === q.left && p.top === q.top && p.width === q.width && p.height === q.height;
          }),
      ),
    );
    const clipId = `${mask.id}-tiles`;
    const svg = svgElement(
      `${glyphMask.markup}<defs><clipPath id="${clipId}">${fills}</clipPath></defs><g clip-path="url(#${clipId})" mask="url(#${glyphMask.id})"><path d="M0 0V${r.height}" stroke="#67e8f9" stroke-opacity=".5" stroke-width="2"/></g>`,
      r,
      "nc-map-scan",
    );
    ctx.fx.append(svg);
    const remove = watchOverlay(el, svg);
    animate(
      svg.querySelector("g path")!,
      [{ transform: "translateX(0)" }, { transform: `translateX(${r.width}px)` }],
      { duration: 500, easing: "linear" },
      remove,
    );
  };
  const decode = (el: Element) => {
    const exact = el.textContent ?? "";
    if (values.get(el) === exact) return;
    if (!(el instanceof HTMLElement) || !visible(el.getBoundingClientRect())) return;
    values.set(el, exact);
    decodes.get(el)?.();
    if (quiet()) return;
    const r = el.getBoundingClientRect();
    if (r.width > innerWidth || r.height > 150 || !/\d/.test(exact)) return;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id");
    clone.removeAttribute("aria-live");
    clone.setAttribute("aria-hidden", "true");
    clone.classList.add("nc-decode");
    // Preserve exact typesetting, including units and flex spacing. No guessed box.
    const originals = [el, ...el.querySelectorAll("*")];
    const copies = [clone, ...clone.querySelectorAll("*")];
    originals.forEach((node, i) => {
      const target = copies[i] as HTMLElement,
        computed = getComputedStyle(node);
      for (const prop of [
        "font-family",
        "font-size",
        "font-weight",
        "font-variant-numeric",
        "line-height",
        "letter-spacing",
        "color",
        "display",
        "gap",
        "align-items",
        "flex-wrap",
        "white-space",
        "margin-left",
      ])
        target.style.setProperty(prop, computed.getPropertyValue(prop));
      target.removeAttribute("id");
    });
    Object.assign(clone.style, {
      position: "absolute",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      margin: "0",
      pointerEvents: "none",
    });
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const texts: { node: Node; exact: string }[] = [];
    while (walker.nextNode()) texts.push({ node: walker.currentNode, exact: walker.currentNode.textContent ?? "" });
    const previous = el.style.opacity,
      hadStyle = el.hasAttribute("style");
    el.style.opacity = "0";
    ctx.fx.append(clone);
    let timer: ReturnType<typeof setTimeout>;
    let step = 0;
    const cleanup = watchOverlay(el, clone, () => {
      clearTimeout(timer);
      el.style.opacity = previous;
      if (!hadStyle && !el.getAttribute("style")) el.removeAttribute("style");
      decodes.delete(el);
    });
    decodes.set(el, cleanup);
    const tick = () => {
      step++;
      for (const text of texts) text.node.textContent = scramble(text.exact, step);
      if (step === 8) {
        cleanup();
        return;
      }
      timer = setTimeout(tick, 35);
    };
    // Scramble immediately so the first capture contains the decode too.
    for (const text of texts) text.node.textContent = scramble(text.exact, 0);
    timer = setTimeout(tick, 35);
  };
  const enter = (el: Element, index: number) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (quiet()) return;
    if (el.matches(cards)) {
      const direction =
        performance.now() < rangeExpiry ? [...rangeTargets].find(([selector]) => el.matches(selector))?.[1] : undefined;
      frame(el, direction ? 0 : index < 6 ? index * 40 : 0, direction);
    }
    if (el.matches(".home-week-bar-stack,.home-skyline-stack")) {
      const all = [...el.parentElement!.parentElement!.querySelectorAll(".home-week-bar-stack,.home-skyline-stack")];
      // Index the full chart, including empty days, rather than just visible bars.
      const column = el.closest(".home-week-day,.home-skyline-col");
      const siblings = column?.parentElement ? [...column.parentElement.children] : [];
      const i = column ? siblings.indexOf(column) : all.indexOf(el);
      animate(
        el,
        [
          { transform: "scaleY(0)", transformOrigin: "center bottom" },
          { transform: "scaleY(1)", transformOrigin: "center bottom" },
        ],
        { duration: 380, delay: Math.max(0, i) * 30, easing: "cubic-bezier(.25,.6,.3,1)", fill: "backwards" },
      );
    }
    if (el.matches(".ui-chart-bar-group")) {
      const segments = [...el.querySelectorAll<SVGRectElement>(".ui-chart-segment")];
      const baseline = Math.max(
        0,
        ...segments.map((segment) => segment.y.baseVal.value + segment.height.baseVal.value),
      );
      const index = [...el.parentElement!.querySelectorAll(".ui-chart-bar-group")].indexOf(el);
      for (const segment of segments)
        animate(
          segment,
          [
            { transform: `matrix(1,0,0,0,0,${baseline})`, transformOrigin: "0 0", transformBox: "view-box" },
            { transform: "matrix(1,0,0,1,0,0)", transformOrigin: "0 0", transformBox: "view-box" },
          ],
          { duration: 380, delay: Math.max(0, index) * 30, easing: "cubic-bezier(.25,.6,.3,1)", fill: "backwards" },
        );
    }
    if (el.matches(".ui-sparkline path[stroke]") && el instanceof SVGGeometryElement) {
      const length = el.getTotalLength();
      animate(
        el,
        [
          { strokeDasharray: `${length}`, strokeDashoffset: length },
          { strokeDasharray: `${length}`, strokeDashoffset: 0 },
        ],
        { duration: 420, easing: ease },
      );
    }
    if (el.matches(".home-day-map")) scanMap(el);
    if (el.matches(".home-time,.ui-stat-value,.work-metric-value")) decode(el);
  };
  const observer = new IntersectionObserver(
    (entries) => {
      let i = 0;
      for (const entry of entries)
        if (entry.isIntersecting) {
          enter(entry.target, entry.target.matches(cards) ? i++ : 0);
          observer.unobserve(entry.target);
          pending.delete(entry.target);
        }
    },
    { threshold: 0.05 },
  );
  const entranceSelector = `${cards},.home-week-bar-stack,.home-skyline-stack,.ui-chart-bar-group,.ui-sparkline path[stroke],.home-day-map,.home-time,.ui-stat-value,.work-metric-value`;
  const rememberQuiet = () => {
    pending.forEach((el) => observer.unobserve(el));
    pending.clear();
    app?.querySelectorAll(entranceSelector).forEach((el) => seen.add(el));
    app
      ?.querySelectorAll(".home-time,.ui-stat-value,.work-metric-value")
      .forEach((el) => values.set(el, el.textContent ?? ""));
  };
  const scan = () => {
    scanTimer = undefined;
    if (disposed) return;
    if (quiet()) {
      rememberQuiet();
      return;
    }
    for (const el of pending)
      if (!el.isConnected) {
        observer.unobserve(el);
        pending.delete(el);
      }
    for (const el of measured)
      if (!el.isConnected) {
        resizeObserver.unobserve(el);
        measured.delete(el);
      }
    app?.querySelectorAll(entranceSelector).forEach((el) => {
      if (el.matches(cards) && !measured.has(el)) {
        resizeObserver.observe(el);
        measured.add(el);
      }
      if (!seen.has(el) && !pending.has(el)) {
        pending.add(el);
        observer.observe(el);
      }
    });
    app?.querySelectorAll(".home-time,.ui-stat-value,.work-metric-value").forEach(decode);
  };
  const schedule = () => {
    if (quiet()) {
      rememberQuiet();
      return;
    }
    if (scanTimer === undefined) scanTimer = setTimeout(scan, 0);
  };
  const mutations = new MutationObserver(() => {
    validate();
    schedule();
  });
  const app = document.getElementById("app");
  if (app) mutations.observe(app, { childList: true, subtree: true, characterData: true });
  const events = [
    ctx.on("day-change", ({ direction }) => range(".home-day-overview,.home-day-entries", direction)),
    ctx.on("week-change", ({ direction }) => range(".home-week-card", direction)),
    ctx.on("month-change", ({ direction }) => range(".home-rhythm-card", direction)),
    ctx.on("page-change", () => {
      clear();
      clearTimeout(eventTimer);
      clearTimeout(rangeTimer);
      rangeTimer = undefined;
      rangeTargets.clear();
      seen = new WeakSet();
      values = new WeakMap();
      pending.forEach((el) => observer.unobserve(el));
      pending.clear();
      if (quiet()) {
        rememberQuiet();
        clearSkinEventHint();
        return;
      }
      // The new route may first render a loading placeholder; the observer handles
      // asynchronously arriving cards, and exact numbers never wait for data motion.
      eventTimer = setTimeout(() => {
        eventTimer = undefined;
        if (quiet()) return;
        schedule();
      }, 0);
    }),
  ];
  function range(selector: string, direction: -1 | 1) {
    if (quiet()) {
      clearSkinEventHint();
      return;
    }
    // A week step also changes the selected day (and sometimes month). Preserve
    // every changed frame when S0 emits those events in the same render cycle.
    if (rangeTimer === undefined) {
      clear();
      rangeTargets.clear();
    }
    rangeTargets.set(selector, direction);
    rangeExpiry = performance.now() + 700;
    // S0's hint is live here. Keep our measured frame reaction independent of
    // the data card's loading/remount timing and its 700ms hint expiry.
    if (rangeTimer === undefined)
      rangeTimer = setTimeout(() => {
        rangeTimer = undefined;
        for (const [target] of rangeTargets)
          document.querySelectorAll(target).forEach((el) => {
            for (const [off, owner] of [...owners]) if (el.contains(owner)) off();
            const elements = [el, ...el.querySelectorAll(entranceSelector)];
            for (const child of elements) {
              seen.delete(child);
              values.delete(child);
              enter(child, 0);
            }
          });
        schedule();
      }, 100);
  }
  const suspend = () => {
    clear();
    clearTimeout(scanTimer);
    scanTimer = undefined;
    clearTimeout(eventTimer);
    eventTimer = undefined;
    clearTimeout(rangeTimer);
    rangeTimer = undefined;
    rangeTargets.clear();
    rangeExpiry = 0;
    if (quiet()) clearSkinEventHint();
  };
  const offVisibility = ctx.onVisibility(() => {
    suspend();
    scan();
  });
  const offMotion = ctx.onMotionChange(() => {
    suspend();
    scan();
  });
  // Clear viewport-positioned decorations before geometry changes. Completed
  // entrances do not replay when the user returns from a hidden tab or scrolls.
  window.addEventListener("scroll", clearOverlays, { capture: true, passive: true, signal: ctx.signal });
  window.addEventListener("resize", clearOverlays, { signal: ctx.signal });
  document.addEventListener("focusin", clearOverlays, { signal: ctx.signal });
  document.fonts.addEventListener("loadingdone", validate, { signal: ctx.signal });
  scan();
  return () => {
    disposed = true;
    suspend();
    mutations.disconnect();
    observer.disconnect();
    resizeObserver.disconnect();
    pending.clear();
    measured.clear();
    events.forEach((off) => off());
    offVisibility();
    offMotion();
  };
}
