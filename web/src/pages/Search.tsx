import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  getTitleHistory,
  search,
  type Category,
  type SearchHit,
  type SearchResult,
  type TitleHistory,
} from "../api";
import { formatSeasonEpisode } from "../lib/calendar";
import {
  categoryLabel,
  resolveItemCategory,
} from "../lib/categories";
import {
  buildCategoryFilterParams,
  matchesCategorySelection,
} from "../lib/category-filter";
import { formatLocalDay } from "../lib/format-date";
import {
  MIN_QUERY_LENGTH,
  SEARCH_MEDIA_TYPES,
  countLabel,
  formatHitMeta,
  highlightParts,
  normalizeForSearch,
} from "../lib/search";
import { sourceLabel } from "../lib/sources";
import { STATS_SOURCES, formatMinutes } from "../lib/stats";
import { formatHours } from "../lib/year-review";
import {
  AddIcon,
  Badge,
  Button,
  Card,
  CategoryChips,
  CategoryIcon,
  Cover,
  EmptyState,
  QuickRatingPill,
  RatingEditor,
  SearchIcon,
  Skeleton,
  bindContextMenu,
} from "../ui";

const PAGE_SIZE = 30;
const DEBOUNCE_MS = 240;

export interface SearchProps {
  qParam?: string;
  hitKeyParam?: string;
  initialCategory?: Category;
  initialCategories?: readonly Category[];
  includeYoutubeInAll?: boolean;
}

function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const parts = useMemo(() => highlightParts(title, query), [title, query]);
  return (
    <span class="search-hit-title">
      {parts.map((part, idx) =>
        part.match ? (
          <mark key={idx} class="search-hit-mark">
            {part.text}
          </mark>
        ) : (
          <span key={idx}>{part.text}</span>
        )
      )}
    </span>
  );
}

export function Search({
  qParam,
  hitKeyParam,
  initialCategory,
  initialCategories,
  includeYoutubeInAll = false,
}: SearchProps) {
  const [inputValue, setInputValue] = useState(qParam ?? "");
  const [query, setQuery] = useState(qParam ?? "");
  const [source, setSource] = useState("");
  const [mediaType, setMediaType] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Category[]>(
    () => {
      if (initialCategories && initialCategories.length > 0) {
        return [...initialCategories];
      }
      if (initialCategory) {
        return [initialCategory];
      }
      return [];
    }
  );
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [history, setHistory] = useState<TitleHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setInputValue(qParam ?? "");
    setQuery(qParam ?? "");
  }, [qParam]);

  useEffect(() => {
    if (initialCategories !== undefined) {
      setSelectedCategories([...initialCategories]);
    } else if (initialCategory !== undefined) {
      setSelectedCategories(initialCategory ? [initialCategory] : []);
    }
  }, [initialCategory, initialCategories]);

  useEffect(() => {
    if (hitKeyParam) return;
    const params = new URLSearchParams();
    if (query !== "") params.set("q", query);
    if (selectedCategories.length > 0) {
      params.set("cat", selectedCategories.join(","));
    }
    const qs = params.toString();
    const hash = qs ? `#/search?${qs}` : "#/search";
    window.history.replaceState(null, "", hash);
  }, [query, selectedCategories, hitKeyParam]);

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

    const filterParams = buildCategoryFilterParams(
      selectedCategories,
      includeYoutubeInAll
    );

    search({
      q: query,
      source: source !== "" ? source : undefined,
      media_type: mediaType !== "" ? mediaType : undefined,
      category: filterParams.category,
      exclude: filterParams.exclude,
      limit: PAGE_SIZE,
      offset: 0,
    })
      .catch(() =>
        search({
          q: query,
          source: source !== "" ? source : undefined,
          media_type: mediaType !== "" ? mediaType : undefined,
          limit: PAGE_SIZE,
          offset: 0,
        })
      )
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
  }, [query, source, mediaType, selectedCategories, includeYoutubeInAll]);

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

  useEffect(
    () => () => {
      window.clearTimeout(debounceRef.current);
    },
    []
  );

  const filteredHits = useMemo(() => {
    const rawHits = result?.hits ?? [];
    return rawHits.filter((hit) => {
      const cat = resolveItemCategory(hit);
      return matchesCategorySelection(
        cat,
        selectedCategories,
        includeYoutubeInAll
      );
    });
  }, [result, selectedCategories, includeYoutubeInAll]);

  const handleLoadMore = () => {
    if (!result || loadingMore || result.hits.length >= result.total) return;
    const seq = ++seqRef.current;
    setLoadingMore(true);
    const filterParams = buildCategoryFilterParams(
      selectedCategories,
      includeYoutubeInAll
    );
    search({
      q: query,
      source: source !== "" ? source : undefined,
      media_type: mediaType !== "" ? mediaType : undefined,
      category: filterParams.category,
      exclude: filterParams.exclude,
      limit: PAGE_SIZE,
      offset: result.hits.length,
    })
      .catch(() =>
        search({
          q: query,
          source: source !== "" ? source : undefined,
          media_type: mediaType !== "" ? mediaType : undefined,
          limit: PAGE_SIZE,
          offset: result.hits.length,
        })
      )
      .then((res) => {
        if (seqRef.current === seq) {
          setResult((prev) =>
            prev
              ? {
                  query: res.query,
                  total: res.total,
                  hits: [...prev.hits, ...res.hits],
                }
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
  };

  if (hitKeyParam) {
    const backHref = qParam
      ? `#/search?q=${encodeURIComponent(qParam)}`
      : "#/search";
    const histCat = history
      ? resolveItemCategory({
          source: history.source,
          media_type: history.items[0]?.media_type,
        })
      : "other";

    return (
      <section class="page-container search-page" aria-label="Title History">
        <div>
          <Button variant="ghost" size="sm" href={backHref}>
            ← Back to Search Results
          </Button>
        </div>

        {historyError && (
          <div class="calendar-error" role="alert">
            <span>
              <strong>Could not load title history:</strong> {historyError}
            </span>
          </div>
        )}

        {historyLoading && <Skeleton height={160} />}

        {history && (
          <>
            <Card padding="lg">
              <div class="library-work-hero-layout">
                <Cover
                  src={history.cover_url}
                  title={history.title}
                  category={histCat}
                  source={history.source}
                  size="xl"
                  aspect="square"
                />
                <div class="library-work-hero-body">
                  <div class="library-work-badges">
                    <Badge
                      size="md"
                      category={histCat}
                      icon={<CategoryIcon category={histCat} size={12} />}
                    >
                      {categoryLabel(histCat)}
                    </Badge>
                    <Badge size="sm" variant="neutral">
                      {sourceLabel(history.source)}
                    </Badge>
                    <QuickRatingPill
                      workKey={history.key}
                      title={history.title}
                      category={histCat}
                      rating={history.rating}
                      source={history.source}
                      onRated={(next) =>
                        setHistory((prev) =>
                          prev ? { ...prev, rating: next } : prev
                        )
                      }
                    />
                  </div>
                  <h1 class="library-work-title">{history.title}</h1>
                  {history.subtitle && (
                    <p class="ui-text-muted">{history.subtitle}</p>
                  )}
                  <p class="library-work-stats-row tabular-nums">
                    {countLabel(history.source, history.count)} ·{" "}
                    {formatHours(history.minutes)}
                  </p>
                </div>
              </div>
            </Card>

            <div class="library-work-two-col">
              <Card padding="md" title="Rating & Note">
                <RatingEditor
                  workKey={history.key}
                  source={history.source}
                  title={history.title}
                  initialRating={history.rating}
                  onSaved={(ann) =>
                    setHistory((prev) =>
                      prev ? { ...prev, rating: ann.rating } : prev
                    )
                  }
                />
              </Card>

              <Card
                padding="md"
                title="Recorded Sessions"
                subtitle={`${history.items.length} ${
                  history.items.length === 1 ? "session" : "sessions"
                }`}
              >
                <ul class="library-history-list">
                  {history.items.map((item) => {
                    const se = formatSeasonEpisode(item.season, item.episode);
                    const evTitle =
                      item.event_title && item.event_title !== history.title
                        ? item.event_title
                        : null;
                    const desc = [se, evTitle].filter(Boolean).join(" · ");
                    return (
                      <li key={item.id} class="library-history-row">
                        <div class="library-history-main">
                          <span class="library-history-label">
                            {desc || history.title}
                          </span>
                          <span class="library-history-meta tabular-nums">
                            <a href={`#/calendar?date=${item.local_date}`}>
                              {formatLocalDay(item.local_date)}
                            </a>{" "}
                            · {item.local_time}
                          </span>
                        </div>
                        <span class="library-history-min tabular-nums">
                          {item.minutes > 0 ? formatMinutes(item.minutes) : "—"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>
          </>
        )}
      </section>
    );
  }

  const queryTooShort = normalizeForSearch(query).length < MIN_QUERY_LENGTH;

  return (
    <section class="page-container search-page" aria-label="Search">
      <header class="page-header">
        <div class="page-header-titles">
          <h1>Search</h1>
          <p class="page-subtitle">
            Find any title, series, author, or YouTube channel across your
            logged history.
          </p>
        </div>
        <div class="page-header-actions">
          <Button
            variant="secondary"
            size="sm"
            href={
              inputValue.trim()
                ? `#/add?q=${encodeURIComponent(inputValue.trim())}`
                : "#/add"
            }
            leadingIcon={<AddIcon size={15} />}
          >
            Look up & Add to Archive
          </Button>
        </div>
      </header>

      <Card padding="md">
        <div class="ui-form-stack">
          <div class="search-controls-grid">
            <div class="add-lookup-input-wrap">
              <span class="add-lookup-icon" aria-hidden="true">
                <SearchIcon size={18} />
              </span>
              <input
                type="search"
                class="ui-input add-lookup-input"
                placeholder="Search titles, authors, series, or channels…"
                aria-label="Search query"
                value={inputValue}
                onInput={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value;
                  setInputValue(val);
                  window.clearTimeout(debounceRef.current);
                  debounceRef.current = window.setTimeout(
                    () => setQuery(val),
                    DEBOUNCE_MS
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    window.clearTimeout(debounceRef.current);
                    setQuery(inputValue);
                  }
                }}
                autofocus
              />
            </div>

            <div class="search-filter-selects">
              <select
                class="ui-input"
                aria-label="Filter by source"
                value={source}
                onChange={(e) =>
                  setSource((e.currentTarget as HTMLSelectElement).value)
                }
              >
                {STATS_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>

              <select
                class="ui-input"
                aria-label="Filter by media type"
                value={mediaType}
                onChange={(e) =>
                  setMediaType((e.currentTarget as HTMLSelectElement).value)
                }
              >
                <option value="">All media types</option>
                {SEARCH_MEDIA_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <CategoryChips
            selected={selectedCategories}
            onChange={setSelectedCategories}
            includeYoutubeInAll={includeYoutubeInAll}
            ariaLabel="Filter search by category"
            syncUrl={false}
          />
        </div>
      </Card>

      {error && (
        <div class="calendar-error" role="alert">
          <span>
            <strong>Search error:</strong> {error}
          </span>
        </div>
      )}

      {queryTooShort ? (
        <EmptyState
          compact
          icon={<SearchIcon size={24} />}
          title="Type at least 2 characters to search"
          description="Matching is case- and diacritics-insensitive across titles, series, authors, and YouTube channels."
        />
      ) : loading ? (
        <div class="ui-form-stack" aria-busy="true">
          <Skeleton height={68} />
          <Skeleton height={68} />
          <Skeleton height={68} />
        </div>
      ) : result && filteredHits.length === 0 ? (
        <EmptyState
          title={`No matches in your history for “${query}”`}
          description="Want to add this work from the past to your archive?"
          actions={
            <Button
              variant="primary"
              size="sm"
              href={`#/add?q=${encodeURIComponent(query)}`}
              leadingIcon={<AddIcon size={15} />}
            >
              Look up “{query}” & Add to Archive
            </Button>
          }
        />
      ) : result ? (
        <>
          <div class="search-results-count tabular-nums" aria-live="polite">
            {filteredHits.length}{" "}
            {filteredHits.length === 1 ? "result" : "results"} for “{query}”
          </div>

          <Card padding="none">
            <ul class="library-works-list">
              {filteredHits.map((hit: SearchHit) => {
                const cat = resolveItemCategory(hit);
                const hitHref = `#/search?q=${encodeURIComponent(
                  query
                )}&key=${encodeURIComponent(hit.key)}`;
                const menuTarget = {
                  kind: "work" as const,
                  workKey: hit.key,
                  title: hit.title,
                  category: cat,
                  href: hitHref,
                  source: hit.source,
                };
                return (
                  <li
                    key={hit.key}
                    class="library-work-list-row"
                    tabIndex={0}
                    {...bindContextMenu(menuTarget)}
                  >
                    <a href={hitHref} class="library-work-list-main">
                      <Cover
                        src={hit.cover_url}
                        title={hit.title}
                        category={cat}
                        source={hit.source}
                        mediaType={hit.media_type}
                        size="md"
                        aspect="square"
                      />
                      <div class="library-work-list-info">
                        <span class="library-work-list-title">
                          <HighlightedTitle title={hit.title} query={query} />
                        </span>
                        {hit.subtitle && (
                          <span class="ui-text-muted">{hit.subtitle}</span>
                        )}
                        <span class="library-work-list-sub tabular-nums">
                          <Badge
                            size="sm"
                            category={cat}
                            icon={<CategoryIcon category={cat} size={11} />}
                          >
                            {categoryLabel(cat)}
                          </Badge>
                          <span>{sourceLabel(hit.source)}</span>
                          <span>·</span>
                          <span>{formatHitMeta(hit)}</span>
                        </span>
                      </div>
                    </a>
                    <div class="library-work-list-right">
                      <QuickRatingPill
                        workKey={hit.key}
                        title={hit.title}
                        category={cat}
                        rating={null}
                        source={hit.source}
                        variant="inline"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          {result.total > result.hits.length && (
            <div class="search-load-more">
              <Button
                variant="secondary"
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more results"}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
