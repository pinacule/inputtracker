import type { AppRoute } from "../../lib/router.ts";

export type ThinkerScene = "thinker" | "hugo" | "plato";
export function sceneForRoute(route: AppRoute): ThinkerScene {
  if (route === "calendar") return "thinker";
  if (route === "library" || route === "review") return "hugo";
  return "plato";
}

export interface Rect { left: number; top: number; width: number; height: number }
const intersects = (a: Rect, b: Rect, clearance: number) =>
  a.left < b.left + b.width + clearance && a.left + a.width > b.left - clearance &&
  a.top < b.top + b.height + clearance && a.top + a.height > b.top - clearance;

/** Rightmost safe heading crop. Coordinates are viewport-relative; shrink or
 * omit when titles/actions occupy it. Pure geometry for synthetic unit tests. */
export function headingWindow(bounds: Rect, protectedRects: readonly Rect[], phone: boolean): Rect | null {
  const sizes = phone ? [[80, 112], [80, 80], [64, 64], [48, 48]] :
    [[220, 140], [180, 112], [140, 96], [100, 80], [80, 64]];
  const inset = 16;
  for (const [width = 0, height = 0] of sizes) {
    if (width > bounds.width - 2 * inset || height > bounds.height - 2 * inset) continue;
    for (let left = bounds.left + bounds.width - inset - width; left >= bounds.left + inset; left -= 8) {
      for (let top = bounds.top + inset; top <= bounds.top + bounds.height - inset - height; top += 8) {
        const rect = { left, top, width, height };
        if (!protectedRects.some((obstacle) => intersects(rect, obstacle, 12))) return rect;
      }
    }
  }
  return null;
}
