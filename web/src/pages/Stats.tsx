import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getInsights,
  getStats,
  type InsightsResult,
  type OnThisDayItem,
  type StatsResult,
  type WeekStatBucket,
  type MonthStatBucket,
} from "../api";
import { sourceIcon } from "../lib/calendar";
import { formatLocalDay } from "../lib/format-date";
import {
  describeCurrentStreak,
  formatDayCount,
  formatOnThisDayHeading,
  formatStreakRange,
} from "../lib/insights";
import { SOURCES, sourceLabel } from "../lib/sources";
import {
  autoMetricForSource,
  computeBarHeight,
  computeMaxMetric,
  computeMetricSegments,
  fillMonthGaps,
  fillWeekGaps,
  formatHoursMinutes,
  formatMetricShort,
  formatMetricValue,
  formatPeriodLabel,
  formatTopItemMetric,
  metricValue,
  showYoutubeMetricNote,
  sourceColor,
  STATS_SOURCES,
  type ActivityMetric,
} from "../lib/stats";

type Period = "week" | "month";

/** Cover thumbnail with a source-icon fallback when missing or broken. */
function OnThisDayThumbnail({ item }: { item: OnThisDayItem }) {
  const [failed, setFailed] = useState(false);

  if (item.cover_url && !failed) {
    return (
      <img
        class="otd-item-cover"
        src={item.cover_url}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span class="otd-item-icon-badge" aria-hidden="true">
      {sourceIcon(item.source, item.media_type)}
    </span>
  );
}

export function Stats() {
  const [period, setPeriod] = useState<Period>("week");
  const [source, setSource] = useState<string>("");
  const [metric, setMetric] = useState<ActivityMetric>("minutes");
  const [data, setData] = useState<StatsResult | null>(null);
  const [insights, setInsights] = useState<InsightsResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // YouTube events have no duration: picking YouTube defaults to Count.
  const handleSourceChange = (value: string) => {
    setSource(value);
    if (autoMetricForSource(value) === "count") {
      setMetric("count");
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const srcParam = source !== "" ? source : undefined;
    Promise.all([getStats({ source: srcParam }), getInsights(srcParam)])
      .then(([statsRes, insightsRes]) => {
        if (!cancelled) {
          setData(statsRes);
          setInsights(insightsRes);
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

  const maxMetric = useMemo(() => {
    return computeMaxMetric(buckets, metric);
  }, [buckets, metric]);

  const youtubeNote = showYoutubeMetricNote(metric, source);

  // Active sources for chart legend
  const activeSources = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.by_source).filter(
      (src) => (data.by_source[src]?.count ?? 0) > 0
    );
  }, [data]);

  // Per-source streaks: known sources first (in SOURCES order), then any
  // unknown source ids alphabetically.
  const streakSources = useMemo(() => {
    if (!insights) return [];
    const bySource = insights.streaks.by_source;
    const known = SOURCES.map((s) => s.value).filter(
      (value) => bySource[value] !== undefined
    );
    const unknown = Object.keys(bySource)
      .filter((src) => !SOURCES.some((s) => s.value === src))
      .sort((a, b) => a.localeCompare(b));
    return [...known, ...unknown];
  }, [insights]);

  return (
    <div class="page stats-page">
      <header class="stats-header">
        <div class="stats-header-titles">
          <h1>Stats</h1>
          <p class="muted">Consumption trends, breakdown, and top items.</p>
          <a class="yr-stats-link" href="#/year">
            Year in review →
          </a>
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
              onChange={(e) =>
                handleSourceChange((e.target as HTMLSelectElement).value)
              }
            >
              {STATS_SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* Metric Toggle */}
          <div
            class="heatmap-metric-toggle"
            role="group"
            aria-label="Metric toggle"
          >
            <button
              type="button"
              class={`heatmap-metric-btn ${
                metric === "minutes" ? "heatmap-metric-btn-active" : ""
              }`}
              onClick={() => setMetric("minutes")}
              aria-pressed={metric === "minutes"}
            >
              Minutes
            </button>
            <button
              type="button"
              class={`heatmap-metric-btn ${
                metric === "count" ? "heatmap-metric-btn-active" : ""
              }`}
              onClick={() => setMetric("count")}
              aria-pressed={metric === "count"}
            >
              Count
            </button>
          </div>
        </div>
      </header>

      {youtubeNote && (
        <p class="muted stats-youtube-note">
          YouTube counts views, not minutes.
        </p>
      )}

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
                const value = metricValue(b, metric);
                const fullValue = formatMetricValue(value, metric);
                const hasValue = value > 0;
                const heightPct = computeBarHeight(
                  value,
                  maxMetric,
                  hasValue ? 2 : 0
                );
                const byValue =
                  metric === "minutes" ? b.by_source : b.count_by_source;
                const segments = computeMetricSegments(byValue, value);

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
                      {hasValue ? formatMetricShort(value, metric) : ""}
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
                            title={`${sourceLabel(seg.source)}: ${formatMetricValue(seg.value, metric)} (${seg.percentage}%)`}
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

      {/* Streaks Section */}
      <section class="card stats-card" aria-labelledby="stats-streaks-heading">
        <div class="stats-card-header">
          <h2 id="stats-streaks-heading" class="stats-card-title">
            Streaks
          </h2>
          <span class="muted stats-card-subtitle">Consecutive active days</span>
        </div>

        {loading ? (
          <p class="muted stats-loading">Loading streaks...</p>
        ) : !insights ? (
          <p class="muted stats-empty">No streaks recorded yet.</p>
        ) : (
          <>
            <div class="insights-duo">
              <div class="insight-figure">
                <span class="insight-figure-label">Current Streak</span>
                <span class="insight-figure-value">
                  {formatDayCount(insights.streaks.overall.current)}
                </span>
                <span class="insight-figure-sub">
                  {describeCurrentStreak(
                    insights.streaks.overall.current,
                    insights.streaks.overall.last_active,
                    insights.streaks.today
                  )}
                </span>
              </div>
              <div class="insight-figure">
                <span class="insight-figure-label">Longest Streak</span>
                <span class="insight-figure-value">
                  {formatDayCount(insights.streaks.overall.longest)}
                </span>
                <span class="insight-figure-sub">
                  {formatStreakRange(
                    insights.streaks.overall.longest_start,
                    insights.streaks.overall.longest_end
                  ) ?? "No active days yet"}
                </span>
              </div>
            </div>

            {streakSources.length > 0 && (
              <ul class="streak-source-list">
                {streakSources.map((src) => {
                  const info = insights.streaks.by_source[src]!;
                  return (
                    <li key={src} class="streak-source-item">
                      <span
                        class="stats-legend-dot"
                        style={{ backgroundColor: sourceColor(src) }}
                        aria-hidden="true"
                      />
                      <span class="streak-source-name">{sourceLabel(src)}</span>
                      <span class="streak-source-figures">
                        Current {formatDayCount(info.current)} · Longest{" "}
                        {formatDayCount(info.longest)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
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
                    {formatTopItemMetric(item)}
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

      {/* On this day Section */}
      <section class="card stats-card" aria-labelledby="stats-otd-heading">
        <div class="stats-card-header">
          <h2 id="stats-otd-heading" class="stats-card-title">
            On this day
          </h2>
          {insights && (
            <span class="muted stats-card-subtitle">
              {formatLocalDay(insights.on_this_day.date)}
            </span>
          )}
        </div>

        {loading ? (
          <p class="muted stats-loading">Loading...</p>
        ) : !insights || insights.on_this_day.years.length === 0 ? (
          <p class="muted stats-empty">
            Nothing on this date in earlier years.
          </p>
        ) : (
          insights.on_this_day.years.map((group) => (
            <div key={group.year} class="otd-year-group">
              <h3 class="otd-year-heading">
                {formatOnThisDayHeading(group.year, group.years_ago)}
              </h3>
              <ul class="otd-item-list">
                {group.items.map((item) => (
                  <li
                    key={`${item.source}-${item.started_at}-${item.title}`}
                    class="otd-item"
                  >
                    <OnThisDayThumbnail item={item} />
                    <div class="otd-item-body">
                      <span class="otd-item-title">{item.title}</span>
                      <span class="otd-item-meta">
                        {sourceLabel(item.source)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
