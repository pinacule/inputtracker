import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { CATEGORIES } from "../web/src/lib/categories.ts";
import {
  THEMES, THEME_REGISTRY, THEME_STORAGE_KEY, applyThemeToDocument,
  contrastRatio, isThemeId, readThemePreference, resolveThemePreference,
  saveThemePreference, themeBootstrapScript,
} from "../web/src/lib/theme.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const tokens = read("web/src/styles/tokens.css");
const skinIds = ["hermes", "workbench", "cwm", "signal"];
function properties(css: string): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map((m) => [m[1]!, m[2]!.trim()]));
}
function themeProperties(id: string) {
  const base = tokens.slice(0, tokens.indexOf("/* --- Theme 2:"));
  const override = skinIds.includes(id)
    ? read(`web/src/styles/themes/${id}.css`).split("\n}")[0]! + "\n}"
    : id === "espresso" ? "" : tokens.split(`:root[data-theme="${id}"]`)[1]!.split("\n}")[0]!;
  return { ...properties(base), ...properties(override) };
}

describe("app skins", () => {
  test("registry validation is own-key only and all choices round-trip", () => {
    for (const bad of [null, undefined, "", "light", "system", "__proto__", "constructor", "toString", {}, 1]) {
      expect(isThemeId(bad)).toBe(false);
      expect(resolveThemePreference(bad)).toBe("espresso");
    }
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    for (const theme of THEMES) {
      expect(saveThemePreference(theme.id, storage)).toBe(theme.id);
      expect(readThemePreference(storage)).toBe(theme.id);
      expect(store.get(THEME_STORAGE_KEY)).toBe(theme.id);
    }
    expect(readThemePreference(null)).toBe("espresso");
    const blocked = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); } };
    expect(readThemePreference(blocked)).toBe("espresso");
    expect(saveThemePreference("cwm", blocked)).toBe("cwm");
  });

  test("synchronous head bootstrap uses the registry and handles blocked storage", () => {
    const script = themeBootstrapScript();
    for (const raw of [...THEMES.map((t) => t.id), null, "light", "constructor", "__proto__", "toString"]) {
      const attrs: Record<string, string> = {};
      const document = {
        documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
        querySelector: () => ({ setAttribute: (_: string, v: string) => { attrs.meta = v; } }),
      };
      runInNewContext(script, { document, localStorage: { getItem: () => raw } });
      const expected = resolveThemePreference(raw);
      expect(attrs["data-theme"]).toBe(expected);
      expect(attrs.meta).toBe(THEME_REGISTRY[expected].swatches.canvas);
    }
    let chosen = "";
    const document = { documentElement: { setAttribute: (_: string, v: string) => { chosen = v; } }, querySelector: () => null };
    runInNewContext(script, { document, localStorage: { getItem: () => { throw Error("blocked"); } } });
    expect(chosen).toBe("espresso");
    expect(() => applyThemeToDocument("signal")).not.toThrow();
    expect(read("web/index.html")).toContain("/* inputtracker-theme-bootstrap */");
    expect(read("web/vite.config.ts")).toContain("themeBootstrapScript()");
  });

  test("live CSS and preview colours agree with registry; text is AA on all surfaces", () => {
    for (const theme of THEMES) {
      const props = themeProperties(theme.id);
      const swatches = {
        canvas: "--bg-canvas", surface: "--bg-surface", surfaceRaised: "--bg-surface-raised",
        subtle: "--bg-subtle", textPrimary: "--text-primary", textSecondary: "--text-secondary",
        accent: "--accent-primary", border: "--border-default",
      } as const;
      for (const [key, token] of Object.entries(swatches)) {
        expect(props[token]).toBe(theme.swatches[key as keyof typeof swatches]);
      }
      const foregrounds = ["--text-primary", "--text-secondary", "--accent-primary"];
      if (skinIds.includes(theme.id)) foregrounds.push("--text-muted");
      for (const fg of foregrounds) {
        for (const bg of ["--bg-canvas", "--bg-surface", "--bg-surface-raised", "--bg-subtle"]) {
          expect(contrastRatio(props[fg]!, props[bg]!), `${theme.id}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      const solids = new Set<string>();
      const actionBg = props["--accent-block"] ?? props["--accent-primary"]!;
      expect(contrastRatio(props["--text-on-accent"]!, actionBg)).toBeGreaterThanOrEqual(4.5);
      if (skinIds.includes(theme.id) && props["--card-title-bg"] !== "transparent") {
        expect(contrastRatio(props["--card-title-color"]!, props["--card-title-bg"]!)).toBeGreaterThanOrEqual(4.5);
      }
      for (const category of CATEGORIES) {
        for (const key of ["fg", "bg", "border", "solid"] as const) {
          expect(props[`--cat-${category}-${key}`]).toBe(theme.categories[category][key]);
        }
        solids.add(theme.categories[category].solid);
      }
      expect(solids.size).toBe(10);
    }
  });

  test("each skin has scoped typography, geometry and local artwork under budget", () => {
    let bytes = 0;
    for (const id of skinIds) {
      const css = read(`web/src/styles/themes/${id}.css`);
      const props = themeProperties(id);
      bytes += Buffer.byteLength(css);
      expect(css).toContain(`:root[data-theme="${id}"]`);
      expect(css).toContain(`.theme-preview[data-theme="${id}"]`);
      expect(css).not.toMatch(/url\(["']?https?:|@font-face|@import/);
      for (const token of ["--font-display", "--font-body", "--font-numbers", "--radius-lg", "--chart-radius", "--wallpaper"]) {
        expect(props[token]).toBeDefined();
      }
      expect(props["--wallpaper"]).not.toBe("none");
    }
    expect(bytes).toBeLessThan(60 * 1024);
    const picker = read("web/src/ui/ThemePicker.tsx");
    expect(picker).toContain('type="radio"');
    expect(picker).toContain("THEMES.map");
    expect(picker).toContain("data-theme={theme.id}");
    expect(read("web/src/styles/base.css")).toContain("prefers-reduced-motion: reduce");
  });

  test("CWM category colours are unique ANSI colours and all other interface tokens are monochrome", () => {
    const ansi = new Set(["#000000", "#aa0000", "#00aa00", "#aa5500", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa", "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff"]);
    for (const colors of Object.values(THEME_REGISTRY.cwm.categories)) {
      for (const color of Object.values(colors)) expect(ansi.has(color)).toBe(true);
    }
    const props = themeProperties("cwm");
    for (const [token, value] of Object.entries(props)) {
      if (/^--(?:bg-|text-|accent-|status-|border-|heat-|card-title-(?:bg|color))/.test(token) && value.startsWith("#")) {
        expect(["#000000", "#ffffff"]).toContain(value);
      }
    }
  });

  test("wallpaper skins opt into opaque reading panes and their own navigation", () => {
    const app = read("web/src/App.tsx");
    expect(app).toContain('["espresso", "midnight", "forest", "obsidian", "plum"].includes(theme)');
    for (const id of skinIds) {
      const props = themeProperties(id);
      expect(props["--page-reading-bg"]).toBe("var(--bg-surface)");
      expect(props["--home-panel-bg"]).toBe("var(--bg-surface)");
      expect(props["--home-group-display"]).toBe("flex");
      expect(props["--mobile-nav-active-bg"]).toBe("var(--nav-active-bg)");
      expect(props["--home-number-margin"]).toBe("0px");
      expect(props["--home-week-value-wrap"]).toBe("normal");
      const resolve = (value: string): string => value.startsWith("var(")
        ? resolve(props[value.slice(4, -1)]!) : value;
      expect(contrastRatio(resolve(props["--nav-active-color"]!), resolve(props["--nav-active-bg"]!)), id).toBeGreaterThanOrEqual(4.5);
      if (id === "signal") {
        expect(props["--home-page-bg"]).toBe("var(--bg-surface)");
        expect(props["--home-panel-border"]).toBe("0px solid transparent");
        expect(props["--content-frame"]).not.toBe("none");
      } else {
        expect(props["--home-panel-border"]).toContain("1px solid");
      }
      if (id === "workbench" || id === "cwm") {
        expect(resolve(props["--title-control-color"]!)).toBe(resolve(props["--card-title-color"]!));
        expect(contrastRatio(resolve(props["--home-title-label-color"]!), resolve(props["--home-title-bg"]!))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("original skins keep transparent Editorial groups and shared styles have no theme exceptions", () => {
    for (const id of ["espresso", "midnight", "forest", "obsidian", "plum"]) {
      const props = themeProperties(id);
      expect(props["--home-panel-bg"]).toBe("transparent");
      expect(props["--home-group-display"]).toBe("contents");
      expect(props["--reading-gutter"]).toBe("0px");
      expect(props["--home-number-tracking"]).toBe("-0.075em");
    }
    for (const file of ["home.css", "shell.css"]) {
      const css = read(`web/src/styles/${file}`);
      expect(css).not.toContain("data-theme=");
      expect(css).not.toMatch(/#[\da-f]{6}\b/i);
    }
    const home = read("web/src/styles/home.css");
    expect(home).toContain("font-family: var(--font-numbers)");
    expect(home).toContain("prefers-reduced-motion: reduce");
    const day = read("web/src/ui/home/DayDetailPanel.tsx");
    expect(day).toContain('class="home-day-overview"');
    expect(day).toContain('class="home-day-entries"');
    expect(day).toContain("<CategoryLegend");
  });

  test("bundled families serve live skins and their previews without scaled fallback headings", () => {
    const fonts = read("web/src/styles/fonts.css");
    for (const id of skinIds) expect(fonts).toContain(`.theme-preview[data-theme="${id}"]`);
    for (const name of ["Instrument Serif", "Inter", "Oswald", "Roboto Condensed", "IBM Plex Mono", "Courier Prime", "Pixelify Sans"]) {
      expect(fonts).toContain(`font-family: "${name}"`);
    }
    for (const id of skinIds) {
      const css = read(`web/src/styles/themes/${id}.css`);
      expect(css).not.toMatch(/--font-[\w-]+:\s*"/);
      expect(css).not.toContain("transform: scale");
    }
    expect(tokens).not.toMatch(/--font-[\w-]+:[^;]*"/);
    expect(read("web/src/styles/shell.css")).toContain(".sidebar-settings-link--active:hover");
    expect(read("web/src/styles/base.css")).toContain(".page-header-actions { min-width: 0; max-width: 100%; }");
  });

  test("Espresso retains its previous explicit font cascade", () => {
    const fonts = read("web/src/styles/fonts.css");
    const espresso = properties(fonts.split(':root[data-theme="espresso"]')[1]!.split("\n}")[0]!);
    expect(espresso["--font-serif"]).toStartWith('"Iowan Old Style"');
    expect(espresso["--font-sans"]).toStartWith('-apple-system');
    expect(fonts).toContain('--font-serif: "Instrument Serif"');
    expect(fonts).toContain('--font-sans: "Inter"');
  });
});
