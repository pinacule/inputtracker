/**
 * Generates the PWA PNG icons from the same geometry as `web/public/icon.svg`.
 *
 * Runs with Bun and has no native dependencies: the raw RGBA pixels are
 * rasterised here and the PNG container (`IHDR` / `IDAT` / `IEND` chunks with
 * a CRC-32 per chunk) is assembled by hand, compressing the pixel data with
 * `node:zlib`.
 *
 * The output is committed under `web/public/`, so neither `vite build` nor a
 * fresh checkout needs to run this script. Re-run it after changing the icon:
 *
 *   bun run scripts/gen-icons.ts
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Colours taken from `web/public/icon.svg`. */
const BACKGROUND: Rgb = [0x11, 0x18, 0x27]; // #111827
const ACCENT: Rgb = [0x3b, 0x82, 0xf6]; // #3b82f6

/** Geometry in the SVG's 192x192 coordinate space. */
const VIEWBOX = 192;
const LINE_RADIUS = 6; // stroke-width 12 / 2
const LINES: readonly Segment[] = [
  { x1: 48, y1: 64, x2: 144, y2: 64 },
  { x1: 48, y1: 96, x2: 144, y2: 96 },
  { x1: 48, y1: 128, x2: 108, y2: 128 },
];
const CIRCLE = { cx: 140, cy: 128, r: 16 };

const OUTPUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web",
  "public"
);

/** Shortest distance from `(px, py)` to the segment `s`. */
function distanceToSegment(px: number, py: number, s: Segment): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / lengthSq)
        );
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

/**
 * Rasterises the icon at `size`x`size` into an RGBA byte buffer.
 *
 * The background fills the whole square (maskable-safe) and each output pixel
 * is averaged over a 4x4 grid of subsamples for smooth edges.
 */
function renderRgba(size: number): Uint8Array {
  const samples = 4;
  const samplesPerPixel = samples * samples;
  const unitPerPixel = VIEWBOX / size;
  const rgba = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const ux = (x + (sx + 0.5) / samples) * unitPerPixel;
          const uy = (y + (sy + 0.5) / samples) * unitPerPixel;
          const onLine = LINES.some(
            (line) => distanceToSegment(ux, uy, line) <= LINE_RADIUS
          );
          const onCircle =
            Math.hypot(ux - CIRCLE.cx, uy - CIRCLE.cy) <= CIRCLE.r;
          const [r, g, b] = onLine || onCircle ? ACCENT : BACKGROUND;
          red += r;
          green += g;
          blue += b;
        }
      }

      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(red / samplesPerPixel);
      rgba[offset + 1] = Math.round(green / samplesPerPixel);
      rgba[offset + 2] = Math.round(blue / samplesPerPixel);
      rgba[offset + 3] = 0xff;
    }
  }

  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds one length-prefixed, CRC-suffixed PNG chunk. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const payload = new Uint8Array(typeBytes.length + data.length);
  payload.set(typeBytes, 0);
  payload.set(data, typeBytes.length);

  const chunk = new Uint8Array(4 + payload.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(payload, 4);
  view.setUint32(chunk.length - 4, crc32(payload));
  return chunk;
}

/** 8-bit RGBA IHDR payload. */
function ihdr(size: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, size); // width
  view.setUint32(4, size); // height
  data[8] = 8; // bit depth
  data[9] = 6; // colour type: truecolour with alpha
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = 0; // interlace method
  return data;
}

/** Adds the per-scanline filter byte (0 = None) to the RGBA pixels. */
function filterScanlines(rgba: Uint8Array, size: number): Uint8Array {
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }
  return raw;
}

function encodePng(size: number): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = deflateSync(filterScanlines(renderRgba(size), size));
  const parts = [
    signature,
    pngChunk("IHDR", ihdr(size)),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

const SIZES = [192, 512] as const;

for (const size of SIZES) {
  const file = join(OUTPUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size));
  console.log(`wrote ${file}`);
}
