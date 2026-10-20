/** @jsxImportSource preact */
import { formatMinutes } from "../../lib/stats";

/** Exact, set-in-type time: units stay small; numerals carry the page. */
export function HomeTimeDisplay({ minutes, class: className = "" }: {
  readonly minutes: number;
  readonly class?: string;
}) {
  const rounded = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return (
    <span class={`home-time ${className}`.trim()} aria-label={formatMinutes(rounded)}>
      <span class="home-time-typeset" aria-hidden="true">
        {hours > 0 && <span class="home-time-part">{hours}<span class="home-time-unit">h</span></span>}
        {(remainder > 0 || hours === 0) && <span class="home-time-part">{hours > 0 ? String(remainder).padStart(2, "0") : remainder}<span class="home-time-unit">m</span></span>}
      </span>
    </span>
  );
}
