import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AreaChart } from "./charts";
import { Money, cx } from "./ui";
import { moveBetween } from "../lib/select";
import type { RangeKey } from "../lib/range";
import type { Point } from "./charts";

/**
 * A figure, how it moved, and the line it moved along — with a finger on it.
 *
 * The Accounts screen and a single account's page ask exactly the same thing
 * of this, so it is one component rather than two that drift: press the chart
 * and the figure above becomes the one for the day under your finger, the
 * change is measured from the start of the period to that day, and the period
 * stops being "6 months" and becomes the stretch you dragged out.
 */

/**
 * The periods on offer, in the order a phone shows them.
 *
 * Two names each: the button is abbreviated because six of them share one
 * line, and the sentence under the headline is not, because "$25,460 (3%) 1M
 * period" is a button label read aloud rather than a sentence.
 */
export const SPANS: { value: RangeKey; label: string; period: string }[] = [
  { value: "1m", label: "1M", period: "1 month" },
  { value: "3m", label: "3M", period: "3 months" },
  { value: "6m", label: "6M", period: "6 months" },
  { value: "ytd", label: "YTD", period: "year to date" },
  { value: "1y", label: "1Y", period: "1 year" },
  { value: "all", label: "ALL", period: "all time" },
];

/** What the period is called when nobody is pointing at a day in it. */
export const periodOf = (range: RangeKey): string =>
  SPANS.find((s) => s.value === range)?.period ?? range;

/** "2.5%", and "<0.1%" rather than a rounded-away nothing. */
export function pctLabel(fraction: number): string {
  const p = Math.abs(fraction) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}

/**
 * How a figure moved, in money and in proportion, over a named stretch.
 *
 * Signed throughout, liabilities included: they are stored negative, so a card
 * paid down comes out positive and green without a special case. A figure that
 * began at nothing has no proportion to report and simply doesn't.
 */
export function Delta({ move, period }: {
  move: { change: number; pct: number | null }; period: string;
}) {
  // Same shape as the moved case, period in the same place: a reader glancing
  // at the line should not have to find it somewhere new because a figure
  // happened to land on nought.
  if (move.change === 0) {
    return (
      <span className="row" style={{ gap: 7 }}>
        <span className="muted">No change</span>
        <span className="faint">{period}</span>
      </span>
    );
  }
  const up = move.change > 0;
  return (
    <span className="row" style={{ gap: 7 }}>
      <span className={up ? "pos" : "neg"}>
        {up ? "↗" : "↘"} <Money value={move.change} />
        {move.pct !== null ? ` (${pctLabel(move.pct)})` : ""}
      </span>
      <span className="faint">{period}</span>
    </span>
  );
}

/**
 * The run of account kinds above a balance chart.
 *
 * Net Worth first and then each kind that exists, which is the same question
 * on the Accounts page and on the dashboard, so it is the same control. It
 * scrolls sideways rather than wrapping: the kinds are a single ordered run,
 * and a second line of them reads as a second, lesser row of options.
 */
export function ScopeBar({ slices, value, onChange }: {
  slices: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  // A pill chosen from the far end of the run can be half off the screen when
  // the tap lands, which reads as though the tap missed.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bar.current?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [value]);

  return (
    <div className="scope-bar" ref={bar} role="tablist" aria-label="What to show">
      {slices.map((s) => (
        <button
          key={s.key} role="tab" aria-selected={s.key === value}
          className={cx("scope-pill", s.key === value && "on")}
          onClick={() => onChange(s.key)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function BalanceChart({ label, above, total, series, points, tone, range, onRange }: {
  /** A small line above the figure — "Current balance". */
  label?: string;
  /** Anything that belongs above that, flush to the card's top edge. */
  above?: ReactNode;
  /** Today's figure, which is not always the last plotted one: the chart is
   *  drawn from dated history, and a live balance can be ahead of it. */
  total: number;
  series: number[];
  points: Point[];
  tone: string;
  range: RangeKey;
  onRange: (r: RangeKey) => void;
}) {
  // Where a finger is resting on the chart, if one is. Null means the whole
  // period, which is what the card says when nobody is touching it.
  const [at, setAt] = useState<number | null>(null);
  const here = at === null ? null : Math.min(at, series.length - 1);
  const shown = here === null || here < 0 ? total : series[here];
  const move = moveBetween(series, here ?? undefined);
  const window = here === null || !points.length ? null : `${points[0].sub} – ${points[here].sub}`;

  return (
    <>
      {above}
      <div className="nw-head">
        {label ? <span className="tile-label">{label}</span> : null}
        <div className="nw-value num"><Money value={shown} /></div>
        <Delta move={move} period={window ?? periodOf(range)} />
      </div>

      {/* Edge to edge, and no axis labels: every figure they would carry is
          spelled out in words directly above them — and follows the finger,
          which is the other reason they would be a second copy. */}
      <AreaChart points={points} height={200} tone={tone} negativeTone={tone} bare onScrub={setAt} />

      <div className="span-bar">
        {SPANS.map((r) => (
          <button
            key={r.value} className={cx("span-pill", r.value === range && "on")}
            onClick={() => onRange(r.value)}
          >
            {r.label}
          </button>
        ))}
      </div>
    </>
  );
}
