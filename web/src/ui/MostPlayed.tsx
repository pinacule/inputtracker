import { useEffect, useState } from "preact/hooks";
import { getTop, type Category, type TopBy, type TopKind, type TopResult } from "../api";
import { subscribeWorkEdits } from "../lib/work-edits";
import { formatMinutes } from "../lib/stats";
import { getTodayLocalDate } from "../lib/home";
import { Card } from "./Card";

export function MostPlayed({ from, to, categories = [], initialRange = "month" }: { from?: string; to?: string; categories?: readonly Category[]; initialRange?: "month" | "year" | "all" }) {
  const [range, setRange] = useState<string>(initialRange);
  const [by, setBy] = useState<TopBy>("plays");
  const [results, setResults] = useState<TopResult[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeWorkEdits(() => setTick((v) => v + 1)), []);
  const today = getTodayLocalDate();
  const rangeFrom = from ?? (range === "all" ? undefined : range === "year" ? `${today.slice(0, 4)}-01-01` : `${today.slice(0, 7)}-01`);
  const rangeTo = to ?? (range === "all" ? undefined : today);
  const kindKey = (["songs", "artists", "channels"] as TopKind[])
    .filter((kind) => categories.length === 0 || categories.includes(kind === "channels" ? "youtube" : "music")).join(",");
  useEffect(() => {
    if (!kindKey) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    Promise.all((kindKey.split(",") as TopKind[]).map((kind) => getTop({ kind, by, from: rangeFrom, to: rangeTo, limit: 5 })))
      .then((data) => { if (!cancelled) { setResults(data); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [by, rangeFrom, rangeTo, tick, kindKey]);
  if (!kindKey) return null;
  return <Card padding="md" title="Most played" actions={
    <div class="most-played-controls">
      {!from && !to && <select class="ui-input" aria-label="Ranking range" value={range} onChange={(e) => setRange(e.currentTarget.value)}>
        <option value="month">This month</option><option value="year">This year</option><option value="all">All time</option>
      </select>}
      <select class="ui-input" aria-label="Rank by" value={by} onChange={(e) => setBy(e.currentTarget.value as TopBy)}>
        <option value="plays">By plays</option><option value="time">By time</option>
      </select>
    </div>
  }>
    {loading ? <p class="ui-text-muted">Loading rankings…</p> : error ? <p role="alert">Could not load rankings.</p> :
      <div class="most-played-grid">{results.filter((r) => categories.length === 0 || categories.includes(r.kind === "channels" ? "youtube" : "music")).map((r) => {
        const max = Math.max(1, ...r.entries.map((e) => by === "plays" ? e.plays : e.total_minutes));
        return <section key={r.kind}>
          <h3 class="settings-subheading">Top {r.kind}</h3>
          {r.entries.length === 0 ? <p class="ui-text-muted">No plays in this period.</p> : <ol class="yt-insights-bar-list">{r.entries.map((entry, index) =>
            <li key={entry.key} class="yt-insights-bar-row">
              <div class="yt-insights-bar-top tabular-nums"><span>{index + 1}. {entry.title}{entry.creator ? ` · ${entry.creator}` : ""}</span>
                <span>{entry.plays} plays · {formatMinutes(entry.total_minutes)}</span></div>
              <div class="yt-bar-track" aria-hidden="true"><div class="yt-bar-fill" style={{ width: `${100 * (by === "plays" ? entry.plays : entry.total_minutes) / max}%`, backgroundColor: `var(--cat-${r.kind === "channels" ? "youtube" : "music"}-solid)` }} /></div>
            </li>)}</ol>}
        </section>;
      })}</div>}
  </Card>;
}
