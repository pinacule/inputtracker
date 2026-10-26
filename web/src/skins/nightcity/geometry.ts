/** Pure geometry shared by rain/frame rendering and synthetic tests. */
export interface Box { left: number; top: number; right: number; bottom: number }
export function overlaps(a: Box, b: Box, clearance = 0): boolean {
  return a.left < b.right + clearance && a.right > b.left - clearance
    && a.top < b.bottom + clearance && a.bottom > b.top - clearance;
}
export function rainBudget(phone: boolean, burst: boolean) {
  // Budget the visible gutters, rather than hiding nearly all 56 faint drops
  // underneath opaque cards. The one canvas still paints behind reading panes.
  return { count: phone ? (burst ? 180 : 120) : (burst ? 540 : 360), fps: phone ? 20 : 30,
    dpr: phone ? 1.5 : 2, opacity: burst ? .60 : .48 };
}
export function scramble(value: string, step: number, rng = Math.random): string {
  return value.replace(/\d/g, (digit, offset: number) => step >= 8 || offset < step - 3
    ? digit : String(Math.floor(rng() * 10)));
}
