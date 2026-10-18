import { useEffect, useState } from "preact/hooks";
import { getDefaultStore, subscribeQueue } from "./lib/offline-queue";
import {
  ALL_ROUTES,
  DEFAULT_ROUTE,
  MEDIA_KINDS,
  MOBILE_MORE_ROUTES,
  MOBILE_PRIMARY_ROUTES,
  parseHash,
  type MediaKind,
  type ParsedRoute,
  type Route,
} from "./lib/ui-helpers";
import { Calendar } from "./pages/Calendar";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import {
  BookIcon,
  IconButton,
  MoreIcon,
  OfflineIcon,
  RouteIcon,
  SearchIcon,
  Sheet,
} from "./ui";

const DESKTOP_LIBRARY_ROUTES: ReadonlyArray<Route> = [
  "calendar",
  "progress",
  "stats",
  "heatmap",
  "year",
  "search",
];

const DESKTOP_UTILITY_ROUTES: ReadonlyArray<Route> = ["add", "importexport"];

function OfflineBanner() {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    if (typeof navigator !== "undefined") {
      setOnline(navigator.onLine);
    }

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) {
    return null;
  }

  return (
    <div class="offline-banner" role="status" aria-live="polite">
      <OfflineIcon size={15} />
      <span>Offline — showing saved data</span>
    </div>
  );
}

export function App() {
  const [{ route, date, year, q, hitKey }, setLocation] = useState<ParsedRoute>(
    () => parseHash(window.location.hash)
  );
  const [queueCount, setQueueCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState(q ?? "");
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash(window.location.hash);
      setLocation(parsed);
      if (parsed.q !== undefined) {
        setSearchQuery(parsed.q);
      }
      setMoreOpen(false);
    };
    window.addEventListener("hashchange", onHashChange);
    if (window.location.hash === "") {
      window.location.hash = `#/${DEFAULT_ROUTE}`;
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Keep offline queue badge count up to date.
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

  const handleSearchSubmit = (e: Event) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (trimmed) {
      window.location.hash = `#/search?q=${encodeURIComponent(trimmed)}`;
    } else {
      window.location.hash = "#/search";
    }
  };

  const renderSidebarLink = (id: Route) => {
    const def = ALL_ROUTES.find((r) => r.id === id);
    if (!def) return null;
    const isActive = route === id;
    const waiting = id === "add" && queueCount > 0;
    const badgeLabel = waiting
      ? `${def.label}, ${queueCount} ${
          queueCount === 1 ? "entry" : "entries"
        } waiting to send`
      : undefined;

    return (
      <a
        key={id}
        href={`#/${id}`}
        class={
          isActive
            ? "sidebar-nav-link sidebar-nav-link--active"
            : "sidebar-nav-link"
        }
        aria-current={isActive ? "page" : undefined}
        aria-label={badgeLabel}
      >
        <span class="sidebar-nav-link-main">
          <span class="sidebar-nav-icon">
            <RouteIcon route={id} size={18} />
          </span>
          <span>{def.label}</span>
        </span>
        {waiting && (
          <span class="queue-badge" aria-hidden="true">
            {queueCount > 9 ? "9+" : queueCount}
          </span>
        )}
      </a>
    );
  };

  const isMoreRouteActive = MOBILE_MORE_ROUTES.includes(route);

  return (
    <div class="app-shell">
      {/* Desktop Left Sidebar */}
      <aside class="app-sidebar" aria-label="Sidebar">
        <a href="#/calendar" class="sidebar-brand">
          <span class="sidebar-brand-mark" aria-hidden="true">
            <BookIcon size={20} />
          </span>
          <span class="sidebar-brand-text">
            <span class="sidebar-brand-title">InputTracker</span>
            <span class="sidebar-brand-tagline">Personal Library</span>
          </span>
        </a>

        <form
          class="sidebar-search-form"
          role="search"
          onSubmit={handleSearchSubmit}
        >
          <span class="sidebar-search-icon" aria-hidden="true">
            <SearchIcon size={15} />
          </span>
          <input
            type="search"
            class="sidebar-search-input"
            placeholder="Search library…"
            aria-label="Search library"
            value={searchQuery}
            onInput={(e) =>
              setSearchQuery((e.currentTarget as HTMLInputElement).value)
            }
          />
        </form>

        <nav class="sidebar-nav-section" aria-label="Primary">
          <span class="sidebar-nav-heading">Library</span>
          {DESKTOP_LIBRARY_ROUTES.map(renderSidebarLink)}
        </nav>

        <nav class="sidebar-nav-section" aria-label="Actions and Data">
          <span class="sidebar-nav-heading">Log & Sync</span>
          {DESKTOP_UTILITY_ROUTES.map(renderSidebarLink)}
        </nav>

        <div class="sidebar-footer" aria-label="Media kind colour legend">
          <span class="sidebar-legend-title">Media Kinds</span>
          <div class="sidebar-legend-grid">
            {(["audiobook", "film", "youtube", "manual"] as const).map(
              (kind: MediaKind) => (
                <div key={kind} class="sidebar-legend-item">
                  <span
                    class={`ui-tab-dot ui-tab-dot--${kind}`}
                    aria-hidden="true"
                  />
                  <span>{MEDIA_KINDS[kind].shortLabel}</span>
                </div>
              )
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Column */}
      <div class="app-main-column">
        <OfflineBanner />

        {/* Mobile Top Bar */}
        <header class="mobile-topbar">
          <a href="#/calendar" class="sidebar-brand">
            <span class="sidebar-brand-mark" aria-hidden="true">
              <BookIcon size={18} />
            </span>
            <span class="sidebar-brand-text">
              <span class="sidebar-brand-title">InputTracker</span>
            </span>
          </a>
          <div class="mobile-topbar-actions">
            <IconButton
              label="Search library"
              variant="subtle"
              size="sm"
              href="#/search"
              active={route === "search"}
            >
              <SearchIcon size={17} />
            </IconButton>
          </div>
        </header>

        <main class="app-main">
          {route === "calendar" && <Calendar date={date} />}
          {route === "progress" && <PlaceholderPage route="progress" />}
          {route === "heatmap" && <PlaceholderPage route="heatmap" />}
          {route === "stats" && <PlaceholderPage route="stats" />}
          {route === "importexport" && <PlaceholderPage route="importexport" />}
          {route === "add" && (
            <PlaceholderPage
              route="add"
              queryNote={
                queueCount > 0
                  ? `${queueCount} queued offline ${
                      queueCount === 1 ? "entry" : "entries"
                    }`
                  : undefined
              }
            />
          )}
          {route === "year" && (
            <PlaceholderPage
              route="year"
              queryNote={year ? `Year: ${year}` : undefined}
            />
          )}
          {route === "search" && (
            <PlaceholderPage
              route="search"
              queryNote={
                q
                  ? `Query: "${q}"`
                  : hitKey
                  ? `Title key: ${hitKey}`
                  : undefined
              }
            />
          )}
        </main>
      </div>

      {/* Mobile Bottom Tab Bar */}
      <nav class="mobile-tabbar" aria-label="Mobile Navigation">
        {MOBILE_PRIMARY_ROUTES.map((id) => {
          const def = ALL_ROUTES.find((r) => r.id === id)!;
          const isActive = route === id;
          const waiting = id === "add" && queueCount > 0;
          const badgeLabel = waiting
            ? `${def.shortLabel}, ${queueCount} ${
                queueCount === 1 ? "entry" : "entries"
              } waiting to send`
            : undefined;

          return (
            <a
              key={id}
              href={`#/${id}`}
              class={isActive ? "mobile-tab mobile-tab--active" : "mobile-tab"}
              aria-current={isActive ? "page" : undefined}
              aria-label={badgeLabel}
            >
              <span class="mobile-tab-icon-wrap">
                <RouteIcon route={id} size={20} />
                {waiting && (
                  <span
                    class="queue-badge mobile-tab-badge"
                    aria-hidden="true"
                  >
                    {queueCount > 9 ? "9+" : queueCount}
                  </span>
                )}
              </span>
              <span>{def.shortLabel}</span>
            </a>
          );
        })}

        <button
          type="button"
          class={
            isMoreRouteActive || moreOpen
              ? "mobile-tab mobile-tab--active"
              : "mobile-tab"
          }
          aria-expanded={moreOpen}
          aria-label="More pages"
          onClick={() => setMoreOpen((prev) => !prev)}
        >
          <span class="mobile-tab-icon-wrap">
            <MoreIcon size={20} />
          </span>
          <span>More</span>
        </button>
      </nav>

      {/* Mobile "More" Sheet */}
      <Sheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="More Views"
        subtitle="Explore your library, heatmaps, and sync tools"
      >
        <div class="more-sheet-list" role="navigation" aria-label="More pages">
          {MOBILE_MORE_ROUTES.map((id) => {
            const def = ALL_ROUTES.find((r) => r.id === id)!;
            const isActive = route === id;
            return (
              <a
                key={id}
                href={`#/${id}`}
                class={
                  isActive
                    ? "more-sheet-link more-sheet-link--active"
                    : "more-sheet-link"
                }
                aria-current={isActive ? "page" : undefined}
                onClick={() => setMoreOpen(false)}
              >
                <span class="more-sheet-link-icon" aria-hidden="true">
                  <RouteIcon route={id} size={20} />
                </span>
                <span class="more-sheet-link-body">
                  <span class="more-sheet-link-title">{def.label}</span>
                  <span class="more-sheet-link-desc">{def.description}</span>
                </span>
              </a>
            );
          })}
        </div>
      </Sheet>
    </div>
  );
}
