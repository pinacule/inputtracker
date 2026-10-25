import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { categoryCssColor, categoryPluralLabel } from "../../lib/categories";
import {
  buildDayMapGroups,
  compactMinutes,
  layoutTreemap,
  type DayMapGroup,
  type DayMapItem,
} from "../../lib/day-map";
import type { HomeDayDetailModel } from "../../lib/home";
import { formatMinutes } from "../../lib/stats";
import { bindContextMenu } from "../ContextMenu";

/** Gap between category tiles and the inset of item cells, in px. */
const TILE_GAP = 4;
const CELL_INSET = 3;

/** Desktop keeps one height; phones grow taller on busy days so cells keep room for names. */
function mapHeight(width: number, itemCount: number): number {
  if (width >= 700) return itemCount > 10 ? 420 : 360;
  return Math.round(Math.min(720, Math.max(300, width * 1.1 + itemCount * 18)));
}

function Cell({
  item,
  x,
  y,
  w,
  h,
  showName,
}: {
  item: DayMapItem;
  x: number;
  y: number;
  w: number;
  h: number;
  showName: boolean;
}) {
  const label = `${item.title}, ${formatMinutes(item.minutes)}`;
  const style = { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` };
  const body = (
    <>
      <span class="home-map-fill" aria-hidden="true" />
      {showName && (
        <span class="home-map-name" aria-hidden="true">
          <b>{item.title}</b>
          <span class="tabular-nums">{compactMinutes(item.minutes)}</span>
        </span>
      )}
    </>
  );
  if (!item.href) {
    return (
      <span class="home-map-cell" style={style} title={label} aria-label={label} role="img">
        {body}
      </span>
    );
  }
  return (
    <a
      class="home-map-cell"
      href={item.href}
      style={style}
      title={label}
      aria-label={label}
      {...(item.menu ? bindContextMenu(item.menu) : {})}
    >
      {body}
    </a>
  );
}

function Tile({ group, w, h }: { group: DayMapGroup; w: number; h: number }) {
  const innerW = Math.max(0, w - 2);
  const innerH = Math.max(0, h - 2);
  const cells = layoutTreemap(
    group.items,
    { x: CELL_INSET, y: CELL_INSET, w: innerW - CELL_INSET * 2, h: innerH - CELL_INSET * 2 },
    (i) => i.minutes
  );
  const big = cells[0];
  const time = compactMinutes(group.minutes);
  // The header lives inside the biggest cell so it never crosses a split.
  const headBoxW = Math.max(0, (big ? big.w : innerW) - 20);
  const headBoxH = big ? big.h : innerH;
  const fontSize = Math.round(
    Math.max(
      14,
      Math.min(54, headBoxW / (time.length * 0.62), innerH / 4.6, headBoxH - 40)
    )
  );
  const headHeight = 26 + fontSize + 12;
  const showLabel = headBoxW >= 76;
  const name = categoryPluralLabel(group.category);

  return (
    <div
      class="home-map-tile-inner"
      style={{ "--map-cat": categoryCssColor(group.category) }}
      role="group"
      aria-label={`${name}: ${formatMinutes(group.minutes)}, ${group.items.length} ${
        group.items.length === 1 ? "item" : "items"
      }`}
    >
      {cells.map((c, i) => {
        const free = i === 0 ? c.h - headHeight : c.h;
        return (
          <Cell
            key={c.key}
            item={c}
            x={c.x}
            y={c.y}
            w={c.w}
            h={c.h}
            showName={c.w > 96 && free > 30}
          />
        );
      })}
      <div class="home-map-head" aria-hidden="true" style={{ width: `${headBoxW - 4}px` }}>
        <span class="home-map-label">
          <span class="home-map-dot" />
          {showLabel && (
            <span>
              {name} · {group.items.length}
            </span>
          )}
        </span>
        <span class="home-map-time" style={{ fontSize: `${fontSize}px` }}>
          {time}
        </span>
      </div>
    </div>
  );
}

/**
 * The day's entries as category tiles sized by time, each split into item
 * cells sized by time. Names sit inside their own cell; cells too small for a
 * name stay blank and show it on hover (title) and to screen readers.
 */
export function DayMap({ model }: { model: HomeDayDetailModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const groups = buildDayMapGroups(model);
  const itemCount = groups.reduce((n, g) => n + g.items.length, 0);
  const height = mapHeight(width || 800, itemCount);
  const tiles =
    width > 0
      ? layoutTreemap(groups, { x: 0, y: 0, w: width, h: height }, (g) => g.minutes)
      : [];

  return (
    <div
      ref={ref}
      class="home-day-map"
      style={{ height: `${height}px` }}
      aria-label={`${model.heading}: what took the time`}
    >
      {tiles.map((t) => (
        <div
          key={t.category}
          class="home-map-tile"
          style={{
            left: `${t.x}px`,
            top: `${t.y}px`,
            width: `${t.w}px`,
            height: `${t.h}px`,
            padding: `${TILE_GAP}px`,
          }}
        >
          <Tile group={t} w={t.w - TILE_GAP * 2} h={t.h - TILE_GAP * 2} />
        </div>
      ))}
    </div>
  );
}
