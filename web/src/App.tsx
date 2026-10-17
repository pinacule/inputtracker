import { useEffect, useState } from "preact/hooks";
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

/** Read the route out of the hash (e.g. `#/heatmap`). */
function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "").split(/[?/]/, 1)[0];
  const match = ROUTES.find((route) => route.id === raw);
  return match ? match.id : DEFAULT_ROUTE;
}

export function App() {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(window.location.hash)
  );

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    if (window.location.hash === "") {
      window.location.hash = `#/${DEFAULT_ROUTE}`;
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div class="app">
      <main class="content">
        {route === "calendar" && <Calendar />}
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
