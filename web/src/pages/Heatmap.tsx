import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  getHeatmapDays,
  getHeatmapHours,
  type HeatmapDay,
  type HeatmapHourCell,
} from "../api";
import { formatDuration } from "../lib/calendar";
import {
  buildHourGrid,
  buildYearGrid,
  describeDay,
  HEATMAP_SOURCES,
  levelFor,
  monthLabels,
  WEEKDAYS_SHORT,
} from "../lib/heatmap";

type Metric = "minutes" | "count";

function getCurrentYear(): number {
  return new Date().getFullYear();
}

const HOUR_LABELS: ReadonlyArray<{ hour: number; label: string }> = [
  { hour: 0, label: "0" },
  { hour: 3, label: "3" },
  { hour: 6, label: "6" },
  { hour: 9, label: "9" },
  { hour: 12, label: "12" },
  { hour: 15, label: "15" },
  { hour: 18, label: "18" },
  { hour: 21, label: "21" },
];

export function Heatmap() {
  const currentYear = getCurrentYear();
  const [year, setYear] = useState<number>(currentYear);
  const [source, setSource] = useState<string>("");
  const [metric, setMetric] = useState<Metric>("minutes");

  const [daysData, setDaysData] = useState<HeatmapDay[]>([]);
  const [hoursData, setHoursData] = useState<HeatmapHourCell[]>([]);
  const [unplaced, setUnplaced] = useState<{ count: number; minutes: number }>({
    count: 0,
    minutes: 0,
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const yearScrollRef = useRef<HTMLDivElement>(null);

  // Fetch both days and hours when year or source changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const srcParam = source !== "" ? source : undefined;
    const yearStr = String(year);

    Promise.all([
      getHeatmapDays(yearStr, srcParam),
      getHeatmapHours(yearStr, srcParam),
    ])
      .then(([daysRes, hoursRes]) => {
        if (!cancelled) {
          setDaysData(daysRes.days ?? []);
          setHoursData(hoursRes.cells ?? []);
          setUnplaced({
            count: hoursRes.unplaced_count ?? 0,
            minutes: hoursRes.unplaced_minutes ?? 0,
          });
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
  }, [year, source]);

  // Year grid: weeks as columns (Monday-first), 7 rows
  const weeks = useMemo(() => {
    try {
      return buildYearGrid(year, daysData);
    } catch {
      return [];
    }
  }, [year, daysData]);

  const months = useMemo(() => {
    return monthLabels(weeks);
  }, [weeks]);

  // Hour grid: 7 rows x 24 cols
  const hourMatrix = useMemo(() => {
    return buildHourGrid(hoursData);
  }, [hoursData]);

  // Max calculations for levelFor
  const maxYearMetric = useMemo(() => {
    let max = 0;
    for (const d of daysData) {
      const val = metric === "minutes" ? d.minutes : d.count;
      if (val > max) max = val;
    }
    return max;
  }, [daysData, metric]);

  const maxHourMetric = useMemo(() => {
    let max = 0;
    for (const c of hoursData) {
      const val = metric === "minutes" ? c.minutes : c.count;
      if (val > max) max = val;
    }
    return max;
  }, [hoursData, metric]);

  // Scroll year grid to the right (current end) on load or data update
  useEffect(() => {
    if (yearScrollRef.current) {
      yearScrollRef.current.scrollLeft = yearScrollRef.current.scrollWidth;
    }
  }, [year, daysData]);

  const handlePrevYear = () => {
    setYear((y) => y - 1);
  };

  const handleNextYear = () => {
    setYear((y) => (y < currentYear ? y + 1 : y));
  };

  return (
    <section class="page heatmap-page">
      <header class="heatmap-header">
        <div class="heatmap-title-group">
          <h1>Heatmap</h1>
          {loading && (
            <span class="heatmap-loading-badge" role="status">
              Loading…
            </span>
          )}
        </div>

        <div class="heatmap-controls">
          {/* Year Switch */}
          <div class="heatmap-year-nav" role="toolbar" aria-label="Year navigation">
            <button
              type="button"
              class="heatmap-nav-btn"
              onClick={handlePrevYear}
              aria-label="Previous year"
            >
              ‹ Prev
            </button>
            <span class="heatmap-year-display" aria-live="polite">
              {year}
            </span>
            <button
              type="button"
              class="heatmap-nav-btn"
              onClick={handleNextYear}
              disabled={year >= currentYear}
              aria-label="Next year"
            >
              Next ›
            </button>
          </div>

          {/* Source Filter */}
          <div class="heatmap-filter-group">
            <label for="heatmap-source-select" class="heatmap-filter-label">
              Source
            </label>
            <select
              id="heatmap-source-select"
              class="heatmap-select"
              value={source}
              onChange={(e) => setSource((e.target as HTMLSelectElement).value)}
              aria-label="Source filter"
            >
              <option value="">All</option>
              {HEATMAP_SOURCES.map((s) => (
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

      {error && (
        <div class="heatmap-error" role="alert">
          <strong>Error loading heatmap:</strong> {error}
        </div>
      )}

      {/* Year Grid Section */}
      <section class="heatmap-card" aria-labelledby="year-grid-heading">
        <div class="heatmap-card-header">
          <h2 id="year-grid-heading" class="heatmap-card-title">
            Daily Activity · {year}
          </h2>
          <div class="heatmap-legend" aria-hidden="true">
            <span class="heatmap-legend-label">Less</span>
            <span class="heatmap-legend-cell heatmap-level-0" />
            <span class="heatmap-legend-cell heatmap-level-1" />
            <span class="heatmap-legend-cell heatmap-level-2" />
            <span class="heatmap-legend-cell heatmap-level-3" />
            <span class="heatmap-legend-cell heatmap-level-4" />
            <span class="heatmap-legend-label">More</span>
          </div>
        </div>

        <div
          class="heatmap-year-scroll"
          ref={yearScrollRef}
          tabIndex={0}
          role="region"
          aria-label="Daily activity calendar"
        >
          <div
            class="heatmap-year-grid"
            style={{
              gridTemplateColumns: `28px repeat(${Math.max(
                1,
                weeks.length
              )}, 13px)`,
            }}
          >
            {/* Month labels along the top (Row 1) */}
            {months.map((m) => (
              <span
                key={m.month}
                class="heatmap-month-label"
                style={{
                  gridColumn: m.weekIndex + 2,
                  gridRow: 1,
                }}
              >
                {m.label}
              </span>
            ))}

            {/* Weekday labels along the left (Rows 2..8) */}
            {WEEKDAYS_SHORT.map((wd, dIdx) => (
              <span
                key={wd}
                class="heatmap-weekday-label"
                style={{
                  gridColumn: 1,
                  gridRow: dIdx + 2,
                }}
                aria-hidden="true"
              >
                {dIdx % 2 === 0 ? wd : ""}
              </span>
            ))}

            {/* Week columns and day cells */}
            {weeks.map((week, wIdx) =>
              week.map((day, dIdx) => {
                const col = wIdx + 2;
                const row = dIdx + 2;

                if (!day) {
                  return (
                    <span
                      key={`empty-${wIdx}-${dIdx}`}
                      class="heatmap-day-cell heatmap-day-cell-empty"
                      style={{ gridColumn: col, gridRow: row }}
                      aria-hidden="true"
                    />
                  );
                }

                const val = metric === "minutes" ? day.minutes : day.count;
                const level = levelFor(val, maxYearMetric);
                const desc = describeDay(day);

                return (
                  <a
                    key={day.date}
                    href={`#/calendar?date=${day.date}`}
                    class={`heatmap-day-cell heatmap-level-${level}`}
                    data-level={level}
                    style={{ gridColumn: col, gridRow: row }}
                    aria-label={desc}
                    title={desc}
                  />
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* Hour × Weekday Grid Section */}
      <section class="heatmap-card" aria-labelledby="hour-grid-heading">
        <div class="heatmap-card-header">
          <h2 id="hour-grid-heading" class="heatmap-card-title">
            Hourly Activity by Day of Week
          </h2>
          <div class="heatmap-legend" aria-hidden="true">
            <span class="heatmap-legend-label">Less</span>
            <span class="heatmap-legend-cell heatmap-level-0" />
            <span class="heatmap-legend-cell heatmap-level-1" />
            <span class="heatmap-legend-cell heatmap-level-2" />
            <span class="heatmap-legend-cell heatmap-level-3" />
            <span class="heatmap-legend-cell heatmap-level-4" />
            <span class="heatmap-legend-label">More</span>
          </div>
        </div>

        <div class="heatmap-hour-container">
          <div
            class="heatmap-hour-grid"
            role="grid"
            aria-label="Hourly activity grid"
          >
            {/* Header row: empty corner + 24 hour columns */}
            <div class="heatmap-hour-corner" aria-hidden="true" />
            {Array.from({ length: 24 }, (_, h) => {
              const labelObj = HOUR_LABELS.find((item) => item.hour === h);
              return (
                <div
                  key={h}
                  class="heatmap-hour-header-cell"
                  aria-hidden="true"
                >
                  {labelObj ? labelObj.label : ""}
                </div>
              );
            })}

            {/* 7 rows for Mon..Sun */}
            {hourMatrix.map((rowCells, wIdx) => {
              const wdName = WEEKDAYS_SHORT[wIdx] ?? "";
              return (
                <div key={wIdx} class="heatmap-hour-row" role="row">
                  <div class="heatmap-hour-weekday-label" aria-hidden="true">
                    {wdName}
                  </div>
                  {rowCells.map((c, hIdx) => {
                    const val = metric === "minutes" ? c.minutes : c.count;
                    const level = levelFor(val, maxHourMetric);
                    const roundedMin = Math.round(c.minutes);
                    const itemWord = c.count === 1 ? "item" : "items";
                    const hourStr = `${String(hIdx).padStart(2, "0")}:00`;
                    const cellDesc = `${wdName} ${hourStr}: ${roundedMin} min, ${c.count} ${itemWord}`;

                    return (
                      <div
                        key={hIdx}
                        class={`heatmap-hour-cell heatmap-level-${level}`}
                        data-level={level}
                        role="gridcell"
                        aria-label={cellDesc}
                        title={cellDesc}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        {unplaced.count > 0 && (
          <p class="heatmap-note">
            Not shown: {unplaced.count} offline{" "}
            {unplaced.count === 1 ? "session" : "sessions"} (
            {formatDuration(unplaced.minutes * 60)}) synced later from a phone, so
            their time of day is unknown. They still count on their sync day above.
          </p>
        )}
      </section>
    </section>
  );
}
