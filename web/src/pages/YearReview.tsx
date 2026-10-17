import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getYearReview,
  type ReviewTitle,
  type YearReview as YearReviewData,
} from "../api";
import { sourceIcon } from "../lib/calendar";
import {
  DEFAULT_TIMEZONE,
  formatDateTime,
  formatLocalDay,
} from "../lib/format-date";
import { formatStreakRange } from "../lib/insights";
import { sourceLabel } from "../lib/sources";
import {
  buildShareLines,
  formatChange,
  formatHours,
  isYoutubeOnly,
  monthLabel,
  weekdayLabel,
} from "../lib/year-review";
import {
  computeBarHeight,
  formatMetricShort,
  STATS_SOURCES,
  type ActivityMetric,
} from "../lib/stats";

/** Cover thumbnail with a source-icon fallback when missing or broken. */
function TitleThumbnail({ item }: { item: ReviewTitle }) {
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

/** Change-vs-previous-year chip; hidden when there is no previous year. */
function Change({
  current,
  previous,
}: {
  current: number;
  previous: number | null;
}) {
  if (previous === null) {
    return null;
  }
  return <span class="yr-change">{formatChange(current, previous)}</span>;
}

// --- Save image (shareable PNG drawn on an off-screen canvas) ---------------

const SHARE_WIDTH = 1080;
const SHARE_HEIGHT = 1350;

/** Minimal share surface types so the page never depends on lib.dom details. */
interface ShareFileData {
  files: File[];
  title?: string;
  text?: string;
}
interface ShareNavigator {
  share?: (data: ShareFileData) => Promise<void>;
  canShare?: (data?: ShareFileData) => boolean;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

/** A CSS variable from the app theme, or a light-mode fallback. */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value !== "" ? value : fallback;
}

/** Truncate a line with an ellipsis so it fits the canvas content width. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let fitted = text;
  while (
    fitted.length > 1 &&
    ctx.measureText(`${fitted}…`).width > maxWidth
  ) {
    fitted = fitted.slice(0, -1);
  }
  return `${fitted}…`;
}

/**
 * Renders the 1080×1350 share image: the plain text lines from
 * `buildShareLines` plus a 12-bar month chart, in the app's colours.
 * Text and bars only — no cover images.
 */
function drawShareCanvas(
  review: YearReviewData,
  sourceFilterLabel: string
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SHARE_WIDTH;
  canvas.height = SHARE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return canvas;
  }

  const bg = cssVar("--surface", "#ffffff");
  const fg = cssVar("--fg", "#0f172a");
  const muted = cssVar("--muted", "#64748b");
  const accent = cssVar("--accent", "#2563eb");
  const margin = 72;
  const contentWidth = SHARE_WIDTH - margin * 2;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SHARE_WIDTH, SHARE_HEIGHT);

  const lines = buildShareLines(review, sourceFilterLabel);
  ctx.fillStyle = fg;
  ctx.textBaseline = "alphabetic";
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.fillText(fitText(ctx, lines[0] ?? "", contentWidth), margin, 92);
  ctx.font = "700 88px system-ui, sans-serif";
  ctx.fillText(fitText(ctx, lines[1] ?? "", contentWidth), margin, 190);

  let y = 272;
  ctx.font = "500 40px system-ui, sans-serif";
  for (const line of lines.slice(2)) {
    ctx.fillText(fitText(ctx, line, contentWidth), margin, y);
    y += 56;
  }

  // 12-bar month chart along the bottom (minutes, or views for YouTube).
  const views = isYoutubeOnly(review);
  const values = review.by_month.map((m) => (views ? m.count : m.minutes));
  const max = Math.max(...values, 0);
  const chartTop = 950;
  const chartBottom = 1250;
  const labelY = 1292;
  const gap = 14;
  const barWidth = (contentWidth - gap * 11) / 12;
  ctx.font = "400 22px system-ui, sans-serif";
  for (let i = 0; i < 12; i++) {
    const x = margin + i * (barWidth + gap);
    const value = values[i]!;
    if (max > 0 && value > 0) {
      const height = Math.max(
        4,
        Math.round((value / max) * (chartBottom - chartTop))
      );
      ctx.fillStyle = accent;
      ctx.fillRect(x, chartBottom - height, barWidth, height);
    }
    ctx.fillStyle = muted;
    const label = monthLabel(review.by_month[i]!.month);
    ctx.fillText(label, x + (barWidth - ctx.measureText(label).width) / 2, labelY);
  }

  return canvas;
}

// --- Page -------------------------------------------------------------------

export function YearReviewPage({ yearParam }: { yearParam?: string }) {
  const [source, setSource] = useState<string>("");
  const [selectedYear, setSelectedYear] = useState<number | null>(
    yearParam ? Number(yearParam) : null
  );
  const [homeYear, setHomeYear] = useState<number | null>(null);
  const [data, setData] = useState<YearReviewData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  // Keep the picker in sync when the hash changes (back/forward navigation).
  useEffect(() => {
    setSelectedYear(yearParam ? Number(yearParam) : null);
  }, [yearParam]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getYearReview(
      selectedYear ?? undefined,
      source !== "" ? source : undefined
    )
      .then((res) => {
        if (!cancelled) {
          setData(res);
          // A fetch without an explicit year resolved the server's current
          // local year; remember it so the picker can always offer it back.
          if (selectedYear === null) {
            setHomeYear(res.year);
          }
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
  }, [selectedYear, source]);

  // Years offered by the picker: every year with events, plus the displayed
  // year and the server's current year so the picker never dead-ends.
  const pickerYears = useMemo(() => {
    if (!data) {
      return [];
    }
    const years = new Set(data.available_years);
    years.add(data.year);
    if (homeYear !== null) {
      years.add(homeYear);
    }
    return Array.from(years).sort((a, b) => b - a);
  }, [data, homeYear]);

  const prevYear = useMemo(() => {
    if (!data) return null;
    const below = pickerYears.filter((y) => y < data.year);
    return below.length > 0 ? Math.max(...below) : null;
  }, [pickerYears, data]);

  const nextYear = useMemo(() => {
    if (!data) return null;
    const above = pickerYears.filter((y) => y > data.year);
    return above.length > 0 ? Math.min(...above) : null;
  }, [pickerYears, data]);

  const sourceFilterLabel = source === "" ? "All sources" : sourceLabel(source);

  // YouTube-only reviews count views: no durations exist to sum.
  const viewsMode =
    data !== null && (source === "youtube" || isYoutubeOnly(data));

  // Bars show minutes, or counts when every minute is 0 (YouTube-only years,
  // or sources without durations).
  const metric: ActivityMetric =
    data !== null && data.totals.minutes === 0 ? "count" : "minutes";

  const maxMonthValue = useMemo(() => {
    if (!data) return 0;
    return Math.max(
      ...data.by_month.map((m) => (metric === "count" ? m.count : m.minutes)),
      0
    );
  }, [data, metric]);

  const maxWeekdayValue = useMemo(() => {
    if (!data) return 0;
    return Math.max(
      ...data.by_weekday.map((w) =>
        metric === "count" ? w.count : w.minutes
      ),
      0
    );
  }, [data, metric]);

  async function handleSaveImage() {
    if (!data || data.totals.items === 0 || saving) {
      return;
    }
    setSaving(true);
    try {
      const canvas = drawShareCanvas(data, sourceFilterLabel);
      const blob = await canvasToBlob(canvas);
      if (!blob) {
        return;
      }
      const file = new File([blob], `inputtracker-${data.year}.png`, {
        type: "image/png",
      });
      const nav = navigator as ShareNavigator;
      if (
        typeof nav.share === "function" &&
        nav.canShare?.({ files: [file] })
      ) {
        try {
          await nav.share({
            files: [file],
            title: `InputTracker — Year in review ${data.year}`,
          });
        } catch {
          // User cancelled (or the share sheet failed); nothing to fall back to.
        }
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `inputtracker-${data.year}.png`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="page stats-page">
      <header class="stats-header">
        <div class="stats-header-titles">
          <h1>Year in review</h1>
          <p class="muted">One year of consumption, summarised.</p>
        </div>

        <div class="stats-controls">
          {/* Year picker */}
          <div class="stats-toggle-group" role="group" aria-label="Year picker">
            <button
              type="button"
              class="stats-toggle-btn yr-year-btn"
              onClick={() => {
                if (prevYear !== null) setSelectedYear(prevYear);
              }}
              disabled={prevYear === null || loading}
              aria-label="Previous year"
            >
              ‹
            </button>
            <span class="yr-year-value" aria-live="polite">
              {data ? `${data.year}${data.partial ? " · so far" : ""}` : "…"}
            </span>
            <button
              type="button"
              class="stats-toggle-btn yr-year-btn"
              onClick={() => {
                if (nextYear !== null) setSelectedYear(nextYear);
              }}
              disabled={nextYear === null || loading}
              aria-label="Next year"
            >
              ›
            </button>
          </div>

          {/* Source filter (same as the Stats page) */}
          <div class="stats-filter">
            <label for="year-source" class="visually-hidden">
              Source
            </label>
            <select
              id="year-source"
              class="form-input stats-source-select"
              value={source}
              onChange={(e) =>
                setSource((e.target as HTMLSelectElement).value)
              }
            >
              {STATS_SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            class="btn btn-primary yr-save-btn"
            onClick={handleSaveImage}
            disabled={!data || saving || data.totals.items === 0}
          >
            {saving ? "Rendering…" : "Save image"}
          </button>
        </div>
      </header>

      {source === "youtube" && (
        <p class="muted stats-youtube-note">
          YouTube counts views, not minutes.
        </p>
      )}

      {error && (
        <div class="alert alert-error" role="alert">
          <strong>Error loading year in review:</strong> {error}
        </div>
      )}

      {loading && <p class="muted stats-loading">Loading year…</p>}

      {data && data.totals.items === 0 && (
        <section class="card stats-card" aria-label="Empty year">
          <p class="muted stats-empty">Nothing recorded in {data.year}.</p>
        </section>
      )}

      {data && data.totals.items > 0 && (
        <>
          {/* 1. Totals */}
          <section class="card stats-card" aria-labelledby="yr-totals-heading">
            <div class="stats-card-header">
              <h2 id="yr-totals-heading" class="stats-card-title">
                In numbers
              </h2>
              <span class="muted stats-card-subtitle">
                {data.partial ? "so far" : `${data.days_in_range} days`}
              </span>
            </div>
            <div class="stats-summary">
              <div class="stats-metric-card">
                <span class="stats-metric-label">
                  {viewsMode ? "Views" : "Hours"}
                </span>
                <span class="stats-metric-value">
                  {viewsMode
                    ? data.totals.items
                    : formatHours(data.totals.minutes)}
                </span>
                <Change
                  current={viewsMode ? data.totals.items : data.totals.minutes}
                  previous={
                    data.previous === null
                      ? null
                      : viewsMode
                        ? data.previous.items
                        : data.previous.minutes
                  }
                />
              </div>
              {!viewsMode && (
                <div class="stats-metric-card">
                  <span class="stats-metric-label">Items</span>
                  <span class="stats-metric-value">{data.totals.items}</span>
                  <Change
                    current={data.totals.items}
                    previous={data.previous?.items ?? null}
                  />
                </div>
              )}
              <div class="stats-metric-card">
                <span class="stats-metric-label">Active days</span>
                <span class="stats-metric-value">
                  {data.totals.active_days}
                </span>
                <span class="yr-change">of {data.days_in_range} days</span>
              </div>
              <div class="stats-metric-card">
                <span class="stats-metric-label">Titles</span>
                <span class="stats-metric-value">{data.totals.titles}</span>
                <Change
                  current={data.totals.titles}
                  previous={data.previous?.titles ?? null}
                />
              </div>
            </div>
          </section>

          {/* 2. Months */}
          <section class="card stats-card" aria-labelledby="yr-months-heading">
            <div class="stats-card-header">
              <h2 id="yr-months-heading" class="stats-card-title">
                Months
              </h2>
              <span class="muted stats-card-subtitle">
                {metric === "count"
                  ? viewsMode
                    ? "Views per month"
                    : "Items per month"
                  : "Minutes per month"}
              </span>
            </div>
            <div
              class="yr-months"
              role="img"
              aria-label={`${metric === "count" ? "Items" : "Minutes"} per month`}
            >
              <div class="stats-chart">
                {data.by_month.map((m) => {
                  const value = metric === "count" ? m.count : m.minutes;
                  const hasValue = value > 0;
                  return (
                    <div
                      key={m.month}
                      class="stats-chart-col"
                      aria-label={`${monthLabel(m.month)}: ${formatMetricShort(value, metric)}`}
                    >
                      <span class="stats-bar-val" aria-hidden="true">
                        {hasValue ? formatMetricShort(value, metric) : ""}
                      </span>
                      <div class="stats-bar-track">
                        <div
                          class="stats-bar-fill"
                          style={{
                            height: `${computeBarHeight(
                              value,
                              maxMonthValue,
                              hasValue ? 2 : 0
                            )}%`,
                          }}
                        />
                      </div>
                      <span class="stats-bar-label">{monthLabel(m.month)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* 3. Top titles */}
          <section class="card stats-card" aria-labelledby="yr-titles-heading">
            <div class="stats-card-header">
              <h2 id="yr-titles-heading" class="stats-card-title">
                Top titles
              </h2>
              <span class="muted stats-card-subtitle">Most consumed</span>
            </div>
            <ol class="stats-top-list">
              {data.top_titles.map((item, index) => (
                <li
                  key={`${item.source}-${item.title}`}
                  class="stats-top-item"
                >
                  <span class="stats-top-rank">{index + 1}</span>
                  <TitleThumbnail item={item} />
                  <div class="stats-top-info">
                    <span class="stats-top-title">{item.title}</span>
                    <span class="stats-top-meta">
                      {sourceLabel(item.source)}
                    </span>
                  </div>
                  <div class="stats-top-stats">
                    <span class="stats-top-time">
                      {item.minutes > 0
                        ? formatHours(item.minutes)
                        : `${item.count} views`}
                    </span>
                    <span class="stats-top-count">
                      {item.count} {item.count === 1 ? "play" : "plays"}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* 4. Top channels (YouTube only) */}
          {data.top_channels.length > 0 && (
            <section
              class="card stats-card"
              aria-labelledby="yr-channels-heading"
            >
              <div class="stats-card-header">
                <h2 id="yr-channels-heading" class="stats-card-title">
                  Top channels
                </h2>
                <span class="muted stats-card-subtitle">YouTube</span>
              </div>
              <ul class="streak-source-list">
                {data.top_channels.map((channel) => (
                  <li key={channel.name} class="streak-source-item">
                    <span class="streak-source-name">{channel.name}</span>
                    <span class="streak-source-figures">
                      {channel.count} {channel.count === 1 ? "view" : "views"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 5. Highlights */}
          <section
            class="card stats-card"
            aria-labelledby="yr-highlights-heading"
          >
            <div class="stats-card-header">
              <h2 id="yr-highlights-heading" class="stats-card-title">
                Highlights
              </h2>
            </div>
            <div class="insights-duo">
              <div class="insight-figure">
                <span class="insight-figure-label">Busiest day</span>
                <span class="insight-figure-value">
                  {data.busiest_day ? formatLocalDay(data.busiest_day.date) : "—"}
                </span>
                <span class="insight-figure-sub">
                  {data.busiest_day
                    ? `${formatHours(data.busiest_day.minutes)} · ${data.busiest_day.count} items`
                    : "No activity"}
                </span>
              </div>
              <div class="insight-figure">
                <span class="insight-figure-label">Busiest month</span>
                <span class="insight-figure-value">
                  {data.busiest_month
                    ? monthLabel(data.busiest_month.month)
                    : "—"}
                </span>
                <span class="insight-figure-sub">
                  {data.busiest_month
                    ? metric === "count"
                      ? `${data.busiest_month.count} items`
                      : formatHours(data.busiest_month.minutes)
                    : "No activity"}
                </span>
              </div>
              <div class="insight-figure">
                <span class="insight-figure-label">Longest streak</span>
                <span class="insight-figure-value">
                  {data.longest_streak.days > 0
                    ? `${data.longest_streak.days} ${data.longest_streak.days === 1 ? "day" : "days"}`
                    : "—"}
                </span>
                <span class="insight-figure-sub">
                  {formatStreakRange(
                    data.longest_streak.start,
                    data.longest_streak.end
                  ) ?? "No active days"}
                </span>
              </div>
            </div>
            <ul class="streak-source-list">
              {data.first && (
                <li class="streak-source-item">
                  <span class="streak-source-name">First item</span>
                  <span class="streak-source-figures">
                    {data.first.title} · {sourceLabel(data.first.source)} ·{" "}
                    {formatDateTime(data.first.started_at, DEFAULT_TIMEZONE)}
                  </span>
                </li>
              )}
              {data.last && (
                <li class="streak-source-item">
                  <span class="streak-source-name">Last item</span>
                  <span class="streak-source-figures">
                    {data.last.title} · {sourceLabel(data.last.source)} ·{" "}
                    {formatDateTime(data.last.started_at, DEFAULT_TIMEZONE)}
                  </span>
                </li>
              )}
            </ul>
          </section>

          {/* 6. Weekdays */}
          <section
            class="card stats-card"
            aria-labelledby="yr-weekdays-heading"
          >
            <div class="stats-card-header">
              <h2 id="yr-weekdays-heading" class="stats-card-title">
                Weekdays
              </h2>
              <span class="muted stats-card-subtitle">
                {metric === "count" ? "Items" : "Minutes"} per weekday
              </span>
            </div>
            <ul class="yr-weekday-list">
              {data.by_weekday.map((w) => {
                const value = metric === "count" ? w.count : w.minutes;
                const pct =
                  maxWeekdayValue > 0 && value > 0
                    ? Math.round((value / maxWeekdayValue) * 100)
                    : 0;
                return (
                  <li key={w.weekday} class="yr-weekday-row">
                    <span class="yr-weekday-label">
                      {weekdayLabel(w.weekday)}
                    </span>
                    <span class="yr-weekday-track" aria-hidden="true">
                      <span
                        class="yr-weekday-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span class="yr-weekday-val">
                      {formatMetricShort(value, metric)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
