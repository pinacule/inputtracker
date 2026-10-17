import { useEffect, useState } from "preact/hooks";
import {
  getGoals,
  saveGoal,
  type Goal,
} from "../api";
import { MEDIA_TYPE_OPTIONS } from "../lib/forms";
import {
  buildGoalInput,
  formatGoalValue,
  GOAL_METRIC_OPTIONS,
  metricLabel,
  statusLabel,
  type GoalFormState,
} from "../lib/goals";
import { SOURCES, sourceLabel } from "../lib/sources";

export interface GoalsCardProps {
  year: number;
}

function mediaTypeLabel(type: string): string {
  const found = MEDIA_TYPE_OPTIONS.find((opt) => opt.value === type);
  return found ? found.label : type;
}

export function GoalsCard({ year }: GoalsCardProps) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState<boolean>(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [formState, setFormState] = useState<GoalFormState>({
    year,
    metric: "items",
    target: "",
    source: "",
    media_type: "",
  });
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const loadGoals = (targetYear: number) => {
    setLoading(true);
    setError(null);
    getGoals(targetYear)
      .then((res) => {
        setGoals(res.goals);
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

  const handleOpenAdd = () => {
    setEditingGoal(null);
    setFormState({
      year,
      metric: "items",
      target: "",
      source: "",
      media_type: "",
    });
    setFormErrors([]);
    setShowForm(true);
  };

  const handleOpenEdit = (goal: Goal) => {
    setEditingGoal(goal);
    setFormState({
      goal_id: goal.goal_id,
      year: goal.year,
      metric: goal.metric,
      target: String(goal.target),
      source: goal.source ?? "",
      media_type: goal.media_type ?? "",
    });
    setFormErrors([]);
    setShowForm(true);
  };

  const handleCancelForm = () => {
    setShowForm(false);
    setEditingGoal(null);
    setFormErrors([]);
  };

  const handleArchive = async (goal: Goal) => {
    const desc = `${formatGoalValue(goal.metric, goal.target)} (${metricLabel(goal.metric)})`;
    if (!window.confirm(`Archive goal "${desc}"?`)) {
      return;
    }
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
      alert(
        `Failed to archive goal: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  const handleSubmitForm = async (e: Event) => {
    e.preventDefault();
    const result = buildGoalInput({
      ...formState,
      year,
    });

    if (result.errors.length > 0) {
      setFormErrors(result.errors);
      return;
    }

    if (!result.input) {
      return;
    }

    setSubmitting(true);
    setFormErrors([]);
    try {
      await saveGoal(result.input);
      setShowForm(false);
      setEditingGoal(null);
      loadGoals(year);
    } catch (err) {
      setFormErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section class="card stats-card" aria-labelledby="goals-card-heading">
      <div class="stats-card-header">
        <h2 id="goals-card-heading" class="stats-card-title">
          Goals
        </h2>
        {!showForm && (
          <button
            type="button"
            class="btn btn-secondary goal-add-btn"
            onClick={handleOpenAdd}
          >
            Add goal
          </button>
        )}
      </div>

      {error && (
        <div class="alert alert-error" role="alert">
          <strong>Error loading goals:</strong> {error}
        </div>
      )}

      {/* Inline Form */}
      {showForm && (
        <form class="goal-form" onSubmit={handleSubmitForm}>
          <h3 class="goal-form-title">
            {editingGoal ? "Edit goal" : "Add goal"} ({year})
          </h3>

          {formErrors.length > 0 && (
            <div class="alert alert-error" role="alert">
              <ul class="goal-form-errors">
                {formErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}

          <div class="goal-form-grid">
            <div class="form-group">
              <label for="goal-form-metric" class="form-label">
                Metric
              </label>
              <select
                id="goal-form-metric"
                class="form-input"
                value={formState.metric}
                onChange={(e) =>
                  setFormState((prev) => ({
                    ...prev,
                    metric: (e.target as HTMLSelectElement).value,
                  }))
                }
                disabled={submitting}
              >
                {GOAL_METRIC_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div class="form-group">
              <label for="goal-form-target" class="form-label">
                Target
              </label>
              <input
                id="goal-form-target"
                type="number"
                step="any"
                min="0.1"
                max="1000000"
                class="form-input"
                placeholder="e.g. 30"
                value={formState.target}
                onInput={(e) =>
                  setFormState((prev) => ({
                    ...prev,
                    target: (e.target as HTMLInputElement).value,
                  }))
                }
                disabled={submitting}
                required
              />
            </div>

            <div class="form-group">
              <label for="goal-form-source" class="form-label">
                Source (optional)
              </label>
              <select
                id="goal-form-source"
                class="form-input"
                value={formState.source ?? ""}
                onChange={(e) =>
                  setFormState((prev) => ({
                    ...prev,
                    source: (e.target as HTMLSelectElement).value,
                  }))
                }
                disabled={submitting}
              >
                <option value="">All sources</option>
                {SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <div class="form-group">
              <label for="goal-form-media-type" class="form-label">
                Media type (optional)
              </label>
              <select
                id="goal-form-media-type"
                class="form-input"
                value={formState.media_type ?? ""}
                onChange={(e) =>
                  setFormState((prev) => ({
                    ...prev,
                    media_type: (e.target as HTMLSelectElement).value,
                  }))
                }
                disabled={submitting}
              >
                <option value="">All media types</option>
                {MEDIA_TYPE_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div class="goal-form-actions">
            <button
              type="button"
              class="btn btn-secondary goal-btn-sm"
              onClick={handleCancelForm}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="btn btn-primary goal-btn-sm"
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}

      {loading && !showForm && (
        <p class="muted goal-loading">Loading goals…</p>
      )}

      {!loading && !showForm && goals.length === 0 && (
        <p class="muted goal-empty">No goals for {year} yet.</p>
      )}

      {!loading && goals.length > 0 && (
        <ul class="goal-list">
          {goals.map((goal) => {
            const current = goal.progress.current;
            const target = goal.target;
            const percent = goal.progress.percent;
            const clampedPct = Math.min(100, Math.max(0, percent));
            const expectedPct =
              target > 0
                ? Math.min(
                    100,
                    Math.max(0, (goal.progress.expected / target) * 100)
                  )
                : 0;

            const valueLabel = formatGoalValue(goal.metric, current, target);
            const statusText = statusLabel(goal.progress, goal.metric);

            return (
              <li key={goal.goal_id} class="goal-item">
                <div class="goal-item-header">
                  <div class="goal-item-info">
                    <span class="goal-item-title">{valueLabel}</span>
                    <div class="goal-item-meta">
                      <span class="goal-item-metric">
                        {metricLabel(goal.metric)}
                      </span>
                      {goal.source && (
                        <span class="goal-item-badge">
                          {sourceLabel(goal.source)}
                        </span>
                      )}
                      {goal.media_type && (
                        <span class="goal-item-badge">
                          {mediaTypeLabel(goal.media_type)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div class="goal-item-actions">
                    <button
                      type="button"
                      class="goal-btn-sm"
                      onClick={() => handleOpenEdit(goal)}
                      aria-label={`Edit ${metricLabel(goal.metric)} goal`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      class="goal-btn-sm"
                      onClick={() => handleArchive(goal)}
                      aria-label={`Archive ${metricLabel(goal.metric)} goal`}
                    >
                      Archive
                    </button>
                  </div>
                </div>

                <div class="goal-progress-container">
                  <div
                    class="goal-progress-bar"
                    role="progressbar"
                    aria-valuenow={Math.round(percent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Progress: ${valueLabel}`}
                  >
                    <div
                      class={`goal-progress-fill goal-status-fill-${goal.progress.status}`}
                      style={{ width: `${clampedPct}%` }}
                    />
                    {goal.progress.status !== "not_started" && (
                      <div
                        class="goal-progress-marker"
                        style={{ left: `${expectedPct}%` }}
                        aria-hidden="true"
                        title={`Expected pace: ${formatGoalValue(
                          goal.metric,
                          goal.progress.expected
                        )}`}
                      />
                    )}
                  </div>
                </div>

                <div class="goal-item-footer">
                  <span class={`goal-status goal-status-${goal.progress.status}`}>
                    {statusText}
                  </span>
                  <span class="goal-item-percent">
                    {Math.round(percent)}%
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
