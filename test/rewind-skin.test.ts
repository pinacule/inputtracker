import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
// Keep the browser-only DOM types out of the server tsconfig's ES-only lib.
const browserModuleUrl = new URL("../web/src/skins/rewind/index.ts", import.meta.url).href;
const { default: effects } = await import(browserModuleUrl) as {
  default: { mount(ctx: { bg: { classList: unknown }; fx: { classList: unknown } }): () => void };
};
import { contrastRatio } from "../web/src/lib/theme.ts";

const css = readFileSync(new URL("../web/src/styles/themes/rewind.css", import.meta.url), "utf8");
const properties = (block: string) => Object.fromEntries(
  [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
);
const base = properties(css.split("\n}")[0]!);
function composite(hex: string, channel: number, alpha: number) {
  return "#" + [1, 3, 5].map((i) => Math.round(
    Number.parseInt(hex.slice(i, i + 2), 16) * (1 - alpha) + channel * alpha,
  ).toString(16).padStart(2, "0")).join("");
}

describe("Rewind VCR foundation", () => {
  test("ships one VCR palette and one responsive wallpaper pair", () => {
    expect(base["--bg-canvas"]).toBe("#07164c");
    expect(base["--accent-primary"]).toBe("#ffdf6d");
    expect(css).not.toContain("data-rewind-look");
    const wallpaperDir = new URL("../web/public/wallpapers/rewind/", import.meta.url);
    expect(readdirSync(wallpaperDir).filter((name) => name.endsWith(".webp")).sort()).toEqual([
      "vcr-desktop.webp", "vcr-phone.webp",
    ]);
    expect(readdirSync(new URL("../web/public/fonts/rewind/", import.meta.url)).some((name) => name.startsWith("caveat"))).toBe(false);
  });

  test("mount ignores storage and cleans up layers, Save-Data state and preloads", () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const dataset: Record<string, string> = {};
    const links = new Set<object>();
    const classes = new Set<string>();
    const classList = { add: (s: string) => classes.add(s), remove: (s: string) => classes.delete(s) };
    try {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw Error("storage must not be read"); } });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { connection: { saveData: true } } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        documentElement: { dataset },
        head: { append: (link: object) => links.add(link) },
        createElement: () => { const link = { remove: () => links.delete(link) }; return link; },
      } });
      const cleanup = effects.mount({ bg: { classList }, fx: { classList } });
      expect(dataset.rewindSaveData).toBe("");
      expect(Object.keys(dataset)).toEqual(["rewindSaveData"]);
      expect(classes.size).toBe(2);
      expect(links.size).toBe(2);
      cleanup();
      expect(Object.keys(dataset)).toEqual([]);
      expect(classes.size).toBe(0);
      expect(links.size).toBe(0);
    } finally {
      for (const [key, descriptor] of [["document", originalDocument], ["localStorage", originalStorage], ["navigator", originalNavigator]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  test("VCR text and controls preserve AA under worst-case screen ink and future band caps", () => {
    {
      const p = base;
      const blackAlpha = Number(p["--rw-scan-alpha"]);
      expect(blackAlpha).toBeLessThanOrEqual(.07);
      const surfaces = ["canvas", "surface", "surface-raised", "subtle"].map((s) => p[`--bg-${s}`]!);
      const inks = ["--text-primary", "--text-secondary", "--text-muted", "--accent-primary", "--card-title-color",
        ...Object.keys(p).filter((s) => /^--cat-.*-fg$/.test(s))];
      for (const key of inks) {
        const backgrounds = [...surfaces];
        if (key.startsWith("--cat-")) backgrounds.push(p[key.replace(/fg$/, "bg")]!);
        for (const bg of backgrounds) {
          // Conservative: darken light ink while brightening its background.
          expect(contrastRatio(composite(p[key]!, 0, blackAlpha), composite(bg, 255, .04)), `${key} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrastRatio(composite(p["--text-on-accent"]!, 255, .04), composite(p["--accent-primary"]!, 0, blackAlpha))).toBeGreaterThanOrEqual(4.5);
      for (const bg of surfaces) {
        expect(contrastRatio(composite(p["--border-strong"]!, 0, blackAlpha), composite(bg, 255, .04))).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
