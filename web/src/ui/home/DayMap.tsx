import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { categoryCssColor, categoryPluralLabel } from "../../lib/categories";
import {
  buildDayMapGroups,
  compactMinutes,
  layoutTreemap,
  type DayMapGroup,
  type DayMapItem,
} from "../../lib/day-map";
import type { Category } from "../../api";
import type { HomeDayDetailModel } from "../../lib/home";
import { formatMinutes } from "../../lib/stats";
import { bindContextMenu } from "../ContextMenu";

/** Gap between category tiles and the inset of item cells, in px. */
const TILE_GAP = 3;
const CELL_INSET = 2;

/** Compact on desktop; phones grow a little on busy days so cells stay tappable. */
function mapHeight(width: number, itemCount: number): number {
  if (width >= 700) return itemCount > 10 ? 270 : 230;
  return Math.round(Math.min(480, Math.max(220, width * 0.7 + itemCount * 12)));
}

interface TipState {
  readonly item: DayMapItem;
  readonly category: Category;
  /** Anchor point in map coordinates: horizontal centre, top edge of the cell. */
  readonly x: number;
  readonly y: number;
  readonly below: boolean;
}

type Hover = (item: DayMapItem, rect: { x: number; y: number; w: number; h: number }) => void;

function Cell({
  item,
  x,
  y,
  w,
  h,
  showName,
  onHover,
  onLeave,
}: {
  item: DayMapItem;
  x: number;
  y: number;
  w: number;
  h: number;
  showName: boolean;
  onHover: Hover;
  onLeave: () => void;
}) {
  const label = `${item.title}${item.detail ? `, ${item.detail}` : ""}, ${formatMinutes(item.minutes)}`;
  const style = { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` };
  const hover = () => onHover(item, { x, y, w, h });
  const events = { onMouseEnter: hover, onFocus: hover, onMouseLeave: onLeave, onBlur: onLeave };
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
      <span class="home-map-cell" style={style} aria-label={label} role="img" tabIndex={0} {...events}>
        {body}
      </span>
    );
  }
  return (
    <a
      class="home-map-cell"
      href={item.href}
      style={style}
      aria-label={label}
      {...events}
      {...(item.menu ? bindContextMenu(item.menu) : {})}
    >
      {body}
    </a>
  );
}

function Tile({
  group,
  w,
  h,
  onHover,
  onLeave,
}: {
  group: DayMapGroup;
  w: number;
  h: number;
  onHover: Hover;
  onLeave: () => void;
}) {
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
  const headBoxW = Math.max(0, (big ? big.w : innerW) - 16);
  const headBoxH = big ? big.h : innerH;
  const fontSize = Math.round(
    Math.max(13, Math.min(38, headBoxW / (time.length * 0.62), innerH / 4, headBoxH - 34))
  );
  const headHeight = 22 + fontSize + 8;
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
            showName={c.w > 90 && free > 24}
            onHover={onHover}
            onLeave={onLeave}
          />
        );
      })}
      <div class="home-map-head" aria-hidden="true" style={{ width: `${headBoxW - 2}px` }}>
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
 * cells sized by time. Names sit inside their own cell; small cells stay blank
 * and show an instant tooltip on hover or focus.
 */
export function DayMap({ model }: { model: HomeDayDetailModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<TipState | null>(null);

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

  const tipLeft = tip ? Math.min(Math.max(tip.x, 110), Math.max(110, width - 110)) : 0;

  return (
    <div
      ref={ref}
      class="home-day-map"
      style={{ height: `${height}px` }}
      aria-label={`${model.heading}: what took the time`}
      onMouseLeave={() => setTip(null)}
    >
      {tiles.map((t) => {
        // Tile origin in map coordinates: tile padding plus the 1px border.
        const ox = t.x + TILE_GAP + 1;
        const oy = t.y + TILE_GAP + 1;
        return (
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
            <Tile
              group={t}
              w={t.w - TILE_GAP * 2}
              h={t.h - TILE_GAP * 2}
              onHover={(item, r) => {
                const top = oy + r.y;
                setTip({
                  item,
                  category: t.category,
                  x: ox + r.x + r.w / 2,
                  y: top < 64 ? oy + r.y + r.h : top,
                  below: top < 64,
                });
              }}
              onLeave={() => setTip(null)}
            />
          </div>
        );
      })}
      {tip && (
        <div
          class={tip.below ? "home-map-tip home-map-tip--below" : "home-map-tip"}
          style={{ left: `${tipLeft}px`, top: `${tip.y}px`, "--map-cat": categoryCssColor(tip.category) }}
          role="tooltip"
        >
          <span class="home-map-tip-title">
            <span class="home-map-dot" />
            {tip.item.title}
          </span>
          {tip.item.detail && <span class="home-map-tip-detail">{tip.item.detail}</span>}
          <span class="home-map-tip-time tabular-nums">{formatMinutes(tip.item.minutes)}</span>
        </div>
      )}
    </div>
  );
}
