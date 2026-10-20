/** Display-only artwork. These source URLs never enter archive snapshots or API JSON. */
import type { WorkArtImage } from "../../core/contract.ts";

export const MAX_WORK_ART = 8;
export const ART_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
export interface ArtSource extends Omit<WorkArtImage, "url"> { url: string }

export function artSource(url: unknown, kind: ArtSource["kind"], width?: unknown, height?: unknown): ArtSource | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url.trim());
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const dimension = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 100_000 ? value : null;
    return { url: parsed.toString(), kind, width: dimension(width), height: dimension(height) };
  } catch { return null; }
}

/** Wide images first. Stable ties preserve provider vote/size ordering. */
export function selectArt(sources: readonly (ArtSource | null)[]): ArtSource[] {
  const unique = new Map<string, ArtSource>();
  for (const source of sources) {
    if (source && !unique.has(source.url)) unique.set(source.url, source);
  }
  return [...unique.values()].sort((a, b) =>
    Number(b.kind === "backdrop" || b.kind === "banner") - Number(a.kind === "backdrop" || a.kind === "banner")
  ).slice(0, MAX_WORK_ART);
}
