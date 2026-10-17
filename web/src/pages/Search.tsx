import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  getTitleHistory,
  search,
  type Annotation,
  type SearchHit,
  type SearchResult,
  type TitleHistory,
} from "../api";
import { RatingEditor } from "../components/RatingEditor";
import { formatSeasonEpisode, sourceIcon } from "../lib/calendar";
import { formatLocalDay } from "../lib/format-date";
import {
  MIN_QUERY_LENGTH,
  SEARCH_MEDIA_TYPES,
  countLabel,
  formatHitMeta,
  highlightParts,
  normalizeForSearch,
} from "../lib/search";
import { formatMinutes, STATS_SOURCES } from "../lib/stats";
import { sourceColor, sourceLabel } from "../lib/sources";
import { formatHours } from "../lib/year-review";

const PAGE_SIZE = 30;
const DEBOUNCE_MS = 250;

export interface SearchProps {
  /** `?q=` from the hash, kept in sync with the input. */
  qParam?: string;
  /** `?key=` from the hash: when set, the detail view is shown. */
  hitKeyParam?: string;
}

/** Cover thumbnail with a source-icon fallback when missing or broken. */
function HitThumbnail({
  source,
  mediaType,
  coverUrl,
  large = false,
}: {
  source: string;
  mediaType: string | null;
  coverUrl: string | null;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  if (coverUrl && !failed) {
    return (
      <img
        class={large ? "search-detail-cover" : "search-hit-cover"}
        src={coverUrl}
        alt=""
        width={large ? 64 : 48}
        height={large ? 64 : 48}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      class={large ? "search-detail-icon-badge" : "search-hit-icon-badge"}
      aria-hidden="true"
    >
      {sourceIcon(source, mediaType)}
    </span>
  );
}

/** Title with every query-word occurrence highlighted, original characters kept. */
function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const parts = useMemo(() => highlightParts(title, query), [title, query]);
  return (
    <span class="search-hit-title">
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} class="search-hit-mark">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </span>
  );
}

/** One row of the title history list. */
function HistoryRow({ item, groupTitle }: { item: TitleHistory["items"][number]; groupTitle: string }) {
  const badge = formatSeasonEpisode(item.season, item.episode);
  // The raw event title is only interesting when it differs from the group
  // title (a YouTube video or episode name, not the book/movie itself).
  const eventTitle =
    item.event_title !== null && item.event_title !== groupTitle
      ? item.event_title
      : null;
  const description = [badge, eventTitle].filter(Boolean).join(" · ");

  return (
    <li class="search-history-row">
      <a class="search-history-date" href={`#/calendar?date=${item.local_date}`}>
        {formatLocalDay(item.local_date)}
      </a>
      <span class="search-history-time">{item.local_time}</span>
      <span class="search-history-desc">{description}</span>
      <span class="search-history-min">
        {item.minutes > 0 ? formatMinutes(item.minutes) : "—"}
      </span>
    </li>
  );
}

export function Search({ qParam, hitKeyParam }: SearchProps) {
  const [inputValue, setInputValue] = useState(qParam ?? "");
  const [query, setQuery] = useState(qParam ?? "");
  const [source, setSource] = useState("");
  const [mediaType, setMediaType] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<TitleHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  /** Latest search request; earlier responses are dropped. */
  const seqRef = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);

  // Back/forward navigation: adopt the query from the hash.
  useEffect(() => {
    setInputValue(qParam ?? "");
    setQuery(qParam ?? "");
  }, [qParam]);

  // Typing (debounced) updates the hash without adding history entries, so
  // reload and the back button keep the query.
  useEffect(() => {
    if (query === (qParam ?? "")) {
      return;
    }
    const hash =
      query !== "" ? `#/search?q=${encodeURIComponent(query)}` : "#/search";
    window.history.replaceState(null, "", hash);
  }, [query]);

  // The search itself. Runs also while a detail view is open so the results
  // behind it stay correct; only the latest request may update the list.
  useEffect(() => {
    const seq = ++seqRef.current;
    if (normalizeForSearch(query).length < MIN_QUERY_LENGTH) {
      setResult(null);
      setError(null);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    setLoading(true);
    setError(null);
    search({
      q: query,
      source: source !== "" ? source : undefined,
      media_type: mediaType !== "" ? mediaType : undefined,
      limit: PAGE_SIZE,
      offset: 0,
    })
      .then((res) => {
        if (seqRef.current === seq) {
          setResult(res);
          setLoading(false);
          setLoadingMore(false);
        }
      })
      .catch((err) => {
        if (seqRef.current === seq) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
          setLoadingMore(false);
        }
      });
  }, [query, source, mediaType]);

  // Detail view: fetch the full history whenever a key is in the hash.
  useEffect(() => {
    if (!hitKeyParam) {
      setHistory(null);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }
    let cancelled = false;
    setHistory(null);
    setHistoryError(null);
    setHistoryLoading(true);
    getTitleHistory(hitKeyParam)
      .then((res) => {
        if (!cancelled) {
          setHistory(res);
          setHistoryLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setHistoryError(err instanceof Error ? err.message : String(err));
          setHistoryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hitKeyParam]);

  // Clear a pending debounce when the page unmounts.
  useEffect(
    () => () => {
      window.clearTimeout(debounceRef.current);
    },
    []
  );

  function handleInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    setInputValue(value);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setQuery(value), DEBOUNCE_MS);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      // Enter searches immediately, skipping the debounce.
      window.clearTimeout(debounceRef.current);
      setQuery(inputValue);
    }
  }

  function loadMore() {
    if (!result || loadingMore || result.hits.length >= result.total) {
      return;
    }
    const seq = ++seqRef.current;
    setLoadingMore(true);
    search({
      q: query,
      source: source !== "" ? source : undefined,
      media_type: mediaType !== "" ? mediaType : undefined,
      limit: PAGE_SIZE,
      offset: result.hits.length,
    })
      .then((res) => {
        if (seqRef.current === seq) {
          setResult((prev) =>
            prev
              ? { query: res.query, total: res.total, hits: [...prev.hits, ...res.hits] }
              : res
          );
          setLoadingMore(false);
        }
      })
      .catch((err) => {
        if (seqRef.current === seq) {
          setError(err instanceof Error ? err.message : String(err));
          setLoadingMore(false);
        }
      });
  }

  const queryTooShort = normalizeForSearch(query).length < MIN_QUERY_LENGTH;
  const backHref = qParam ? `#/search?q=${encodeURIComponent(qParam)}` : "#/search";

  const countText = queryTooShort
    ? `Type at least ${MIN_QUERY_LENGTH} characters`
    : loading
      ? "Searching…"
      : error !== null
        ? ""
        : result === null
          ? ""
          : result.total === 0
            ? `No matches for “${query}”`
            : `${result.total} ${result.total === 1 ? "result" : "results"}`;

  return (
    <div class="page search-page">
      {hitKeyParam ? (
        <>
          <a class="search-back-link" href={backHref}>
            ← Back to results
          </a>

          {historyError !== null && (
            <div class="alert alert-error" role="alert">
              <strong>Error loading title:</strong> {historyError}
            </div>
          )}

          {historyLoading && <p class="muted">Loading title…</p>}

          {history !== null && (
            <>
              <section class="card search-detail" aria-labelledby="search-detail-title">
                <div class="search-detail-header">
                  <HitThumbnail
                    source={history.source}
                    mediaType={null}
                    coverUrl={history.cover_url}
                    large
                  />
                  <div class="search-detail-info">
                    <h1 id="search-detail-title" class="search-detail-title">
                      {history.title}
                    </h1>
                    {history.subtitle && (
                      <p class="muted search-detail-subtitle">{history.subtitle}</p>
                    )}
                    <p class="muted search-detail-meta">
                      {countLabel(history.source, history.count)} ·{" "}
                      {formatHours(history.minutes)} · {sourceLabel(history.source)}
                    </p>
                  </div>
                </div>
                <RatingEditor
                  source={history.source}
                  title={history.title}
                  initialRating={history.rating}
                  onSaved={(annotation: Annotation) =>
                    setHistory((prev) =>
                      prev === null
                        ? prev
                        : { ...prev, rating: annotation.rating }
                    )
                  }
                />
              </section>

              <section class="card" aria-label="History">
                <ul class="search-history-list">
                  {history.items.map((item) => (
                    <HistoryRow key={item.id} item={item} groupTitle={history.title} />
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      ) : (
        <>
          <header class="stats-header">
            <div class="stats-header-titles">
              <h1>Search</h1>
              <p class="muted">
                Find a title, series, author or YouTube channel.
              </p>
            </div>
          </header>

          <div class="search-controls">
            <div class="search-input-row">
              <label for="search-input" class="visually-hidden">
                Search query
              </label>
              <input
                id="search-input"
                type="search"
                class="form-input search-input"
                placeholder="Title, series, author, channel…"
                value={inputValue}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                autofocus
              />
            </div>
            <div class="search-filters">
              <div class="search-filter">
                <label for="search-source" class="visually-hidden">
                  Source
                </label>
                <select
                  id="search-source"
                  class="form-input stats-source-select"
                  value={source}
                  onChange={(e) =>
                    setSource((e.target as HTMLSelectElement).value)
                  }
                >
                  {STATS_SOURCES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div class="search-filter">
                <label for="search-media-type" class="visually-hidden">
                  Media type
                </label>
                <select
                  id="search-media-type"
                  class="form-input stats-source-select"
                  value={mediaType}
                  onChange={(e) =>
                    setMediaType((e.target as HTMLSelectElement).value)
                  }
                >
                  <option value="">All media types</option>
                  {SEARCH_MEDIA_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {error !== null && (
            <div class="alert alert-error" role="alert">
              <strong>Error searching:</strong> {error}
            </div>
          )}

          <p class="search-count" aria-live="polite">
            {countText}
          </p>

          {result !== null && result.hits.length > 0 && (
            <ul class="search-list">
              {result.hits.map((hit: SearchHit) => (
                <li key={hit.key}>
                  <a
                    class="search-hit"
                    href={`#/search?q=${encodeURIComponent(query)}&key=${encodeURIComponent(hit.key)}`}
                  >
                    <HitThumbnail
                      source={hit.source}
                      mediaType={hit.media_type}
                      coverUrl={hit.cover_url}
                    />
                    <span class="search-hit-info">
                      <HighlightedTitle title={hit.title} query={query} />
                      {hit.subtitle && (
                        <span class="search-hit-subtitle">{hit.subtitle}</span>
                      )}
                      <span class="search-hit-meta">
                        <span
                          class="search-source-dot"
                          style={{ backgroundColor: sourceColor(hit.source) }}
                          aria-hidden="true"
                        />
                        <span class="search-hit-source">
                          {sourceLabel(hit.source)}
                        </span>
                        <span class="search-hit-meta-line">
                          {formatHitMeta(hit)}
                        </span>
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}

          {result !== null && result.total > result.hits.length && (
            <div class="search-more-row">
              <button
                type="button"
                class="btn btn-secondary search-more"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
