import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
// Keep the browser-only DOM types out of the server tsconfig's ES-only lib.
const browserModuleUrl = new URL("../web/src/skins/rewind/index.ts", import.meta.url).href;
const { foundation: effects } = await import(browserModuleUrl) as {
  foundation: { mount(ctx: { bg: { classList: unknown }; fx: { classList: unknown } }): () => void };
};
import { THEMES, THEME_REGISTRY, contrastRatio } from "../web/src/lib/theme.ts";

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
  test("is an active choice with the live palette and a static CRT preview", () => {
    expect(THEMES.find((theme) => theme.id === "rewind")).toBe(THEME_REGISTRY.rewind);
    expect(THEME_REGISTRY.rewind?.label).toBe("Rewind");
    // All swatches, categories and AA pairs are also checked by web-themes.test.ts.
    const preview = css.slice(css.indexOf("/* A static, self-contained CRT miniature"), css.indexOf("/* Blue television wall"));
    expect(preview).toContain('.theme-preview[data-theme="rewind"] .theme-preview-window');
    for (const mark of ["PLAY ▶", "REC ●", "0:02:48", "repeating-linear-gradient", "--accent-primary", "--font-numbers"]) {
      expect(preview).toContain(mark);
    }
    for (const state of [".theme-tile:hover", ":checked", ":focus-visible"]) expect(preview).toContain(state);
    expect(preview).not.toMatch(/animation\s*:|transition\s*:|url\(/);
  });

  test("responsive images meet viewport budgets and every font has credits", () => {
    const dir = new URL("../web/public/wallpapers/rewind/", import.meta.url);
    const credits = readFileSync(new URL("CREDITS.md", dir), "utf8");
    for (const [file, budget, width, height] of [
      ["vcr-desktop.webp", 350 * 1024, 2400, 1350],
      ["vcr-phone.webp", 200 * 1024, 1080, 1800],
    ] as const) {
      const data = readFileSync(new URL(file, dir));
      expect(data.byteLength).toBeLessThanOrEqual(budget);
      // The shipped lossy WebP's VP8 frame header records its real dimensions.
      expect(data.toString("ascii", 12, 16)).toBe("VP8 ");
      expect(data.readUInt16LE(26) & 0x3fff).toBe(width);
      expect(data.readUInt16LE(28) & 0x3fff).toBe(height);
      expect(credits).toContain(file);
      expect(credits).toContain(data.byteLength.toLocaleString("en-US"));
    }
    expect(credits).toContain("Liana S");
    expect(credits).toContain("https://unsplash.com/license");
    const fonts = new URL("../web/public/fonts/rewind/", import.meta.url);
    const licence = readFileSync(new URL("LICENSE.md", fonts), "utf8");
    const names = readdirSync(fonts).filter((file) => file.endsWith(".woff2"));
    expect(names).toHaveLength(5);
    expect(names.reduce((sum, file) => sum + statSync(new URL(file, fonts)).size, 0)).toBeLessThanOrEqual(300 * 1024);
    for (const file of names) {
      expect(licence).toContain(file);
      expect(licence).toContain(statSync(new URL(file, fonts)).size.toLocaleString("en-US"));
    }
    for (const family of ["ibmplexsans", "vt323", "sharetechmono"]) expect(licence).toContain(`https://github.com/google/fonts/tree/main/ofl/${family}`);
    expect(licence.match(/SIL OPEN FONT LICENSE Version 1.1/g)).toHaveLength(3);
  });

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
