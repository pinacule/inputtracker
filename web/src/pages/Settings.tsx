import { useEffect, useRef, useState } from "preact/hooks";
import {
  getSettings,
  getSyncStatus,
  importAchriom,
  importFile,
  syncNow,
  syncSimklNow,
  type AchriomImportResult,
  type ImportResult,
  type LibraryWork,
  type MetaProvider,
  type SettingsView,
  type SimklSyncResult,
  type SourceStatus,
  type SyncNowResult,
  type SyncRun,
} from "../api";
import { categoryLabel } from "../lib/categories";
import { DEFAULT_TIMEZONE, formatDateTime } from "../lib/format-date";
import { describeImport } from "../lib/forms";
import { sourceLabel } from "../lib/sources";
import { formatMinutes } from "../lib/stats";
import {
  DARK_THEMES,
  readThemePreference,
  saveThemePreference,
  type DarkThemeId,
} from "../lib/theme";
import {
  fetchHiddenWorksGraceful,
  performWorkEdit,
  pushToast,
  subscribeWorkEdits,
} from "../lib/work-edits";
import {
  Badge,
  Button,
  Card,
  CheckIcon,
  Cover,
  ImportExportIcon,
  Skeleton,
} from "../ui";

export interface SettingsProps {
  theme?: DarkThemeId;
  onThemeChange?: (theme: DarkThemeId) => void;
}

const PROVIDER_LABELS: Readonly<Record<MetaProvider, string>> = {
  anilist: "AniList (Anime)",
  tvmaze: "TVmaze (Series)",
  cinemeta: "Cinemeta (Films & Series)",
  itunes: "iTunes Search (Films)",
  openlibrary: "Open Library (Books & Audiobooks)",
  tmdb: "TMDB (Films & Series)",
};

export function formatBytes(bytes: number | null | undefined): string {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes < 0
  ) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${Math.round(kb * 10) / 10} KB`;
  }
  const mb = kb / 1024;
  return `${Math.round(mb * 10) / 10} MB`;
}

export function Settings({
  theme,
  onThemeChange,
}: SettingsProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const achriomFileRef = useRef<HTMLInputElement>(null);

  const [localTheme, setLocalTheme] = useState<DarkThemeId>(() =>
    theme ?? readThemePreference()
  );

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [hiddenWorks, setHiddenWorks] = useState<LibraryWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Sync actions state
  const [syncingAbs, setSyncingAbs] = useState(false);
  const [absResult, setAbsResult] = useState<SyncNowResult | null>(null);
  const [absError, setAbsError] = useState<string | null>(null);

  const [syncingSimkl, setSyncingSimkl] = useState(false);
  const [simklResult, setSimklResult] = useState<SimklSyncResult | null>(null);
  const [simklError, setSimklError] = useState<string | null>(null);

  // Native / Takeout Import state
  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Achriom Import state (upload -> dry-run summary -> import)
  const [achriomFile, setAchriomFile] = useState<File | null>(null);
  const [achriomBusy, setAchriomBusy] = useState<"dry-run" | "import" | null>(
    null
  );
  const [achriomResult, setAchriomResult] =
    useState<AchriomImportResult | null>(null);
  const [achriomError, setAchriomError] = useState<string | null>(null);
  const [showAllSkipped, setShowAllSkipped] = useState(false);

  useEffect(() => {
    if (theme) {
      setLocalTheme(theme);
    }
  }, [theme]);

  const loadHidden = async () => {
    const list = await fetchHiddenWorksGraceful();
    setHiddenWorks(list);
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [settingsRes, syncRes, hiddenRes] = await Promise.all([
        getSettings().catch(() => null),
        getSyncStatus().catch(() => ({ runs: [] as SyncRun[] })),
        fetchHiddenWorksGraceful(),
      ]);
      if (settingsRes) {
        setSettings(settingsRes);
      }
      setRuns(syncRes.runs ?? []);
      setHiddenWorks(hiddenRes);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
    return subscribeWorkEdits(() => {
      void loadHidden();
    });
  }, []);

  const handleThemeSelect = (next: DarkThemeId) => {
    const saved = saveThemePreference(next);
    setLocalTheme(saved);
    onThemeChange?.(saved);
  };

  const handleSyncAbs = async () => {
    setSyncingAbs(true);
    setAbsError(null);
    setAbsResult(null);
    try {
      const res = await syncNow();
      setAbsResult(res);
      await loadAll();
    } catch (err) {
      setAbsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingAbs(false);
    }
  };

  const handleSyncSimkl = async () => {
    setSyncingSimkl(true);
    setSimklError(null);
    setSimklResult(null);
    try {
      const res = await syncSimklNow();
      setSimklResult(res);
      await loadAll();
    } catch (err) {
      setSimklError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingSimkl(false);
    }
  };

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0] ?? null;
    if (!file) {
      setImportError("Choose a .json or .csv file first.");
      return;
    }

    setUploading(true);
    setImportError(null);
    setImportResult(null);

    try {
      const res = await importFile(file);
      setImportResult(res);
      if (fileRef.current) {
        fileRef.current.value = "";
      }
      await loadAll();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleAchriomRun = async (dryRun: boolean) => {
    const file = achriomFile ?? achriomFileRef.current?.files?.[0] ?? null;
    if (!file) {
      setAchriomError("Choose an Achriom .zip or .csv export file first.");
      return;
    }

    setAchriomBusy(dryRun ? "dry-run" : "import");
    setAchriomError(null);
    setShowAllSkipped(false);

    try {
      const res = await importAchriom(file, { dryRun });
      setAchriomResult(res);
      if (!dryRun) {
        pushToast({
          message: `Achriom import complete: ${res.created} created, ${res.updated} updated`,
          variant: "success",
        });
        await loadAll();
      }
    } catch (err) {
      setAchriomError(err instanceof Error ? err.message : String(err));
    } finally {
      setAchriomBusy(null);
    }
  };

  const handleUnhideWork = async (work: LibraryWork) => {
    await performWorkEdit(
      work.key,
      { hidden: false },
      {
        title: work.title,
        category: work.category,
      }
    );
    setHiddenWorks((prev) => prev.filter((w) => w.key !== work.key));
    pushToast({
      message: `Restored “${work.title}” to your library`,
      variant: "success",
    });
  };

  const tz = settings?.timezone ?? DEFAULT_TIMEZONE;

  const effectiveSources: SourceStatus[] = settings?.sources?.length
    ? settings.sources
    : [
        {
          source: "audiobookshelf",
          enabled: true,
          host: null,
          last_sync_at:
            runs.find((r) => r.source === "audiobookshelf")?.started_at ?? null,
          last_status: null,
          last_error:
            runs.find((r) => r.source === "audiobookshelf")?.error ?? null,
          can_sync_now: true,
        },
        {
          source: "simkl",
          enabled: true,
          host: "api.simkl.com",
          last_sync_at:
            runs.find((r) => r.source === "simkl")?.started_at ?? null,
          last_status: null,
          last_error: runs.find((r) => r.source === "simkl")?.error ?? null,
          can_sync_now: true,
        },
        {
          source: "youtube",
          enabled: true,
          host: null,
          last_sync_at:
            runs.find((r) => r.source === "youtube-takeout")?.started_at ??
            null,
          last_status: null,
          last_error: null,
          can_sync_now: false,
        },
      ];

  return (
    <section class="page-container settings-page" aria-label="Settings">
      <header class="page-header">
        <div class="page-header-titles">
          <h1>Settings</h1>
          <p class="page-subtitle">
            Dark themes, YouTube filtering, Achriom & Takeout imports, hidden
            works, connected sources, and backups.
          </p>
        </div>
      </header>

      {/* 1. Appearance (Dark Theme Swatch Cards) */}
      <Card
        padding="md"
        title="Appearance"
        subtitle="Five WCAG-AA dark themes applied before first paint"
      >
        <div
          class="theme-swatches-grid"
          role="radiogroup"
          aria-label="Dark colour theme"
        >
          {DARK_THEMES.map((t) => {
            const isSelected = localTheme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                class={
                  isSelected
                    ? "theme-swatch-card theme-swatch-card--active"
                    : "theme-swatch-card"
                }
                onClick={() => handleThemeSelect(t.id)}
              >
                <div
                  class="theme-swatch-preview"
                  style={{
                    backgroundColor: t.swatches.canvas,
                    borderColor: t.swatches.border,
                  }}
                  aria-hidden="true"
                >
                  <div
                    class="theme-swatch-surface"
                    style={{
                      backgroundColor: t.swatches.surface,
                      borderColor: t.swatches.border,
                    }}
                  >
                    <span
                      class="theme-swatch-text"
                      style={{ color: t.swatches.textPrimary }}
                    >
                      Aa
                    </span>
                    <span
                      class="theme-swatch-pill"
                      style={{
                        backgroundColor: t.swatches.accent,
                        color: t.swatches.canvas,
                      }}
                    />
                  </div>
                  <div class="theme-swatch-dots">
                    <span
                      style={{ backgroundColor: t.categories.anime.solid }}
                    />
                    <span
                      style={{ backgroundColor: t.categories.series.solid }}
                    />
                    <span
                      style={{ backgroundColor: t.categories.film.solid }}
                    />
                    <span
                      style={{ backgroundColor: t.categories.book.solid }}
                    />
                  </div>
                </div>

                <div class="theme-swatch-info">
                  <div class="theme-swatch-title-row">
                    <strong>{t.label}</strong>
                    {isSelected && (
                      <span class="theme-swatch-check" aria-hidden="true">
                        <CheckIcon size={14} />
                      </span>
                    )}
                  </div>
                  <span class="theme-swatch-desc">{t.description}</span>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {/* 2. Achriom Library Import (upload -> dry-run summary -> import) */}
      <Card
        padding="md"
        title="Import Achriom Library"
        subtitle="Upload an achriom-library-YYYY-MM-DD.zip export or individual CSV (anime.csv, movies.csv, shows.csv, books.csv)"
      >
        <div class="ui-form-stack">
          <div class="ui-form-field">
            <label class="ui-form-label" for="settings-achriom-file">
              Achriom export file (.zip or .csv)
            </label>
            <input
              id="settings-achriom-file"
              ref={achriomFileRef}
              type="file"
              accept=".zip,.csv"
              class="ui-input"
              onChange={(e) => {
                const f =
                  (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
                setAchriomFile(f);
                setAchriomResult(null);
                setAchriomError(null);
              }}
            />
          </div>

          <div class="ui-form-actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={achriomBusy !== null}
              leadingIcon={<ImportExportIcon size={15} />}
              onClick={() => void handleAchriomRun(true)}
            >
              {achriomBusy === "dry-run"
                ? "Checking Dry Run…"
                : "1. Preview (Dry Run)"}
            </Button>

            <Button
              variant="primary"
              size="sm"
              disabled={achriomBusy !== null}
              leadingIcon={<ImportExportIcon size={15} />}
              onClick={() => void handleAchriomRun(false)}
            >
              {achriomBusy === "import"
                ? "Importing…"
                : "2. Import Achriom Archive"}
            </Button>
          </div>

          {achriomError && (
            <p class="ui-form-error" role="alert">
              {achriomError}
            </p>
          )}

          {achriomResult && (
            <div class="achriom-result-box" role="status" aria-live="polite">
              <div class="settings-row-between">
                <strong>
                  {achriomResult.dry_run
                    ? "Dry-Run Preview Summary"
                    : "Achriom Import Complete"}
                </strong>
                <Badge
                  size="sm"
                  variant={achriomResult.dry_run ? "warning" : "success"}
                >
                  {achriomResult.dry_run
                    ? "Dry run — nothing written yet"
                    : "Saved to archive"}
                </Badge>
              </div>

              <div class="achriom-stats-grid tabular-nums">
                <div class="achriom-stat-cell">
                  <span class="ui-text-muted">New entries</span>
                  <strong>{achriomResult.created}</strong>
                </div>
                <div class="achriom-stat-cell">
                  <span class="ui-text-muted">Updated</span>
                  <strong>{achriomResult.updated}</strong>
                </div>
                <div class="achriom-stat-cell">
                  <span class="ui-text-muted">Unchanged</span>
                  <strong>{achriomResult.unchanged}</strong>
                </div>
                <div class="achriom-stat-cell">
                  <span class="ui-text-muted">Planned (Watchlist)</span>
                  <strong>{achriomResult.planned}</strong>
                </div>
                <div class="achriom-stat-cell">
                  <span class="ui-text-muted">Metadata matched</span>
                  <strong>{achriomResult.matched}</strong>
                </div>
                <div class="achriom-stat-cell">
                  <span class="ui-text-muted">Total time</span>
                  <strong>{formatMinutes(achriomResult.total_minutes)}</strong>
                </div>
              </div>

              {Object.keys(achriomResult.rows ?? {}).length > 0 && (
                <div class="achriom-files-row tabular-nums">
                  <span class="ui-text-muted">Rows per file:</span>
                  {Object.entries(achriomResult.rows).map(([file, count]) => (
                    <Badge key={file} size="sm" variant="neutral">
                      {file}: {count}
                    </Badge>
                  ))}
                </div>
              )}

              {achriomResult.skipped && achriomResult.skipped.length > 0 && (
                <div class="achriom-skipped-section">
                  <div class="settings-row-between">
                    <span class="ui-text-muted tabular-nums">
                      Skipped rows ({achriomResult.skipped.length})
                    </span>
                    {achriomResult.skipped.length > 6 && (
                      <button
                        type="button"
                        class="ui-inline-link"
                        onClick={() => setShowAllSkipped((v) => !v)}
                      >
                        {showAllSkipped
                          ? "Show fewer"
                          : `Show all ${achriomResult.skipped.length}`}
                      </button>
                    )}
                  </div>
                  <ul class="achriom-skipped-list">
                    {(showAllSkipped
                      ? achriomResult.skipped
                      : achriomResult.skipped.slice(0, 6)
                    ).map((s, idx) => (
                      <li key={`${s.file}-${s.title}-${idx}`}>
                        <strong>{s.title || "(Untitled)"}</strong>{" "}
                        <span class="ui-text-muted">
                          ({s.file}) — {s.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* 3. Hidden Works (Unhide) */}
      <Card
        padding="md"
        title={`Hidden Works (${hiddenWorks.length})`}
        subtitle="Hidden works are excluded from library, calendar, charts, and totals"
      >
        {hiddenWorks.length === 0 ? (
          <p class="ui-text-muted">
            No works are currently hidden. You can hide any work from its page
            or right-click context menu.
          </p>
        ) : (
          <ul class="library-archive-entries-list">
            {hiddenWorks.map((work) => (
              <li key={work.key} class="library-archive-entry-row">
                <Cover
                  src={work.cover_url}
                  title={work.title}
                  category={work.category}
                  size="sm"
                  aspect="square"
                />
                <div class="library-archive-entry-info">
                  <strong>{work.title}</strong>
                  <span class="ui-text-muted tabular-nums">
                    {categoryLabel(work.category)}
                    {work.total_minutes > 0
                      ? ` · ${formatMinutes(work.total_minutes)}`
                      : ""}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleUnhideWork(work)}
                >
                  Unhide
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 4. Connected Sources & Sync */}
      <Card
        padding="md"
        title="Sources & Sync"
        subtitle="Pull recent activity from Audiobookshelf and Simkl"
      >
        {loading && !settings && runs.length === 0 ? (
          <Skeleton height={120} />
        ) : (
          <div class="settings-sources-stack">
            <ul class="settings-sources-list">
              {effectiveSources.map((src) => {
                const isAbs = src.source === "audiobookshelf";
                const isSimkl = src.source === "simkl";
                return (
                  <li key={src.source} class="settings-source-row">
                    <div class="settings-source-info">
                      <div class="settings-source-title-row">
                        <strong>{sourceLabel(src.source)}</strong>
                        <Badge
                          size="sm"
                          variant={src.enabled ? "success" : "neutral"}
                        >
                          {src.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                        {src.last_status && (
                          <Badge
                            size="sm"
                            variant={
                              src.last_status === "ok"
                                ? "success"
                                : src.last_status === "failed"
                                  ? "danger"
                                  : "warning"
                            }
                          >
                            {src.last_status}
                          </Badge>
                        )}
                      </div>
                      <div class="settings-source-meta tabular-nums">
                        {src.host && <span>Host: {src.host} · </span>}
                        {src.last_sync_at ? (
                          <span>
                            Last sync: {formatDateTime(src.last_sync_at, tz)}
                          </span>
                        ) : (
                          <span>No sync recorded yet</span>
                        )}
                      </div>
                      {src.last_error && (
                        <p class="ui-form-error">{src.last_error}</p>
                      )}
                    </div>

                    <div class="settings-source-actions">
                      {isAbs && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={syncingAbs}
                          onClick={() => void handleSyncAbs()}
                        >
                          {syncingAbs ? "Syncing…" : "Sync now"}
                        </Button>
                      )}
                      {isSimkl && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={syncingSimkl}
                          onClick={() => void handleSyncSimkl()}
                        >
                          {syncingSimkl ? "Syncing…" : "Sync Simkl now"}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {absError && (
              <p class="ui-form-error" role="alert">
                Audiobookshelf sync failed: {absError}
              </p>
            )}
            {absResult && (
              <p class="add-saved-banner" role="status">
                Audiobookshelf sync complete: {describeImport(absResult)}
              </p>
            )}

            {simklError && (
              <p class="ui-form-error" role="alert">
                Simkl sync failed: {simklError}
              </p>
            )}
            {simklResult && (
              <p class="add-saved-banner" role="status">
                Simkl sync complete: {describeImport(simklResult)} (
                {simklResult.mode})
              </p>
            )}

            {statusError && (
              <p class="ui-form-error" role="alert">
                {statusError}
              </p>
            )}

            {runs.length > 0 && (
              <div class="settings-runs-section">
                <h3 class="settings-subheading">Recent Ingest Runs</h3>
                <ul class="settings-runs-list">
                  {runs.map((run) => (
                    <li
                      key={`${run.source}-${run.started_at}`}
                      class="settings-run-row tabular-nums"
                    >
                      <strong>{sourceLabel(run.source)}</strong>
                      <span>{formatDateTime(run.started_at, tz)}</span>
                      <span>
                        {describeImport({
                          seen: run.rows_seen,
                          inserted: run.rows_inserted,
                        })}
                      </span>
                      {run.error && (
                        <span class="ui-form-error">{run.error}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 5. Native Backup & YouTube Takeout Import / Export */}
      <div class="insights-two-col">
        <Card
          padding="md"
          title="Import Backup or YouTube Takeout"
          subtitle="Upload a native InputTracker backup (.json / .csv) or YouTube Takeout watch-history.json"
        >
          <div class="ui-form-stack">
            <div class="ui-form-field">
              <label class="ui-form-label" for="settings-import-file">
                Choose export or Takeout file
              </label>
              <input
                id="settings-import-file"
                ref={fileRef}
                type="file"
                accept=".json,.csv"
                class="ui-input"
              />
            </div>

            <div>
              <Button
                variant="primary"
                size="sm"
                disabled={uploading}
                onClick={() => void handleUpload()}
                leadingIcon={<ImportExportIcon size={15} />}
              >
                {uploading ? "Uploading…" : "Upload & Import"}
              </Button>
            </div>

            {importError && (
              <p class="ui-form-error" role="alert">
                {importError}
              </p>
            )}

            {importResult && (
              <p class="add-saved-banner" role="status">
                {importResult.kind === "youtube-takeout"
                  ? `YouTube Takeout — ${importResult.seen ?? 0} views, ${
                      importResult.inserted
                    } new`
                  : `${describeImport(importResult)} — ${
                      importResult.seen
                    } seen, ${importResult.inserted} inserted`}
                {importResult.kind === "native" &&
                (importResult.goals?.seen ||
                  importResult.annotations?.seen) ? (
                  <>
                    {" "}
                    — goals{" "}
                    {describeImport(
                      importResult.goals ?? { seen: 0, inserted: 0 }
                    )}
                    , ratings/notes{" "}
                    {describeImport(
                      importResult.annotations ?? { seen: 0, inserted: 0 }
                    )}
                  </>
                ) : null}
                {importResult.kind === "youtube-takeout" &&
                  importResult.skipped && (
                    <>
                      {" "}
                      — skipped {importResult.skipped.ads} ads,{" "}
                      {importResult.skipped.no_video} without video,{" "}
                      {importResult.skipped.other} other,{" "}
                      {importResult.skipped.invalid} invalid
                    </>
                  )}
              </p>
            )}
          </div>
        </Card>

        <Card
          padding="md"
          title="Export Archive"
          subtitle="Download your complete append-only consumption log, goals, and annotations"
        >
          <div class="ui-form-stack">
            <p class="ui-text-muted">
              Exports include all events, archive units, annotations, and goals
              in a portable format.
            </p>
            <div class="ui-form-actions">
              <Button
                variant="secondary"
                size="sm"
                href="/api/export.json"
                leadingIcon={<ImportExportIcon size={15} />}
              >
                Export JSON
              </Button>
              <Button
                variant="secondary"
                size="sm"
                href="/api/export.csv"
                leadingIcon={<ImportExportIcon size={15} />}
              >
                Export CSV
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* 6. Metadata Providers & System Info */}
      <div class="insights-two-col">
        <Card
          padding="md"
          title="Metadata Lookup Providers"
          subtitle="Used when searching titles in Add to Archive"
        >
          <ul class="settings-providers-list">
            {(
              settings?.metadata_providers ?? [
                { provider: "anilist" as const, enabled: true },
                { provider: "tvmaze" as const, enabled: true },
                { provider: "itunes" as const, enabled: true },
                { provider: "openlibrary" as const, enabled: true },
                { provider: "tmdb" as const, enabled: false },
              ]
            ).map((p) => (
              <li key={p.provider} class="settings-provider-row">
                <span>{PROVIDER_LABELS[p.provider] ?? p.provider}</span>
                <Badge size="sm" variant={p.enabled ? "success" : "neutral"}>
                  {p.enabled ? "Enabled" : "Not configured"}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card
          padding="md"
          title="Database & Environment"
          subtitle="Read-only server diagnostics (secrets are never exposed)"
        >
          <dl class="settings-kv-list tabular-nums">
            <div class="settings-kv-row">
              <dt>Timezone</dt>
              <dd>{settings?.timezone ?? DEFAULT_TIMEZONE}</dd>
            </div>
            <div class="settings-kv-row">
              <dt>Total Stored Events</dt>
              <dd>{settings ? settings.database.events : "—"}</dd>
            </div>
            <div class="settings-kv-row">
              <dt>Database Size</dt>
              <dd>{formatBytes(settings?.database.size_bytes)}</dd>
            </div>
            <div class="settings-kv-row">
              <dt>Last Backup</dt>
              <dd>
                {settings?.database.last_backup_at
                  ? formatDateTime(settings.database.last_backup_at, tz)
                  : "—"}
              </dd>
            </div>
            <div class="settings-kv-row">
              <dt>Ingest Token</dt>
              <dd>
                <Badge
                  size="sm"
                  variant={settings?.ingest_token_set ? "success" : "neutral"}
                >
                  {settings?.ingest_token_set ? "Configured" : "Not set"}
                </Badge>
              </dd>
            </div>
            <div class="settings-kv-row">
              <dt>External Covers Cache</dt>
              <dd>
                <Badge
                  size="sm"
                  variant={settings?.covers_external ? "success" : "neutral"}
                >
                  {settings?.covers_external ? "Enabled" : "Local only"}
                </Badge>
              </dd>
            </div>
            {settings?.version && (
              <div class="settings-kv-row">
                <dt>Version</dt>
                <dd>{settings.version}</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>
    </section>
  );
}
