import {
  resolveItemCategory,
  type Category,
  type MediaKind,
  type Route,
} from "../lib/ui-helpers";
import type { AppRoute } from "../lib/router";

export interface IconProps {
  size?: number;
  class?: string;
}

function Svg({
  size = 20,
  class: className,
  children,
}: IconProps & { children: preact.ComponentChildren }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={["ui-icon", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* --- Navigation Icons --- */

export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="17" rx="3" />
      <path d="M8 2v4M16 2v4M3 9h18" />
      <circle cx="8.5" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="14" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function LibraryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M9 7h6M9 11h4" />
    </Svg>
  );
}

export const ProgressIcon = LibraryIcon;

export function HeatmapIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function InsightsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20h16" />
      <rect x="6" y="11" width="3" height="6" rx="1" />
      <rect x="11" y="6" width="3" height="11" rx="1" />
      <rect x="16" y="9" width="3" height="8" rx="1" />
    </Svg>
  );
}

export const StatsIcon = InsightsIcon;

export function ImportExportIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3v12" />
      <path d="m8 11 4 4 4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </Svg>
  );
}

export function AddIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </Svg>
  );
}

export function ReviewIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2l2.4 5.2L20 8l-4 4 .9 5.6L12 15l-4.9 2.6.9-5.6-4-4 5.6-.8L12 2z" />
    </Svg>
  );
}

export const YearIcon = ReviewIcon;

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/* --- Category & Media Kind Icons --- */

export function AnimeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2.5 14.4 9l6.6 2.4-6.6 2.4L12 20.5l-2.4-6.7L3 11.4 9.6 9 12 2.5z" />
    </Svg>
  );
}

export function AudiobookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </Svg>
  );
}

export function YoutubeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="5" width="19" height="14" rx="4" />
      <polygon points="10 9 15.5 12 10 15 10 9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function FilmIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="M7 4v16M17 4v16M2.5 9h4.5M17 9h4.5M2.5 15h4.5M17 15h4.5" />
    </Svg>
  );
}

export function TvIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="m8 2 4 4 4-4" />
    </Svg>
  );
}

export function PodcastIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
    </Svg>
  );
}

export function MusicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </Svg>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z" />
    </Svg>
  );
}

export function ManualIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  );
}

/* --- Action & Status Icons --- */

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

export function OfflineIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 2l20 20" />
      <path d="M8.5 8.5A10 10 0 0 0 2 12.5M14 5.2A10 10 0 0 1 22 9" />
      <path d="M5 16a6 6 0 0 1 6-2M12 20h.01" />
    </Svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l1.8 4.8L18.5 9.5l-4.7 1.7L12 16l-1.8-4.8L5.5 9.5l4.7-1.7L12 3z" />
      <path d="M19 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8L19 15z" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </Svg>
  );
}

/* --- Composite Icon Pickers --- */

export function RouteIcon({
  route,
  size = 20,
  class: className,
}: { route: Route | AppRoute } & IconProps) {
  switch (route) {
    case "calendar":
      return <CalendarIcon size={size} class={className} />;
    case "progress":
    case "library":
      return <LibraryIcon size={size} class={className} />;
    case "heatmap":
      return <HeatmapIcon size={size} class={className} />;
    case "stats":
    case "insights":
      return <InsightsIcon size={size} class={className} />;
    case "importexport":
      return <ImportExportIcon size={size} class={className} />;
    case "settings":
      return <SettingsIcon size={size} class={className} />;
    case "add":
      return <AddIcon size={size} class={className} />;
    case "year":
    case "review":
      return <ReviewIcon size={size} class={className} />;
    case "search":
      return <SearchIcon size={size} class={className} />;
  }
}

export function CategoryIcon({
  category,
  size = 16,
  class: className,
}: { category: Category } & IconProps) {
  switch (category) {
    case "anime":
      return <AnimeIcon size={size} class={className} />;
    case "series":
      return <TvIcon size={size} class={className} />;
    case "film":
      return <FilmIcon size={size} class={className} />;
    case "book":
      return <BookIcon size={size} class={className} />;
    case "audiobook":
      return <AudiobookIcon size={size} class={className} />;
    case "youtube":
    case "shortform":
      return <YoutubeIcon size={size} class={className} />;
    case "podcast":
      return <PodcastIcon size={size} class={className} />;
    case "music":
      return <MusicIcon size={size} class={className} />;
    case "other":
      return <ManualIcon size={size} class={className} />;
  }
}

export function MediaKindIcon({
  category,
  kind,
  source,
  mediaType,
  size = 16,
  class: className,
}: {
  category?: Category | null;
  kind?: MediaKind;
  source?: string | null;
  mediaType?: string | null;
} & IconProps) {
  if (category) {
    return <CategoryIcon category={category} size={size} class={className} />;
  }
  const m = (mediaType ?? "").toLowerCase().trim();
  if (m === "podcast" || m === "podcast_episode") {
    return <PodcastIcon size={size} class={className} />;
  }
  if (m === "episode" || m === "tv") {
    return <TvIcon size={size} class={className} />;
  }
  if (m === "music") {
    return <MusicIcon size={size} class={className} />;
  }
  if (m === "book") {
    return <BookIcon size={size} class={className} />;
  }

  if (kind) {
    switch (kind) {
      case "audiobook":
        return <AudiobookIcon size={size} class={className} />;
      case "youtube":
        return <YoutubeIcon size={size} class={className} />;
      case "film":
        return <FilmIcon size={size} class={className} />;
      case "manual":
        return <ManualIcon size={size} class={className} />;
    }
  }

  const resolvedCat = resolveItemCategory({
    source,
    media_type: mediaType,
  });
  return <CategoryIcon category={resolvedCat} size={size} class={className} />;
}
