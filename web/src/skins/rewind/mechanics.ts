/** Small, DOM-free rules shared by the visual controller and its tests. */
export const TRACKING_MS = 240;
export const LOCK_MS = 600;
export const COUNTER_MS = 350;

export function digitFrames(digit: number): readonly number[] {
  return [3, 2, 1, 0].map((offset) => (digit + offset) % 10);
}

export function digitDelay(index: number, count: number): number {
  return Math.min(126, Math.max(0, count - index - 1) * 14);
}

export function sliceShift(kind: string, phone: boolean, index: number): number {
  return (index % 2 ? -1 : 1) * (phone ? 6 : kind === "week-change" ? 12 : 8);
}

export interface Bounds { left: number; top: number; right: number; bottom: number }
export function overlaps(a: Bounds, b: Bounds, margin = 0): boolean {
  return a.left < b.right + margin && a.right > b.left - margin
    && a.top < b.bottom + margin && a.bottom > b.top - margin;
}

/** Union overlapping exclusions so an even-odd mask never reopens their overlap. */
export function mergeBounds(bounds: readonly Bounds[]): Bounds[] {
  const merged: Bounds[] = [];
  for (const bound of bounds) {
    let next = { ...bound };
    for (let i = 0; i < merged.length;) {
      const other = merged[i]!;
      if (!overlaps(next, other, .01)) { i++; continue; }
      next = { left: Math.min(next.left, other.left), top: Math.min(next.top, other.top),
        right: Math.max(next.right, other.right), bottom: Math.max(next.bottom, other.bottom) };
      merged.splice(i, 1); i = 0;
    }
    merged.push(next);
  }
  return merged;
}
