import { useEffect, useState } from "preact/hooks";
import { getTop, getYoutubeOverview, type Category, type TopBy, type TopKind } from "../api";
import { subscribeWorkEdits } from "../lib/work-edits";
import { formatMinutes } from "../lib/stats";
import { getTodayLocalDate } from "../lib/home";
import { Card } from "./Card";

/** What the one "Most played" card can rank: three /api/top kinds plus YouTube topics. */
type View = TopKind | "topics";

const VIEWS: ReadonlyArray<{ id: View; label: string; category: Category }> = [
  { id: "songs", label: "Songs", category: "music" },
  { id: "artists", label: "Artists", category: "music" },
  { id: "channels", label: "Channels", category: "youtube" },
  { id: "topics", label: "Topics", category: "youtube" },
];

interface Row {
  key: string;
  title: string;
  /** Artist for songs, topic for channels, channel count for topics. */
  detail: string | null;
  plays: number;
  minutes: number;
  href: string | null;
}

const LIMIT = 8;

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div class="mp-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          class={value === option.id ? "mp-seg mp-seg--on" : "mp-seg"}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One ranked list with a switch for what is ranked (songs, artists, channels, YouTube topics),
 * the period and plays vs time. Used in Insights, Review and the Library's Music/YouTube views.
 */
export function MostPlayed({ from, to, categories = [], initialRange = "month" }: {
  from?: string;
  to?: string;
  categories?: readonly Category[];
  initialRange?: "month" | "year" | "all";
}) {
  const views = VIEWS.filter((v) => categories.length === 0 || categories.includes(v.category));
  const [view, setView] = useState<View>(views[0]?.id ?? "songs");
  const [range, setRange] = useState<"month" | "year" | "all">(initialRange);
  const [by, setBy] = useState<TopBy>("plays");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeWorkEdits(() => setTick((v) => v + 1)), []);

  const activeView = views.some((v) => v.id === view) ? view : views[0]?.id;
  const today = getTodayLocalDate();
  const rangeFrom = from ?? (range === "all" ? undefined : range === "year" ? `${today.slice(0, 4)}-01-01` : `${today.slice(0, 7)}-01`);
  const rangeTo = to ?? (range === "all" ? undefined : today);

  useEffect(() => {
    if (!activeView) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    const load: Promise<Row[]> = activeView === "topics"
      ? getYoutubeOverview({ from: rangeFrom, to: rangeTo }).then((overview) =>
          overview.topics.map((t) => ({
            key: t.topic,
            title: t.topic,
            detail: `${t.channels} ${t.channels === 1 ? "channel" : "channels"}`,
            plays: t.videos,
            minutes: t.total_minutes,
            href: `#/library?cat=youtube&topic=${encodeURIComponent(t.topic)}`,
          })))
      : getTop({ kind: activeView, by, from: rangeFrom, to: rangeTo, limit: LIMIT }).then((result) =>
          result.entries.map((e) => ({
            key: e.key,
            title: e.title,
            detail: e.creator ?? null,
            plays: e.plays,
            minutes: e.total_minutes,
            href: activeView === "channels" ? `#/library?cat=youtube&channel=${encodeURIComponent(e.title)}` : null,
          })));
    load
      .then((next) => {
        if (cancelled) return;
        const sorted = [...next].sort((a, b) => by === "plays" ? b.plays - a.plays || b.minutes - a.minutes : b.minutes - a.minutes || b.plays - a.plays);
        setRows(sorted.slice(0, LIMIT));
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [activeView, by, rangeFrom, rangeTo, tick]);

  if (!activeView) return null;
  const category = VIEWS.find((v) => v.id === activeView)!.category;
  const unit = activeView === "topics" ? "videos" : "plays";
  const max = Math.max(1, ...rows.map((r) => by === "plays" ? r.plays : r.minutes));

  return (
    <Card padding="md" class="most-played">
      <div class="mp-head">
        <h2 class="mp-title">Most played</h2>
        <Segmented label="What to rank" value={activeView} options={views} onChange={setView} />
      </div>
      <div class="mp-controls">
        {!from && !to && (
          <Segmented
            label="Period"
            value={range}
            options={[{ id: "month", label: "Month" }, { id: "year", label: "Year" }, { id: "all", label: "All time" }]}
            onChange={setRange}
          />
        )}
        <Segmented
          label="Rank by"
          value={by}
          options={[{ id: "plays", label: unit === "videos" ? "Videos" : "Plays" }, { id: "time", label: "Time" }]}
          onChange={setBy}
        />
      </div>
      {loading ? <p class="ui-text-muted">Loading…</p>
        : error ? <p role="alert">Could not load rankings.</p>
        : rows.length === 0 ? <p class="ui-text-muted">Nothing played in this period.</p>
        : (
          <ol class="mp-list" style={{ "--mp-color": `var(--cat-${category}-solid)` }}>
            {rows.map((row, index) => {
              const value = by === "plays" ? row.plays : row.minutes;
              const primary = by === "plays" ? `${row.plays} ${row.plays === 1 ? unit.slice(0, -1) : unit}` : formatMinutes(row.minutes);
              const secondary = by === "plays" ? formatMinutes(row.minutes) : `${row.plays} ${row.plays === 1 ? unit.slice(0, -1) : unit}`;
              const name = <span class="mp-name">{row.title}</span>;
              return (
                <li key={row.key} class="mp-row">
                  <span class="mp-rank tabular-nums" aria-hidden="true">{index + 1}</span>
                  <span class="mp-text">
                    {row.href ? <a href={row.href} class="mp-link">{name}</a> : name}
                    {row.detail && <span class="mp-detail">{row.detail}</span>}
                  </span>
                  <span class="mp-value tabular-nums">
                    <strong>{primary}</strong>
                    <span class="mp-secondary">{secondary}</span>
                  </span>
                  <span class="mp-bar" aria-hidden="true"><span style={{ width: `${(100 * value) / max}%` }} /></span>
                </li>
              );
            })}
          </ol>
        )}
    </Card>
  );
}
