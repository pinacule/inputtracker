import { useEffect, useMemo, useState } from "preact/hooks";
import {
  getGoals,
  getHeatmapDays,
  getHeatmapHours,
  getInsights,
  getLibrary,
  getSeries,
  getYoutubeOverview,
  saveGoal,
  type Category,
  type CategoryTotal,
  type Goal,
  type HeatmapDaysResult,
  type HeatmapHoursResult,
  type InsightsResult,
  type LibraryWork,
  type SeriesPoint,
  type SeriesResult,
  type YoutubeOverview,
} from "../api";
import {
  CATEGORIES,
  categoryLabel,
  resolveItemCategory,
} from "../lib/categories";
import {
  buildCategoryFilterParams,
  matchesCategorySelection,
} from "../lib/category-filter";
import {
  resolveInsightsRange,
  type InsightsRangePreset,
} from "../lib/charts";
import { formatLocalDay } from "../lib/format-date";
import { MEDIA_TYPE_OPTIONS } from "../lib/forms";
import {
  GOAL_METRIC_OPTIONS,
  buildGoalInput,
  formatGoalValue,
  metricLabel,
  statusLabel,
  type GoalFormState,
} from "../lib/goals";
import {
  describeCurrentStreak,
  formatDayCount,
  formatOnThisDayHeading,
  formatStreakRange,
} from "../lib/insights";
import { SOURCES, sourceLabel } from "../lib/sources";
import { formatMinutes } from "../lib/stats";
import {
  getChannelTopicOverride,
  subscribeWorkEdits,
} from "../lib/work-edits";
import {
  buildYoutubeOverviewFromWorks,
  groupYoutubeByTopic,
  rankYoutubeChannels,
} from "../lib/youtube";
import {
  Badge,
  Button,
  Card,
  CategoryChips,
  CategoryShareChart,
  ChevronLeftIcon,
  ChevronRightIcon,
  Cover,
  HeatmapCalendarChart,
  IconButton,
  ProgressBar,
  PunchCardChart,
  Skeleton,
  Sparkline,
  StackedSeriesChart,
  Stat,
  Tabs,
  bindContextMenu,
  type TabOption,
} from "../ui";

export interface InsightsProps {
  initialRange?: InsightsRangePreset;
  initialCategory?: Category;
  initialCategories?: readonly Category[];
  initialYear?: string;
  /** @deprecated Insights "All" always includes YouTube and Music. */
  includeYoutubeInAll?: boolean;
}

const RANGE_TABS: ReadonlyArray<TabOption<InsightsRangePreset>> = [
  { value: "30d", label: "30 days" },
  { value: "12w", label: "12 weeks" },
  { value: "12m", label: "12 months" },
  { value: "all", label: "All time" },
];

function getTodayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function GoalsSection({ year }: { year: number }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [formState, setFormState] = useState<GoalFormState>({
    year,
    metric: "hours",
    target: "",
    source: "",
    media_type: "",
  });
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const loadGoals = (targetYear: number) => {
    setLoading(true);
    setError(null);
    getGoals(targetYear)
      .then((res) => {
        setGoals(res.goals ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  };

  useEffect(() => {
    loadGoals(year);
    setShowForm(false);
    setEditingGoal(null);
  }, [year]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const built = buildGoalInput({ ...formState, year });
    if (built.errors.length > 0 || !built.input) {
      setFormErrors(built.errors);
      return;
    }
    setSubmitting(true);
    setFormErrors([]);
    try {
      await saveGoal(built.input);
      setShowForm(false);
      setEditingGoal(null);
      loadGoals(year);
    } catch (err) {
      setFormErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSubmitting(false);
    }
  };

  const handleArchiveGoal = async (goal: Goal) => {
    try {
      await saveGoal({
        goal_id: goal.goal_id,
        year: goal.year,
        metric: goal.metric,
        source: goal.source,
        media_type: goal.media_type,
        target: goal.target,
        archived: 1,
      });
      loadGoals(year);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card
      padding="md"
      title={`Annual Goals (${year})`}
      subtitle="Track yearly targets for hours, titles, items, or active days"
      actions={
        !showForm ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditingGoal(null);
              setFormState({
                year,
                metric: "hours",
                target: "",
                source: "",
                media_type: "",
              });
              setFormErrors([]);
              setShowForm(true);
            }}
          >
            + Add Goal
          </Button>
        ) : undefined
      }
    >
      {error && (
        <p class="ui-form-error" role="alert">
          {error}
        </p>
      )}

      {showForm && (
        <form
          class="ui-form-stack insights-goal-form"
          onSubmit={(e) => void handleSubmit(e)}
        >
          <div class="ui-form-grid-4">
            <div class="ui-form-field">
              <label class="ui-form-label" for="goal-metric">
                Metric
              </label>
              <select
                id="goal-metric"
                class="ui-input"
                value={formState.metric}
                onChange={(e) =>
                  setFormState((s) => ({
                    ...s,
                    metric: (e.currentTarget as HTMLSelectElement).value,
                  }))
                }
              >
                {GOAL_METRIC_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div class="ui-form-field">
              <label class="ui-form-label" for="goal-target">
                Target
              </label>
              <input
                id="goal-target"
                type="number"
                step="any"
                min="1"
                class="ui-input tabular-nums"
                required
                placeholder="e.g. 100"
                value={String(formState.target)}
                onInput={(e) =>
                  setFormState((s) => ({
                    ...s,
                    target: (e.currentTarget as HTMLInputElement).value,
                  }))
                }
              />
            </div>

            <div class="ui-form-field">
              <label class="ui-form-label" for="goal-source">
                Source (optional)
              </label>
              <select
                id="goal-source"
                class="ui-input"
                value={formState.source ?? ""}
                onChange={(e) =>
                  setFormState((s) => ({
                    ...s,
                    source: (e.currentTarget as HTMLSelectElement).value,
                  }))
                }
              >
                <option value="">All sources</option>
                {SOURCES.map((src) => (
                  <option key={src.value} value={src.value}>
                    {src.label}
                  </option>
                ))}
              </select>
            </div>

            <div class="ui-form-field">
              <label class="ui-form-label" for="goal-media-type">
                Media type (optional)
              </label>
              <select
                id="goal-media-type"
                class="ui-input"
                value={formState.media_type ?? ""}
                onChange={(e) =>
                  setFormState((s) => ({
                    ...s,
                    media_type: (e.currentTarget as HTMLSelectElement).value,
                  }))
                }
              >
                <option value="">All types</option>
                {MEDIA_TYPE_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {formErrors.length > 0 && (
            <ul class="ui-form-error-list" role="alert">
              {formErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}

          <div class="ui-form-actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={submitting}
            >
              {submitting
                ? "Saving…"
                : editingGoal
                  ? "Update Goal"
                  : "Save Goal"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setEditingGoal(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {loading && !showForm ? (
        <Skeleton height={64} />
      ) : goals.length === 0 && !showForm ? (
        <p class="ui-text-muted">No goals configured for {year} yet.</p>
      ) : (
        <div class="insights-goals-grid">
          {goals.map((goal) => {
            const valLabel = formatGoalValue(
              goal.metric,
              goal.progress.current,
              goal.target
            );
            const statText = statusLabel(goal.progress, goal.metric);
            return (
              <div key={goal.goal_id} class="insights-goal-item">
                <div class="insights-goal-header">
                  <div>
                    <strong class="tabular-nums">{valLabel}</strong>
                    <span class="insights-goal-sub">
                      {metricLabel(goal.metric)}
                      {goal.source ? ` · ${sourceLabel(goal.source)}` : ""}
                    </span>
                  </div>
                  <div class="insights-goal-actions">
                    <Badge
                      size="sm"
                      variant={
                        goal.progress.status === "done" ||
                        goal.progress.status === "on_track"
                          ? "success"
                          : goal.progress.status === "behind"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {statText}
                    </Badge>
                    <button
                      type="button"
                      class="ui-inline-link"
                      onClick={() => {
                        setEditingGoal(goal);
                        setFormState({
                          goal_id: goal.goal_id,
                          year: goal.year,
                          metric: goal.metric,
                          target: String(goal.target),
                          source: goal.source ?? "",
                          media_type: goal.media_type ?? "",
                        });
                        setShowForm(true);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="ui-inline-link"
                      onClick={() => void handleArchiveGoal(goal)}
                    >
                      Archive
                    </button>
                  </div>
                </div>
                <ProgressBar
                  value={goal.progress.percent}
                  max={100}
                  size="sm"
                  ariaLabel={`Goal progress: ${valLabel}`}
                />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function Insights({
  initialRange = "30d",
  initialCategory,
  initialCategories,
  initialYear,
}: InsightsProps) {
  const todayStr = getTodayStr();
  const currentYear = Number(todayStr.slice(0, 4));

  const [rangePreset, setRangePreset] =
    useState<InsightsRangePreset>(initialRange);
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
  const [heatmapYear, setHeatmapYear] = useState<number>(
    initialYear ? Number(initialYear) : currentYear
  );

  const [seriesData, setSeriesData] = useState<SeriesResult | null>(null);
  const [libraryCategories, setLibraryCategories] = useState<CategoryTotal[]>(
    []
  );
  const [libraryWorks, setLibraryWorks] = useState<LibraryWork[]>([]);
  const [youtubeOverview, setYoutubeOverview] =
    useState<YoutubeOverview | null>(null);
  const [insightsData, setInsightsData] = useState<InsightsResult | null>(null);
  const [heatmapDays, setHeatmapDays] = useState<HeatmapDaysResult | null>(
    null
  );
  const [heatmapHours, setHeatmapHours] = useState<HeatmapHoursResult | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setOverrideTick] = useState(0);

  useEffect(() => {
    return subscribeWorkEdits(() => setOverrideTick((t) => t + 1));
  }, []);

  useEffect(() => {
    if (initialCategories !== undefined) {
      setSelectedCategories([...initialCategories]);
    } else if (initialCategory !== undefined) {
      setSelectedCategories(initialCategory ? [initialCategory] : []);
    }
  }, [initialCategory, initialCategories]);

  const resolvedRange = useMemo(
    () => resolveInsightsRange(rangePreset, todayStr),
    [rangePreset, todayStr]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const filterParams = buildCategoryFilterParams(selectedCategories, "all");

    const fetchSeries = getSeries({
      bucket: resolvedRange.bucket,
      from: resolvedRange.from,
      to: resolvedRange.to,
      category: filterParams.category,
      exclude: filterParams.exclude,
    }).catch(() =>
      getSeries({
        bucket: resolvedRange.bucket,
        from: resolvedRange.from,
        to: resolvedRange.to,
      })
    );

    const fetchHours = getHeatmapHours(String(heatmapYear), filterParams).catch(
      () => getHeatmapHours(String(heatmapYear)).catch(() => null)
    );

    const fetchIns = getInsights(filterParams).catch(() =>
      getInsights().catch(() => null)
    );

    const fetchYt = getYoutubeOverview({
      from: resolvedRange.from,
      to: resolvedRange.to,
    }).catch(() => null);

    Promise.all([
      fetchSeries,
      getLibrary().catch(() => null),
      fetchIns,
      fetchHours,
      fetchYt,
    ])
      .then(([seriesRes, libRes, insRes, hoursRes, ytRes]) => {
        if (cancelled) return;
        setSeriesData(seriesRes);
        if (libRes?.categories) {
          setLibraryCategories(libRes.categories);
        }
        if (libRes?.works) {
          setLibraryWorks(libRes.works);
        }
        setInsightsData(insRes);
        setHeatmapHours(hoursRes);
        setYoutubeOverview(ytRes);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resolvedRange, selectedCategories, heatmapYear]);

  // Fetch 52-week heatmap days whenever `heatmapYear` or category filter changes
  useEffect(() => {
    let cancelled = false;
    const filterParams = buildCategoryFilterParams(selectedCategories, "all");
    getHeatmapDays(String(heatmapYear), filterParams)
      .catch(() => getHeatmapDays(String(heatmapYear)))
      .then((res) => {
        if (!cancelled) {
          setHeatmapDays(res);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHeatmapDays({ year: String(heatmapYear), days: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [heatmapYear, selectedCategories]);

  // Compute filtered series points, bucket totals, and category totals
  const {
    points,
    bucketTotals,
    rangeTotalMinutes,
    avgPerBucket,
    derivedCategoryTotals,
  } = useMemo(() => {
    const rawPts: SeriesPoint[] = seriesData?.points ?? [];
    const pts: SeriesPoint[] = [];
    const totals: number[] = [];
    let sum = 0;
    const catSums = new Map<Category, { minutes: number; units: number }>();

    for (const pt of rawPts) {
      let ptSum = 0;
      const byCat = pt.minutes_by_category ?? {};
      const filteredByCat: Partial<Record<Category, number>> = {};

      for (const cat of CATEGORIES) {
        if (!matchesCategorySelection(cat, selectedCategories, "all")) {
          continue;
        }
        const v = byCat[cat] ?? 0;
        if (v > 0) {
          filteredByCat[cat] = v;
          ptSum += v;
          const prev = catSums.get(cat);
          if (prev) {
            prev.minutes += v;
            prev.units += 1;
          } else {
            catSums.set(cat, { minutes: v, units: 1 });
          }
        }
      }
      pts.push({
        bucket: pt.bucket,
        minutes_by_category: filteredByCat,
      });
      totals.push(Math.round(ptSum));
      sum += ptSum;
    }

    const derivedCats: CategoryTotal[] = CATEGORIES.map((cat) => {
      const libMatch = libraryCategories.find((c) => c.category === cat);
      const fromSeries = catSums.get(cat);
      return {
        category: cat,
        total_minutes: Math.round(
          fromSeries?.minutes ??
            (rangePreset === "all" ? libMatch?.total_minutes ?? 0 : 0)
        ),
        works: libMatch?.works ?? 0,
        units: fromSeries?.units ?? libMatch?.units ?? 0,
      };
    }).filter((c) => c.total_minutes > 0 || c.units > 0);

    const avg = pts.length > 0 ? Math.round(sum / pts.length) : 0;

    return {
      points: pts,
      bucketTotals: totals,
      rangeTotalMinutes: Math.round(sum),
      avgPerBucket: avg,
      derivedCategoryTotals:
        derivedCats.length > 0 ? derivedCats : libraryCategories,
    };
  }, [seriesData, selectedCategories, libraryCategories, rangePreset]);

  // YouTube Insights data (with 404 fallback from libraryWorks)
  const effectiveYoutube = useMemo<YoutubeOverview>(() => {
    const base =
      youtubeOverview ?? buildYoutubeOverviewFromWorks(libraryWorks);
    return {
      ...base,
      channels: (base.channels ?? []).map((ch) => ({
        ...ch,
        topic: getChannelTopicOverride(ch.channel, ch.topic),
      })),
    };
  }, [youtubeOverview, libraryWorks]);

  const youtubeTopicGroups = useMemo(
    () => groupYoutubeByTopic(effectiveYoutube).slice(0, 8),
    [effectiveYoutube]
  );

  const youtubeTopChannels = useMemo(
    () => rankYoutubeChannels(effectiveYoutube.channels).slice(0, 8),
    [effectiveYoutube]
  );

  const youtubeSparkline = useMemo(() => {
    if (!effectiveYoutube.days || effectiveYoutube.days.length === 0) {
      return [];
    }
    return effectiveYoutube.days.map((pt) =>
      Object.values(pt.minutes_by_category ?? {}).reduce<number>(
        (acc, v) => acc + (typeof v === "number" ? v : 0),
        0
      )
    );
  }, [effectiveYoutube]);

  const streakOverall = insightsData?.streaks.overall;
  const onThisDayYears = insightsData?.on_this_day.years ?? [];
  const singleCategory =
    selectedCategories.length === 1 ? selectedCategories[0] : undefined;

  return (
    <section class="page-container insights-page" aria-label="Insights">
      <header class="page-header">
        <div class="page-header-titles">
          <h1>Insights</h1>
          <p class="page-subtitle">
            Stacked category trends, share of time, hourly rhythm, YouTube
            topics & channels, and your 52-week streak calendar.
          </p>
        </div>

        <div class="page-header-actions">
          <Tabs
            ariaLabel="Time range"
            options={RANGE_TABS}
            value={rangePreset}
            onChange={(val) => setRangePreset(val)}
          />
        </div>
      </header>

      {/* Multi-Select Category Chips */}
      <CategoryChips
        selected={selectedCategories}
        onChange={setSelectedCategories}
        totals={libraryCategories.length > 0 ? libraryCategories : derivedCategoryTotals}
        scope="all"
        ariaLabel="Filter charts by category"
        showCounts="hours"
      />

      {error && (
        <div class="calendar-error" role="alert">
          <span>
            <strong>Could not load insights:</strong> {error}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRangePreset((r) => r)}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Compact 3-Item KPI Strip with Sparklines */}
      <div class="insights-kpi-strip">
        <Card padding="md">
          <Stat
            label={`Time (${resolvedRange.label})`}
            value={formatMinutes(rangeTotalMinutes)}
            category={singleCategory}
            sparkline={
              <Sparkline
                values={bucketTotals}
                category={singleCategory}
                label={`Time trend (${resolvedRange.label})`}
              />
            }
            sublabel={`${resolvedRange.from} – ${resolvedRange.to}`}
          />
        </Card>

        <Card padding="md">
          <Stat
            label={`Average per ${resolvedRange.bucket}`}
            value={formatMinutes(avgPerBucket)}
            category={singleCategory}
            sparkline={
              <Sparkline
                values={bucketTotals}
                category={singleCategory}
                label={`Average per ${resolvedRange.bucket}`}
              />
            }
            sublabel={`Across ${points.length || 1} ${resolvedRange.bucket}${
              points.length === 1 ? "" : "s"
            }`}
          />
        </Card>

        <Card padding="md">
          <Stat
            label="Daily Streak"
            value={
              streakOverall
                ? `${formatDayCount(streakOverall.current)} current`
                : "—"
            }
            sublabel={
              streakOverall
                ? `Longest: ${formatDayCount(streakOverall.longest)}${
                    streakOverall.longest_start
                      ? ` (${formatStreakRange(
                          streakOverall.longest_start,
                          streakOverall.longest_end
                        )})`
                      : ""
                  } · ${describeCurrentStreak(
                    streakOverall.current,
                    streakOverall.last_active,
                    insightsData?.streaks.today ?? todayStr
                  )}`
                : "Consecutive active days"
            }
          />
        </Card>
      </div>

      {/* Chart 1: Stacked Minutes by Category Over Time */}
      <Card
        padding="md"
        title={`Minutes by Category (${resolvedRange.label})`}
        subtitle={`Stacked by ${resolvedRange.bucket} — click any bar to inspect`}
      >
        {loading && !seriesData ? (
          <Skeleton height={220} />
        ) : (
          <StackedSeriesChart
            points={points}
            bucketType={resolvedRange.bucket}
            title={`Minutes per category (${resolvedRange.label})`}
            onSelectBucket={(bucket) => {
              if (resolvedRange.bucket === "day") {
                window.location.hash = `#/calendar?date=${bucket}`;
              } else if (resolvedRange.bucket === "month") {
                window.location.hash = `#/review?month=${bucket}`;
              }
            }}
          />
        )}
      </Card>

      {/* Two-Column Charts: Category Share + Hour × Weekday Punch Card */}
      <div class="insights-two-col">
        <Card
          padding="md"
          title="Category Share"
          subtitle="Proportion of time and works across categories"
        >
          <CategoryShareChart
            categories={derivedCategoryTotals.filter((c) =>
              matchesCategorySelection(c.category, selectedCategories, "all")
            )}
            selectedCategory={singleCategory ?? ""}
            onSelectCategory={(cat) =>
              setSelectedCategories(cat ? [cat] : [])
            }
            title="Category share"
          />
        </Card>

        <Card
          padding="md"
          title="Hour × Weekday Punch Card"
          subtitle="When you watch, read, and listen across the week"
        >
          <PunchCardChart
            cells={heatmapHours?.cells ?? []}
            unplacedCount={heatmapHours?.unplaced_count ?? 0}
            title="Hour by weekday rhythm"
          />
        </Card>
      </div>

      {/* YouTube Insights Section (Topics Over Time & Top Channels) */}
      <Card
        padding="md"
        title="YouTube — Topics & Top Channels"
        subtitle="Breakdown of YouTube watch time by topic and channel"
      >
        {effectiveYoutube.total_minutes === 0 &&
        youtubeTopicGroups.length === 0 &&
        youtubeTopChannels.length === 0 ? (
          <p class="ui-text-muted">
            No YouTube activity recorded in this period.
          </p>
        ) : (
          <div class="yt-insights-stack">
            <div class="yt-insights-summary">
              <Stat
                label="YouTube Time"
                value={formatMinutes(effectiveYoutube.total_minutes)}
                category="youtube"
                sparkline={
                  youtubeSparkline.length > 1 ? (
                    <Sparkline
                      values={youtubeSparkline}
                      category="youtube"
                      label="YouTube daily minutes"
                    />
                  ) : undefined
                }
                sublabel={`${effectiveYoutube.videos} videos · ${effectiveYoutube.channels.length} channels`}
              />
            </div>

            <div class="insights-two-col">
              {/* Topics Breakdown */}
              <div class="yt-insights-col">
                <h3 class="settings-subheading">Topics</h3>
                {youtubeTopicGroups.length === 0 ? (
                  <p class="ui-text-muted">No topics assigned yet.</p>
                ) : (
                  <ul class="yt-insights-bar-list">
                    {youtubeTopicGroups.map((t) => (
                      <li key={t.topic} class="yt-insights-bar-row">
                        <div class="yt-insights-bar-top tabular-nums">
                          <a
                            href={`#/library?cat=youtube&topic=${encodeURIComponent(
                              t.topic
                            )}`}
                            class="yt-insights-bar-name"
                          >
                            {t.topic}
                          </a>
                          <span>
                            <strong>{formatMinutes(t.totalMinutes)}</strong> ·{" "}
                            {t.sharePct}%
                          </span>
                        </div>
                        <div class="yt-bar-track">
                          <div
                            class="yt-bar-fill"
                            style={{
                              width: `${Math.round(t.barRatio * 100)}%`,
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Top Channels */}
              <div class="yt-insights-col">
                <h3 class="settings-subheading">Top Channels</h3>
                {youtubeTopChannels.length === 0 ? (
                  <p class="ui-text-muted">No channels recorded yet.</p>
                ) : (
                  <ul class="yt-insights-bar-list">
                    {youtubeTopChannels.map((ch) => (
                      <li
                        key={ch.channel}
                        class="yt-insights-bar-row"
                        {...bindContextMenu({
                          kind: "youtube-channel",
                          title: ch.channel,
                          category: "youtube",
                          channel: ch.channel,
                          topic: ch.topic,
                        })}
                      >
                        <div class="yt-insights-bar-top tabular-nums">
                          <span class="yt-insights-channel-left">
                            <a
                              href={`#/library?cat=youtube&channel=${encodeURIComponent(
                                ch.channel
                              )}`}
                              class="yt-insights-bar-name"
                            >
                              {ch.channel}
                            </a>
                            {ch.topic && (
                              <Badge size="sm" variant="neutral">
                                {ch.topic}
                              </Badge>
                            )}
                          </span>
                          <span>
                            <strong>{formatMinutes(ch.total_minutes)}</strong> ·{" "}
                            {ch.videos}v
                          </span>
                        </div>
                        <div class="yt-bar-track">
                          <div
                            class="yt-bar-fill"
                            style={{
                              width: `${Math.round(ch.barRatio * 100)}%`,
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Chart 4: 52-Week Streak & Activity Heatmap Calendar */}
      <Card
        padding="md"
        title={`52-Week Activity & Streak Calendar (${heatmapYear})`}
        subtitle="Daily consumption intensity across the calendar year"
        actions={
          <div class="calendar-month-stepper">
            <IconButton
              label="Previous year"
              variant="ghost"
              size="sm"
              onClick={() => setHeatmapYear((y) => y - 1)}
            >
              <ChevronLeftIcon size={17} />
            </IconButton>
            <button
              type="button"
              class="calendar-today-btn tabular-nums"
              onClick={() => setHeatmapYear(currentYear)}
            >
              {heatmapYear}
            </button>
            <IconButton
              label="Next year"
              variant="ghost"
              size="sm"
              disabled={heatmapYear >= currentYear}
              onClick={() => setHeatmapYear((y) => y + 1)}
            >
              <ChevronRightIcon size={17} />
            </IconButton>
          </div>
        }
      >
        <HeatmapCalendarChart
          year={heatmapYear}
          days={heatmapDays?.days ?? []}
          onSelectDay={(dateStr) => {
            window.location.hash = `#/calendar?date=${dateStr}`;
          }}
        />
      </Card>

      {/* Memories: On This Day + Annual Goals */}
      {onThisDayYears.length > 0 && (
        <Card
          padding="md"
          title="On This Day"
          subtitle={
            insightsData
              ? formatLocalDay(insightsData.on_this_day.date)
              : undefined
          }
        >
          <div class="insights-otd-groups">
            {onThisDayYears.map((group) => (
              <div key={group.year} class="insights-otd-group">
                <h3 class="insights-otd-heading">
                  {formatOnThisDayHeading(group.year, group.years_ago)}
                </h3>
                <div class="insights-otd-items">
                  {group.items.map((item, idx) => {
                    const cat = resolveItemCategory(item);
                    const href = `#/library?q=${encodeURIComponent(
                      item.title
                    )}`;
                    return (
                      <a
                        key={`${item.title}-${idx}`}
                        href={href}
                        class="insights-otd-card"
                        {...bindContextMenu({
                          kind: "work",
                          workKey: `${cat}:${item.title.toLowerCase()}`,
                          title: item.title,
                          category: cat,
                          href,
                          source: item.source,
                        })}
                      >
                        <Cover
                          src={item.cover_url}
                          title={item.title}
                          category={cat}
                          source={item.source}
                          mediaType={item.media_type}
                          size="sm"
                          aspect="square"
                        />
                        <div class="insights-otd-card-info">
                          <span class="insights-otd-title">{item.title}</span>
                          <span class="ui-text-muted">
                            {categoryLabel(cat)} · {sourceLabel(item.source)}
                          </span>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <GoalsSection year={heatmapYear} />
    </section>
  );
}
