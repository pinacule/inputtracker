import type { WorkArtImage } from "../../../src/core/contract";

const ART_PATH = /^\/api\/meta-art\/(?:anilist|tmdb|tvmaze|cinemeta|openlibrary|itunes|steam|wikipedia)\/[A-Za-z0-9_-]{1,64}$/;
export function localArtListUrl(url: string | null | undefined): string | null {
  return url && ART_PATH.test(url) ? url : null;
}

export function localArtImages(images: readonly WorkArtImage[], listUrl: string): WorkArtImage[] {
  if (!localArtListUrl(listUrl)) return [];
  return images.filter((image) => image && /^[0-7]$/.test(image.url.slice(listUrl.length + 1)) && image.url.startsWith(`${listUrl}/`)).slice(0, 8);
}

export function featuredArtIndex(images: readonly WorkArtImage[]): number {
  const wide = images.findIndex((image) => image.kind === "backdrop" || image.kind === "banner");
  if (wide >= 0) return wide;
  return images.reduce((best, image, index) => (image.width ?? 0) * (image.height ?? 0) > (images[best]?.width ?? 0) * (images[best]?.height ?? 0) ? index : best, 0);
}

export function nextArtIndex(index: number, count: number, delta: number): number {
  return count > 0 ? ((index + delta) % count + count) % count : 0;
}

export function artworkAlt(title: string, image: WorkArtImage, index: number): string {
  return `${title} — ${image.kind} ${index + 1}`;
}
