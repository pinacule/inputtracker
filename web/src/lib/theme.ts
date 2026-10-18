/**
 * Theme preference helpers (`system` | `light` | `dark`), stored in `localStorage`
 * and reflected as `data-theme="light|dark"` on `document.documentElement`.
 *
 * Pure storage helpers accept an optional storage interface so they are
 * unit-testable under Bun with no DOM.
 */

export type ThemeMode = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "inputtracker.theme";

export interface ThemeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function defaultStorage(): ThemeStorageLike | null {
  try {
    const ls = (globalThis as unknown as { localStorage?: ThemeStorageLike })
      .localStorage;
    if (ls && typeof ls.getItem === "function" && typeof ls.setItem === "function") {
      return ls;
    }
  } catch {
    // Ignore storage access errors (e.g. private browsing restrictions).
  }
  return null;
}

export function readThemePreference(
  storage: ThemeStorageLike | null = defaultStorage()
): ThemeMode {
  if (!storage) {
    return "system";
  }
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function applyThemeToDocument(theme: ThemeMode): void {
  try {
    const doc = (
      globalThis as unknown as {
        document?: {
          documentElement?: {
            setAttribute(name: string, value: string): void;
            removeAttribute(name: string): void;
          };
        };
      }
    ).document;
    const root = doc?.documentElement;
    if (!root) return;
    if (theme === "light" || theme === "dark") {
      root.setAttribute("data-theme", theme);
    } else {
      root.removeAttribute("data-theme");
    }
  } catch {
    // Ignore when no DOM exists.
  }
}

export function saveThemePreference(
  theme: ThemeMode,
  storage: ThemeStorageLike | null = defaultStorage()
): ThemeMode {
  const valid: ThemeMode = isThemeMode(theme) ? theme : "system";
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
