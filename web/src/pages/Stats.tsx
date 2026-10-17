import { useEffect, useMemo, useState } from "preact/hooks";
import { getStats, type StatsResult, type WeekStatBucket, type MonthStatBucket } from "../api";
import { sourceIcon } from "../lib/calendar";
import { sourceLabel } from "../lib/sources";
import {
  computeBarHeight,
  computeMaxMinutes,
  computeStackedSegments,
  fillMonthGaps,
  fillWeekGaps,
  formatHoursMinutes,
  formatMinutes,
  formatMinutesShort,
  formatPeriodLabel,
  sourceColor,
  STATS_SOURCES,
} from "../lib/stats";

type Period = "week" | "month";

export function Stats() {
  const [period, setPeriod] = useState<Period>("week");
  const [source, setSource] = useState<string>("");
  const [data, setData] = useState<StatsResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const srcParam = source !== "" ? source : undefined;
    getStats({ source: srcParam })
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  // Active periods for bar chart (gaps filled so empty periods are visible)
  const buckets = useMemo(() => {
    if (!data) return [];
    return period === "week"
      ? fillWeekGaps(data.by_week)
      : fillMonthGaps(data.by_month);
  }, [data, period]);

  const maxMinutes = useMemo(() => {
    return computeMaxMinutes(buckets);
  }, [buckets]);

  // Active sources for chart legend
  const activeSources = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.by_source).filter(
      (src) => (data.by_source[src]?.count ?? 0) > 0
    );
  }, [data]);

  return (
    <div class="page stats-page">
      <header class="stats-header">
        <div class="stats-header-titles">
          <h1>Stats</h1>
          <p class="muted">Consumption trends, breakdown, and top items.</p>
        </div>

        <div class="stats-controls">
          {/* Period Toggle */}
          <div
            class="stats-toggle-group"
            role="group"
            aria-label="Period toggle"
          >
            <button
              type="button"
              class={`stats-toggle-btn ${
                period === "week" ? "stats-toggle-btn-active" : ""
              }`}
              onClick={() => setPeriod("week")}
              aria-pressed={period === "week"}
            >
              Week
            </button>
            <button
              type="button"
              class={`stats-toggle-btn ${
                period === "month" ? "stats-toggle-btn-active" : ""
              }`}
              onClick={() => setPeriod("month")}
              aria-pressed={period === "month"}
            >
              Month
            </button>
          </div>

          {/* Source Filter */}
          <div class="stats-filter">
            <label for="stats-source" class="visually-hidden">
              Source
            </label>
            <select
              id="stats-source"
              class="form-input stats-source-select"
              value={source}
              onChange={(e) => setSource((e.target as HTMLSelectElement).value)}
            >
              {STATS_SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {error && (
        <div class="alert alert-error" role="alert">
          <strong>Error loading stats:</strong> {error}
        </div>
      )}

      {/* Summary Totals */}
      <section class="stats-summary" aria-label="Totals">
        <div class="stats-metric-card">
          <span class="stats-metric-label">Total Time</span>
          <span class="stats-metric-value">
            {formatHoursMinutes(data?.total_minutes ?? 0)}
          </span>
        </div>
        <div class="stats-metric-card">
          <span class="stats-metric-label">Total Items</span>
          <span class="stats-metric-value">{data?.total_items ?? 0}</span>
        </div>
      </section>

      {/* Activity Chart Section */}
      <section class="card stats-card" aria-labelledby="stats-chart-heading">
        <div class="stats-card-header">
          <h2 id="stats-chart-heading" class="stats-card-title">
            Activity by {period === "week" ? "Week" : "Month"}
          </h2>
          {activeSources.length > 0 && (
            <div class="stats-legend" aria-hidden="true">
              {activeSources.map((src) => (
                <span key={src} class="stats-legend-item">
                  <span
                    class="stats-legend-dot"
                    style={{ backgroundColor: sourceColor(src) }}
                  />
                  <span class="stats-legend-name">{sourceLabel(src)}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <p class="muted stats-loading">Loading stats...</p>
        ) : buckets.length === 0 ? (
          <p class="muted stats-empty">No activity recorded for this filter.</p>
        ) : (
          <div
            class="stats-chart-scroll"
            tabIndex={0}
            role="region"
            aria-label={`Activity by ${period}`}
          >
            <div class="stats-chart">
              {buckets.map((b) => {
                const periodKey = "week" in b ? (b as WeekStatBucket).week : (b as MonthStatBucket).month;
                const label = formatPeriodLabel(periodKey, period);
                const fullValue = formatMinutes(b.minutes);
                const hasValue = b.minutes > 0;
                const heightPct = computeBarHeight(
                  b.minutes,
                  maxMinutes,
                  hasValue ? 2 : 0
                );
                const segments = computeStackedSegments(b.by_source, b.minutes);

                return (
                  <div
                    key={periodKey}
                    class="stats-chart-col"
                    aria-label={`${periodKey}: ${fullValue}`}
                  >
                    <span
                      class="stats-bar-val"
                      title={`${fullValue} total`}
                      aria-hidden="true"
                    >
                      {hasValue ? formatMinutesShort(b.minutes) : ""}
                    </span>
                    <div
                      class="stats-bar-track"
                      title={`${periodKey}: ${fullValue}`}
                    >
                      <div
                        class="stats-bar-fill"
                        style={{ height: `${heightPct}%` }}
                      >
                        {segments.map((seg) => (
                          <div
                            key={seg.source}
                            class="stats-bar-segment"
                            style={{
                              height: `${seg.percentage}%`,
                              backgroundColor: sourceColor(seg.source),
                            }}
                            title={`${sourceLabel(seg.source)}: ${formatMinutes(seg.minutes)} (${seg.percentage}%)`}
                          />
                        ))}
                      </div>
                    </div>
                    <span class="stats-bar-label" title={periodKey}>
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* Top Items Section */}
      <section class="card stats-card" aria-labelledby="stats-top-heading">
        <div class="stats-card-header">
          <h2 id="stats-top-heading" class="stats-card-title">
            Top Items
          </h2>
          <span class="muted stats-card-subtitle">By minutes consumed</span>
        </div>

        {loading ? (
          <p class="muted stats-loading">Loading top items...</p>
        ) : !data || data.top_items.length === 0 ? (
          <p class="muted stats-empty">No items recorded yet.</p>
        ) : (
          <ol class="stats-top-list">
            {data.top_items.map((item, index) => (
              <li key={`${item.source}-${item.title}-${index}`} class="stats-top-item">
                <span class="stats-top-rank">{index + 1}</span>
                <span class="stats-top-icon" aria-hidden="true">
                  {sourceIcon(item.source, item.media_type)}
                </span>
                <div class="stats-top-info">
                  <span class="stats-top-title">{item.title}</span>
                  <span class="stats-top-meta">
                    <span class="stats-top-source">
                      {sourceLabel(item.source)}
                    </span>
                    <span class="stats-top-sep">·</span>
                    <span class="stats-top-type">{item.media_type}</span>
                  </span>
                </div>
                <div class="stats-top-stats">
                  <span class="stats-top-time">
                    {formatHoursMinutes(item.minutes)}
                  </span>
                  <span class="stats-top-count">
                    {item.count} {item.count === 1 ? "entry" : "entries"}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
