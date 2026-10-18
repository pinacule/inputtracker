import { ALL_ROUTES, type Route } from "../lib/ui-helpers";
import { Badge, Button, Card, EmptyState, RouteIcon } from "../ui";

export interface PlaceholderPageProps {
  route: Route;
  queryNote?: string;
}

const ROUTE_HIGHLIGHTS: Readonly<
  Record<
    Exclude<Route, "calendar">,
    ReadonlyArray<{ title: string; desc: string }>
  >
> = {
  progress: [
    {
      title: "Cover-First Reading & Watch Shelf",
      desc: "Large cover art with live progress bars for in-progress audiobooks and series.",
    },
    {
      title: "Completed Library",
      desc: "Finished works sorted by completion date with quick filtering by source.",
    },
    {
      title: "Personal Ratings & Notes",
      desc: "Attach 1–10 ratings and private reflections to any title group.",
    },
  ],
  stats: [
    {
      title: "Streaks & On This Day",
      desc: "Current and longest daily streaks plus memories from previous years.",
    },
    {
      title: "Weekly & Monthly Rhythm",
      desc: "Stacked time and item charts coloured by media kind.",
    },
    {
      title: "Annual Reading & Listening Goals",
      desc: "Track yearly targets for hours, titles, items, or active days.",
    },
  ],
  heatmap: [
    {
      title: "52-Week Activity Grid",
      desc: "A warm year-long tapestry of daily media consumption.",
    },
    {
      title: "Time-of-Day Matrix",
      desc: "Weekday × hour breakdown showing when you listen, watch, and read.",
    },
    {
      title: "Source Filtering",
      desc: "Inspect patterns across all media or isolate a single source.",
    },
  ],
  add: [
    {
      title: "Manual Entry Form",
      desc: "Log books, films, episodes, podcasts, or music with local Europe/Bratislava timestamps.",
    },
    {
      title: "Offline Queue & Auto-Sync",
      desc: "Entries saved while offline are queued locally and sent automatically once reconnected.",
    },
    {
      title: "Idempotent Client IDs",
      desc: "Every manual entry carries a unique client ID so retries never duplicate rows.",
    },
  ],
  year: [
    {
      title: "Annual Overview & Milestones",
      desc: "Total hours, active days, distinct titles, and year-over-year comparisons.",
    },
    {
      title: "Top Works & Channels",
      desc: "Cover gallery of your most-listened and most-watched titles of the year.",
    },
    {
      title: "First & Last Moments",
      desc: "Bookend highlights and busiest days across the calendar year.",
    },
  ],
  search: [
    {
      title: "Instant Diacritics-Insensitive Search",
      desc: "Find any title, author, series, or YouTube channel with matched text highlighted.",
    },
    {
      title: "Complete Title History",
      desc: "Open any work to inspect every session, episode, rating, and note.",
    },
    {
      title: "Source & Media Filters",
      desc: "Narrow results by Audiobookshelf, Simkl, YouTube, or Manual entries.",
    },
  ],
  importexport: [
    {
      title: "One-Click Source Sync",
      desc: "Trigger Audiobookshelf and Simkl syncs and inspect recent ingest runs.",
    },
    {
      title: "YouTube Takeout & Native Import",
      desc: "Upload watch-history.json or a native InputTracker JSON backup.",
    },
    {
      title: "Full JSON & CSV Export",
      desc: "Download your complete append-only consumption log at any time.",
    },
  ],
};

export function PlaceholderPage({ route, queryNote }: PlaceholderPageProps) {
  const def = ALL_ROUTES.find((r) => r.id === route) ?? ALL_ROUTES[0]!;
  const highlights =
    route !== "calendar" ? ROUTE_HIGHLIGHTS[route] : [];

  return (
    <section class="page-container" aria-label={def.label}>
      <header class="page-header">
        <div class="page-header-titles">
          <span class="page-eyebrow">InputTracker Library</span>
          <h1>{def.label}</h1>
          <p class="page-subtitle">{def.description}</p>
        </div>
        <Badge variant="warning" size="md">
          Being rebuilt
        </Badge>
      </header>

      <EmptyState
        icon={<RouteIcon route={route} size={26} />}
        title={`${def.label} is being rebuilt`}
        description={
          <>
            This view is being redesigned on top of the new cover-first design
            system.
            {queryNote ? ` (${queryNote})` : ""}
          </>
        }
        actions={
          <Button variant="primary" size="md" href="#/calendar">
            Return to Calendar
          </Button>
        }
      />

      {highlights.length > 0 && (
        <div class="placeholder-grid">
          {highlights.map((item) => (
            <Card key={item.title} padding="md" class="placeholder-feature-card">
              <h2 class="placeholder-feature-title">{item.title}</h2>
              <p class="placeholder-feature-desc">{item.desc}</p>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
