import { useEffect, useState } from "preact/hooks";
import { OfflineBanner } from "./components/OfflineBanner";
import { Add } from "./pages/Add";
import { Calendar } from "./pages/Calendar";
import { Heatmap } from "./pages/Heatmap";
import { ImportExport } from "./pages/ImportExport";

type Route = "calendar" | "heatmap" | "importexport" | "add";

const ROUTES: ReadonlyArray<{ id: Route; label: string }> = [
  { id: "calendar", label: "Calendar" },
  { id: "heatmap", label: "Heatmap" },
  { id: "importexport", label: "Import/Export" },
  { id: "add", label: "Add" },
];

const DEFAULT_ROUTE: Route = "calendar";

interface ParsedRoute {
  route: Route;
  date?: string;
}

/** Read the route and optional query params out of the hash (e.g. `#/calendar?date=2026-10-17`). */
function parseHash(hash: string): ParsedRoute {
  const stripped = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = stripped.split("?");
  const raw = (pathPart ?? "").split(/[?/]/, 1)[0];
  const match = ROUTES.find((route) => route.id === raw);
  const route = match ? match.id : DEFAULT_ROUTE;

  let date: string | undefined;
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    const d = params.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      date = d;
    }
  }

  return { route, date };
}

export function App() {
  const [{ route, date }, setLocation] = useState<ParsedRoute>(() =>
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
        {route === "heatmap" && <Heatmap />}
        {route === "importexport" && <ImportExport />}
        {route === "add" && <Add />}
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
