import { useEffect, useRef, useState } from "preact/hooks";
import {
  getSyncStatus,
  importFile,
  syncNow,
  syncSimklNow,
  type ImportResult,
  type SimklSyncResult,
  type SyncNowResult,
  type SyncRun,
} from "../api";
import { DEFAULT_TIMEZONE, formatDateTime } from "../lib/format-date";
import { describeImport } from "../lib/forms";
import { sourceLabel } from "../lib/sources";

export function ImportExport() {
  const fileRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncNowResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [syncingSimkl, setSyncingSimkl] = useState(false);
  const [simklResult, setSimklResult] = useState<SimklSyncResult | null>(null);
  const [simklError, setSimklError] = useState<string | null>(null);

  const [runs, setRuns] = useState<SyncRun[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadStatus = async () => {
    try {
      const res = await getSyncStatus();
      setRuns(res.runs ?? []);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0] ?? null;
    if (file === null) {
      setImportError("Choose a .json or .csv file first.");
      return;
    }

    setUploading(true);
    setImportError(null);
    setImportResult(null);

    try {
      const result = await importFile(file);
      setImportResult(result);
      if (fileRef.current) {
        fileRef.current.value = "";
      }
      await loadStatus();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);

    try {
      const result = await syncNow();
      setSyncResult(result);
      await loadStatus();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncSimkl = async () => {
    setSyncingSimkl(true);
    setSimklError(null);
    setSimklResult(null);

    try {
      const result = await syncSimklNow();
      setSimklResult(result);
      await loadStatus();
    } catch (err) {
      setSimklError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingSimkl(false);
    }
  };

  return (
    <section class="page stack">
      <h1>Import / Export</h1>

      <section class="card" aria-labelledby="import-heading">
        <h2 id="import-heading" class="card-title">
          Import
        </h2>
        <p class="muted">
          Upload a native InputTracker export (<code>.json</code> or{" "}
          <code>.csv</code>). Duplicates are skipped. A YouTube Takeout{" "}
          <code>watch-history.json</code> (JSON format) is accepted too.
        </p>

        <div class="form-field">
          <label class="form-label" for="import-file">
            Export file
          </label>
          <input
            id="import-file"
            ref={fileRef}
            class="form-input"
            type="file"
            accept=".json,.csv"
          />
        </div>

        <button
          type="button"
          class="btn btn-primary"
          onClick={handleUpload}
          disabled={uploading}
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>

        {importError && (
          <p class="alert alert-error" role="alert">
            {importError}
          </p>
        )}

        {importResult && (
          <p class="alert alert-success" role="status">
            {importResult.kind === "youtube-takeout"
              ? `YouTube Takeout — ${importResult.seen ?? 0} views, ${
                  importResult.inserted
                } new`
              : `${describeImport(importResult)} — ${importResult.seen} seen, ${
                  importResult.inserted
                } inserted`}
            {importResult.kind === "youtube-takeout" && importResult.skipped && (
              <>
                {" "}
                — skipped {importResult.skipped.ads} ads,{" "}
                {importResult.skipped.no_video} without video,{" "}
                {importResult.skipped.other} other, {importResult.skipped.invalid}{" "}
                invalid
              </>
            )}
          </p>
        )}
      </section>

      <section class="card" aria-labelledby="export-heading">
        <h2 id="export-heading" class="card-title">
          Export
        </h2>
        <p class="muted">Download your full archive.</p>
        <div class="link-row">
          <a class="btn btn-secondary" href="/api/export.json" download>
            Export JSON
          </a>
          <a class="btn btn-secondary" href="/api/export.csv" download>
            Export CSV
          </a>
        </div>
      </section>

      <section class="card" aria-labelledby="sync-heading">
        <h2 id="sync-heading" class="card-title">
          Sync
        </h2>
        <p class="muted">
          Pull recent activity from Audiobookshelf and Simkl.
        </p>

        <div class="link-row">
          <button
            type="button"
            class="btn btn-primary"
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>

          <button
            type="button"
            class="btn btn-primary"
            onClick={handleSyncSimkl}
            disabled={syncingSimkl}
          >
            {syncingSimkl ? "Syncing…" : "Sync Simkl now"}
          </button>
        </div>

        {syncError && (
          <p class="alert alert-error" role="alert">
            {syncError}
          </p>
        )}

        {syncResult && (
          <p class="alert alert-success" role="status">
            {describeImport(syncResult)}
          </p>
        )}

        {simklError && (
          <p class="alert alert-error" role="alert">
            {simklError}
          </p>
        )}

        {simklResult && (
          <p class="alert alert-success" role="status">
            {describeImport(simklResult)} ({simklResult.mode})
          </p>
        )}

        <div class="status-block">
          <h3 class="status-heading">Last run per source</h3>

          {statusError && (
            <p class="alert alert-error" role="alert">
              {statusError}
            </p>
          )}

          {statusError === null && runs !== null && runs.length === 0 && (
            <p class="muted">No sync runs yet.</p>
          )}

          {runs !== null && runs.length > 0 && (
            <ul class="status-list">
              {runs.map((run) => (
                <li key={run.source} class="status-item">
                  <span class="status-source">
                    {sourceLabel(run.source)}
                  </span>
                  <span class="status-time">
                    {formatDateTime(run.started_at, DEFAULT_TIMEZONE)}
                  </span>
                  <span class="status-counts">
                    {describeImport({
                      seen: run.rows_seen,
                      inserted: run.rows_inserted,
                    })}
                  </span>
                  {run.error !== null && run.error !== "" && (
                    <span class="status-error">{run.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </section>
  );
}
