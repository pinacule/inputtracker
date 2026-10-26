/** Three continuous, non-repeating noise bands. No clock, DOM or random global:
 * tests can reproduce the exact light which also drives the projected shadows. */
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const smooth = (v: number) => v * v * (3 - 2 * v);
function noise(t: number, period: number, seed: number): number {
  const slot = Math.floor(t / period);
  const value = (i: number) => {
    let n = Math.imul(i ^ seed, 0x9e3779b1);
    n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
    return ((n ^ (n >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
  };
  const mix = smooth(t / period - slot);
  return value(slot) * (1 - mix) + value(slot + 1) * mix;
}
export interface Flame { intensity: number; x: number; y: number; stretch: number }
export function sampleFlame(milliseconds: number, seed = 41): Flame {
  const t = Math.max(0, milliseconds) / 1000;
  const slow = noise(t, 3.8, seed);
  return {
    intensity: clamp(.55 + .04 * noise(t, .23, seed + 7) + .07 * noise(t, .49, seed + 13) + .20 * slow, .24, .86),
    // A drifting position, rather than stationary noise plateaus: the hearth
    // leans over 5–9 s, with the same slow envelope making each sway different.
    x: .72 * Math.sin(t * .88) + .28 * noise(t, 6.7, seed + 23),
    y: .65 * Math.sin(t * .71 + .7) + .35 * noise(t, 8.3, seed + 31),
    // A four-second projection stretch every 24 s, never photo deformation.
    stretch: 1 + .25 * Math.sin(Math.PI * clamp((t % 24 - 19) / 4, 0, 1)) ** 2,
  };
}
export const LIT_SURFACES = [
  ["#171411", "#292018"], ["#211c17", "#32261c"],
  ["#2a231d", "#382b20"], ["#302720", "#3d2e23"],
] as const;
/** sRGB interpolation between audited endpoints: all overlapping light uses
 * this one colour, not additive foreground washes. Normal ΔY never exceeds .010. */
export function litSurface(base: string, lit: string, amount: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  const mix = clamp(amount, 0, 1);
  return `rgb(${[1, 3, 5].map((i) => Math.round(channel(base, i) * (1 - mix) + channel(lit, i) * mix)).join(" ")})`;
}
