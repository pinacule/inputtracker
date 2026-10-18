import { useEffect, useRef, useState } from "preact/hooks";
import {
  getSettings,
  getSyncStatus,
  importFile,
  syncNow,
  syncSimklNow,
  type ImportResult,
  type MetaProvider,
  type SettingsView,
  type SimklSyncResult,
  type SourceStatus,
  type SyncNowResult,
  type SyncRun,
} from "../api";
import { DEFAULT_TIMEZONE, formatDateTime } from "../lib/format-date";
import { describeImport } from "../lib/forms";
import { sourceLabel } from "../lib/sources";
import {
  readThemePreference,
  saveThemePreference,
  type ThemeMode,
} from "../lib/theme";
import {
  Badge,
  Button,
  Card,
  ImportExportIcon,
  MoonIcon,
  Skeleton,
  SunIcon,
  Tabs,
  type TabOption,
} from "../ui";

export interface SettingsProps {
  theme?: ThemeMode;
  onThemeChange?: (theme: ThemeMode) => void;
}

const THEME_OPTIONS: ReadonlyArray<TabOption<ThemeMode>> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light", icon: <SunIcon size={14} /> },
  { value: "dark", label: "Dark", icon: <MoonIcon size={14} /> },
];

const PROVIDER_LABELS: Readonly<Record<MetaProvider, string>> = {
  anilist: "AniList (Anime)",
  tvmaze: "TVmaze (Series)",
  cinemeta: "Cinemeta (Films & Series)",
  itunes: "iTunes Search (Films)",
  openlibrary: "Open Library (Books & Audiobooks)",
  tmdb: "TMDB (Films & Series)",
};

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
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

export function Settings({ theme, onThemeChange }: SettingsProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [localTheme, setLocalTheme] = useState<ThemeMode>(() =>
    theme ?? readThemePreference()
  );

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Sync actions state
  const [syncingAbs, setSyncingAbs] = useState(false);
  const [absResult, setAbsResult] = useState<SyncNowResult | null>(null);
  const [absError, setAbsError] = useState<string | null>(null);

  const [syncingSimkl, setSyncingSimkl] = useState(false);
  const [simklResult, setSimklResult] = useState<SimklSyncResult | null>(null);
  const [simklError, setSimklError] = useState<string | null>(null);

  // Import state
  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (theme) {
      setLocalTheme(theme);
    }
  }, [theme]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [settingsRes, syncRes] = await Promise.all([
        getSettings().catch(() => null),
        getSyncStatus().catch(() => ({ runs: [] as SyncRun[] })),
      ]);
      if (settingsRes) {
        setSettings(settingsRes);
      }
      setRuns(syncRes.runs ?? []);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleThemeSelect = (next: ThemeMode) => {
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

  const tz = settings?.timezone ?? DEFAULT_TIMEZONE;

  // Build effective sources list combining `settings.sources` with default known sources
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
            runs.find((r) => r.source === "youtube-takeout")?.started_at ?? null,
          last_status: null,
          last_error: null,
          can_sync_now: false,
        },
      ];

  return (
    <section class="page-container settings-page" aria-label="Settings">
      <header class="page-header">
        <div class="page-header-titles">
          <span class="page-eyebrow">Configuration & Data</span>
          <h1>Settings</h1>
          <p class="page-subtitle">
            Appearance, connected sources, manual sync triggers, backups, and
            metadata lookup providers.
          </p>
        </div>
      </header>

      {/* 1. Appearance */}
      <Card
        padding="md"
        title="Appearance"
        subtitle="Warm linen light paper or deep espresso charcoal dark study"
      >
        <div class="settings-row-between">
          <div>
            <strong>Colour Theme</strong>
            <p class="ui-text-muted">
              Stored in this browser&apos;s local storage (`inputtracker.theme`).
            </p>
          </div>
          <Tabs
            ariaLabel="Theme preference"
            options={THEME_OPTIONS}
            value={localTheme}
            onChange={handleThemeSelect}
          />
        </div>
      </Card>

      {/* 2. Connected Sources & Sync */}
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

      {/* 3. Import & Export */}
      <div class="insights-two-col">
        <Card
          padding="md"
          title="Import Data"
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
                (importResult.goals?.seen || importResult.annotations?.seen) ? (
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

      {/* 4. Metadata Providers & System Info */}
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
