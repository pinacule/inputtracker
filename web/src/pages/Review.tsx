import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getMonthReview,
  getYearReviewV2,
  type Category,
  type LibraryWork,
  type MonthReview,
  type SeriesPoint,
  type YearReviewV2,
} from "../api";
import { formatStarValue, ratingToStars } from "../lib/annotations";
import { shiftMonth } from "../lib/calendar";
import {
  categoryLabel,
  formatCategoryUnits,
} from "../lib/categories";
import { formatMinutes } from "../lib/stats";
import { formatChange, formatHours } from "../lib/year-review";
import {
  AddIcon,
  Badge,
  Button,
  Card,
  CategoryShareChart,
  ChevronLeftIcon,
  ChevronRightIcon,
  Cover,
  EmptyState,
  IconButton,
  PunchCardChart,
  Skeleton,
  Sparkline,
  StackedSeriesChart,
  Stat,
  Tabs,
} from "../ui";

export interface ReviewProps {
  initialView?: "month" | "year";
  initialMonth?: string;
  initialYear?: string;
}

function getCurrentMonthStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Default month for Review: the last complete month (or current month if on or after the 25th).
 */
export function getDefaultReviewMonth(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const current = `${y}-${m}`;
  if (now.getDate() >= 25) {
    return current;
  }
  return shiftMonth(current, -1);
}

function formatMonthHeading(month: string): string {
  const [yStr, mStr] = month.split("-");
  const y = Number.parseInt(yStr ?? "2026", 10);
  const m = Number.parseInt(mStr ?? "1", 10);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  return dt.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function WorkShowcaseGrid({
  works,
  emptyLabel,
}: {
  works: readonly LibraryWork[];
  emptyLabel: string;
}) {
  if (works.length === 0) {
    return <p class="ui-text-muted">{emptyLabel}</p>;
  }

  return (
    <div class="review-works-grid">
      {works.map((work) => {
        const stars = ratingToStars(work.rating);
        return (
          <a
            key={work.key}
            href={`#/library?work=${encodeURIComponent(work.key)}`}
            class="review-work-card"
            title={work.title}
          >
            <Cover
              src={work.cover_url}
              title={work.title}
              category={work.category}
              size="lg"
              aspect="poster"
            />
            <div class="review-work-info">
              <Badge size="sm" category={work.category}>
                {categoryLabel(work.category)}
              </Badge>
              <strong class="review-work-title">{work.title}</strong>
              <span class="review-work-meta tabular-nums">
                {work.total_minutes > 0
                  ? formatMinutes(work.total_minutes)
                  : formatCategoryUnits(work.category, work.units)}
                {stars !== null ? ` · ★ ${formatStarValue(stars)}` : ""}
              </span>
            </div>
          </a>
        );
      })}
    </div>
  );
}

export function Review({
  initialView = "month",
  initialMonth,
  initialYear,
}: ReviewProps) {
  const currentMonth = getCurrentMonthStr();
  const currentYear = Number(currentMonth.slice(0, 4));

  const [view, setView] = useState<"month" | "year">(initialView);
  const [month, setMonth] = useState<string>(
    initialMonth && /^\d{4}-\d{2}$/.test(initialMonth)
      ? initialMonth
      : getDefaultReviewMonth()
  );
  const [year, setYear] = useState<number>(
    initialYear && /^\d{4}$/.test(initialYear)
      ? Number(initialYear)
      : currentYear
  );

  const [monthData, setMonthData] = useState<MonthReview | null>(null);
  const [yearData, setYearData] = useState<YearReviewV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialView) setView(initialView);
  }, [initialView]);

  useEffect(() => {
    if (initialMonth && /^\d{4}-\d{2}$/.test(initialMonth)) {
      setMonth(initialMonth);
    }
  }, [initialMonth]);

  useEffect(() => {
    if (initialYear && /^\d{4}$/.test(initialYear)) {
      setYear(Number(initialYear));
    }
  }, [initialYear]);

  // Fetch Month or Year Review
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (view === "month") {
      getMonthReview(month)
        .then((res) => {
          if (cancelled) return;
          setMonthData(res);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    } else {
      getYearReviewV2(year)
        .then((res) => {
          if (cancelled) return;
          setYearData(res);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [view, month, year]);

  const monthDailySparkline = useMemo(() => {
    if (!monthData?.days) return [];
    return monthData.days.map((pt) =>
      Object.values(pt.minutes_by_category ?? {}).reduce<number>(
        (acc, v) => acc + (typeof v === "number" ? v : 0),
        0
      )
    );
  }, [monthData]);

  const yearMonthSeriesPoints = useMemo<SeriesPoint[]>(() => {
    if (!yearData?.months) return [];
    return yearData.months.map((m) => {
      const byCat: Partial<Record<Category, number>> = {};
      for (const c of m.categories ?? []) {
        byCat[c.category] = c.total_minutes;
      }
      return {
        bucket: m.month,
        minutes_by_category: byCat,
      };
    });
  }, [yearData]);

  const yearSparkline = useMemo(() => {
    if (!yearData?.months) return [];
    return yearData.months.map((m) => m.total_minutes);
  }, [yearData]);

  return (
    <section class="page-container review-page" aria-label="Review">
      <header class="page-header">
        <div class="page-header-titles">
          <span class="page-eyebrow">Retrospective & Highlights</span>
          <h1>
            {view === "month"
              ? formatMonthHeading(month)
              : `${year} in Review`}
          </h1>
          <p class="page-subtitle">
            {view === "month"
              ? "Monthly consumption summary, category balance, and top works."
              : "Twelve months combined: annual totals, category rhythm, and finished works."}
          </p>
        </div>

        <div class="page-header-actions review-header-controls">
          <Tabs
            ariaLabel="Review scope"
            options={[
              { value: "month", label: "Month in Review" },
              { value: "year", label: "Year View" },
            ]}
            value={view}
            onChange={(v) => setView(v)}
          />

          {view === "month" ? (
            <div class="calendar-month-stepper">
              <IconButton
                label="Previous month"
                variant="ghost"
                size="sm"
                onClick={() => setMonth((m) => shiftMonth(m, -1))}
              >
                <ChevronLeftIcon size={18} />
              </IconButton>
              <button
                type="button"
                class="calendar-today-btn"
                onClick={() => setMonth(currentMonth)}
              >
                This Month
              </button>
              <IconButton
                label="Next month"
                variant="ghost"
                size="sm"
                onClick={() => setMonth((m) => shiftMonth(m, 1))}
              >
                <ChevronRightIcon size={18} />
              </IconButton>
            </div>
          ) : (
            <div class="calendar-month-stepper">
              <IconButton
                label="Previous year"
                variant="ghost"
                size="sm"
                onClick={() => setYear((y) => y - 1)}
              >
                <ChevronLeftIcon size={18} />
              </IconButton>
              <button
                type="button"
                class="calendar-today-btn tabular-nums"
                onClick={() => setYear(currentYear)}
              >
                {year}
              </button>
              <IconButton
                label="Next year"
                variant="ghost"
                size="sm"
                disabled={year >= currentYear}
                onClick={() => setYear((y) => y + 1)}
              >
                <ChevronRightIcon size={18} />
              </IconButton>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div class="calendar-error" role="alert">
          <span>
            <strong>Could not load review:</strong> {error}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setView((v) => v)}
          >
            Retry
          </Button>
        </div>
      )}

      {/* --- MONTH IN REVIEW VIEW --- */}
      {view === "month" && (
        <>
          {loading && !monthData ? (
            <div class="ui-form-stack" aria-busy="true">
              <Skeleton height={110} />
              <Skeleton height={240} />
            </div>
          ) : !monthData ||
            (monthData.total_minutes === 0 &&
              monthData.categories.length === 0) ? (
            <EmptyState
              title={`Nothing recorded in ${formatMonthHeading(month)}`}
              description="Step to another month or archive books, films, or series you finished during this month."
              actions={
                <Button
                  variant="primary"
                  size="sm"
                  href="#/add"
                  leadingIcon={<AddIcon size={15} />}
                >
                  Add to Archive
                </Button>
              }
            />
          ) : (
            <>
              {/* Monthly Hero KPI Strip */}
              <div class="insights-kpi-strip">
                <Card padding="md">
                  <Stat
                    label="Total Time"
                    value={formatHours(monthData.total_minutes)}
                    size="lg"
                    sparkline={
                      <Sparkline
                        values={monthDailySparkline}
                        label={`Daily rhythm in ${monthData.month}`}
                      />
                    }
                    sublabel={
                      <>
                        <strong>
                          {formatChange(
                            monthData.total_minutes,
                            monthData.previous_month_minutes
                          )}
                        </strong>{" "}
                        vs previous month ({formatMinutes(monthData.total_minutes)}
                        )
                      </>
                    }
                  />
                </Card>

                <Card padding="md">
                  <Stat
                    label="Active Days & Streak"
                    value={`${monthData.active_days} days`}
                    size="lg"
                    sublabel={`Longest streak: ${monthData.longest_streak_days} ${
                      monthData.longest_streak_days === 1 ? "day" : "days"
                    }`}
                  />
                </Card>

                <Card padding="md">
                  <Stat
                    label="Works Touched"
                    value={
                      monthData.categories.reduce((acc, c) => acc + c.works, 0) ||
                      monthData.top_works.length
                    }
                    size="lg"
                    sublabel={
                      monthData.undated_minutes > 0
                        ? `Includes ${formatMinutes(
                            monthData.undated_minutes
                          )} from month-dated archive entries`
                        : `${monthData.finished_works.length} finished · ${monthData.started_works.length} started`
                    }
                  />
                </Card>
              </div>

              {/* Daily Stacked Chart */}
              <Card
                padding="md"
                title={`Daily Activity in ${formatMonthHeading(month)}`}
                subtitle="Stacked minutes per category — click any day to open in Calendar"
              >
                <StackedSeriesChart
                  points={monthData.days}
                  bucketType="day"
                  onSelectBucket={(dayBucket) => {
                    window.location.hash = `#/calendar?date=${dayBucket}`;
                  }}
                />
              </Card>

              {/* Category Share + Monthly Punch Card */}
              <div class="insights-two-col">
                <Card
                  padding="md"
                  title="Category Breakdown"
                  subtitle="Share of time and works this month"
                >
                  <CategoryShareChart categories={monthData.categories} />
                </Card>

                <Card
                  padding="md"
                  title="Monthly Rhythm (Hour × Weekday)"
                  subtitle="Time of day and day of week patterns"
                >
                  <PunchCardChart hourWeekday={monthData.hour_weekday} />
                </Card>
              </div>

              {/* Cover Highlights: Top Works, Finished, Started */}
              <Card
                padding="md"
                title="Top Works This Month"
                subtitle="Most time spent in this month"
              >
                <WorkShowcaseGrid
                  works={monthData.top_works}
                  emptyLabel="No works recorded this month."
                />
              </Card>

              {(monthData.finished_works.length > 0 ||
                monthData.started_works.length > 0) && (
                <div class="insights-two-col">
                  <Card
                    padding="md"
                    title={`Finished (${monthData.finished_works.length})`}
                    subtitle="Completed during this month"
                  >
                    <WorkShowcaseGrid
                      works={monthData.finished_works}
                      emptyLabel="No works marked finished this month."
                    />
                  </Card>

                  <Card
                    padding="md"
                    title={`Started (${monthData.started_works.length})`}
                    subtitle="Begun during this month"
                  >
                    <WorkShowcaseGrid
                      works={monthData.started_works}
                      emptyLabel="No new works started this month."
                    />
                  </Card>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* --- YEAR IN REVIEW VIEW --- */}
      {view === "year" && (
        <>
          {loading && !yearData ? (
            <div class="ui-form-stack" aria-busy="true">
              <Skeleton height={110} />
              <Skeleton height={240} />
            </div>
          ) : !yearData ||
            (yearData.total_minutes === 0 &&
              yearData.categories.length === 0) ? (
            <EmptyState
              title={`Nothing recorded in ${year}`}
              description="Step to another year or add past works from this year to your archive."
              actions={
                <Button
                  variant="primary"
                  size="sm"
                  href="#/add"
                  leadingIcon={<AddIcon size={15} />}
                >
                  Add to Archive
                </Button>
              }
            />
          ) : (
            <>
              <div class="insights-kpi-strip">
                <Card padding="md">
                  <Stat
                    label={`Total Time in ${yearData.year}`}
                    value={formatHours(yearData.total_minutes)}
                    size="lg"
                    sparkline={
                      <Sparkline
                        values={yearSparkline}
                        label={`Monthly rhythm in ${yearData.year}`}
                      />
                    }
                    sublabel={
                      yearData.undated_minutes > 0
                        ? `${formatMinutes(
                            yearData.total_minutes
                          )} (includes ${formatMinutes(
                            yearData.undated_minutes
                          )} year-dated archive time)`
                        : formatMinutes(yearData.total_minutes)
                    }
                  />
                </Card>

                <Card padding="md">
                  <Stat
                    label="Active Days & Streak"
                    value={`${yearData.active_days} days`}
                    size="lg"
                    sublabel={`Longest streak: ${yearData.longest_streak_days} ${
                      yearData.longest_streak_days === 1 ? "day" : "days"
                    }`}
                  />
                </Card>

                <Card padding="md">
                  <Stat
                    label="Completed Works"
                    value={yearData.finished_works.length}
                    size="lg"
                    sublabel={`Across ${yearData.categories.length} ${
                      yearData.categories.length === 1
                        ? "category"
                        : "categories"
                    }`}
                  />
                </Card>
              </div>

              {/* 12-Month Stacked Bar Chart (click any month to open Month Review) */}
              <Card
                padding="md"
                title={`Month by Month (${yearData.year})`}
                subtitle="Click any month bar to open that Month in Review"
              >
                <StackedSeriesChart
                  points={yearMonthSeriesPoints}
                  bucketType="month"
                  onSelectBucket={(monthBucket) => {
                    setMonth(monthBucket);
                    setView("month");
                  }}
                />
              </Card>

              <Card
                padding="md"
                title={`Category Share in ${yearData.year}`}
                subtitle="Annual time and works distribution"
              >
                <CategoryShareChart categories={yearData.categories} />
              </Card>

              <Card
                padding="md"
                title={`Top Works of ${yearData.year}`}
                subtitle="Your most-consumed titles of the year"
              >
                <WorkShowcaseGrid
                  works={yearData.top_works}
                  emptyLabel="No top works for this year."
                />
              </Card>

              {yearData.finished_works.length > 0 && (
                <Card
                  padding="md"
                  title={`Finished in ${yearData.year} (${yearData.finished_works.length})`}
                  subtitle="Works completed during the year"
                >
                  <WorkShowcaseGrid
                    works={yearData.finished_works}
                    emptyLabel="No works finished this year."
                  />
                </Card>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
