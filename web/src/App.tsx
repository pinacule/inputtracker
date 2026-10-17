import { useEffect, useState } from "preact/hooks";
import { OfflineBanner } from "./components/OfflineBanner";
import { getDefaultStore, subscribeQueue } from "./lib/offline-queue";
import { Add } from "./pages/Add";
import { Calendar } from "./pages/Calendar";
import { Heatmap } from "./pages/Heatmap";
import { ImportExport } from "./pages/ImportExport";
import { Progress } from "./pages/Progress";
import { Search } from "./pages/Search";
import { Stats } from "./pages/Stats";
import { YearReviewPage } from "./pages/YearReview";

type Route =
  | "calendar"
  | "progress"
  | "heatmap"
  | "stats"
  | "importexport"
  | "add"
  | "year"
  | "search";

const ROUTES: ReadonlyArray<{ id: Route; label: string }> = [
  { id: "calendar", label: "Calendar" },
  { id: "progress", label: "Progress" },
  { id: "heatmap", label: "Heatmap" },
  { id: "stats", label: "Stats" },
  { id: "importexport", label: "Import/Export" },
  { id: "add", label: "Add" },
];

/** All routable pages. `year` and `search` have no bottom-nav tab: the bar is already full on a phone. */
const PAGES: ReadonlyArray<{ id: Route; label: string }> = [
  ...ROUTES,
  { id: "year", label: "Year in review" },
  { id: "search", label: "Search" },
];

const DEFAULT_ROUTE: Route = "calendar";

interface ParsedRoute {
  route: Route;
  date?: string;
  year?: string;
  q?: string;
  hitKey?: string;
}

/** Read the route and optional query params out of the hash (e.g. `#/calendar?date=2026-10-17`, `#/search?q=harry`). */
function parseHash(hash: string): ParsedRoute {
  const stripped = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = stripped.split("?");
  const raw = (pathPart ?? "").split(/[?/]/, 1)[0];
  const match = PAGES.find((route) => route.id === raw);
  const route = match ? match.id : DEFAULT_ROUTE;

  let date: string | undefined;
  let year: string | undefined;
  let q: string | undefined;
  let hitKey: string | undefined;
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    const d = params.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      date = d;
    }
    const y = params.get("year");
    if (y && /^\d{4}$/.test(y)) {
      year = y;
    }
    // Free-text query / opaque hit key, capped like the server accepts them.
    const qRaw = params.get("q");
    if (qRaw && qRaw.length <= 200) {
      q = qRaw;
    }
    const keyRaw = params.get("key");
    if (keyRaw && keyRaw.length <= 500) {
      hitKey = keyRaw;
    }
  }

  return { route, date, year, q, hitKey };
}

export function App() {
  const [{ route, date, year, q, hitKey }, setLocation] = useState<ParsedRoute>(() =>
    parseHash(window.location.hash)
  );
  const [queueCount, setQueueCount] = useState(0);

  useEffect(() => {
    const onHashChange = () => setLocation(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    if (window.location.hash === "") {
      window.location.hash = `#/${DEFAULT_ROUTE}`;
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Count of entries waiting to send, for the badge on the Add tab.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const store = await getDefaultStore();
      if (store === null || cancelled) {
        return;
      }
      const entries = await store.list();
      if (!cancelled) {
        setQueueCount(entries.length);
      }
    };
    void refresh();
    const unsubscribe = subscribeQueue(() => void refresh());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div class="app">
      <OfflineBanner />
      <main class="content">
        {route === "calendar" && <Calendar date={date} />}
        {route === "progress" && <Progress />}
        {route === "heatmap" && <Heatmap />}
        {route === "stats" && <Stats />}
        {route === "importexport" && <ImportExport />}
        {route === "add" && <Add />}
        {route === "year" && <YearReviewPage yearParam={year} />}
        {route === "search" && <Search qParam={q} hitKeyParam={hitKey} />}
      </main>
      <nav class="tabbar" aria-label="Primary">
        {ROUTES.map((item) => {
          const waiting = item.id === "add" && queueCount > 0;
          return (
            <a
              key={item.id}
              class={route === item.id ? "tab tab-active" : "tab"}
              href={`#/${item.id}`}
              aria-current={route === item.id ? "page" : undefined}
              aria-label={
                waiting ? `Add, ${queueCount} entries waiting to send` : undefined
              }
            >
              {item.label}
              {waiting && (
                <span class="queue-badge" aria-hidden="true">
                  {queueCount > 9 ? "9+" : queueCount}
                </span>
              )}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
