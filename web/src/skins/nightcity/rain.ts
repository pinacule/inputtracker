import type { SkinContext } from "../types.ts";
import { cards, protectedRects, safeMask, svgElement, visible } from "./dom.ts";
import { rainBudget } from "./geometry.ts";

/** One canvas for the atmosphere; front beads are strictly stroke-masked SVG. */
export function mountRain(ctx: SkinContext) {
  const canvas = document.createElement("canvas");
  canvas.className = "nc-rain";
  ctx.bg.append(canvas);
  const g = canvas.getContext("2d");
  let raf = 0,
    last = 0,
    nextBurst = 0,
    burstEnd = 0,
    nextBead = 0;
  let bead: SVGSVGElement | undefined,
    beadEnd = 0,
    lightEnd = 0;
  const drops = Array.from({ length: 540 }, () => ({
    x: Math.random(),
    y: Math.random(),
    speed: 900 + Math.random() * 500,
    length: 14 + Math.random() * 26,
  }));
  const windows = new Map<Element, { svg: SVGSVGElement; rect: DOMRect; drops: typeof drops }>();
  let windowsDirty = true;
  const updateWindows = () => {
    windowsDirty = false;
    for (const item of windows.values()) item.svg.remove();
    windows.clear();
    for (const el of document.querySelectorAll(".page-header,.home-topbar,.work-hero-card")) {
      const bounds = el.getBoundingClientRect();
      if (!visible(bounds)) continue;
      const r = el.matches(".work-hero-card") ? new DOMRect(bounds.left, bounds.top, bounds.width, 44) : bounds;
      const protectedBounds = protectedRects(el);
      // The opaque local reading bands remain dry, including empty space inside
      // their boxes. Rain is visible only through the exposed city window.
      el.querySelectorAll(
        ".page-header-titles,.page-header-actions,.home-month-nav,.home-topbar-actions,.work-hero-layout",
      ).forEach((node) => protectedBounds.push(node.getBoundingClientRect()));
      const mask = safeMask(r, protectedBounds);
      const svg = svgElement(
        `${mask.markup}<g mask="url(#${mask.id})"><path class="nc-window-rain-glow" fill="none" stroke="#67e8f9" stroke-width="4" stroke-opacity=".16"/><path class="nc-window-rain-core" fill="none" stroke="#dbfaff" stroke-width="1" stroke-opacity=".55"/></g>`,
        r,
        "nc-window-rain",
      );
      ctx.fx.append(svg);
      windows.set(el, {
        svg,
        rect: r,
        drops: Array.from({ length: ctx.isPhone ? 22 : 64 }, () => ({
          ...drops[Math.floor(Math.random() * drops.length)]!,
        })),
      });
    }
  };
  const resetTimes = () => {
    const now = performance.now();
    nextBurst = now + 20000 + Math.random() * 20000;
    nextBead = now + 1800 + Math.random() * 2200;
    burstEnd = 0;
  };
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, rainBudget(ctx.isPhone, false).dpr);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    g?.setTransform(dpr, 0, 0, dpr, 0, 0);
    bead?.remove();
    bead = undefined;
    windowsDirty = true;
  };
  const front = (now: number) => {
    const choices = [...document.querySelectorAll(cards)].filter((el) => visible(el.getBoundingClientRect()));
    const card = choices[Math.floor(Math.random() * choices.length)];
    if (!card) return;
    const r = card.getBoundingClientRect(),
      mask = safeMask(r, protectedRects(card), true);
    const count = ctx.isPhone ? 2 : 3;
    const paths = Array.from({ length: count }, (_, i) => {
      const x = i % 2 ? r.width - 1 : 1;
      const y = Math.max(4, Math.random() * (r.height - 70));
      return `<g class="nc-bead" style="--nc-run:${20 + Math.random() * 40}px;animation-delay:${i * 55}ms"><path d="M${x} ${y}v12" stroke="#eafcff" stroke-width="2"/></g>`;
    }).join("");
    const ticks = Array.from({ length: 3 }, (_, i) => `<path d="M${(r.width * (i + 1)) / 4} 1h2"/>`).join("");
    bead?.remove();
    bead = svgElement(
      `${mask.markup}<g mask="url(#${mask.id})">${paths}<g class="nc-splash" stroke="#b6f5ff" stroke-width="2">${ticks}</g></g>`,
      r,
      "nc-front-rain",
    );
    ctx.fx.append(bead);
    beadEnd = now + 1400;
  };
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const budget = rainBudget(ctx.isPhone, now < burstEnd);
    const interval = 1000 / budget.fps,
      elapsed = now - last;
    if (elapsed < interval) return;
    const dt = Math.min(100, elapsed || interval);
    last = now - (elapsed % interval);
    if (!g) return;
    if (now >= nextBurst) {
      burstEnd = now + 6000;
      nextBurst = now + 20000 + Math.random() * 20000;
    }
    if (now >= nextBead) {
      front(now);
      nextBead = now + 2400 + Math.random() * 2000;
    }
    if (bead && now > beadEnd) {
      bead.remove();
      bead = undefined;
    }
    g.clearRect(0, 0, innerWidth, innerHeight);
    g.beginPath();
    for (let i = 0; i < budget.count; i++) {
      const d = drops[i]!;
      d.y += dt / d.speed;
      if (d.y > 1.05) {
        d.y = -0.05;
        d.x = Math.random();
      }
      const y = d.y * innerHeight,
        x = d.x * innerWidth - y * 0.176;
      // Wrap the diagonal so the right gutter receives the same rainfall.
      const wrapped = (x + innerWidth) % innerWidth;
      g.moveTo(wrapped, y);
      g.lineTo(wrapped - d.length * 0.176, y + d.length);
    }
    // Two batched strokes give a soft halo without an expensive viewport blur.
    g.lineWidth = 4;
    g.strokeStyle = "#67e8f9";
    g.globalAlpha = 0.16;
    g.stroke();
    g.lineWidth = 1;
    g.strokeStyle = now < lightEnd ? "#ffffff" : "#dbfaff";
    g.globalAlpha = budget.opacity;
    g.stroke();
    if (windowsDirty) updateWindows();
    for (const [el, item] of windows) {
      if (!el.isConnected) {
        item.svg.remove();
        windows.delete(el);
        continue;
      }
      const r = el.getBoundingClientRect();
      item.svg.style.left = `${r.left}px`;
      item.svg.style.top = `${r.top}px`;
      let path = "";
      for (const d of item.drops) {
        d.y = (d.y + dt / d.speed) % 1;
        const y = d.y * (item.rect.height + 40) - 40,
          x = d.x * item.rect.width;
        path += `M${x.toFixed(1)} ${y.toFixed(1)}l${(-d.length * 0.176).toFixed(1)} ${d.length.toFixed(1)}`;
      }
      for (const node of item.svg.querySelectorAll("g > path")) node.setAttribute("d", path);
    }
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    bead?.remove();
    bead = undefined;
    for (const item of windows.values()) item.svg.remove();
    windows.clear();
    windowsDirty = true;
    g?.clearRect(0, 0, innerWidth, innerHeight);
  };
  const refresh = () => {
    stop();
    if (!ctx.reducedMotion && !document.hidden) {
      resetTimes();
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  };
  window.addEventListener("resize", size, { signal: ctx.signal });
  window.addEventListener(
    "scroll",
    () => {
      bead?.remove();
      bead = undefined;
      windowsDirty = true;
      for (const item of windows.values()) item.svg.remove();
      windows.clear();
    },
    { signal: ctx.signal, passive: true, capture: true },
  );
  document.addEventListener(
    "focusin",
    () => {
      bead?.remove();
      bead = undefined;
    },
    { signal: ctx.signal },
  );
  const offVisibility = ctx.onVisibility(refresh),
    offMotion = ctx.onMotionChange(refresh);
  const offPage = ctx.on("page-change", () => {
    lightEnd = performance.now() + 660;
  });
  const mutations = new MutationObserver(() => {
    windowsDirty = true;
  });
  const app = document.getElementById("app");
  if (app)
    mutations.observe(app, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["open", "hidden", "aria-expanded"],
    });
  size();
  refresh();
  return () => {
    stop();
    mutations.disconnect();
    offVisibility();
    offMotion();
    offPage();
    canvas.remove();
  };
}
