/**
 * V2 Hash Router & Legacy Route Redirects for InputTracker.
 *
 * Canonical routes:
 * - `calendar`: Home / Monthly Calendar & Day Detail
 * - `library`: Category Shelf, Works Grid & Work Detail (`?work=<key>`)
 * - `insights`: Charts, Time Series, Punch Card, 52-Week Heatmap, Streaks & Goals
 * - `review`: Month in Review (default) & Year in Review (`?view=year`)
 * - `add`: Lookup-First Add to Archive & Offline Quick Log
 * - `search`: Global Library & Event Search (`?q=`, `?key=`)
 * - `settings`: Sources & Sync, Import/Export, Providers, Appearance
 *
 * Legacy routes redirect automatically:
 * - `#/stats` -> `#/insights`
 * - `#/heatmap` -> `#/insights`
 * - `#/year` -> `#/review?view=year`
 * - `#/progress` -> `#/library?status=in_progress`
 * - `#/importexport` -> `#/settings`
 *
 * Pure and DOM-free; safe to run under Bun or in the browser.
 */

import type { Category, LibrarySort, WorkStatus } from "../api";
import { isCategory } from "./categories";
import type { InsightsRangePreset } from "./charts";

export type AppRoute =
  | "calendar"
  | "library"
  | "insights"
  | "review"
  | "add"
  | "search"
  | "settings";

export interface AppRouteDef {
  readonly id: AppRoute;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly inPrimaryNav: boolean;
}

export const APP_ROUTES: ReadonlyArray<AppRouteDef> = [
  {
    id: "calendar",
    label: "Calendar",
    shortLabel: "Today",
    description: "Monthly activity log and daily media breakdown",
    inPrimaryNav: true,
  },
  {
    id: "library",
    label: "Library",
    shortLabel: "Library",
    description: "Every watched, read, and listened work by category",
    inPrimaryNav: true,
  },
  {
    id: "insights",
    label: "Insights",
    shortLabel: "Insights",
    description: "Charts, category rhythm, punch card, heatmap, and goals",
    inPrimaryNav: true,
  },
  {
    id: "review",
    label: "Review",
    shortLabel: "Review",
    description: "Month in review and annual retrospective",
    inPrimaryNav: true,
  },
  {
    id: "add",
    label: "Add to Archive",
    shortLabel: "Add",
    description: "Look up any work to archive or log a quick session",
    inPrimaryNav: false,
  },
  {
    id: "search",
    label: "Search",
    shortLabel: "Search",
    description: "Find any title, series, author, or channel across your archive",
    inPrimaryNav: false,
  },
  {
    id: "settings",
    label: "Settings",
    shortLabel: "Settings",
    description: "Sources, sync, import/export, metadata providers, and theme",
    inPrimaryNav: false,
  },
];

export const PRIMARY_NAV_ROUTES: ReadonlyArray<AppRoute> = [
  "calendar",
  "library",
  "insights",
  "review",
];

export const MOBILE_TAB_ROUTES: ReadonlyArray<AppRoute> = [
  "calendar",
  "library",
  "add",
  "insights",
  "review",
];

export interface ParsedAppLocation {
  readonly route: AppRoute;
  /** Non-null when an old deep link (`#/stats`, `#/year`, etc.) should redirect. */
  readonly redirectedFrom?: string;
  readonly canonicalHash?: string;
  readonly date?: string;
  readonly month?: string;
  readonly year?: string;
  readonly q?: string;
  readonly hitKey?: string;
  readonly workKey?: string;
  readonly category?: Category;
  readonly status?: WorkStatus;
  readonly sort?: LibrarySort;
  readonly range?: InsightsRangePreset;
  readonly reviewView?: "month" | "year";
  readonly entryId?: string;
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "in_progress",
  "finished",
  "dropped",
  "unknown",
]);

const VALID_SORTS: ReadonlySet<string> = new Set(["recent", "time", "title"]);

const VALID_RANGES: ReadonlySet<string> = new Set([
  "30d",
  "12w",
  "12m",
  "all",
]);

/**
 * Checks if a raw hash is a legacy route (`#/stats`, `#/heatmap`, `#/year`,
 * `#/progress`, `#/importexport`) and returns its new canonical hash if so,
 * or `null` if no redirect is needed.
 */
export function resolveLegacyRedirect(hash: string): string | null {
  const stripped = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = stripped.split("?");
  const raw = (pathPart ?? "").split(/[?/]/, 1)[0]?.toLowerCase() ?? "";
  const params = new URLSearchParams(queryPart ?? "");

  switch (raw) {
    case "stats":
    case "heatmap":
      return "#/insights";
    case "year": {
      const y = params.get("year");
      if (y && /^\d{4}$/.test(y)) {
        return `#/review?view=year&year=${y}`;
      }
      return "#/review?view=year";
    }
    case "progress":
      return "#/library?status=in_progress";
    case "importexport":
      return "#/settings";
    default:
      return null;
  }
}

/**
 * Parses the location hash into a strongly typed `ParsedAppLocation`,
 * resolving legacy deep links automatically.
 */
export function parseAppRoute(hash: string): ParsedAppLocation {
  const redirectTarget = resolveLegacyRedirect(hash);
  const effectiveHash = redirectTarget ?? hash;

  const stripped = effectiveHash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = stripped.split("?");
  const rawRoute = (pathPart ?? "").split(/[?/]/, 1)[0]?.toLowerCase() ?? "";

  const matched = APP_ROUTES.find((r) => r.id === rawRoute);
  const route: AppRoute = matched ? matched.id : "calendar";

  let date: string | undefined;
  let month: string | undefined;
  let year: string | undefined;
  let q: string | undefined;
  let hitKey: string | undefined;
  let workKey: string | undefined;
  let category: Category | undefined;
  let status: WorkStatus | undefined;
  let sort: LibrarySort | undefined;
  let range: InsightsRangePreset | undefined;
  let reviewView: "month" | "year" | undefined;
  let entryId: string | undefined;

  if (queryPart) {
    const params = new URLSearchParams(queryPart);

    const d = params.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      date = d;
    }

    const m = params.get("month");
    if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
      month = m;
    }

    const y = params.get("year");
    if (y && /^\d{4}$/.test(y)) {
      year = y;
    }

    const qRaw = params.get("q");
    if (qRaw && qRaw.length <= 200) {
      q = qRaw;
    }

    const keyRaw = params.get("key");
    if (keyRaw && keyRaw.length <= 500) {
      hitKey = keyRaw;
    }

    const workRaw = params.get("work");
    if (workRaw && workRaw.length <= 500) {
      workKey = workRaw;
    }

    const catRaw = params.get("category");
    if (catRaw && isCategory(catRaw)) {
      category = catRaw;
    }

    const statusRaw = params.get("status");
    if (statusRaw && VALID_STATUSES.has(statusRaw)) {
      status = statusRaw as WorkStatus;
    }

    const sortRaw = params.get("sort");
    if (sortRaw && VALID_SORTS.has(sortRaw)) {
      sort = sortRaw as LibrarySort;
    }

    const rangeRaw = params.get("range");
    if (rangeRaw && VALID_RANGES.has(rangeRaw)) {
      range = rangeRaw as InsightsRangePreset;
    }

    const viewRaw = params.get("view");
    if (viewRaw === "month" || viewRaw === "year") {
      reviewView = viewRaw;
    }

    const entryRaw = params.get("entry");
    if (entryRaw && entryRaw.length <= 128) {
      entryId = entryRaw;
    }
  }

  return {
    route,
    redirectedFrom: redirectTarget ? rawRoute : undefined,
    canonicalHash: redirectTarget ?? undefined,
    date,
    month,
    year,
    q,
    hitKey,
    workKey,
    category,
    status,
    sort,
    range,
    reviewView,
    entryId,
  };
}
