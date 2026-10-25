import { useEffect, useState } from "preact/hooks";
import {
  extractInitials,
  resolveItemCategory,
  type Category,
  type MediaKind,
} from "../lib/ui-helpers";
import { MediaKindIcon } from "./icons";

export type CoverSize = "xs" | "sm" | "md" | "lg" | "xl" | "fill";
export type CoverAspect = "square" | "poster" | "wide";

export interface CoverProps {
  /** Image URL (e.g. `/api/cover/...` or `/api/meta-cover/...`), or null/undefined when absent. */
  src?: string | null;
  /** Title used for fallback initials and optional image alt. */
  title?: string | null;
  /** Canonical v2 category (`anime`, `series`, `film`, `book`, `audiobook`, `youtube`, `podcast`, `music`, `other`). */
  category?: Category | null;
  /** Event source (`audiobookshelf`, `simkl`, `youtube`, `manual`). */
  source?: string | null;
  /** Event media type (`audiobook`, `movie`, `episode`, `video`, `book`, etc.). */
  mediaType?: string | null;
  /** Legacy MediaKind override. */
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
  category,
  source,
  mediaType,
  kind,
  size = "md",
  aspect = "square",
  alt = "",
  class: className,
}: CoverProps) {
  const [failed, setFailed] = useState(false);
  // Square art (e.g. Audiobookshelf covers) in a poster frame: shown whole over a blurred copy, not cropped.
  const [letterbox, setLetterbox] = useState(false);

  useEffect(() => {
    setFailed(false);
    setLetterbox(false);
  }, [src]);

  const resolvedCategory: Category =
    category ??
    resolveItemCategory({
      category,
      source,
      media_type: mediaType,
    });
  const initials = extractInitials(title);

  const classes = [
    "ui-cover",
    `ui-cover--${size}`,
    `ui-cover--${aspect}`,
    `ui-cover--cat-${resolvedCategory}`,
    kind ? `ui-cover--${kind}` : "",
    letterbox ? "ui-cover--letterbox" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={classes} aria-hidden={alt === "" ? "true" : undefined}>
      {src && !failed ? (
        <>
          {letterbox && (
            <span
              class="ui-cover-backdrop"
              style={{ backgroundImage: `url("${src}")` }}
            />
          )}
          <img
            class="ui-cover-img"
            src={src}
            alt={alt}
            loading="lazy"
            onLoad={(e) => {
              const img = e.currentTarget;
              setLetterbox(
                aspect === "poster" &&
                  img.naturalHeight > 0 &&
                  img.naturalWidth / img.naturalHeight > 0.8,
              );
            }}
            onError={() => setFailed(true)}
          />
        </>
      ) : (
        <div class="ui-cover-fallback" aria-hidden="true">
          <span class="ui-cover-icon">
            <MediaKindIcon
              category={resolvedCategory}
              kind={kind}
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
