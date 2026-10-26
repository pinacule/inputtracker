/**
 * Theme registry and persistence helpers. The original five dark palettes
 * remain compatible; four app skins include the monochrome light CWM skin.
 * Choices are stored in `localStorage` under
 * `inputtracker.theme` and applied as `data-theme="<id>"` on
 * `document.documentElement` before first paint.
 *
 * Pure helpers accept an optional storage interface so they are unit-testable
 * under Bun with no DOM.
 */

import type { Category } from "../../../src/core/category.ts";

export type ThemeId =
  | "espresso"
  | "midnight"
  | "forest"
  | "obsidian"
  | "plum"
  | "hermes"
  | "workbench"
  | "cwm"
  | "signal"
  | "dot"
  | "nightcity"
  | "rewind"
  | "thinker";

/** Compatibility aliases for existing callers (CWM is a light skin). */
export type DarkThemeId = ThemeId;
export type ThemeMode = ThemeId;

export const DEFAULT_THEME: DarkThemeId = "dot";

export const THEME_STORAGE_KEY = "inputtracker.theme";

export interface ThemeSwatches {
  readonly canvas: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly subtle: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly accent: string;
  readonly border: string;
}

export interface CategoryThemeColors {
  readonly fg: string;
  readonly bg: string;
  readonly border: string;
  readonly solid: string;
}

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly label: string;
  readonly description: string;
  readonly swatches: ThemeSwatches;
  readonly categories: Readonly<Record<Category, CategoryThemeColors>>;
}

export type DarkThemeDefinition = ThemeDefinition;

const SHARED_DARK_CATEGORIES: Readonly<Record<Category, CategoryThemeColors>> = {
  anime: {
    fg: "#c2beff",
    bg: "#1e1c38",
    border: "#3a356e",
    solid: "#8278f5",
  },
  series: {
    fg: "#8ee0ee",
    bg: "#142a30",
    border: "#25505c",
    solid: "#3cb8cc",
  },
  film: {
    fg: "#f6c982",
    bg: "#302312",
    border: "#5c421f",
    solid: "#e29a38",
  },
  book: {
    fg: "#8fdcb8",
    bg: "#172b22",
    border: "#2a5441",
    solid: "#4cb888",
  },
  audiobook: {
    fg: "#d5bcf9",
    bg: "#271d35",
    border: "#4a3566",
    solid: "#a37bf0",
  },
  youtube: {
    fg: "#f8b4ac",
    bg: "#331c19",
    border: "#61312b",
    solid: "#e46356",
  },
  podcast: {
    fg: "#f7bc97",
    bg: "#301f15",
    border: "#5e3b26",
    solid: "#e07b42",
  },
  music: {
    fg: "#f7b2d3",
    bg: "#301925",
    border: "#5e2e46",
    solid: "#de5d97",
  },
  other: {
    fg: "#d2c9bb",
    bg: "#28241f",
    border: "#474037",
    solid: "#9c9080",
  },
  shortform: { fg: "#b1d3ff", bg: "#192638", border: "#354f70", solid: "#6194cf" },
};

// ANSI's bright fills use black labels on white rather than unreadable bright
// text on a light pane. All values come from the classic 16-colour palette.
const ANSI_CATEGORIES: Readonly<Record<Category, CategoryThemeColors>> = {
  anime: { fg: "#0000aa", bg: "#ffffff", border: "#000000", solid: "#0000aa" },
  series: { fg: "#000000", bg: "#ffffff", border: "#000000", solid: "#00aaaa" },
  film: { fg: "#000000", bg: "#ffffff", border: "#000000", solid: "#ffff55" },
  book: { fg: "#000000", bg: "#ffffff", border: "#000000", solid: "#00aa00" },
  audiobook: { fg: "#aa00aa", bg: "#ffffff", border: "#000000", solid: "#aa00aa" },
  youtube: { fg: "#aa0000", bg: "#ffffff", border: "#000000", solid: "#aa0000" },
  podcast: { fg: "#aa5500", bg: "#ffffff", border: "#000000", solid: "#aa5500" },
  music: { fg: "#000000", bg: "#ffffff", border: "#000000", solid: "#ff55ff" },
  shortform: { fg: "#5555ff", bg: "#ffffff", border: "#000000", solid: "#5555ff" },
  other: { fg: "#555555", bg: "#ffffff", border: "#000000", solid: "#555555" },
};

/** Every skin ever built, including archived ones (kept so they can be restored). */
export const ALL_THEMES: ReadonlyArray<ThemeDefinition> = [
  {
    id: "espresso",
    label: "Warm Study",
    description: "Deep walnut charcoal & warm terracotta leather",
    swatches: {
      canvas: "#14120f",
      surface: "#1d1a16",
      surfaceRaised: "#25211c",
      subtle: "#29241e",
      textPrimary: "#f4efe6",
      textSecondary: "#c4bba9",
      accent: "#e58564",
      border: "#3a332b",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "midnight",
    label: "Midnight Ink",
    description: "Nocturnal slate-navy study & crisp sky blue",
    swatches: {
      canvas: "#0b1017",
      surface: "#121924",
      surfaceRaised: "#192230",
      subtle: "#1e293a",
      textPrimary: "#eaf0f8",
      textSecondary: "#b2c0d4",
      accent: "#68b5ff",
      border: "#2a384d",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "forest",
    label: "Pine & Moss",
    description: "Deep botanical evergreen & tranquil sage",
    swatches: {
      canvas: "#0c130f",
      surface: "#131e18",
      surfaceRaised: "#1a2820",
      subtle: "#203027",
      textPrimary: "#e9f2ed",
      textSecondary: "#b4c8bc",
      accent: "#62c994",
      border: "#2b4235",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "obsidian",
    label: "Obsidian Archive",
    description: "Neutral carbon ink & warm library gold leaf",
    swatches: {
      canvas: "#0e0e11",
      surface: "#16161b",
      surfaceRaised: "#1e1e25",
      subtle: "#24242c",
      textPrimary: "#f2f1f7",
      textSecondary: "#bcbac9",
      accent: "#e5b557",
      border: "#32323d",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "plum",
    label: "Velvet Nocturne",
    description: "Dark aubergine salon & soft rosewood",
    swatches: {
      canvas: "#130e16",
      surface: "#1c1521",
      surfaceRaised: "#251c2c",
      subtle: "#2c2134",
      textPrimary: "#f3ecf7",
      textSecondary: "#c5b5cf",
      accent: "#df85bc",
      border: "#3e2f49",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "hermes",
    label: "Hermes",
    description: "Ink navy, etched rays & electric-blue geometry",
    swatches: {
      canvas: "#0b0e20", surface: "#11162b", surfaceRaised: "#191f36",
      subtle: "#202740", textPrimary: "#f0f2ff", textSecondary: "#bcc5df",
      accent: "#8baaff", border: "#45516f",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "workbench",
    label: "Workbench",
    description: "Circuit wallpaper, bitmap type & bevelled windows",
    swatches: {
      canvas: "#293b49", surface: "#263540", surfaceRaised: "#30424f",
      subtle: "#394d5b", textPrimary: "#f4f8fc", textSecondary: "#d2dfe9",
      accent: "#a8d5ff", border: "#718998",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "cwm",
    label: "CWM",
    description: "Monochrome terminal panes, dither & ANSI categories",
    swatches: {
      canvas: "#ffffff", surface: "#ffffff", surfaceRaised: "#ffffff",
      subtle: "#ffffff", textPrimary: "#000000", textSecondary: "#000000",
      accent: "#000000", border: "#000000",
    },
    categories: ANSI_CATEGORIES,
  },
  {
    id: "signal",
    label: "Signal",
    description: "Particle grain, mint typewriter headings & quiet frames",
    swatches: {
      canvas: "#0c100e", surface: "#111814", surfaceRaised: "#19221c",
      subtle: "#202c24", textPrimary: "#e6f2e9", textSecondary: "#b8cbbc",
      accent: "#a4f5c1", border: "#41594a",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "dot",
    label: "Dot",
    description: "Black blocks, dot-matrix numbers & a red accent",
    swatches: {
      canvas: "#000000", surface: "#111111", surfaceRaised: "#191919",
      subtle: "#1f1f1f", textPrimary: "#f4f4f4", textSecondary: "#ababab",
      accent: "#ff4a4a", border: "#2c2c2c",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "nightcity",
    label: "Night City",
    description: "Neon rain over a city at night",
    swatches: {
      canvas: "#080e1c",
      surface: "#101b2c",
      surfaceRaised: "#17243a",
      subtle: "#1c2d43",
      textPrimary: "#edfaff",
      textSecondary: "#b3c9da",
      accent: "#55e5f5",
      border: "#31475f",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "rewind",
    label: "Rewind",
    description: "VHS tape, scanlines and on-screen display",
    swatches: {
      canvas: "#080a10",
      surface: "#111620",
      surfaceRaised: "#191f2c",
      subtle: "#20293a",
      textPrimary: "#f3f6ff",
      textSecondary: "#bbc9e4",
      accent: "#92b8ff",
      border: "#394a66",
    },
    categories: SHARED_DARK_CATEGORIES,
  },
  {
    id: "thinker",
    label: "Thinker",
    description: "Marble statues in firelight",
    swatches: {
      canvas: "#0b0a09",
      surface: "#171411",
      surfaceRaised: "#211c17",
      subtle: "#2a231d",
      textPrimary: "#f4eee4",
      textSecondary: "#d5c8b7",
      accent: "#f0bb79",
      border: "#544638",
    },
    categories: {
      anime: { fg: "#d8c7ec", bg: "#241c2c", border: "#806994", solid: "#b9a5d6" },
      series: { fg: "#a4dad2", bg: "#182824", border: "#527f77", solid: "#65b7ad" },
      film: { fg: "#eed99f", bg: "#2d2618", border: "#927d48", solid: "#d5b96e" },
      book: { fg: "#cfddb0", bg: "#23291c", border: "#768554", solid: "#a2b87c" },
      audiobook: { fg: "#c5caf0", bg: "#202235", border: "#7076a1", solid: "#989ed0" },
      youtube: { fg: "#f2bca9", bg: "#30201b", border: "#a36d5a", solid: "#db927d" },
      podcast: { fg: "#e7c5a6", bg: "#2c231c", border: "#94704f", solid: "#d3a07b" },
      music: { fg: "#edbdd5", bg: "#2d1e28", border: "#95647f", solid: "#d894b6" },
      shortform: { fg: "#bcd9eb", bg: "#1c2630", border: "#617f94", solid: "#88b4cf" },
      other: { fg: "#ddd6c9", bg: "#28251f", border: "#8a8273", solid: "#c8c1b4" },
    },
  },
];

/**
 * Archived skins: their code and CSS stay in the repo, but they are not offered
 * in Settings and a saved choice of one falls back to the default. To bring one
 * back, remove its id from this list.
 */
export const ARCHIVED_THEME_IDS: ReadonlyArray<ThemeId> = [
  "espresso", "midnight", "forest", "obsidian", "plum",
  "hermes", "workbench", "cwm", "signal",
];

/** The skins people can choose. */
export const THEMES: ReadonlyArray<ThemeDefinition> = ALL_THEMES.filter(
  (theme) => !ARCHIVED_THEME_IDS.includes(theme.id)
);

/** Legacy export retained; use THEMES for new code. */
export const DARK_THEMES = THEMES;

/** Active skins only; archived ids are not valid choices. */
export const THEME_REGISTRY = Object.fromEntries(
  THEMES.map((theme) => [theme.id, theme])
) as Readonly<Partial<Record<ThemeId, ThemeDefinition>>> & Readonly<Record<typeof DEFAULT_THEME, ThemeDefinition>>;

/** Every skin by id, archived ones included (for tests and restoring). */
export const ALL_THEME_REGISTRY = Object.fromEntries(
  ALL_THEMES.map((theme) => [theme.id, theme])
) as Readonly<Record<ThemeId, ThemeDefinition>>;

export interface ThemeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && Object.hasOwn(THEME_REGISTRY, value);
}

export const isDarkThemeId = isThemeId;
export const isThemeMode = isThemeId;

/** Vite embeds this synchronously in <head>, keeping first paint in sync with
 * the registry without fetching a module or maintaining a second ID list. */
export function themeBootstrapScript(): string {
  const colors = Object.fromEntries(THEMES.map((t) => [t.id, t.swatches.canvas]));
  return `(function(){try{var colors=${JSON.stringify(colors)};var theme=${JSON.stringify(DEFAULT_THEME)};try{var raw=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(Object.prototype.hasOwnProperty.call(colors,raw))theme=raw;}catch(e){}document.documentElement.setAttribute("data-theme",theme);var meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute("content",colors[theme]);}catch(e){}})();`;
}

function defaultStorage(): ThemeStorageLike | null {
  try {
    const ls = (globalThis as unknown as { localStorage?: ThemeStorageLike })
      .localStorage;
    if (
      ls &&
      typeof ls.getItem === "function" &&
      typeof ls.setItem === "function"
    ) {
      return ls;
    }
  } catch {
    // Ignore storage access errors (e.g. private browsing restrictions).
  }
  return null;
}

export function resolveThemePreference(raw: unknown): DarkThemeId {
  if (isDarkThemeId(raw)) {
    return raw;
  }
  return DEFAULT_THEME;
}

export function readThemePreference(
  storage: ThemeStorageLike | null = defaultStorage()
): DarkThemeId {
  if (!storage) {
    return DEFAULT_THEME;
  }
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return resolveThemePreference(raw);
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyThemeToDocument(theme: DarkThemeId): void {
  const valid = resolveThemePreference(theme);
  try {
    const doc = (
      globalThis as unknown as {
        document?: {
          documentElement?: {
            setAttribute(name: string, value: string): void;
          };
          querySelector?(selector: string): {
            setAttribute(name: string, value: string): void;
          } | null;
        };
      }
    ).document;
    const root = doc?.documentElement;
    if (!root) return;
    root.setAttribute("data-theme", valid);
    const meta = doc?.querySelector?.('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", ALL_THEME_REGISTRY[valid].swatches.canvas);
    }
  } catch {
    // Ignore when no DOM exists.
  }
}

export function saveThemePreference(
  theme: DarkThemeId | string,
  storage: ThemeStorageLike | null = defaultStorage()
): DarkThemeId {
  const valid = resolveThemePreference(theme);
  if (storage) {
    try {
      storage.setItem(THEME_STORAGE_KEY, valid);
    } catch {
      // Ignore storage write errors.
    }
  }
  applyThemeToDocument(valid);
  return valid;
}

// --- WCAG 2.1 Contrast Verification Helpers --------------------------------

function parseHexChannel(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "").trim();
  if (clean.length === 3) {
    const r = Number.parseInt(clean[0]! + clean[0]!, 16);
    const g = Number.parseInt(clean[1]! + clean[1]!, 16);
    const b = Number.parseInt(clean[2]! + clean[2]!, 16);
    return [r, g, b];
  }
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

/**
 * Computes WCAG 2.1 relative luminance (`0..1`) for a `#RRGGBB` colour.
 */
export function relativeLuminance(hex: string): number {
  const [r8, g8, b8] = parseHexChannel(hex);
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * toLinear(r8) + 0.7152 * toLinear(g8) + 0.0722 * toLinear(b8)
  );
}

/**
 * Computes WCAG 2.1 contrast ratio (`1..21`) between two `#RRGGBB` colours.
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}
