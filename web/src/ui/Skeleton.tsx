export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  circle?: boolean;
  class?: string;
}

export function Skeleton({
  width = "100%",
  height = "1rem",
  circle = false,
  class: className,
}: SkeletonProps) {
  const classes = [
    "ui-skeleton",
    circle ? "ui-skeleton--circle" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      class={classes}
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        height: typeof height === "number" ? `${height}px` : height,
      }}
      aria-hidden="true"
    />
  );
}
