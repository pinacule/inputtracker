import { findFreeSpot } from "../ambient.ts";
import type { SkinContext } from "../types.ts";
import { presentationCopy } from "./copies.ts";
import { COUNTER_MS, LOCK_MS, TRACKING_MS, digitDelay, digitFrames, mergeBounds, overlaps, sliceShift } from "./mechanics.ts";

const cards = ".home-day-overview,.home-week-card,.home-rhythm-card,.home-day-entries,.ui-card,.library-work-card";
const targets = [".home-day-overview", ".home-week-card", ".home-rhythm-card", ".home-day-entries"];
const numbers = ".home-time--hero,.home-time--week,.home-time--week-side,.home-time--month,.ui-stat-value";

export function mountLive(ctx: SkinContext): () => void {
  const root = document.documentElement;
  const app = document.getElementById("app")!;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const temporary = new Map<HTMLElement, string>();
  const numberValues = new WeakMap<HTMLElement, string>();
  const numberChanges = new WeakMap<HTMLElement, number>();
  const acquired = new WeakSet<Element>();
  const signatures = new Map<string, string>();
  const recentChanges = new Map<string, number>();
  let frame = 0, idleTimer: ReturnType<typeof setTimeout> | undefined;
  let eventStart = -Infinity, lastGlitch = -Infinity, direction = 1, kind = "", allowGlitch = false;
  let action = 0, eventAction = -1;
  const copied = new Set<string>();
  const eventTypes = new Set<string>();
  let rec: HTMLElement | undefined;
  let disposed = false;
  let initialized = false;
  const active = () => !disposed && !ctx.reducedMotion && !document.hidden;
  const after = (ms: number, cb: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!disposed) cb(); }, ms);
    timers.add(timer);
    return timer;
  };
  const cancelTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); idleTimer = undefined;
  };
  const node = (className: string, parent = ctx.fx, text = "") => {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    el.setAttribute("aria-hidden", "true");
    el.inert = true;
    parent.append(el);
    return el;
  };
  const remove = (el: HTMLElement) => {
    if (el.dataset.rwReserved !== undefined) rec?.querySelector<HTMLElement>(".rw-transport")?.style.removeProperty("visibility");
    el.getAnimations({ subtree: true }).forEach((a) => a.cancel()); el.remove(); temporary.delete(el);
  };
  const expire = (el: HTMLElement, group: string, ms: number) => {
    temporary.set(el, group);
    after(ms, () => remove(el));
    return el;
  };
  const clear = (...groups: string[]) => {
    for (const [el, group] of temporary) if (!groups.length || groups.includes(group)) remove(el);
  };
  const inView = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  const box = (el: HTMLElement, r: DOMRect) => Object.assign(el.style, {
    left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
  });
  const free = (width: number, height: number) => findFreeSpot({
    viewport: { x: 0, y: 0, width: innerWidth, height: innerHeight },
    obstacles: [...ctx.obstacles(), ...[...temporary.keys()].filter((el) => el.dataset.rwFree !== undefined).map((el) => el.getBoundingClientRect())],
    size: { width, height }, margin: ctx.isPhone ? 12 : 16, prefer: "edges",
  });
  const freeNode = (className: string, width: number, height: number, text: string, ms: number) => {
    const spot = free(width, height);
    if (!spot) return;
    const el = expire(node(className), "navigation", ms);
    el.textContent = text;
    el.dataset.rwFree = "";
    Object.assign(el.style, { left: `${spot.x}px`, top: `${spot.y}px`, width: `${width}px`, height: `${height}px` });
    return el;
  };
  const startAmbient = () => {
    if (idleTimer) { clearTimeout(idleTimer); timers.delete(idleTimer); }
    ctx.ambient.stop();
    if (active()) idleTimer = after(8000 + Math.random() * 8000, () => { idleTimer = undefined; ctx.ambient.start(); });
  };

  // All six emissions use S0's bounded, obstacle-aware scheduler. Their complete swept
  // paths fit inside the allocated rectangle. Scroll/resize/mutations revalidate them.
  function registerAmbient() {
    const ambientSpecs = [
      { id: "tracking", min: 35000, max: 65000, w: 112, h: 32, ms: 2800, text: "TRACKING" },
      { id: "dropout", min: 18000, max: 32000, w: ctx.isPhone ? 76 : 164, h: 8, ms: 900, text: "" },
      { id: "seam", min: 28000, max: 50000, w: ctx.isPhone ? 64 : 132, h: 8, ms: 1600, text: "" },
      { id: "streaks", min: 40000, max: 70000, w: ctx.isPhone ? 100 : 192, h: ctx.isPhone ? 12 : 24, ms: 1100, text: "" },
      { id: "reel", min: 55000, max: 90000, w: ctx.isPhone ? 16 : 24, h: ctx.isPhone ? 12 : 24, ms: 3600, text: "" },
      { id: "phosphor", min: 22000, max: 38000, w: ctx.isPhone ? 22 : 32, h: ctx.isPhone ? 12 : 22, ms: 2200, text: "" },
    ];
    return ambientSpecs.map((effect) => ctx.ambient.add({
      id: `rw-${effect.id}`, minDelay: effect.min, maxDelay: effect.max,
      maxConcurrent: ctx.isPhone ? 1 : 2, prefer: "edges", margin: ctx.isPhone ? 12 : 16,
      size: { width: effect.w, height: effect.h },
      run(_spot, layer) {
        if (!active() || performance.now() - eventStart < LOCK_MS
          || ctx.fx.querySelectorAll(".rw-bead,[data-ambient-effect]").length > (ctx.isPhone ? 1 : 2)) { layer.remove(); return 0; }
        layer.classList.add("rw-ambient", `rw-${effect.id}`);
        layer.textContent = effect.text;
        layer.style.setProperty("--rw-travel", `${ctx.isPhone ? 40 : 90}px`);
        layer.style.setProperty("--rw-sign", Math.random() < .5 ? "-1" : "1");
        return effect.ms;
      },
    }));
  }
  let ambientPhone = ctx.isPhone;
  let offAmbient = registerAmbient();

  function roll(source: HTMLElement) {
    if (!active() || source.closest('button,a,input,[contenteditable]') || !document.fonts.check('16px "Share Tech Mono"')) return;
    const sinceEvent = performance.now() - eventStart;
    const budget = sinceEvent < LOCK_MS ? Math.min(COUNTER_MS, 320 - sinceEvent) : COUNTER_MS;
    if (budget < 80) return;
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    const digits: { rect: DOMRect; char: string; style: CSSStyleDeclaration }[] = [];
    const range = document.createRange();
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (text.parentElement?.closest(".home-time-unit")) continue;
      for (let i = 0; i < (text.textContent?.length ?? 0); i++) {
        const char = text.textContent![i]!;
        if (!/\d/.test(char)) continue;
        range.setStart(text, i); range.setEnd(text, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.width > 2 && inView(rect)) digits.push({ rect, char, style: getComputedStyle(text.parentElement!) });
      }
    }
    if (!digits.length) return;
    // The real value and ARIA remain untouched. Only individual numeric glyphs get
    // opaque windows; punctuation, units and labels are never copied or animated.
    let surface: Element | null = source;
    let background = "";
    while (surface) {
      background = getComputedStyle(surface).backgroundColor;
      if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") break;
      surface = surface.parentElement;
    }
    for (const [index, { rect, char, style }] of digits.entries()) {
      const window = expire(node("rw-digit"), "counter", budget);
      box(window, rect);
      Object.assign(window.style, { background: background || "var(--bg-surface)", color: style.color,
        fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
        fontVariantNumeric: style.fontVariantNumeric, letterSpacing: style.letterSpacing });
      const strip = node("rw-digit-strip", window);
      for (const value of digitFrames(Number(char))) {
        const glyph = node("rw-digit-glyph", strip, String(value));
        Object.assign(glyph.style, { height: `${rect.height}px`, lineHeight: `${rect.height}px` });
      }
      const delay = Math.min(digitDelay(index, digits.length), budget - 80);
      strip.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-3 * rect.height}px)` }], {
        duration: Math.min(220, budget - delay - 1), delay, easing: "cubic-bezier(.16,1,.3,1)", fill: "both",
      });
    }
  }

  function acquire(card: HTMLElement, channel = false) {
    const rect = card.getBoundingClientRect();
    if (!active() || !inView(rect)) return;
    const el = expire(node(channel ? "rw-acquire rw-channel" : "rw-acquire"), "entrance", channel ? 260 : 300);
    if (Number.parseFloat(getComputedStyle(card).paddingTop) < 12) el.classList.add("rw-no-noise");
    box(el, rect);
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      const el = entry.target as HTMLElement;
      observer.unobserve(el);
      if (el.matches(numbers)) {
        const value = el.textContent ?? "";
        if (numberValues.get(el) !== value) { numberValues.set(el, value); numberChanges.set(el, performance.now()); roll(el); }
      } else if (!acquired.has(el)) { acquired.add(el); acquire(el); }
    }
  });

  function glitch(selector: string) {
    // Leave one paint's margin under the hard deadline, including post-render events.
    const remaining = TRACKING_MS - 20 - (performance.now() - eventStart);
    if (!allowGlitch || copied.has(selector) || !active() || remaining < 40) return;
    const card = app.querySelector<HTMLElement>(selector);
    if (!card || card.contains(document.activeElement) && !document.activeElement?.matches("button")) return;
    if (getSelection()?.toString() || document.querySelector('[role="dialog"],.ui-context-menu,.home-map-tip,[role="tooltip"]')) return;
    if ([...card.querySelectorAll("img,.ui-cover,.home-work-thumb")].some((el) => inView(el.getBoundingClientRect()))) return;
    const rect = card.getBoundingClientRect();
    if (!inView(rect)) return;
    const holeSelector = 'button:not(.home-week-day),a:not(.home-map-cell),input,select,textarea,[contenteditable],.home-time,.ui-stat-value,.home-rhythm-readout';
    const holes = mergeBounds([...card.querySelectorAll(holeSelector)].map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0).map((r) => ({
        left: Math.max(0, r.left - rect.left - 6), top: Math.max(0, r.top - rect.top - 6),
        right: Math.min(rect.width, r.right - rect.left + 6), bottom: Math.min(rect.height, r.bottom - rect.top + 6),
      })));
    const path = [`M0 0H${rect.width}V${rect.height}H0Z`, ...holes.map((r) => `M${r.left} ${r.top}H${r.right}V${r.bottom}H${r.left}Z`)].join(" ");
    const clip = `path(evenodd, "${path}")`;
    if (!CSS.supports("clip-path", clip)) return;
    copied.add(selector);
    const holder = expire(node("rw-tracking-copy"), "slice", remaining);
    box(holder, rect);
    holder.style.clipPath = clip;
    const copy = presentationCopy(card);
    Object.assign(copy.style, { position: "absolute", left: "0", top: "0", margin: "0", width: `${rect.width}px`, height: `${rect.height}px` });
    const count = ctx.isPhone ? 2 : 3;
    for (let i = 0; i < count; i++) {
      const slice = node("rw-slice", holder);
      slice.style.animationDuration = `${Math.min(220, remaining)}ms`;
      slice.style.setProperty("--rw-offset", `${sliceShift(kind, ctx.isPhone, i) * direction}px`);
      slice.style.clipPath = `inset(${22 + i * 23}% 0 ${Math.max(0, 62 - i * 23)}% 0)`;
      slice.append(copy.cloneNode(true));
    }
  }

  function scan() {
    frame = 0;
    if (disposed) return;
    const header = app.querySelector<HTMLElement>(".home-topbar");
    if (header && !header.contains(rec ?? null)) {
      rec?.remove();
      rec = node("rw-deck-osd", header);
      rec.innerHTML = '<span class="rw-rec">REC <i></i></span><span class="rw-transport">PLAY ▶ · SP</span><span>0:00:00</span>';
    } else if (!header) { rec?.remove(); rec = undefined; }
    for (const selector of targets) {
      const card = app.querySelector<HTMLElement>(selector);
      if (!card) continue;
      const signature = card.innerHTML;
      const previous = signatures.get(selector);
      signatures.set(selector, signature);
      if (previous !== undefined && signature !== previous) {
        recentChanges.set(selector, performance.now());
        if (performance.now() - eventStart < LOCK_MS) glitch(selector);
      }
    }
    for (const el of app.querySelectorAll<HTMLElement>(cards)) if (!acquired.has(el)) observer.observe(el);
    for (const el of app.querySelectorAll<HTMLElement>(numbers)) {
      const value = el.textContent ?? "";
      if (numberValues.get(el) !== value && inView(el.getBoundingClientRect())) {
        numberValues.set(el, value);
        numberChanges.set(el, performance.now());
        clear("counter");
        // Roll all changes together below; no stale strip can survive a data update.
        pendingNumbers.add(el);
      } else if (!numberValues.has(el)) observer.observe(el);
    }
    for (const el of pendingNumbers) roll(el);
    pendingNumbers.clear();
    revalidate();
  }
  const pendingNumbers = new Set<HTMLElement>();
  const scheduleScan = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(scan); };
  const mutation = new MutationObserver(scheduleScan);
  mutation.observe(app, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "aria-pressed"] });

  function navigate(type: string, sign: number) {
    // A week click can emit week, month and day notifications for one render.
    // Coalesce those notifications, while a second click of the same type replaces.
    if (active() && eventAction === action && sign === direction && performance.now() - eventStart < 400 && !eventTypes.has(type)) {
      eventTypes.add(type); scheduleScan(); return;
    }
    clear(); cancelTimers();
    ctx.ambient.stop();
    eventStart = performance.now(); direction = sign; kind = type; copied.clear();
    eventAction = action;
    // Post-render day notifications must retarget strips that the mutation observer
    // already began for this exact update, rather than leaving the new value static.
    for (const el of app.querySelectorAll<HTMLElement>(numbers)) {
      if (eventStart - (numberChanges.get(el) ?? -Infinity) < 100) numberValues.delete(el);
    }
    eventTypes.clear(); eventTypes.add(type);
    allowGlitch = eventStart - lastGlitch >= 900;
    if (!active()) return;
    if (allowGlitch) lastGlitch = eventStart;
    let plaque: HTMLElement | undefined;
    const transport = rec?.querySelector<HTMLElement>(".rw-transport");
    const header = app.querySelector<HTMLElement>(".home-topbar");
    // This permanently reserved decorative slot replaces only the decorative PLAY
    // stamp. Ignore its enclosing header rectangle, but still protect real controls.
    if (transport && header && inView(transport.getBoundingClientRect())) {
      transport.style.visibility = "hidden";
      const r = transport.getBoundingClientRect(), h = header.getBoundingClientRect();
      if (!ctx.obstacles().some((o) => !(o.left === h.left && o.top === h.top && o.width === h.width && o.height === h.height) && overlaps(r, o))) {
        plaque = expire(node("rw-plaque", ctx.fx, "TRACKING"), "navigation", LOCK_MS);
        box(plaque, r); plaque.dataset.rwReserved = "";
      } else transport.style.removeProperty("visibility");
    }
    plaque ??= freeNode("rw-plaque", 112, 32, "TRACKING", LOCK_MS);
    if (plaque) { const mark = plaque; after(400, () => { if (mark.isConnected) mark.textContent = "PLAY ▶"; }); }
    const bandCount = ctx.isPhone || type === "day-change" ? 2 : 3;
    for (let i = 0; i < bandCount; i++) {
      const band = expire(node("rw-wall-band", ctx.bg), "navigation", 400);
      const y = Math.round(innerHeight * (.2 + i * .26));
      Object.assign(band.style, { top: `${y}px`, height: `${ctx.isPhone ? 26 : 44}px` });
      band.style.setProperty("--rw-slip", `${sign * (ctx.isPhone ? 4 : type === "week-change" ? 16 : type === "month-change" ? 12 : 8)}px`);
      const photo = node("rw-wall-picture", band);
      Object.assign(photo.style, { top: `${-y}px`, width: `${innerWidth}px`, height: `${innerHeight}px` });
    }
    const streak = freeNode("rw-nav-streak rw-streaks", ctx.isPhone ? 100 : 192, 24, sign < 0 ? "◀◀" : "▶▶", 400);
    streak?.style.setProperty("--rw-sign", String(sign));
    streak?.style.setProperty("--rw-travel", `${ctx.isPhone ? 40 : 90}px`);
    after(240, () => { if (active()) freeNode("rw-nav-seam rw-seam", ctx.isPhone ? 64 : 132, 8, "", 160); });
    after(LOCK_MS, () => { clear("navigation", "slice"); startAmbient(); });
    // Week events precede the Preact update; day/month events can follow it.
    for (const selector of targets) if (eventStart - (recentChanges.get(selector) ?? -Infinity) < 100) glitch(selector);
    scheduleScan();
  }

  const offEvents = [
    ctx.on("day-change", (e) => navigate("day-change", e.direction)),
    ctx.on("week-change", (e) => navigate("week-change", e.direction)),
    ctx.on("month-change", (e) => navigate("month-change", e.direction)),
    ctx.on("page-change", () => {
      clear(); cancelTimers(); eventStart = -Infinity; signatures.clear(); recentChanges.clear(); startAmbient();
      if (active()) after(0, () => { const header = app.querySelector<HTMLElement>(".page-header,.home-topbar"); if (header) acquire(header, true); scheduleScan(); });
    }),
  ];
  function revalidate() {
    const obstacles = ctx.obstacles();
    let collision = false;
    for (const el of ctx.fx.querySelectorAll<HTMLElement>("[data-ambient-effect],[data-rw-free],.rw-bead")) {
      if (obstacles.some((r) => overlaps(el.getBoundingClientRect(), r, ctx.isPhone ? 12 : 16))) {
        if (el.dataset.ambientEffect) collision = true;
        else remove(el);
      }
    }
    if (collision) startAmbient();
  }
  const cancelInteraction = () => { clear("slice", "counter", "bead"); };
  // Distinguish two rapid clicks from multiple date notifications for one click.
  document.addEventListener("click", () => { action++; }, { signal: ctx.signal, capture: true });
  for (const event of ["pointerdown", "focusin", "keydown", "selectionchange", "dragstart"])
    document.addEventListener(event, cancelInteraction, { signal: ctx.signal, capture: true });
  const geometryChange = () => {
    clear(); cancelTimers(); eventStart = -Infinity; allowGlitch = false;
    if (ambientPhone !== ctx.isPhone) {
      offAmbient.forEach((off) => off());
      ambientPhone = ctx.isPhone; offAmbient = registerAmbient();
    }
    startAmbient(); scheduleScan();
  };
  window.addEventListener("scroll", geometryChange, { signal: ctx.signal, capture: true, passive: true });
  window.addEventListener("resize", geometryChange, { signal: ctx.signal, passive: true });

  let lastBead = 0, previousPointer: { x: number; y: number } | undefined;
  document.addEventListener("pointermove", (event) => {
    const previous = previousPointer;
    previousPointer = { x: event.clientX, y: event.clientY };
    if (!active() || !ctx.finePointer || !matchMedia("(hover: hover)").matches || ctx.isPhone || event.buttons
      || performance.now() - eventStart < LOCK_MS || performance.now() - lastBead < 80 || !previous
      || Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 18
      || getSelection()?.toString() || document.querySelector('[role="dialog"],.ui-context-menu')
      || ctx.fx.querySelectorAll(".rw-bead,[data-ambient-effect]").length >= 2) return;
    const rect = { left: previous.x - 1, top: previous.y - 1, right: previous.x + 1, bottom: previous.y + 1 };
    if (rect.left < 2 || rect.right > innerWidth - 2 || rect.top < 2 || rect.bottom > innerHeight - 2
      || ctx.obstacles().some((r) => overlaps(rect, r, 18))) return;
    lastBead = performance.now();
    const bead = expire(node("rw-bead"), "bead", 180);
    Object.assign(bead.style, { left: `${rect.left}px`, top: `${rect.top}px` });
  }, { signal: ctx.signal, passive: true });

  const sync = () => {
    root.toggleAttribute("data-rewind-paused", document.hidden || ctx.reducedMotion);
    clear();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    cancelTimers();
    eventStart = -Infinity;
    if (initialized) {
      // Returning to a tab/preference starts fresh ambient delays, never a backlog
      // of number rolls or card entrances for changes made while motion was off.
      for (const el of app.querySelectorAll<HTMLElement>(numbers)) numberValues.set(el, el.textContent ?? "");
      for (const el of app.querySelectorAll<HTMLElement>(cards)) if (inView(el.getBoundingClientRect())) acquired.add(el);
    }
    initialized = true;
    startAmbient();
    if (!document.hidden) scheduleScan();
  };
  const offVisibility = ctx.onVisibility(sync);
  const offMotion = ctx.onMotionChange(sync);
  sync();
  void document.fonts.load('16px "Share Tech Mono"').then(() => {
    if (disposed || !active()) return;
    for (const el of app.querySelectorAll<HTMLElement>(numbers)) numberValues.delete(el);
    scheduleScan();
  }).catch(() => { /* Missing font: the exact real value is already visible. */ });
  return () => {
    disposed = true;
    mutation.disconnect(); observer.disconnect();
    cancelAnimationFrame(frame);
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); clear();
    ctx.ambient.stop(); offAmbient.forEach((off) => off()); offEvents.forEach((off) => off());
    offVisibility(); offMotion(); rec?.remove();
    root.removeAttribute("data-rewind-paused");
  };
}
