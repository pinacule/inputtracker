import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { ALL_THEME_REGISTRY, contrastRatio, relativeLuminance } from "../web/src/lib/theme.ts";
import { parseAppRoute, type AppRoute } from "../web/src/lib/router.ts";
import { headingWindow, sceneForRoute, type ThinkerScene } from "../web/src/skins/thinker/scene.ts";
import type { SkinEvents } from "../web/src/skins/events.ts";

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

  test("lookup input yields space to its readable Search button", () => {
    expect(css).toContain('.add-lookup-form .add-lookup-input-wrap > .ui-input { flex: 1; min-width: 0; }');
    expect(css).toContain('.add-lookup-form .add-lookup-input-wrap > .ui-btn { flex-shrink: 0; white-space: nowrap; }');
  });

  test("six media-selected, credited WebPs and local upright font subsets fit tighter budgets", () => {
    const directory = "web/public/wallpapers/thinker/";
    const names = readdirSync(new URL(directory, root));
    expect(names.filter((name) => name.endsWith(".webp")).length).toBe(6);
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
    try {
      replace("window", { location: { hash: "#/library?work=synthetic-work" }, ...listenerHost });
      replace("document", {
        documentElement: { dataset: attrs, removeAttribute: () => { delete attrs.thinkerScene; } },
        getElementById: () => ({}), querySelectorAll: () => [], fonts: listenerHost, hidden: false,
      });
      replace("ResizeObserver", class { observe() {} unobserve() {} disconnect() { disconnected++; } });
      replace("MutationObserver", class { observe() {} disconnect() { disconnected++; } });
      replace("requestAnimationFrame", () => 7);
      replace("cancelAnimationFrame", (id: number) => { cancelled = id; });
      const ctx = {
        signal: new AbortController().signal, isPhone: false,
        on: (_type: string, fn: typeof pageListener) => { pageListener = fn; return () => { pageListener = undefined; }; },
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
      expect(disconnected).toBe(2);
      expect(listeners.size).toBe(0);
    } finally {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
