import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { CATEGORIES } from "../web/src/lib/categories.ts";
import { contrastRatio, THEMES, THEME_REGISTRY } from "../web/src/lib/theme.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const bytes = (path: string) => statSync(new URL(path, root)).size;
const css = read("web/src/styles/themes/nightcity.css");
const palette = Object.fromEntries([...css.split("\n}")[0]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)]
  .map(match => [match[1]!, match[2]!.trim()]));

describe("Night City skin", () => {
  test("registered picker swatches match live/preview tokens and extended text pairs pass AA", () => {
    const theme = THEME_REGISTRY.nightcity!;
    expect(THEMES.find(theme => theme.id === "nightcity")).toBe(theme);
    expect(theme.label).toBe("Night City");
    // Full swatch/category parity and base-surface text checks also run in web-themes.test.ts.
    for (const [key, token] of Object.entries({ canvas: "--bg-canvas", surface: "--bg-surface",
      surfaceRaised: "--bg-surface-raised", subtle: "--bg-subtle", textPrimary: "--text-primary",
      textSecondary: "--text-secondary", accent: "--accent-primary", border: "--border-default" })) {
      expect(palette[token]).toBe(theme.swatches[key as keyof typeof theme.swatches]);
    }
    for (const category of CATEGORIES) {
      const bg = palette[`--cat-${category}-bg`]!;
      for (const foreground of ["--text-primary", "--text-secondary", "--text-muted", `--cat-${category}-fg`]) {
        expect(contrastRatio(palette[foreground]!, bg), `${foreground} on ${category}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(palette["--text-on-accent"]!, palette[`--cat-${category}-solid`]!)).toBeGreaterThanOrEqual(4.5);
    }
    for (const status of ["success", "warning", "danger"]) {
      expect(contrastRatio(palette[`--status-${status}-fg`]!, palette[`--status-${status}-bg`]!)).toBeGreaterThanOrEqual(4.5);
    }
    for (const foreground of ["--accent-secondary", "--focus-ring", "--accent-primary-hover"]) {
      for (const background of ["--bg-canvas", "--bg-surface", "--bg-surface-raised", "--bg-subtle"]) {
        expect(contrastRatio(palette[foreground]!, palette[background]!)).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Worst-case header backing (#071221f0) composited over white scenery.
    for (const foreground of ["--text-primary", "--text-secondary", "--text-muted"]) {
      expect(contrastRatio(palette[foreground]!, "#16202e")).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("wallpapers meet strict export dimensions and sizes; every local asset has credits", () => {
    const credits = read("web/public/wallpapers/nightcity/CREDITS.md");
    for (const [name, width, height, cap] of [
      ["skyline-desktop.webp", 1920, 1200, 350_000],
      ["street-phone.webp", 1080, 2340, 200_000],
    ] as const) {
      const path = `web/public/wallpapers/nightcity/${name}`;
      const data = readFileSync(new URL(path, root));
      expect(bytes(path)).toBeLessThanOrEqual(cap);
      // Both shipped WebP files use the VP8 frame header; read dimensions locally.
      expect(data.toString("ascii", 0, 4)).toBe("RIFF");
      expect(data.toString("ascii", 8, 16)).toBe("WEBPVP8 ");
      expect(data.readUInt16LE(26) & 0x3fff).toBe(width);
      expect(data.readUInt16LE(28) & 0x3fff).toBe(height);
      expect(credits).toContain(name);
    }
    expect(credits).toContain("Base64"); expect(credits).toContain("CC BY-SA 3.0"); expect(credits).toContain("CC0");
    for (const name of ["city.svg", "window.svg"]) {
      expect(bytes(`web/public/wallpapers/nightcity/${name}`)).toBeLessThanOrEqual(12 * 1024);
      expect(credits).toContain(name);
    }
    const fontCredits = read("web/public/fonts/nightcity/LICENSE.md");
    const fonts = readdirSync(new URL("web/public/fonts/nightcity/", root)).filter(name => name.endsWith(".woff2"));
    expect(fonts.reduce((sum, name) => sum + bytes(`web/public/fonts/nightcity/${name}`), 0)).toBeLessThanOrEqual(600 * 1024);
    for (const font of fonts) expect(fontCredits).toContain(font);
    for (const family of ["barlow", "rajdhani", "ibmplexmono", "notosansjp"]) {
      expect(fontCredits).toContain(`https://github.com/google/fonts/tree/main/ofl/${family}`);
    }
    expect(fontCredits).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  test("the independent static miniature has art, subset sign, brackets, rain and interaction states", () => {
    const preview = css.slice(css.indexOf("/* Static city-window miniature."), css.indexOf("/* The title is a window"));
    expect(preview).toContain('.theme-preview[data-theme="nightcity"]');
    expect(preview).toContain("/wallpapers/nightcity/window.svg");
    expect(preview).toContain("content: '夜の街'");
    expect(preview).toContain("var(--font-sign)");
    expect(preview).toContain(".theme-preview-window::after");
    expect(preview).toContain("linear-gradient(100deg");
    expect(preview).toContain("pointer-events: none");
    for (const state of [".theme-tile:hover", ".theme-tile-radio:checked", ".theme-tile-radio:focus-visible"]) expect(preview).toContain(state);
    expect(preview).not.toMatch(/animation:|transition:|@keyframes|https?:/);
    const fontCSS = read("web/src/styles/fonts/nightcity.css");
    expect(fontCSS).toContain('.theme-preview[data-theme="nightcity"]');
    expect(fontCSS).toContain("noto-sans-jp-signs-700.woff2");
    expect(fontCSS).toContain("U+306e, U+591c, U+672a, U+6765, U+8133, U+8857, U+96fb");
    expect(read("web/src/ui/ThemePicker.tsx")).not.toContain("skins/nightcity");
  });
});
