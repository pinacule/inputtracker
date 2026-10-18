import { useEffect, useState } from "preact/hooks";
import type { Category } from "../../api";
import { CategoryIcon } from "../icons";

export interface HomeWorkThumbProps {
  readonly coverUrl: string | null | undefined;
  readonly category: Category;
  readonly size?: "sm" | "md";
  readonly aspect?: "poster" | "square";
}

/**
 * Renders a real cover thumbnail ONLY when `coverUrl` exists and loads cleanly.
 * When `coverUrl` is absent or 404s, renders a calm, compact category icon badge
 * instead of a large gradient letter tile so the home page is never bloated with
 * fake covers.
 */
export function HomeWorkThumb({
  coverUrl,
  category,
  size = "sm",
  aspect = category === "audiobook" ||
  category === "podcast" ||
  category === "music"
    ? "square"
    : "poster",
}: HomeWorkThumbProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [coverUrl]);

  if (coverUrl && !failed) {
    return (
      <span
        class={`home-work-thumb home-work-thumb--${size} home-work-thumb--${aspect}`}
        aria-hidden="true"
      >
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          class="home-work-thumb-img"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      class={`home-cat-badge home-cat-badge--${size} home-cat-badge--${category}`}
      aria-hidden="true"
    >
      <CategoryIcon category={category} size={size === "md" ? 17 : 15} />
    </span>
  );
}
