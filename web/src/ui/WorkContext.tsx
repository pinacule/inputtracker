import { useState } from "preact/hooks";
import type { LibraryWorkDetail } from "../../../src/core/contract";
import { workBannerImage, workRankLines } from "../lib/work-presentation";

/** Decorative images stay local and degrade banner → cover → category gradient. */
export function WorkBanner({ detail }: { detail: LibraryWorkDetail }) {
  const [failed, setFailed] = useState<string[]>([]);
  const src = workBannerImage(detail, failed);
  return (
    <div class={`work-banner work-banner--${detail.category}`} aria-hidden="true">
      {src && <img key={src} src={src} alt="" onError={() => setFailed((urls) => [...urls, src])} />}
    </div>
  );
}

export function WorkContext({ detail }: { detail: LibraryWorkDetail }) {
  const [expanded, setExpanded] = useState(false);
  const score = detail.community_score;
  const rankLines = workRankLines(detail);
  return (
    <div class="work-context">
      {(detail.year !== null || detail.narrators.length > 0) && (
        <p class="work-context-credit">
          {[detail.year, detail.narrators.length > 0 ? `Narrated by ${detail.narrators.join(", ")}` : null].filter((part) => part !== null).join(" · ")}
        </p>
      )}
      {detail.description && (
        <div class="work-description-block">
          <p id="work-description" class={`work-description${expanded || detail.description.length <= 180 ? " work-description--expanded" : ""}`}>{detail.description}</p>
          {detail.description.length > 180 && (
            <button type="button" class="work-description-toggle" aria-expanded={expanded} aria-controls="work-description" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Less" : "More"}
            </button>
          )}
        </div>
      )}
      {detail.genres.length > 0 && (
        <ul class="work-genres" aria-label="Genres">
          {detail.genres.map((genre) => <li key={genre}>{genre}</li>)}
        </ul>
      )}
      {score && (
        <div class="work-score" aria-label="Community score and your rating, out of 10">
          <div class="work-score-labels tabular-nums">
            <span>{score.source} <strong>{score.value_10.toFixed(1)}</strong></span>
            {detail.category !== "music" && <span>· You <strong>{detail.rating === null ? "Not rated" : detail.rating.toFixed(1)}</strong></span>}
            <span class="work-score-scale">/ 10</span>
          </div>
          <div class="work-score-bars" aria-hidden="true">
            <div><span style={{ width: `${score.value_10 * 10}%` }} /></div>
            {detail.category !== "music" && <div><span class="work-score-mine" style={{ width: `${(detail.rating ?? 0) * 10}%` }} /></div>}
          </div>
          {score.votes !== null && <small class="work-score-votes">{score.votes.toLocaleString("en-US")} public ratings</small>}
        </div>
      )}
      {rankLines.length > 0 && <div class="work-rank" aria-label="Your category ranking">{rankLines.map((line) => <p key={line}>{line}</p>)}</div>}
    </div>
  );
}
