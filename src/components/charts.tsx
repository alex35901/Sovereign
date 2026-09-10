import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { fmt0 } from "../lib/money";
import { color, cx } from "./ui";

/** Tracks a container's pixel width so charts can lay out real text. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const flip = x > width * 0.6;
  return (
    <div className="chart-tip" style={{ left: flip ? undefined : x + 12, right: flip ? width - x + 12 : undefined, top: Math.max(0, y - 12) }}>
      {children}
    </div>
  );
}

/**
 * Evenly divides lo..hi so the first and last labels are the actual minimum and
 * maximum of the period — the range is the information on a balance chart, and
 * rounding to "nice" numbers hides it.
 */
export const rangeTicks = (lo: number, hi: number, count = 4): number[] =>
  Array.from({ length: count + 1 }, (_, i) => lo + ((hi - lo) * i) / count);

/**
 * Picks a unit and precision from the span rather than the values, so a $500
 * swing on a $570k balance doesn't render as five identical labels.
 */
export function axisFormat(lo: number, hi: number, count = 4): (v: number) => string {
  const maxAbs = Math.max(Math.abs(lo), Math.abs(hi)) / 100;
  const step = Math.abs(hi - lo) / count / 100;
  const unit = maxAbs >= 1_000_000 ? 1_000_000 : maxAbs >= 1000 ? 1000 : 1;
  const suffix = unit === 1_000_000 ? "M" : unit === 1000 ? "k" : "";
  const stepInUnit = step / unit;
  const decimals = unit === 1 ? 0 : stepInUnit >= 1 ? 1 : 2;
  return (v: number) => {
    const d = v / 100 / unit;
    return `${d < 0 ? "-" : ""}$${Math.abs(d).toFixed(decimals)}${suffix}`;
  };
}

const niceTicks = (min: number, max: number, count = 4): number[] => {
  if (max === min) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max; v += step) out.push(v);
  return out;
};

/* ── area / line ──────────────────────────────────────────────────────── */

export interface Point { label: string; value: number; sub?: string }

export function AreaChart({
  points, height = 190, tone = "--accent", negativeTone = "--neg", zeroBase = false, startLine = false,
  markLine, markLabel, bare = false, onScrub, format,
}: {
  points: Point[]; height?: number; tone?: string; negativeTone?: string; zeroBase?: boolean; startLine?: boolean;
  /** A horizontal line to aim at — a goal's target, and where the line meets it. */
  markLine?: number;
  markLabel?: string;
  /**
   * No axes, no labels, no margins: the line runs the full width it is given.
   *
   * For a headline chart whose figures are already spelled out above it in
   * words. Axis labels there are a second, smaller copy of what the reader
   * has just been told, and the gutter they need is what stops the line
   * reaching either edge.
   */
  bare?: boolean;
  /**
   * Which point is under the pointer, as it moves.
   *
   * For a chart whose readout lives outside it — a headline figure above that
   * follows the finger. Supplying this also turns off the chart's own tooltip,
   * since two readouts of the same point is one too many.
   */
  onScrub?: (index: number | null) => void;
  /**
   * How to write a value, when it is not money.
   *
   * A credit score charted with the money formatter comes out as an axis of
   * "$8" — every reading rounded to the nearest thousand dollars, which is
   * both wrong and unreadable.
   */
  format?: (value: number) => string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  // A touch only scrubs while it is held. A mouse scrubs on hover, which is
  // what it has always done, so the two need telling apart.
  const dragging = useRef(false);
  const scrubRef = useRef(onScrub);
  scrubRef.current = onScrub;
  useEffect(() => { scrubRef.current?.(hover); }, [hover]);
  const raw = useId();
  const uid = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (!points.length) return <div ref={ref} style={{ height }} />;

  // One pixel, not none: the line is 2px wide and centred on its endpoints,
  // so at a true zero margin a clipping chart shaves the outer half off both
  // ends and the run looks cut rather than finished.
  const padL = bare ? 1 : 52;
  const padR = bare ? 1 : 8;
  const padT = bare ? 2 : 10;
  const padB = bare ? 2 : 22;
  const innerW = Math.max(40, w - padL - padR);
  const innerH = height - padT - padB;
  const values = points.map((p) => p.value);
  const hasNegative = values.some((v) => v < 0);
  // The axis spans exactly the period's min and max. Zero is only forced in
  // where a caller asks for it; on a balance chart it would flatten the line
  // into a straight edge at the bottom.
  // The mark is part of the range, or a target above everything saved so far
  // would sit off the top of its own chart.
  let lo = Math.min(...values, zeroBase ? 0 : Infinity, markLine ?? Infinity);
  let hi = Math.max(...values, zeroBase ? 0 : -Infinity, markLine ?? -Infinity);
  // a flat or near-flat series still needs a readable band
  const minSpan = Math.max(100, Math.abs(hi) * 0.001);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  // breathing room in pixels, not in values, so the labels stay exact
  const inset = 4;
  const plotH = Math.max(1, innerH - inset * 2);
  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + inset + plotH - ((v - lo) / (hi - lo)) * plotH;

  const zeroY = Math.max(padT, Math.min(padT + innerH, y(0)));
  /** Which reading a screen position is nearest, clamped to the two ends. */
  const indexAt = (clientX: number, el: Element) => {
    const rel = clientX - el.getBoundingClientRect().left - padL;
    const i = Math.round((rel / innerW) * (points.length - 1));
    return Math.max(0, Math.min(points.length - 1, i));
  };
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  // Fill to the zero axis rather than the floor of the plot, so a negative
  // series paints the band between 0 and the balance instead of a thin sliver.
  const area = `${line} L${x(points.length - 1).toFixed(1)},${zeroY} L${x(0).toFixed(1)},${zeroY} Z`;
  const ticks = rangeTicks(lo, hi);
  const label = format ?? axisFormat(lo, hi);

  // Sampled days can land twice in the same month, which would print "Jan '26"
  // beside itself; only the first of a repeated label is drawn.
  const every = Math.ceil(points.length / Math.max(2, Math.floor(innerW / 62)));
  const labelled: number[] = [];
  let previous = "";
  for (let i = 0; i < points.length; i += every) {
    if (points[i].label === previous) continue;
    previous = points[i].label;
    labelled.push(i);
  }
  const showZeroLine = hasNegative && hi > 0 && lo < 0;

  return (
    <div ref={ref} className="chart-wrap" style={{ height }}>
      <svg
        width="100%" height={height}
        style={{
          display: "block",
          overflow: bare ? "hidden" : "visible",
          // Vertical drags still scroll the page; horizontal ones come here.
          // touch-action:none would turn a 200px-tall chart into a strip of
          // the screen that cannot be scrolled past.
          touchAction: onScrub ? "pan-y" : undefined,
        }}
        onPointerDown={(e) => {
          if (!onScrub) return;
          // Capture, or a finger that slides off the chart stops reporting
          // half way through the gesture.
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          setHover(indexAt(e.clientX, e.currentTarget));
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse" || dragging.current) setHover(indexAt(e.clientX, e.currentTarget));
        }}
        onPointerUp={(e) => { dragging.current = false; if (e.pointerType !== "mouse") setHover(null); }}
        onPointerCancel={() => { dragging.current = false; setHover(null); }}
        onPointerLeave={() => { if (!dragging.current) setHover(null); }}
      >
        <defs>
          <linearGradient id={`up-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1={padT} x2="0" y2={zeroY}>
            <stop offset="0%" stopColor={color(tone)} stopOpacity="0.30" />
            <stop offset="100%" stopColor={color(tone)} stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id={`dn-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1={zeroY} x2="0" y2={padT + innerH}>
            <stop offset="0%" stopColor={color(negativeTone)} stopOpacity="0.05" />
            <stop offset="100%" stopColor={color(negativeTone)} stopOpacity="0.34" />
          </linearGradient>
          {/* split at the axis so a series crossing zero is green above, red below */}
          <clipPath id={`above-${uid}`}>
            <rect x={padL} y={padT} width={innerW} height={Math.max(0, zeroY - padT)} />
          </clipPath>
          <clipPath id={`below-${uid}`}>
            <rect x={padL} y={zeroY} width={innerW} height={Math.max(0, padT + innerH - zeroY)} />
          </clipPath>
        </defs>

        {bare ? null : ticks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} />
            <text className="axis-text" x={padL - 8} y={y(t) + 3.5} textAnchor="end">{label(t)}</text>
          </g>
        ))}

        <path d={area} fill={`url(#up-${uid})`} clipPath={`url(#above-${uid})`} />
        <path d={area} fill={`url(#dn-${uid})`} clipPath={`url(#below-${uid})`} />
        <path d={line} fill="none" stroke={color(tone)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#above-${uid})`} />
        <path d={line} fill="none" stroke={color(negativeTone)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#below-${uid})`} />

        {showZeroLine ? (
          <line x1={padL} x2={padL + innerW} y1={zeroY} y2={zeroY} stroke={color("--muted")} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
        ) : null}

        {markLine !== undefined ? (
          <g>
            <line
              x1={padL} x2={padL + innerW} y1={y(markLine)} y2={y(markLine)}
              stroke={color("--muted")} strokeWidth={1} strokeDasharray="4 4" opacity={0.85}
            />
            {markLabel ? (
              <text className="axis-text" x={padL + innerW} y={y(markLine) - 5} textAnchor="end">{markLabel}</text>
            ) : null}
          </g>
        ) : null}

        {startLine ? (
          <line
            className="start-baseline"
            x1={padL} x2={padL + innerW} y1={y(points[0].value)} y2={y(points[0].value)}
            stroke={color("--faint")} strokeWidth={1} strokeDasharray="3 4" opacity={0.8}
          />
        ) : null}

        {bare ? null : labelled.map((i) => (
          <text key={points[i].label + i} className="axis-text" x={x(i)} y={height - 6} textAnchor="middle">
            {points[i].label}
          </text>
        ))}

        {hover !== null ? (
          <g>
            {/* The line a finger is following has to be findable under it: a
                hairline in --line disappears against the fill it crosses. */}
            <line
              className="grid-line" x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH}
              stroke={color(onScrub ? tone : "--line")}
              strokeWidth={onScrub ? 1.5 : 1}
              opacity={onScrub ? 0.65 : 1}
            />
            <circle
              cx={x(hover)} cy={y(points[hover].value)} r={onScrub ? 5.5 : 4}
              fill={color(points[hover].value < 0 ? negativeTone : tone)}
              stroke={color("--surface")} strokeWidth={onScrub ? 3 : 2}
            />
          </g>
        ) : null}
      </svg>
      {hover !== null && !onScrub ? (
        <Tip x={x(hover)} y={y(points[hover].value)} width={w}>
          <div className="tiny muted">{points[hover].label}</div>
          <div className={`num bold ${points[hover].value < 0 ? "neg" : ""}`}>
            {format ? format(points[hover].value) : fmt0(points[hover].value)}
          </div>
          {points[hover].sub ? <div className="tiny muted">{points[hover].sub}</div> : null}
        </Tip>
      ) : null}
    </div>
  );
}

/**
 * Two runs of the same thing over the same stretch, for comparison.
 *
 * One of them is complete and one is still being written, which is the whole
 * point: this month's line stops where today is, and the gap between where it
 * stopped and where the other line had got to by the same day is the answer
 * being looked for. The finished run is drawn behind and in grey so the live
 * one reads as the subject rather than as one of a pair.
 */
export function CompareChart({ current, previous, height = 210, span, tone = "--accent", label, priorLabel }: {
  /** [x, y] pairs. x is shared between the two — a day of the month. */
  current: [number, number][];
  previous: [number, number][];
  height?: number;
  /** The widest x either run can reach, so both are drawn to one scale. */
  span: number;
  tone?: string;
  label: string;
  priorLabel: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const raw = useId();
  const uid = raw.replace(/[^a-zA-Z0-9]/g, "");
  const padL = 46;
  const padR = 10;
  const padT = 10;
  const padB = 26;
  const innerW = Math.max(40, w - padL - padR);
  const innerH = height - padT - padB;
  const hi = Math.max(1, ...current.map((p) => p[1]), ...previous.map((p) => p[1]));
  const x = (day: number) => padL + (span <= 1 ? 0 : ((day - 1) / (span - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / hi) * innerH;
  const path = (pts: [number, number][]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  const ticks = rangeTicks(0, hi);
  const fmtTick = axisFormat(0, hi);
  const tip = current[current.length - 1];

  return (
    <div ref={ref} className="chart-wrap" style={{ height }}>
      <svg width="100%" height={height} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id={`cmp-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1={padT} x2="0" y2={padT + innerH}>
            <stop offset="0%" stopColor={color(tone)} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color(tone)} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} />
            <text className="axis-text" x={padL - 8} y={y(t) + 3.5} textAnchor="end">{fmtTick(t)}</text>
          </g>
        ))}
        {previous.length > 1 ? (
          <path d={path(previous)} fill="none" stroke={color("--muted")} strokeWidth={2} strokeLinejoin="round" opacity={0.65} />
        ) : null}
        {current.length > 1 ? (
          <>
            <path
              d={`${path(current)} L${x(current[current.length - 1][0]).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(current[0][0]).toFixed(1)},${(padT + innerH).toFixed(1)} Z`}
              fill={`url(#cmp-${uid})`}
            />
            <path d={path(current)} fill="none" stroke={color(tone)} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          </>
        ) : null}
        {tip ? (
          <>
            <circle cx={x(tip[0])} cy={y(tip[1])} r={3.5} fill={color(tone)} />
            <text className="axis-text" x={Math.min(x(tip[0]) + 8, padL + innerW)} y={y(tip[1]) - 8} textAnchor={x(tip[0]) > padL + innerW * 0.7 ? "end" : "start"} fill={color(tone)}>
              {fmt0(tip[1])}
            </text>
          </>
        ) : null}
        <text className="axis-text" x={padL} y={height - 6}>Day 1</text>
        <text className="axis-text" x={padL + innerW} y={height - 6} textAnchor="end">{`Day ${span}`}</text>
      </svg>
      <div className="row cmp-key tiny">
        <span className="row" style={{ gap: 6 }}><i className="cmp-swatch" style={{ background: color(tone) }} />{label}</span>
        <span className="row" style={{ gap: 6 }}><i className="cmp-swatch" style={{ background: color("--muted") }} />{priorLabel}</span>
      </div>
    </div>
  );
}

/**
 * Income above the line, spending below it, and what was left drawn across.
 *
 * One axis with a real zero on it, rather than two rows of bars side by side:
 * the question a cash-flow chart answers is whether the green outweighs the
 * red, and that is a thing you see at a glance only when they are measured
 * against the same nought.
 */
/** How wide one period's bar may grow when there is room going spare. */
const FLOW_BAR_MAX = 92;

export function FlowChart({ buckets, height = 240, onPick }: {
  buckets: { key: string; label: string; income: number; expense: number; net: number }[];
  height?: number;
  onPick?: (key: string) => void;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!buckets.length) return <div ref={ref} style={{ height }} />;

  const padL = 52;
  const padR = 10;
  const padT = 12;
  const padB = 26;
  const innerW = Math.max(40, w - padL - padR);
  const innerH = height - padT - padB;
  const hi = Math.max(1, ...buckets.map((b) => b.income), ...buckets.map((b) => b.expense), ...buckets.map((b) => Math.abs(b.net)));
  const mid = padT + innerH / 2;
  const y = (v: number) => mid - (v / hi) * (innerH / 2);
  const slot = innerW / buckets.length;
  // One bar per period rather than two side by side: income and spending are
  // the same month's two halves, and reading them off one vertical line is
  // what makes the shape of a month legible. It also buys back the width the
  // second bar was using, which goes into the bar that is left.
  //
  // The ceiling is generous because a year of months and a quarter of them are
  // the same chart at two densities: twelve bars are held apart by the slot
  // and never reach it, while three bars on a desktop card would otherwise be
  // three pencil lines adrift in a field of nothing. The bar takes its share
  // of the slot it is given, and the share is what keeps the gaps even.
  const barW = Math.max(6, Math.min(FLOW_BAR_MAX, slot * 0.62));
  const x = (i: number) => padL + slot * i + slot / 2;
  const ticks = rangeTicks(-hi, hi);
  const label = axisFormat(-hi, hi);
  const net = buckets.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.net).toFixed(1)}`).join(" ");
  // Every label would collide on a year of months, so they thin out.
  const every = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(innerW / 46))));

  return (
    <div ref={ref} className="chart-wrap" style={{ height }}>
      <svg width="100%" height={height} style={{ display: "block", overflow: "visible" }} onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} />
            <text className="axis-text" x={padL - 8} y={y(t) + 3.5} textAnchor="end">{label(Math.abs(t))}</text>
          </g>
        ))}
        <line x1={padL} x2={padL + innerW} y1={mid} y2={mid} stroke={color("--line")} strokeWidth={1} />

        {buckets.map((b, i) => (
          <g
            key={b.key}
            onMouseEnter={() => setHover(i)}
            onClick={onPick ? () => onPick(b.key) : undefined}
            style={onPick ? { cursor: "pointer" } : undefined}
          >
            <rect x={x(i) - slot / 2} y={padT} width={slot} height={innerH} fill="transparent" />
            <rect
              x={x(i) - barW / 2} y={y(b.income)} width={barW} height={Math.max(1, mid - y(b.income))}
              rx={3} fill={color("--pos")} opacity={hover === null || hover === i ? 0.85 : 0.4}
            />
            <rect
              x={x(i) - barW / 2} y={mid} width={barW} height={Math.max(1, y(-b.expense) - mid)}
              rx={3} fill={color("--neg")} opacity={hover === null || hover === i ? 0.85 : 0.4}
            />
          </g>
        ))}

        {/* What was left, across the top of the bars it came from. */}
        <path d={net} fill="none" stroke={color("--text")} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {buckets.map((b, i) => <circle key={b.key} cx={x(i)} cy={y(b.net)} r={2.5} fill={color("--text")} />)}

        {buckets.map((b, i) => (i % every ? null : (
          <text key={b.key} className="axis-text" x={x(i)} y={height - 6} textAnchor="middle">{b.label}</text>
        )))}
      </svg>
      {hover !== null ? (
        <Tip x={x(hover)} y={padT} width={w}>
          <div className="tiny muted">{buckets[hover].label}</div>
          <div className="tiny pos">In {fmt0(buckets[hover].income)}</div>
          <div className="tiny neg">Out {fmt0(buckets[hover].expense)}</div>
          <div className="tiny bold">Saved {fmt0(buckets[hover].net)}</div>
        </Tip>
      ) : null}
    </div>
  );
}

/* ── bars ─────────────────────────────────────────────────────────────── */

export interface BarGroup { label: string; bars: { key: string; value: number; tone: string }[]; }

export function BarChart({ groups, height = 200, showZero = true, compact = false, onClickGroup }: {
  groups: BarGroup[]; height?: number; showZero?: boolean; compact?: boolean; onClickGroup?: (label: string) => void;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!groups.length) return <div ref={ref} style={{ height }} />;

  const padL = compact ? 36 : 52;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const innerW = Math.max(40, w - padL - padR);
  const innerH = height - padT - padB;
  const all = groups.flatMap((g) => g.bars.map((b) => b.value));
  const hi = Math.max(...all, 0);
  const lo = Math.min(...all, showZero ? 0 : Math.min(...all));
  const span = hi - lo || 1;
  const y = (v: number) => padT + innerH - ((v - lo) / span) * innerH;
  const slot = innerW / groups.length;
  const barsPer = groups[0].bars.length;
  const gap = Math.min(6, slot * 0.12);
  const bw = Math.max(3, (slot - gap * 2 - (barsPer - 1) * 2) / barsPer);
  const ticks = niceTicks(lo, hi);

  return (
    <div ref={ref} className="chart-wrap" style={{ height }}>
      <svg width="100%" height={height} style={{ display: "block", overflow: "visible" }} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} />
            <text className="axis-text" x={padL - 8} y={y(t) + 3.5} textAnchor="end">{fmt0(t, { compact: true })}</text>
          </g>
        ))}
        {groups.map((g, gi) => {
          const gx = padL + gi * slot;
          return (
            <g key={g.label + gi}
              onMouseEnter={() => setHover(gi)}
              onClick={() => onClickGroup?.(g.label)}
              style={{ cursor: onClickGroup ? "pointer" : "default" }}
            >
              <rect x={gx} y={padT} width={slot} height={innerH} fill={hover === gi ? color("--surface-2") : "transparent"} />
              {g.bars.map((b, bi) => {
                const bx = gx + gap + bi * (bw + 2);
                const top = b.value >= 0 ? y(b.value) : y(0);
                const h = Math.max(1, Math.abs(y(b.value) - y(0)));
                return <rect key={b.key} x={bx} y={top} width={bw} height={h} rx={Math.min(3, bw / 2)} fill={color(b.tone)} />;
              })}
              {compact || gi % Math.ceil(groups.length / Math.max(2, Math.floor(innerW / 58))) === 0 ? (
                <text className="axis-text" x={gx + slot / 2} y={height - 6} textAnchor="middle">{g.label}</text>
              ) : null}
            </g>
          );
        })}
        {lo < 0 ? <line x1={padL} x2={padL + innerW} y1={y(0)} y2={y(0)} stroke={color("--line")} strokeWidth={1} /> : null}
      </svg>
      {hover !== null ? (
        <Tip x={padL + hover * slot + slot / 2} y={padT + 8} width={w}>
          <div className="tiny muted" style={{ marginBottom: 3 }}>{groups[hover].label}</div>
          {groups[hover].bars.map((b) => (
            <div key={b.key} className="row" style={{ gap: 6, justifyContent: "space-between" }}>
              <span className="row" style={{ gap: 5 }}>
                <span className="dot" style={{ background: color(b.tone) }} />
                <span className="tiny">{b.key}</span>
              </span>
              <span className="num tiny bold">{fmt0(b.value)}</span>
            </div>
          ))}
        </Tip>
      ) : null}
    </div>
  );
}

/* ── donut ────────────────────────────────────────────────────────────── */

export interface Slice { label: string; value: number; tone: string }

export function Donut({ slices, size = 170, thickness = 22, center }: {
  slices: Slice[]; size?: number; thickness?: number; center?: ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = size / 2 - thickness / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="row donut-wrap" style={{ gap: 18, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          {total === 0 ? (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color("--surface-3")} strokeWidth={thickness} />
          ) : slices.map((s, i) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={color(s.tone)} strokeWidth={hover === i ? thickness + 4 : thickness}
                strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                style={{ transition: "stroke-width .1s" }}
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
          {hover !== null && slices[hover] ? (
            <div className="col" style={{ gap: 0 }}>
              <span className="tiny muted">{slices[hover].label}</span>
              <span className="num bold">{fmt0(slices[hover].value)}</span>
              <span className="tiny faint">{((slices[hover].value / total) * 100).toFixed(0)}%</span>
            </div>
          ) : center}
        </div>
      </div>
      <div className="col donut-key" style={{ gap: 7 }}>
        {slices.map((s, i) => (
          <div key={s.label} className="row" style={{ gap: 8 }} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="dot" style={{ background: color(s.tone) }} />
            <span className="grow truncate small">{s.label}</span>
            <span className="num small bold">{fmt0(s.value)}</span>
            <span className="num tiny faint" style={{ width: 34, textAlign: "right" }}>
              {total ? ((s.value / total) * 100).toFixed(0) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── sankey ───────────────────────────────────────────────────────────── */

export interface SankeyInput {
  nodes: { id: string; label: string; value: number; color: string; depth: number }[];
  links: { source: string; target: string; value: number }[];
}

/**
 * A label cut to the room it has, in an ellipsis.
 *
 * SVG text neither wraps nor truncates, so a long category name simply runs
 * off the side of the card — which is what "Mortgage Payment" did the moment
 * the sankey could be cut by category rather than only by group. Measured in
 * characters against an average width, which is close enough for a label whose
 * job is to be recognised rather than read.
 */
function clip(text: string, px: number): string {
  const max = Math.max(4, Math.floor(px / 6.2));
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function Sankey({ data, height = 320, minWidth = 0 }: {
  data: SankeyInput;
  height?: number;
  /**
   * A floor on the width to lay out at, whatever the container measures.
   *
   * Three columns of labelled bands do not fit a phone, and squeezing them in
   * gives three columns of nothing legible. Given a floor wider than the
   * screen, the diagram is drawn at its comfortable size and the container
   * scrolls sideways — one column at a time, which is how it is read anyway.
   */
  minWidth?: number;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const w = Math.max(measured, minWidth);
  const [hover, setHover] = useState<string | null>(null);
  const depths = [0, 1, 2];
  const nodeW = 12;
  const padY = 8;
  // The gutters give way before the diagram does. Fixing them at 120px and
  // then forcing a minimum width on what was left pushed the right-hand
  // column past the edge of its own card on a phone, and its labels with it.
  const labelW = Math.max(44, Math.min(120, (w - 120) / 2));
  const innerW = Math.max(60, w - labelW * 2);
  if (!data.nodes.length) return <div ref={ref} style={{ height }} />;

  const byDepth = depths.map((d) => data.nodes.filter((n) => n.depth === d));
  const columnTotal = byDepth.map((col) => col.reduce((s, n) => s + n.value, 0));
  const maxTotal = Math.max(...columnTotal, 1);
  const scale = (height - padY * 2 - 8 * Math.max(...byDepth.map((c) => c.length), 1)) / maxTotal;

  const pos = new Map<string, { x: number; y: number; h: number }>();
  byDepth.forEach((col, d) => {
    const total = col.reduce((s, n) => s + n.value * scale + 8, 0) - 8;
    let y = padY + (height - padY * 2 - total) / 2;
    for (const n of col) {
      const h = Math.max(2, n.value * scale);
      pos.set(n.id, { x: labelW + (innerW - nodeW) * (d / 2), y, h });
      y += h + 8;
    }
  });

  const cursor = new Map<string, number>();
  const ribbons = data.links.map((l, i) => {
    const s = pos.get(l.source);
    const t = pos.get(l.target);
    if (!s || !t) return null;
    const sh = Math.max(1, l.value * scale);
    const so = cursor.get(`s${l.source}`) ?? 0;
    const to = cursor.get(`t${l.target}`) ?? 0;
    cursor.set(`s${l.source}`, so + sh);
    cursor.set(`t${l.target}`, to + sh);
    const x1 = s.x + nodeW;
    const x2 = t.x;
    const y1 = s.y + so;
    const y2 = t.y + to;
    const mx = (x1 + x2) / 2;
    const tone = data.nodes.find((n) => n.id === (l.source === "hub" ? l.target : l.source))?.color ?? "--c1";
    const on = hover === null || hover === l.source || hover === l.target;
    return (
      <path
        key={i}
        d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2} L${x2},${y2 + sh} C${mx},${y2 + sh} ${mx},${y1 + sh} ${x1},${y1 + sh} Z`}
        fill={color(tone)} opacity={on ? 0.24 : 0.06}
      />
    );
  });

  // Laid out wider than it was given: the container scrolls, and each column
  // gets a snap point so a swipe lands on the next one rather than between two.
  const scrolls = w > measured;
  return (
    <div ref={ref} className={scrolls ? "chart-wrap sankey-scroll" : "chart-wrap"} style={{ height }}>
      <div style={{ position: "relative", width: w, height }}>
      {scrolls ? depths.map((d) => (
        <span
          key={`snap${d}`} className="sankey-snap"
          style={{ left: Math.max(0, labelW + (innerW - nodeW) * (d / 2) - (d === 2 ? 4 : labelW + 4)) }}
        />
      )) : null}
      <svg width={w} height={height} style={{ display: "block", overflow: "visible" }}>
        {ribbons}
        {data.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const rightSide = n.depth === 2;
          return (
            <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
              <rect x={p.x} y={p.y} width={nodeW} height={p.h} rx={3} fill={color(n.color)} />
              {p.h >= 9 ? (
                <text
                  className="axis-text" x={rightSide ? p.x + nodeW + 8 : p.x - 8}
                  y={p.y + p.h / 2 + (p.h >= 26 ? -2 : 4)}
                  textAnchor={rightSide ? "start" : "end"} fill={color("--muted")} style={{ fontSize: 11.5 }}
                >
                  {clip(n.label, labelW - 10)}
                </text>
              ) : null}
              {p.h >= 26 ? (
                <text
                  className="axis-text" x={rightSide ? p.x + nodeW + 8 : p.x - 8} y={p.y + p.h / 2 + 11}
                  textAnchor={rightSide ? "start" : "end"}
                >
                  {fmt0(n.value, { compact: true })}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}

/* ── small pieces ─────────────────────────────────────────────────────── */

export function Sparkline({ values, tone = "--accent", width = 88, height = 26, baseline = false }: {
  values: number[]; tone?: string; width?: number; height?: number; baseline?: boolean;
}) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const y = (v: number) => height - ((v - lo) / span) * (height - 4) - 2;
  const d = values.map((v, i) => `${i ? "L" : "M"}${(i / (values.length - 1)) * width},${y(v)}`).join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {/* where the period started, so the shape reads as up or down at a glance */}
      {baseline ? (
        <line
          className="spark-baseline"
          x1={0} x2={width} y1={y(values[0])} y2={y(values[0])}
          stroke={color("--faint")} strokeWidth={1} strokeDasharray="2 3" opacity={0.75}
        />
      ) : null}
      <path d={d} fill="none" stroke={color(tone)} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Ranked horizontal bars — the category/merchant breakdown list. */
export function HBars({ rows, onClick }: {
  rows: { label: string; value: number; tone: string; icon?: string; sub?: string }[];
  onClick?: (label: string) => void;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="col" style={{ gap: 11 }}>
      {rows.map((r) => (
        <div
          key={r.label} className="col" style={{ gap: 5, cursor: onClick ? "pointer" : undefined }}
          onClick={() => onClick?.(r.label)}
        >
          <div className="spread">
            <span className="row" style={{ gap: 7, minWidth: 0 }}>
              {r.icon ? <span style={{ fontSize: 13 }}>{r.icon}</span> : <span className="dot" style={{ background: color(r.tone) }} />}
              <span className="truncate small">{r.label}</span>
              {r.sub ? <span className="tiny faint nowrap">{r.sub}</span> : null}
            </span>
            <span className="num small bold nowrap">{fmt0(r.value)}</span>
          </div>
          <div className="bar" style={{ height: 6 }}>
            <i style={{ width: `${(r.value / max) * 100}%`, background: color(r.tone) }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Month-grid calendar used by Recurring. */
export function MonthGrid({ year, month, marks, onPick }: {
  year: number; month: number;
  /** `to` makes the name a way in, for a mark that stands for something with
   *  a page of its own; `paid` swaps its dot for a tick. */
  marks: Record<number, { tone: string; amount: number; label: string; to?: string; paid?: boolean }[]>;
  onPick?: (day: number) => void;
}) {
  const first = new Date(year, month - 1, 1).getDay();
  const days = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div>
      <div className="cal-grid" style={{ marginBottom: 6 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="tiny faint center">{d}</div>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((day, i) => (
          <div
            key={i}
            className={cx("cal-cell", Boolean(day && marks[day]?.length) && "on")}
            onMouseEnter={() => day && setHover(day)}
            onMouseLeave={() => setHover(null)}
            onClick={() => day && onPick?.(day)}
          >
            {day ? <div className="tiny faint num">{day}</div> : null}
            {/* Dots on a narrow screen, names once the cell is wide enough to
                hold one: a full-width calendar that says only "something is
                due" wastes the width it was given. */}
            <div className="cal-marks">
              {(day && marks[day] ? marks[day] : []).slice(0, 4).map((m, j) => (
                m.paid
                  ? <Check key={j} size={10} className="cal-tick" strokeWidth={3.5} />
                  : <span key={j} className="dot" style={{ background: color(m.tone), width: 6, height: 6 }} />
              ))}
            </div>
            <div className="cal-names">
              {(day && marks[day] ? marks[day] : []).slice(0, 3).map((m, j) => {
                const body = (
                  <>
                    {/* A tick where the dot would be: the dot says a bill is
                        due on this day, and once the money has actually gone
                        that is no longer the news. */}
                    {m.paid
                      ? <Check size={11} className="cal-tick" strokeWidth={3} />
                      /* Seven rather than five: the smaller a round dot is
                         the more of it is antialiased edge, and an edge is
                         half the cell behind it, so a colour arrives washed
                         out at the size it is least able to afford it. */
                      : <span className="dot" style={{ background: color(m.tone), width: 7, height: 7 }} />}
                    {/* Wrapped, not clipped: the cell has the height for a
                        second line, and a name cut to "Bright Horiz…" is one
                        you have to hover to read. */}
                    <span className="cal-name-text">{m.label}</span>
                  </>
                );
                const title = `${m.label} ${fmt0(m.amount)}${m.paid ? " · paid" : ""}`;
                return m.to
                  ? <Link key={j} to={m.to} className="cal-name click" title={title}>{body}</Link>
                  : <span key={j} className="cal-name" title={title}>{body}</span>;
              })}
              {day && (marks[day]?.length ?? 0) > 3 ? (
                <span className="tiny faint">+{marks[day]!.length - 3} more</span>
              ) : null}
            </div>
            {hover === day && day && marks[day]?.length ? (
              <div className="chart-tip" style={{ left: 0, top: 44, minWidth: 150 }}>
                {marks[day].map((m, j) => (
                  <div key={j} className="spread" style={{ gap: 10 }}>
                    <span className="tiny truncate">{m.label}</span>
                    <span className="num tiny bold">{fmt0(m.amount)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
