import { useEffect, useState } from "preact/hooks";
import {
  extractInitials,
  resolveMediaKind,
  type MediaKind,
} from "../lib/ui-helpers";
import { MediaKindIcon } from "./icons";

export type CoverSize = "xs" | "sm" | "md" | "lg" | "xl";
export type CoverAspect = "square" | "poster" | "wide";

export interface CoverProps {
  /** Image URL (e.g. `/api/cover/...`), or null/undefined when absent. */
  src?: string | null;
  /** Title used for fallback initials and optional image alt. */
  title?: string | null;
  /** Event source (`audiobookshelf`, `simkl`, `youtube`, `manual`). */
  source?: string | null;
  /** Event media type (`audiobook`, `movie`, `episode`, `video`, `book`, etc.). */
  mediaType?: string | null;
  /** Explicit MediaKind override. */
  kind?: MediaKind;
  size?: CoverSize;
  aspect?: CoverAspect;
  /** Accessible alt text. Defaults to `""` (decorative next to visible title). */
  alt?: string;
  class?: string;
}

export function Cover({
  src,
  title,
  source,
  mediaType,
  kind,
  size = "md",
  aspect = "square",
  alt = "",
  class: className,
}: CoverProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const resolvedKind = kind ?? resolveMediaKind(source, mediaType);
  const initials = extractInitials(title);

  const classes = [
    "ui-cover",
    `ui-cover--${size}`,
    `ui-cover--${aspect}`,
    `ui-cover--${resolvedKind}`,
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={classes} aria-hidden={alt === "" ? "true" : undefined}>
      {src && !failed ? (
        <img
          class="ui-cover-img"
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <div class="ui-cover-fallback" aria-hidden="true">
          <span class="ui-cover-icon">
            <MediaKindIcon
              kind={resolvedKind}
              source={source}
              mediaType={mediaType}
            />
          </span>
          <span class="ui-cover-initials">{initials}</span>
        </div>
      )}
    </div>
  );
}
