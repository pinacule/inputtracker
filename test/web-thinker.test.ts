import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { ALL_THEME_REGISTRY, contrastRatio, relativeLuminance } from "../web/src/lib/theme.ts";
import { parseAppRoute, type AppRoute } from "../web/src/lib/router.ts";
import { headingBackdrop, headingWindow, sceneForRoute, type ThinkerScene } from "../web/src/skins/thinker/scene.ts";
import type { SkinEvents } from "../web/src/skins/events.ts";
import { LIT_SURFACES, litSurface, sampleFlame } from "../web/src/skins/thinker/flame.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const css = read("web/src/styles/themes/thinker.css");
const tokens = Object.fromEntries([...css.split("\n}")[0]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)]
  .map((m) => [m[1]!, m[2]!.trim()]));
const color = (name: string): string => tokens[name]!;
// Keep Bun's server tsconfig free of DOM globals; web/tsconfig.json separately
// type-checks this browser module. Exercise its real mount with synthetic mocks.
const effects: { mount(ctx: unknown): () => void } =
  (await import(new URL("../web/src/skins/thinker/index.ts", import.meta.url).href)).default;

describe("Thinker static foundation", () => {
  test("exact brief palette: baseline and cumulative maximum-lit text are AA", () => {
    const surfaces = ["--bg-canvas", "--bg-surface", "--bg-surface-raised", "--bg-subtle", "--bg-muted"];
    const text = ["--text-primary", "--text-secondary", "--text-muted", "--accent-primary", "--accent-secondary",
      ...Object.keys(ALL_THEME_REGISTRY.thinker.categories).map((id) => `--cat-${id}-fg`),
      ...["success", "warning", "danger", "info"].map((id) => `--status-${id}-fg`)];
    for (const bg of surfaces) {
      for (const fg of text) {
        expect(contrastRatio(color(fg), color(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        const maximumLitRatio = (relativeLuminance(color(fg)) + 0.05) / (relativeLuminance(color(bg)) + 0.020 + 0.05);
        expect(maximumLitRatio, `${fg} on maximally lit ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(color("--border-strong"), color(bg))).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color("--focus-ring"), color(bg))).toBeGreaterThanOrEqual(3);
    }
    for (const [bg, lit] of [["--bg-surface", "--th-surface-lit"], ["--bg-surface-raised", "--th-raised-lit"],
      ["--bg-subtle", "--th-subtle-lit"], ["--bg-muted", "--th-muted-lit"]]) {
      const delta = relativeLuminance(color(lit!)) - relativeLuminance(color(bg!));
      expect(delta).toBeGreaterThan(0);
      expect(delta, `${lit} luminance increase over ${bg}`).toBeLessThanOrEqual(0.010);
      for (const fg of text) expect(contrastRatio(color(fg), color(lit!))).toBeGreaterThanOrEqual(4.5);
    }
    for (const category of Object.values(ALL_THEME_REGISTRY.thinker.categories)) {
      for (const fg of [category.fg, color("--text-primary"), color("--text-secondary"), color("--text-muted")]) {
        expect(contrastRatio(fg, category.bg)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(color("--text-on-accent"), category.solid)).toBeGreaterThanOrEqual(4.5);
    }
    for (const id of ["success", "warning", "danger", "info"]) {
      expect(contrastRatio(color(`--status-${id}-fg`), color(`--status-${id}-bg`))).toBeGreaterThanOrEqual(4.5);
    }
    for (const fill of ["--accent-primary", "--accent-primary-hover"]) {
      expect(contrastRatio(color("--text-on-accent"), color(fill))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("routes are fixed families, including work and legacy deep links", () => {
    const routes: Record<AppRoute, ThinkerScene> = {
      calendar: "thinker", library: "hugo", review: "hugo", insights: "plato", settings: "plato", search: "plato", add: "plato",
    };
    for (const [route, scene] of Object.entries(routes)) expect(sceneForRoute(route as AppRoute)).toBe(scene);
    for (const hash of ["#/library?work=synthetic-work", "#/library?cat=book", "#/year?year=2026"]) {
      expect(sceneForRoute(parseAppRoute(hash).route)).toBe("hugo");
    }
    expect(sceneForRoute(parseAppRoute("#/stats").route)).toBe("plato");
    expect(css).toContain('data-thinker-scene="hugo"');
    expect(css).toContain('data-thinker-scene="plato"');
    const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(phone).not.toContain("-desktop.webp");
    for (const scene of ["thinker", "hugo", "plato"]) expect(phone).toContain(`${scene}-phone.webp`);
  });

  test("heading windows shrink or disappear instead of intersecting real ink / controls", () => {
    const bounds = { left: 300, top: 40, width: 700, height: 172 };
    const title = { left: 320, top: 64, width: 200, height: 100 };
    expect(headingWindow(bounds, [title], false)).toEqual({ left: 764, top: 56, width: 220, height: 140 });
    expect(headingWindow(bounds, [bounds], false)).toBeNull();
    const phone = { left: 16, top: 80, width: 358, height: 144 };
    const phoneTitle = { left: 32, top: 102, width: 200, height: 62 };
    const spot = headingWindow(phone, [phoneTitle], true)!;
    expect(spot.width).toBe(80);
    expect(spot.left).toBeGreaterThanOrEqual(phoneTitle.left + phoneTitle.width + 12);
    expect(spot.top + spot.height).toBeLessThanOrEqual(phone.top + phone.height - 16);
    expect(headingWindow({ ...phone, height: 45 }, [], true)).toBeNull();
  });

  test("decorative header backdrops fit the existing card without adding height", () => {
    for (const phone of [true, false]) for (const height of [64, 96, 144, 240]) {
      const bounds = { left: 16, top: 80, width: phone ? 358 : 900, height };
      const spot = headingBackdrop(bounds, phone)!;
      expect(spot.left + spot.width).toBe(bounds.left + bounds.width);
      expect(spot.top).toBeGreaterThanOrEqual(bounds.top);
      expect(spot.top + spot.height).toBeLessThanOrEqual(bounds.top + height);
      expect(spot.height).toBeLessThanOrEqual(phone ? 200 : 204);
    }
    expect(headingBackdrop({ left: 0, top: 0, width: 100, height: 24 }, true)).toBeNull();
    expect(css).not.toMatch(/min-height:\s*(256|300)px|padding-bottom:\s*196px/);
    expect(css).toContain('position: relative; isolation: isolate; min-height: 0');
    expect(css).toContain('position: absolute; z-index: -1');
    expect(css).toContain('.th-ink-scrim');
    expect(css).toContain('pointer-events: none; background: var(--bg-surface)');
    // Photo filters must not also brighten the AA-safe scrims.
    expect(css.slice(css.indexOf('.th-scene-window {'), css.indexOf('.th-window-photo {'))).not.toContain('filter:');
    const implementation = read('web/src/skins/thinker/index.ts');
    expect(implementation).toContain('const backdrop = !header.matches(".work-hero-card")');
    expect(implementation).toContain('const protectedRects = protectedHeaderRects(header)');
    expect(implementation).toContain('for (const scrim of crop.querySelectorAll(".th-ink-scrim")) scrim.remove()');
  });

  test("desktop page-header busts are fully visible without overlapping text or controls", () => {
    expect(css).toContain('@media (min-width: 1024px)');
    expect(css).toContain(':root[data-theme="thinker"] :is(.page-header, .work-hero-card) .th-window-photo');
    expect(css).toContain('background-position: right 48px center');
    expect(css).toContain(':root[data-theme="thinker"] .page-header-titles');
    expect(css).toContain('max-width: calc(100% - 240px)');
    expect(css).toContain(':root[data-theme="thinker"] .page-header-actions');
    expect(css).toContain(':root[data-theme="thinker"] .work-hero-card .work-hero-body');
    // Ensure title and subtitle retain high contrast over the dark reading surface
    expect(contrastRatio("#f4eee4", "#171411")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#d5c8b7", "#171411")).toBeGreaterThanOrEqual(4.5);
  });

  test("rebuilt sculptures use intact original contours and restrained firelight", () => {
    const credits = read('web/public/wallpapers/thinker/CREDITS.md');
    expect(credits).toContain('full-resolution original');
    expect(credits).toContain('3925 × 5887');
    expect(credits).toContain('`plato-detail.webp` is unchanged');
    expect(read('web/public/wallpapers/thinker/thinker-contour.svg')).toContain('C160 25 181 20 198 24');
    expect(css).toContain(':not([data-thinker-scene="plato"]) :is(.th-statue-light, .th-window-light)');
    expect(css).toContain('filter: brightness(1.18)');
  });

  test("lookup input yields space to its readable Search button", () => {
    expect(css).toContain('.add-lookup-form .add-lookup-input-wrap > .ui-input { flex: 1; min-width: 0; }');
    expect(css).toContain('.add-lookup-form .add-lookup-input-wrap > .ui-btn { flex-shrink: 0; white-space: nowrap; }');
  });

  test("responsive scenes, shared isolated details and upright fonts fit tighter budgets", () => {
    const directory = "web/public/wallpapers/thinker/";
    const names = readdirSync(new URL(directory, root));
    expect(names.filter((name) => name.endsWith(".webp")).length).toBe(13);
    for (const name of names.filter((name) => name.endsWith(".webp"))) {
      const bytes = statSync(new URL(directory + name, root)).size;
      expect(bytes).toBeLessThanOrEqual(name.includes("phone") ? 150_000 : 280_000);
      expect(read(directory + "CREDITS.md")).toContain(name);
    }
    expect(names.reduce((n, name) => n + statSync(new URL(directory + name, root)).size, 0)).toBeLessThanOrEqual(1_500_000);
    const fonts = readdirSync(new URL("web/public/fonts/thinker/", root));
    expect(fonts.filter((name) => name.endsWith(".woff2")).length).toBe(8);
    expect(fonts.reduce((n, name) => n + statSync(new URL("web/public/fonts/thinker/" + name, root)).size, 0)).toBeLessThanOrEqual(420_000);
    const faces = read("web/src/styles/fonts/thinker.css");
    expect(faces.match(/font-display: swap/g)?.length).toBe(8);
    expect(faces).not.toMatch(/https?:\/\/|font-style:\s*italic/);
    for (const name of fonts.filter((name) => name.endsWith(".woff2"))) {
      expect(faces).toContain(name);
      expect(readFileSync(new URL("web/public/fonts/thinker/" + name, root)).subarray(0, 4).toString()).toBe("wOF2");
    }
  });

  test("mount reads the initial route, subscribes once, and cleans up all owned resources", () => {
    const original = new Map<string, PropertyDescriptor | undefined>();
    const replace = (key: string, value: unknown) => {
      original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    };
    const attrs: Record<string, string> = {};
    const listeners = new Map<string, unknown>();
    let pageListener: ((event: SkinEvents["page-change"]) => void) | undefined;
    let visibilityListener: ((visible: boolean) => void) | undefined;
    let cancelled = 0;
    let disconnected = 0;
    const listenerHost = {
      addEventListener: (key: string, fn: unknown) => { listeners.set(key, fn); },
      removeEventListener: (key: string) => { listeners.delete(key); },
    };
    const style = { setProperty() {}, removeProperty() {} };
    const fakeNode = () => ({ style, append() {}, remove() {} });
    try {
      replace("window", { location: { hash: "#/library?work=synthetic-work" }, ...listenerHost });
      replace("document", {
        documentElement: { dataset: attrs, style, removeAttribute: (name: string) => {
          delete attrs[name.replace(/^data-/, "").replace(/-([a-z])/g, (_m: string, char: string) => char.toUpperCase())];
        } },
        createElement: fakeNode,
        getElementById: () => ({}), querySelectorAll: () => [], fonts: listenerHost, hidden: false,
      });
      replace("ResizeObserver", class { observe() {} unobserve() {} disconnect() { disconnected++; } });
      replace("MutationObserver", class { observe() {} disconnect() { disconnected++; } });
      replace("IntersectionObserver", class { observe() {} unobserve() {} disconnect() { disconnected++; } });
      replace("requestAnimationFrame", () => 7);
      replace("cancelAnimationFrame", (id: number) => { cancelled = id; });
      const ctx = {
        signal: new AbortController().signal, isPhone: false, reducedMotion: false, finePointer: false,
        bg: fakeNode(), ambient: { add: () => () => {}, start() {}, stop() {} },
        on: (type: string, fn: typeof pageListener) => {
          if (type === "page-change") pageListener = fn;
          return () => { if (type === "page-change") pageListener = undefined; };
        },
        onMotionChange: () => () => {},
        onVisibility: (fn: typeof visibilityListener) => { visibilityListener = fn; return () => { visibilityListener = undefined; }; },
      };
      const cleanup = effects.mount(ctx);
      expect(attrs.thinkerScene).toBe("hugo");
      pageListener!({ from: "library", to: "insights" });
      expect(attrs.thinkerScene).toBe("plato");
      visibilityListener!(false);
      expect(cancelled).toBe(7);
      cleanup();
      expect(attrs.thinkerScene).toBeUndefined();
      expect(pageListener).toBeUndefined();
      expect(visibilityListener).toBeUndefined();
      expect(disconnected).toBe(3);
      expect(listeners.size).toBe(0);
    } finally {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});

describe("Thinker live flame", () => {
  test("three noise bands stay continuous, bounded and reproducible without a clock", () => {
    let low = 1, high = 0;
    for (let t = 0; t < 90_000; t += 20) {
      const flame = sampleFlame(t);
      low = Math.min(low, flame.intensity); high = Math.max(high, flame.intensity);
      expect(flame).toEqual(sampleFlame(t));
      expect(flame.intensity).toBeGreaterThanOrEqual(.24);
      expect(flame.intensity).toBeLessThanOrEqual(.86);
      expect(Math.abs(flame.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(flame.y)).toBeLessThanOrEqual(1);
      expect(flame.stretch).toBeGreaterThanOrEqual(1);
      expect(flame.stretch).toBeLessThanOrEqual(1.25);
      expect(Math.abs(flame.intensity - sampleFlame(t + 20).intensity)).toBeLessThan(.025);
    }
    expect(high - low).toBeGreaterThan(.3);
    expect(sampleFlame(1000, 41)).not.toEqual(sampleFlame(1000, 42));
  });
  test("all breathing / overlapping torch colours share an AA-safe, non-additive endpoint", () => {
    for (const [base, lit] of LIT_SURFACES) for (let i = 0; i <= 100; i++) {
      const rgb = litSurface(base, lit, i / 100).match(/\d+/g)!.map(Number);
      const hex = "#" + rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("");
      expect(relativeLuminance(hex) - relativeLuminance(base)).toBeLessThanOrEqual(.010);
      expect(contrastRatio("#b6a895", hex)).toBeGreaterThanOrEqual(4.5);
    }
    expect(litSurface("#171411", "#292018", -5)).toBe("rgb(23 20 17)");
    expect(litSurface("#171411", "#292018", 5)).toBe("rgb(41 32 24)");
  });
  test("local native cursors have targeting hotspots and tiny redistribution-free payloads", () => {
    let bytes = 0;
    for (const file of ["default", "pointer", "text"]) {
      const cursor = read(`web/public/cursors/thinker/${file}.svg`);
      bytes += Buffer.byteLength(cursor);
      expect(cursor).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(cursor).not.toMatch(/https?:\/\/(?!www.w3.org)|<script/);
      expect(css).toContain(`/cursors/thinker/${file}.svg`);
    }
    expect(bytes).toBeLessThan(8000);
    expect(css).toContain('4 3, pointer');
    expect(css).toContain('12 14, text');
    expect(css).not.toContain('cursor: none');
  });
});
