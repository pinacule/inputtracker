/** @jsxImportSource preact */
import { normComparison } from "../../lib/home-norm";
import { formatMinutes } from "../../lib/stats";

/** Two aligned rules, one shared scale. A zero norm is a mark, never a fake bar. */
export function NormComparison({ actual, norm, label }: {
  readonly actual: number;
  readonly norm: number;
  readonly label: string;
}) {
  const ceiling = Math.max(60, actual, norm);
  return (
    <div class="home-norm" role="img" aria-label={`${label}: ${formatMinutes(actual)} logged; usual ${formatMinutes(norm)}; ${normComparison(actual, norm)}`}>
      <div class="home-norm-row" aria-hidden="true">
        <span>Logged</span>
        <span class="home-norm-track"><span class="home-norm-actual" style={{ width: `${actual / ceiling * 100}%` }} /></span>
        <span>{formatMinutes(actual)}</span>
      </div>
      <div class="home-norm-row" aria-hidden="true">
        <span>Usual</span>
        <span class="home-norm-track"><span class="home-norm-usual" style={{ width: `${norm / ceiling * 100}%` }} /></span>
        <span>{formatMinutes(norm)}</span>
      </div>
      <span class="home-norm-caption" aria-hidden="true">{normComparison(actual, norm)}</span>
    </div>
  );
}
