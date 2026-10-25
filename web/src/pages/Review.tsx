import { useEffect, useMemo, useState } from "preact/hooks";
import { previousMonthName } from "../lib/format-date";
import {
  getMonthReview,
  getYearReviewV2,
  type Category,
  type LibraryWork,
  type MonthReview,
  type SeriesPoint,
  type YearReviewV2,
} from "../api";
import { shiftMonth } from "../lib/calendar";
import {
  CATEGORIES,
  categoryLabel,
  formatWorkCardMeta,
} from "../lib/categories";
import {
  buildCategoryFilterParams,
  matchesCategorySelection,
} from "../lib/category-filter";
import { canRateCategory } from "../lib/rating";
import { formatMinutes } from "../lib/stats";
import {
  applyWorkOverridesToList,
  subscribeWorkEdits,
} from "../lib/work-edits";
import { formatChange, formatHours, isMilestoneCategory } from "../lib/year-review";
import {
  AddIcon,
  Badge,
  Button,
  Card,
  CategoryChips,
  CategoryShareChart,
  ChevronLeftIcon,
  ChevronRightIcon,
  Cover,
  EmptyState,
  IconButton,
  PunchCardChart,
  QuickRatingPill,
  Skeleton,
  Sparkline,
  StackedSeriesChart,
  Stat,
  Tabs,
  bindContextMenu,
} from "../ui";

export interface ReviewProps {
  initialView?: "month" | "year";
  initialMonth?: string;
  initialYear?: string;
  initialCategory?: Category;
  initialCategories?: readonly Category[];
  includeYoutubeInAll?: boolean;
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

/** `limit` shows the first N cards with a toggle for the rest. */
function WorkShowcaseGrid({
  works,
  emptyLabel,
  limit,
}: {
  works: readonly LibraryWork[];
  emptyLabel: string;
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  if (works.length === 0) {
    return <p class="ui-text-muted">{emptyLabel}</p>;
  }
  const capped = limit !== undefined && works.length > limit;
  const shown = capped && !showAll ? works.slice(0, limit) : works;

  return (
    <>
    <div class="review-works-grid">
      {shown.map((work) => {
        const workHref = `#/library?work=${encodeURIComponent(work.key)}`;
        const menuTarget = {
          kind: "work" as const,
          workKey: work.key,
          title: work.title,
          category: work.category,
          status: work.status,
          rating: work.rating,
          href: workHref,
          source: work.sources[0] ?? "manual",
        };
        return (
          <div
            key={work.key}
            class="review-work-card"
            tabIndex={0}
            {...bindContextMenu(menuTarget)}
          >
            <a href={workHref} class="review-work-cover-link">
              <Cover
                src={work.cover_url}
                title={work.title}
                category={work.category}
                size="lg"
                aspect="poster"
              />
            </a>
            <div class="review-work-info">
              <div class="review-work-badges">
                <Badge size="sm" category={work.category}>
                  {categoryLabel(work.category)}
                </Badge>
                {canRateCategory(work.category) && (
                  <QuickRatingPill
                    workKey={work.key}
                    title={work.title}
                    category={work.category}
                    rating={work.rating}
                    source={work.sources[0] ?? "manual"}
                    variant="inline"
                  />
                )}
              </div>
              <a
                href={workHref}
                class="review-work-title"
                title={work.title}
              >
                {work.title}
              </a>
              {(work.creator ?? work.channel) && (
                <span class="review-work-meta">
                  {work.creator ?? work.channel}
                </span>
              )}
              <span class="review-work-meta tabular-nums">
                {formatWorkCardMeta(work)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
    {capped && (
      <button type="button" class="ui-inline-link review-works-toggle" onClick={() => setShowAll((v) => !v)}>
        {showAll ? "Show fewer" : `Show all ${works.length}`}
      </button>
    )}
    </>
  );
}


export function Review({
  initialView = "month",
  initialMonth,
  initialYear,
  initialCategory,
  initialCategories,
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
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(
    () => {
      if (initialCategories && initialCategories.length > 0) {
        return [...initialCategories];
      }
      if (initialCategory) {
        return [initialCategory];
      }
      return [];
    }
  );

  const [monthData, setMonthData] = useState<MonthReview | null>(null);
  const [yearData, setYearData] = useState<YearReviewV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overrideTick, setOverrideTick] = useState(0);

  useEffect(() => {
    return subscribeWorkEdits(() => setOverrideTick((t) => t + 1));
  }, []);

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

  useEffect(() => {
    if (initialCategories !== undefined) {
      setSelectedCategories([...initialCategories]);
    } else if (initialCategory !== undefined) {
      setSelectedCategories(initialCategory ? [initialCategory] : []);
    }
  }, [initialCategory, initialCategories]);

  // Fetch Month or Year Review with category/exclude params (graceful fallback on 400/404)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const filterParams = buildCategoryFilterParams(selectedCategories, "all");

    if (view === "month") {
      getMonthReview(month, filterParams)
        .catch(() => getMonthReview(month))
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
      getYearReviewV2(year, filterParams)
        .catch(() => getYearReviewV2(year))
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
  }, [view, month, year, selectedCategories]);

  // Filtered Month Review view model
  const filteredMonth = useMemo(() => {
    if (!monthData) return null;
    const categories = (monthData.categories ?? []).filter((c) =>
      matchesCategorySelection(c.category, selectedCategories, "all")
    );
    const days: SeriesPoint[] = (monthData.days ?? []).map((pt) => {
      const byCat: Partial<Record<Category, number>> = {};
      for (const cat of CATEGORIES) {
        if (matchesCategorySelection(cat, selectedCategories, "all")) {
          const v = pt.minutes_by_category?.[cat];
          if (v && v > 0) {
            byCat[cat] = v;
          }
        }
      }
      return {
        bucket: pt.bucket,
        minutes_by_category: byCat,
      };
    });
    const filterWorks = (list: readonly LibraryWork[]) =>
      applyWorkOverridesToList(list).filter((w) =>
        matchesCategorySelection(w.category, selectedCategories, "all")
      );

    const totalMinutes = categories.reduce(
      (acc, c) => acc + c.total_minutes,
      0
    );

    return {
      ...monthData,
      total_minutes: totalMinutes,
      categories,
      days,
      top_works: filterWorks(monthData.top_works ?? []),
      started_works: filterWorks(monthData.started_works ?? []).filter((w) => isMilestoneCategory(w.category)),
      finished_works: filterWorks(monthData.finished_works ?? []).filter((w) => isMilestoneCategory(w.category)),
    };
  }, [monthData, selectedCategories, overrideTick]);

  // Filtered Year Review view model
  const filteredYear = useMemo(() => {
    if (!yearData) return null;
    const categories = (yearData.categories ?? []).filter((c) =>
      matchesCategorySelection(c.category, selectedCategories, "all")
    );
    const months = (yearData.months ?? []).map((m) => {
      const cats = (m.categories ?? []).filter((c) =>
        matchesCategorySelection(c.category, selectedCategories, "all")
      );
      const tot = cats.reduce((acc, c) => acc + c.total_minutes, 0);
      return {
        month: m.month,
        total_minutes: tot,
        categories: cats,
      };
    });
    const filterWorks = (list: readonly LibraryWork[]) =>
      applyWorkOverridesToList(list).filter((w) =>
        matchesCategorySelection(w.category, selectedCategories, "all")
      );

    const totalMinutes = categories.reduce(
      (acc, c) => acc + c.total_minutes,
      0
    );

    return {
      ...yearData,
      total_minutes: totalMinutes,
      categories,
      months,
      top_works: filterWorks(yearData.top_works ?? []),
      finished_works: filterWorks(yearData.finished_works ?? []).filter((w) => isMilestoneCategory(w.category)),
    };
  }, [yearData, selectedCategories, overrideTick]);

  const monthDailySparkline = useMemo(() => {
    if (!filteredMonth?.days) return [];
    return filteredMonth.days.map((pt) =>
      Object.values(pt.minutes_by_category ?? {}).reduce<number>(
        (acc, v) => acc + (typeof v === "number" ? v : 0),
        0
      )
    );
  }, [filteredMonth]);

  const yearMonthSeriesPoints = useMemo<SeriesPoint[]>(() => {
    if (!filteredYear?.months) return [];
    return filteredYear.months.map((m) => {
      const byCat: Partial<Record<Category, number>> = {};
      for (const c of m.categories ?? []) {
        byCat[c.category] = c.total_minutes;
      }
      return {
        bucket: m.month,
        minutes_by_category: byCat,
      };
    });
  }, [filteredYear]);

  const yearSparkline = useMemo(() => {
    if (!filteredYear?.months) return [];
    return filteredYear.months.map((m) => m.total_minutes);
  }, [filteredYear]);

  const allCategoriesTotals =
    view === "month"
      ? (monthData?.categories ?? [])
      : (yearData?.categories ?? []);

  return (
    <section class="page-container review-page" aria-label="Review">
      <header class="page-header">
        <div class="page-header-titles">
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

      {/* Multi-select Category Chips */}
      <CategoryChips
        selected={selectedCategories}
        onChange={setSelectedCategories}
        totals={allCategoriesTotals}
        scope="all"
        ariaLabel="Filter review by category"
        showCounts="hours"
      />

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
          {loading && !filteredMonth ? (
            <div class="ui-form-stack" aria-busy="true">
              <Skeleton height={110} />
              <Skeleton height={240} />
            </div>
          ) : !filteredMonth ||
            (filteredMonth.total_minutes === 0 &&
              filteredMonth.categories.length === 0) ? (
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
                    value={formatHours(filteredMonth.total_minutes)}
                    size="lg"
                    sparkline={
                      <Sparkline
                        values={monthDailySparkline}
                        label={`Daily rhythm in ${filteredMonth.month}`}
                      />
                    }
                    sublabel={
                      <>
                        <strong>
                          {formatChange(
                            filteredMonth.total_minutes,
                            filteredMonth.previous_month_minutes
                          )}
                        </strong>{" "}
                        vs {previousMonthName(filteredMonth.month)} (
                        {formatMinutes(filteredMonth.previous_month_minutes)})
                      </>
                    }
                  />
                </Card>

                <Card padding="md">
                  <Stat
                    label="Active Days & Streak"
                    value={`${filteredMonth.active_days} days`}
                    size="lg"
                    sublabel={`Longest streak: ${filteredMonth.longest_streak_days} ${
                      filteredMonth.longest_streak_days === 1 ? "day" : "days"
                    }`}
                  />
                </Card>

                <Card padding="md">
                  <Stat
                    label="Works Touched"
                    value={
                      filteredMonth.categories.reduce(
                        (acc, c) => acc + c.works,
                        0
                      ) || filteredMonth.top_works.length
                    }
                    size="lg"
                    sublabel={
                      filteredMonth.undated_minutes > 0
                        ? `Includes ${formatMinutes(
                            filteredMonth.undated_minutes
                          )} from month-dated archive entries`
                        : `${filteredMonth.finished_works.length} finished · ${filteredMonth.started_works.length} started`
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
                  points={filteredMonth.days}
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
                  <CategoryShareChart categories={filteredMonth.categories} />
                </Card>

                <Card
                  padding="md"
                  title="Monthly Rhythm (Hour × Weekday)"
                  subtitle="Time of day and day of week patterns"
                >
                  <PunchCardChart hourWeekday={filteredMonth.hour_weekday} />
                </Card>
              </div>

              {/* Cover Highlights: Top Works, Finished, Started */}
              <Card
                padding="md"
                title="Top Works This Month"
                subtitle="Most time spent in this month — rate directly on any card"
              >
                <WorkShowcaseGrid
                  works={filteredMonth.top_works}
                  emptyLabel="No works recorded this month."
                />
              </Card>

              {(filteredMonth.finished_works.length > 0 ||
                filteredMonth.started_works.length > 0) && (
                <div class="insights-two-col">
                  <Card
                    padding="md"
                    title={`Finished (${filteredMonth.finished_works.length})`}
                    subtitle="Completed during this month"
                  >
                    <WorkShowcaseGrid
                      key={month}
                      works={filteredMonth.finished_works}
                      limit={6}
                      emptyLabel="No works marked finished this month."
                    />
                  </Card>

                  <Card
                    padding="md"
                    title={`Started (${filteredMonth.started_works.length})`}
                    subtitle="Begun during this month"
                  >
                    <WorkShowcaseGrid
                      key={month}
                      works={filteredMonth.started_works}
                      limit={6}
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
          {loading && !filteredYear ? (
            <div class="ui-form-stack" aria-busy="true">
              <Skeleton height={110} />
              <Skeleton height={240} />
            </div>
          ) : !filteredYear ||
            (filteredYear.total_minutes === 0 &&
              filteredYear.categories.length === 0) ? (
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
                    label={`Total Time in ${filteredYear.year}`}
                    value={formatHours(filteredYear.total_minutes)}
                    size="lg"
                    sparkline={
                      <Sparkline
                        values={yearSparkline}
                        label={`Monthly rhythm in ${filteredYear.year}`}
                      />
                    }
                    sublabel={
                      filteredYear.undated_minutes > 0
                        ? `${formatMinutes(
                            filteredYear.total_minutes
                          )} (includes ${formatMinutes(
                            filteredYear.undated_minutes
                          )} year-dated archive time)`
                        : formatMinutes(filteredYear.total_minutes)
                    }
                  />
                </Card>

                <Card padding="md">
                  <Stat
                    label="Active Days & Streak"
                    value={`${filteredYear.active_days} days`}
                    size="lg"
                    sublabel={`Longest streak: ${filteredYear.longest_streak_days} ${
                      filteredYear.longest_streak_days === 1 ? "day" : "days"
                    }`}
                  />
                </Card>

                <Card padding="md">
                  <Stat
                    label="Completed Works"
                    value={filteredYear.finished_works.length}
                    size="lg"
                    sublabel={`Across ${filteredYear.categories.length} ${
                      filteredYear.categories.length === 1
                        ? "category"
                        : "categories"
                    }`}
                  />
                </Card>
              </div>

              {/* 12-Month Stacked Bar Chart */}
              <Card
                padding="md"
                title={`Month by Month (${filteredYear.year})`}
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
                title={`Category Share in ${filteredYear.year}`}
                subtitle="Annual time and works distribution"
              >
                <CategoryShareChart categories={filteredYear.categories} />
              </Card>

              <Card
                padding="md"
                title={`Top Works of ${filteredYear.year}`}
                subtitle="Your most-consumed titles of the year"
              >
                <WorkShowcaseGrid
                  works={filteredYear.top_works}
                  emptyLabel="No top works for this year."
                />
              </Card>

              {filteredYear.finished_works.length > 0 && (
                <Card
                  padding="md"
                  title={`Finished in ${filteredYear.year} (${filteredYear.finished_works.length})`}
                  subtitle="Works completed during the year"
                >
                  <WorkShowcaseGrid
                    key={filteredYear.year}
                      works={filteredYear.finished_works}
                      limit={6}
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
