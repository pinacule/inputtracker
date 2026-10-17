import { useEffect, useState } from "preact/hooks";
import { OfflineBanner } from "./components/OfflineBanner";
import { Add } from "./pages/Add";
import { Calendar } from "./pages/Calendar";
import { Heatmap } from "./pages/Heatmap";
import { ImportExport } from "./pages/ImportExport";
import { Progress } from "./pages/Progress";
import { Stats } from "./pages/Stats";
import { YearReviewPage } from "./pages/YearReview";

type Route = "calendar" | "progress" | "heatmap" | "stats" | "importexport" | "add" | "year";

const ROUTES: ReadonlyArray<{ id: Route; label: string }> = [
  { id: "calendar", label: "Calendar" },
  { id: "progress", label: "Progress" },
  { id: "heatmap", label: "Heatmap" },
  { id: "stats", label: "Stats" },
  { id: "importexport", label: "Import/Export" },
  { id: "add", label: "Add" },
];

/** All routable pages. `year` has no bottom-nav tab: the bar is already full on a phone. */
const PAGES: ReadonlyArray<{ id: Route; label: string }> = [
  ...ROUTES,
  { id: "year", label: "Year in review" },
];

const DEFAULT_ROUTE: Route = "calendar";

interface ParsedRoute {
  route: Route;
  date?: string;
  year?: string;
}

/** Read the route and optional query params out of the hash (e.g. `#/calendar?date=2026-10-17` or `#/year?year=2025`). */
function parseHash(hash: string): ParsedRoute {
  const stripped = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = stripped.split("?");
  const raw = (pathPart ?? "").split(/[?/]/, 1)[0];
  const match = PAGES.find((route) => route.id === raw);
  const route = match ? match.id : DEFAULT_ROUTE;

  let date: string | undefined;
  let year: string | undefined;
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
  }

  return { route, date, year };
}

export function App() {
  const [{ route, date, year }, setLocation] = useState<ParsedRoute>(() =>
    parseHash(window.location.hash)
  );

  useEffect(() => {
    const onHashChange = () => setLocation(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    if (window.location.hash === "") {
      window.location.hash = `#/${DEFAULT_ROUTE}`;
    }
    return () => window.removeEventListener("hashchange", onHashChange);
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
      </main>
      <nav class="tabbar" aria-label="Primary">
        {ROUTES.map((item) => (
          <a
            key={item.id}
            class={route === item.id ? "tab tab-active" : "tab"}
            href={`#/${item.id}`}
            aria-current={route === item.id ? "page" : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
