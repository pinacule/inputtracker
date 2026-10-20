import type { LibraryWorkDetail } from "../../../src/core/contract";

export function localWorkImage(url: string | null | undefined): string | null {
  return url && /^\/api\/(?:meta-banner|meta-cover|cover|thumb)\/[A-Za-z0-9_/-]+$/.test(url) ? url : null;
}

export function workBannerImage(detail: Pick<LibraryWorkDetail, "banner_url" | "cover_url">, failed: readonly string[]): string | null {
  const banner = localWorkImage(detail.banner_url);
  const cover = localWorkImage(detail.cover_url);
  return banner && !failed.includes(banner) ? banner : cover && !failed.includes(cover) ? cover : null;
}

export function workRankLines(detail: LibraryWorkDetail): string[] {
  if (!detail.rank || detail.status === "planned") return [];
  const label = ({ anime: "anime", series: "series", film: "film", book: "book", audiobook: "audiobook", youtube: "YouTube work", podcast: "podcast", music: "track", shortform: "short-form", other: "work" } as const)[detail.category];
  const lines: string[] = [];
  if (detail.rank.time !== null) {
    const percent = detail.rank.time_share_percent;
    const share = percent > 0 && percent < 1 ? "<1" : String(Math.round(percent));
    lines.push(`Your #${detail.rank.time} ${label} by time · ${share}% of your ${label} hours`);
  }
  if (detail.rating !== null && detail.rank.rating !== null && detail.category !== "music") {
    lines.push(`Your #${detail.rank.rating} highest-rated ${label}`);
  }
  return lines;
}
