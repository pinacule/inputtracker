import { useState } from "preact/hooks";
import { categoryCssColor, categoryPluralLabel, formatCategoryUnits } from "../../lib/categories";
import { formatCleanDayHeading, type MonthRhythmModel } from "../../lib/home";
import { formatMinutes } from "../../lib/stats";
import { HomeTimeDisplay } from "./HomeTimeDisplay";

export interface MonthRhythmCardProps {
  readonly model: MonthRhythmModel;
  readonly todayStr: string;
  readonly onSelectDate: (date: string) => void;
}

/** A full-width rhythm line and aligned category ledger, without a second filter. */
export function MonthRhythmCard({ model, todayStr, onSelectDate }: MonthRhythmCardProps) {
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const inspectedBar = model.skyline.find((bar) => bar.date === hoveredDate)
    ?? model.skyline.find((bar) => bar.isSelected);

  return (
    <section class="home-rhythm-card" aria-label={`${model.heading} overview graph`}>
      <div class="home-rhythm-heading">
        <div>
          <span class="home-kicker">The month in view</span>
          <h2 class="home-rhythm-title">{model.heading}</h2>
        </div>
        <a class="home-section-link" href={`#/review?month=${model.month}`}>Month review <span aria-hidden="true">↗</span></a>
      </div>
      <div class="home-rhythm-header">
        <HomeTimeDisplay minutes={model.totalMinutes} class="home-time--month" />
        <div class="home-rhythm-meta">
          <span>{model.activeDays} active {model.activeDays === 1 ? "day" : "days"}</span>
          {model.deltaLabel && <span>{model.deltaLabel}</span>}
        </div>
      </div>
      <div class="home-rhythm-readout" aria-live="polite" aria-atomic="true">
        {inspectedBar ? <><span>{formatCleanDayHeading(inspectedBar.date, todayStr)}</span><strong>{inspectedBar.totalMinutes > 0 ? formatMinutes(inspectedBar.totalMinutes) : inspectedBar.totalCount > 0 ? `${inspectedBar.totalCount} items` : "Nothing logged"}</strong></> : <span>Daily record</span>}
      </div>
      <div class="home-skyline" role="group" aria-label={`Daily activity bars for ${model.heading}`} onMouseLeave={() => setHoveredDate(null)}>
        {model.skyline.map((bar) => {
          const showTick = [1, 8, 15, 22, model.daysInMonth].includes(bar.dayOfMonth);
          const future = bar.date > todayStr;
          const label = `${formatCleanDayHeading(bar.date, todayStr)}: ${bar.totalMinutes > 0 ? formatMinutes(bar.totalMinutes) : bar.totalCount > 0 ? `${bar.totalCount} items` : "no activity"}`;
          return (
            <button key={bar.date} type="button"
              class={`home-skyline-col${bar.isSelected ? " home-skyline-col--selected" : ""}${future ? " home-skyline-col--future" : ""}`}
              disabled={future} aria-pressed={bar.isSelected} aria-current={bar.isToday ? "date" : undefined} aria-label={label}
              onMouseEnter={() => setHoveredDate(bar.date)} onFocus={() => setHoveredDate(bar.date)} onBlur={() => setHoveredDate(null)}
              onClick={() => onSelectDate(bar.date)}>
              <span class="home-skyline-well" aria-hidden="true">
                {bar.heightRatio > 0 ? (
                  <span class="home-skyline-stack" style={{ height: `${bar.heightRatio * 100}%` }}>
                    {bar.segments.map((seg) => (
                      <span key={seg.category} class={`home-skyline-seg home-tone--${seg.category}`}
                        style={{ flexGrow: seg.sharePct, flexBasis: 0, backgroundColor: categoryCssColor(seg.category) }}
                        title={`${categoryPluralLabel(seg.category)}: ${formatMinutes(seg.minutes)}`} />
                    ))}
                  </span>
                ) : <span class="home-skyline-dot" />}
              </span>
              <span class="home-skyline-tick" aria-hidden="true">{showTick ? bar.dayOfMonth : ""}</span>
            </button>
          );
        })}
      </div>
      {(model.undatedMinutes ?? 0) > 0 && (
        <p class="home-rhythm-undated">{formatMinutes(model.undatedMinutes!)} dated to the month only; not placed on the daily line.</p>
      )}
      {model.categoryShares.length > 0 ? (
        <dl class="home-month-ledger" aria-label="Month totals by category">
          {model.categoryShares.map((share, index) => (
            <div key={share.category} class={`home-ledger-entry home-tone--${share.category}`}>
              <dt><span class="home-ledger-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>{share.label}</dt>
              <dd>{share.totalMinutes > 0 ? formatMinutes(share.totalMinutes) : formatCategoryUnits(share.category, share.units)}</dd>
              <span class="home-ledger-track" aria-hidden="true"><span style={{ width: `${share.sharePct}%`, backgroundColor: categoryCssColor(share.category) }} /></span>
            </div>
          ))}
        </dl>
      ) : <p class="home-month-empty">An unwritten month. Your next entry starts the record.</p>}
    </section>
  );
}
