import { SkinLayer } from "./skins/SkinLayer";
import { clearSkinEventHint, emitSkinEvent } from "./skins/events.ts";
import { useEffect, useRef, useState } from "preact/hooks";
import { loadArchiveContext, type OpenArchiveOptions } from "./lib/archive-form";
import { getDefaultStore, subscribeQueue } from "./lib/offline-queue";
import {
  APP_ROUTES,
  MOBILE_TAB_ROUTES,
  PRIMARY_NAV_ROUTES,
  parseAppRoute,
  type AppRoute,
  type ParsedAppLocation,
} from "./lib/router";
import {
  applyThemeToDocument,
  readThemePreference,
  type DarkThemeId,
} from "./lib/theme";
import {
  dismissToast,
  pushToast,
  subscribeToasts,
  type AppToast,
} from "./lib/work-edits";
import { Add } from "./pages/Add";
import { Calendar } from "./pages/Calendar";
import { Insights } from "./pages/Insights";
import { Library } from "./pages/Library";
import { Review } from "./pages/Review";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import {
  AddIcon,
  BookIcon,
  Button,
  ContextMenuHost,
  EditWorkSheet,
  IconButton,
  OfflineIcon,
  RouteIcon,
  SearchIcon,
  SettingsIcon,
  Sheet,
  ToastViewport,
  type EditableWorkTarget,
} from "./ui";

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

interface AddSheetContext extends OpenArchiveOptions {
  open: boolean;
}

export function App() {
  const [loc, setLoc] = useState<ParsedAppLocation>(() =>
    parseAppRoute(window.location.hash)
  );
  const [theme, setTheme] = useState<DarkThemeId>(() => readThemePreference());
  const includeYoutubeInAll = true;
  const [queueCount, setQueueCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState(loc.q ?? "");
  const [addSheet, setAddSheet] = useState<AddSheetContext>({ open: false });
  const [editingWork, setEditingWork] = useState<EditableWorkTarget | null>(
    null
  );
  const [toasts, setToasts] = useState<readonly AppToast[]>([]);

  const previousRoute = useRef(loc.route);
  useEffect(() => {
    if (previousRoute.current !== loc.route) {
      emitSkinEvent("page-change", { from: previousRoute.current, to: loc.route });
      previousRoute.current = loc.route;
    }
  }, [loc.route]);
  useEffect(() => clearSkinEventHint, []);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Apply stored dark theme preference on mount & change
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  // Subscribe to global Undo toasts
  useEffect(() => {
    return subscribeToasts(setToasts);
  }, []);

  // Listen to hash changes & perform legacy route redirects
  useEffect(() => {
    const syncFromHash = () => {
      const parsed = parseAppRoute(window.location.hash);
      if (parsed.canonicalHash) {
        window.history.replaceState(null, "", parsed.canonicalHash);
      }
      setLoc(parsed);
      if (parsed.q !== undefined) {
        setSearchQuery(parsed.q);
      }
    };

    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    if (window.location.hash === "") {
      window.history.replaceState(null, "", "#/calendar");
    }
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  // Global `/` keyboard shortcut on desktop to focus search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (searchInputRef.current && window.innerWidth >= 768) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      } else {
        window.location.hash = "#/search";
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep offline queue badge count up to date
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const store = await getDefaultStore();
      if (store === null || cancelled) return;
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

  const addLoadSeq = useRef(0);
  const handleOpenAdd = (opts?: OpenArchiveOptions) => {
    const seq = ++addLoadSeq.current;
    if (opts?.entryId || opts?.workKey) {
      void loadArchiveContext(opts).then((loaded) => {
        if (seq === addLoadSeq.current) setAddSheet({ ...loaded, open: true });
      }).catch((err: unknown) => {
        if (seq === addLoadSeq.current) pushToast({
          message: err instanceof Error ? err.message : "Could not load the stored archive entry.",
          variant: "danger",
        });
      });
      return;
    }
    if (
      typeof window !== "undefined" &&
      window.innerWidth >= 768 &&
      !opts?.editingEntry
    ) {
      setAddSheet({
        open: true,
        date: opts?.date,
        category: opts?.category,
        query: opts?.query,
        work: opts?.work ?? null,
        editingEntry: opts?.editingEntry ?? null,
      });
      return;
    }
    if (opts?.editingEntry || opts?.work) {
      setAddSheet({
        open: true,
        date: opts?.date,
        category: opts?.category,
        query: opts?.query,
        work: opts?.work ?? null,
        editingEntry: opts?.editingEntry ?? null,
      });
      return;
    }
    const params = new URLSearchParams();
    if (opts?.date) params.set("date", opts.date);
    if (opts?.category) params.set("category", opts.category);
    if (opts?.query) params.set("q", opts.query);
    const qs = params.toString();
    window.location.hash = qs ? `#/add?${qs}` : "#/add";
  };

  const renderSidebarLink = (id: AppRoute) => {
    const def = APP_ROUTES.find((r) => r.id === id);
    if (!def) return null;
    const isActive = loc.route === id;

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
      >
        <span class="sidebar-nav-link-main">
          <span class="sidebar-nav-icon">
            <RouteIcon route={id} size={18} />
          </span>
          <span>{def.label}</span>
        </span>
      </a>
    );
  };

  return (
    <div
      class={["espresso", "midnight", "forest", "obsidian", "plum"].includes(theme)
        ? "app-shell app-shell--editorial" : "app-shell"}
    >
      <SkinLayer theme={theme} />
      {/* Desktop Left Sidebar */}
      <aside class="app-sidebar" aria-label="Sidebar">
        <a href="#/calendar" class="sidebar-brand">
          <span class="sidebar-brand-mark" aria-hidden="true">
            <BookIcon size={20} />
          </span>
          <span class="sidebar-brand-text">
            <span class="sidebar-brand-title">InputTracker</span>
            <span class="sidebar-brand-tagline">Archive & Log</span>
          </span>
        </a>

        {/* Primary Add to Archive Action */}
        <div class="sidebar-add-wrap">
          <Button
            variant="primary"
            size="md"
            fullWidth
            leadingIcon={<AddIcon size={17} />}
            onClick={() => handleOpenAdd()}
          >
            Add to Archive
            {queueCount > 0 && (
              <span class="queue-badge" aria-hidden="true">
                {queueCount > 9 ? "9+" : queueCount}
              </span>
            )}
          </Button>
        </div>

        {/* Global Search Input (`/` shortcut) */}
        <form
          class="sidebar-search-form"
          role="search"
          onSubmit={handleSearchSubmit}
        >
          <span class="sidebar-search-icon" aria-hidden="true">
            <SearchIcon size={15} />
          </span>
          <input
            ref={searchInputRef}
            type="search"
            class="sidebar-search-input"
            placeholder="Search… (/)"
            aria-label="Search library"
            value={searchQuery}
            onInput={(e) =>
              setSearchQuery((e.currentTarget as HTMLInputElement).value)
            }
          />
        </form>

        {/* Primary Navigation (4 core views) */}
        <nav class="sidebar-nav-section" aria-label="Primary">
          <span class="sidebar-nav-heading">Views</span>
          {PRIMARY_NAV_ROUTES.map(renderSidebarLink)}
        </nav>

        {/* Clean Sidebar Footer (Settings & Sync) */}
        <div class="sidebar-footer">
          <a
            href="#/settings"
            class={
              loc.route === "settings"
                ? "sidebar-settings-link sidebar-settings-link--active"
                : "sidebar-settings-link"
            }
            aria-current={loc.route === "settings" ? "page" : undefined}
          >
            <SettingsIcon size={16} />
            <span>Settings & Sync</span>
          </a>
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
              active={loc.route === "search"}
            >
              <SearchIcon size={17} />
            </IconButton>
            <IconButton
              label="Settings and sync"
              variant="subtle"
              size="sm"
              href="#/settings"
              active={loc.route === "settings"}
            >
              <SettingsIcon size={17} />
            </IconButton>
          </div>
        </header>

        <main class="app-main">
          {loc.route === "calendar" && (
            <Calendar
              date={loc.date}
              initialMonth={loc.month}
              initialCategory={loc.category}
              initialCategories={loc.categories}
              includeYoutubeInAll={includeYoutubeInAll}
              onOpenAdd={handleOpenAdd}
              onOpenEditWork={(w) => setEditingWork(w)}
            />
          )}
          {loc.route === "library" && (
            <Library
              // Remount when a link changes the filters while the Library is open
              // (in-page chip changes use replaceState and do not reach here).
              key={[
                loc.category ?? "",
                (loc.categories ?? []).join(","),
                loc.status ?? "",
                loc.channel ?? "",
                loc.topic ?? "",
              ].join("|")}
              initialCategory={loc.category}
              initialCategories={loc.categories}
              initialStatus={loc.status}
              initialSort={loc.sort}
              initialQuery={loc.q}
              initialChannel={loc.channel}
              initialTopic={loc.topic}
              workKey={loc.workKey}
              includeYoutubeInAll={includeYoutubeInAll}
              onOpenAdd={handleOpenAdd}
              onOpenEditWork={(w) => setEditingWork(w)}
            />
          )}
          {loc.route === "insights" && (
            <Insights
              initialRange={loc.range}
              initialCategory={loc.category}
              initialCategories={loc.categories}
              initialYear={loc.year}
              includeYoutubeInAll={includeYoutubeInAll}
            />
          )}
          {loc.route === "review" && (
            <Review
              initialView={loc.reviewView ?? (loc.year ? "year" : "month")}
              initialMonth={loc.month}
              initialYear={loc.year}
              initialCategory={loc.category}
              initialCategories={loc.categories}
              includeYoutubeInAll={includeYoutubeInAll}
            />
          )}
          {loc.route === "add" && (
            <Add
              initialQuery={loc.q}
              initialCategory={loc.category}
              initialDate={loc.date}
            />
          )}
          {loc.route === "search" && (
            <Search
              qParam={loc.q}
              hitKeyParam={loc.hitKey}
              initialCategory={loc.category}
              initialCategories={loc.categories}
              includeYoutubeInAll={includeYoutubeInAll}
            />
          )}
          {loc.route === "settings" && (
            <Settings
              theme={theme}
              onThemeChange={setTheme}
            />
          )}
        </main>
      </div>

      {/* Mobile Bottom Tab Bar (5 Core Destinations) */}
      <nav class="mobile-tabbar" aria-label="Mobile Navigation">
        {MOBILE_TAB_ROUTES.map((id) => {
          const def = APP_ROUTES.find((r) => r.id === id)!;
          const isActive = loc.route === id;
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
      </nav>

      {/* Desktop Add / Edit Archive Sheet Dialog */}
      <Sheet
        open={addSheet.open}
        onClose={() => setAddSheet({ open: false })}
        size="lg"
        title={
          addSheet.editingEntry
            ? `Edit Archive Entry — ${addSheet.editingEntry.work.title}`
            : addSheet.work
              ? `Add to Archive — ${addSheet.work.title}`
              : "Add to Archive"
        }
        subtitle="Look up any anime, series, film, book, or audiobook to archive"
      >
        <Add
          inSheet
          initialCategory={addSheet.category}
          initialDate={addSheet.date}
          initialWork={addSheet.work}
          editingArchiveEntry={addSheet.editingEntry}
          initialQuery={addSheet.query}
          onSavedArchive={() => {
            setAddSheet({ open: false });
          }}
        />
      </Sheet>

      {/* Global Edit Any Work Sheet Dialog */}
      <EditWorkSheet
        open={editingWork !== null}
        work={editingWork}
        onClose={() => setEditingWork(null)}
      />

      {/* Global Accessible Context Menu Host */}
      <ContextMenuHost
        onOpenEditWork={(w) => setEditingWork(w)}
        onOpenAdd={(opts) => handleOpenAdd(opts)}
      />

      {/* Global Toast Viewport (with Undo) */}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
