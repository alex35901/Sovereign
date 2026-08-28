import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fmt0 } from "../lib/money";
import { color } from "./ui";

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

export function AreaChart({ points, height = 190, tone = "--accent", negativeTone = "--neg", zeroBase = false }: {
  points: Point[]; height?: number; tone?: string; negativeTone?: string; zeroBase?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const raw = useId();
  const uid = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (!points.length) return <div ref={ref} style={{ height }} />;

  const padL = 52;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const innerW = Math.max(40, w - padL - padR);
  const innerH = height - padT - padB;
  const values = points.map((p) => p.value);
  const hasNegative = values.some((v) => v < 0);
  // A debt line is only meaningful against zero — the filled distance from the
  // axis down to the balance is the point of the chart.
  const anchorZero = zeroBase || hasNegative;
  let lo = Math.min(...values, anchorZero ? 0 : Infinity);
  let hi = Math.max(...values, anchorZero ? 0 : -Infinity);
  if (lo === hi) { lo -= 100; hi += 100; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - lo) / (hi - lo)) * innerH;

  const zeroY = Math.max(padT, Math.min(padT + innerH, y(0)));
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  // Fill to the zero axis rather than the floor of the plot, so a negative
  // series paints the band between 0 and the balance instead of a thin sliver.
  const area = `${line} L${x(points.length - 1).toFixed(1)},${zeroY} L${x(0).toFixed(1)},${zeroY} Z`;
  const ticks = niceTicks(lo, hi);
  const showZeroLine = hasNegative && hi > 0;

  return (
    <div ref={ref} className="chart-wrap" style={{ height }}>
      <svg
        width="100%" height={height} style={{ display: "block", overflow: "visible" }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rel = e.clientX - rect.left - padL;
          const i = Math.round((rel / innerW) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
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

        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} />
            <text className="axis-text" x={padL - 8} y={y(t) + 3.5} textAnchor="end">{fmt0(t, { compact: true })}</text>
          </g>
        ))}

        <path d={area} fill={`url(#up-${uid})`} clipPath={`url(#above-${uid})`} />
        <path d={area} fill={`url(#dn-${uid})`} clipPath={`url(#below-${uid})`} />
        <path d={line} fill="none" stroke={color(tone)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#above-${uid})`} />
        <path d={line} fill="none" stroke={color(negativeTone)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#below-${uid})`} />

        {showZeroLine ? (
          <line x1={padL} x2={padL + innerW} y1={zeroY} y2={zeroY} stroke={color("--muted")} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
        ) : null}

        {points.map((p, i) =>
          i % Math.ceil(points.length / Math.max(2, Math.floor(innerW / 62))) === 0 ? (
            <text key={p.label + i} className="axis-text" x={x(i)} y={height - 6} textAnchor="middle">{p.label}</text>
          ) : null)}

        {hover !== null ? (
          <g>
            <line className="grid-line" x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} stroke={color("--line")} />
            <circle
              cx={x(hover)} cy={y(points[hover].value)} r={4}
              fill={color(points[hover].value < 0 ? negativeTone : tone)}
              stroke={color("--surface")} strokeWidth={2}
            />
          </g>
        ) : null}
      </svg>
      {hover !== null ? (
        <Tip x={x(hover)} y={y(points[hover].value)} width={w}>
          <div className="tiny muted">{points[hover].label}</div>
          <div className={`num bold ${points[hover].value < 0 ? "neg" : ""}`}>{fmt0(points[hover].value)}</div>
          {points[hover].sub ? <div className="tiny muted">{points[hover].sub}</div> : null}
        </Tip>
      ) : null}
    </div>
  );
}

/* ── bars ─────────────────────────────────────────────────────────────── */

export interface BarGroup { label: string; bars: { key: string; value: number; tone: string }[]; }

export function BarChart({ groups, height = 200, showZero = true, onClickGroup }: {
  groups: BarGroup[]; height?: number; showZero?: boolean; onClickGroup?: (label: string) => void;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (!groups.length) return <div ref={ref} style={{ height }} />;

  const padL = 52;
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
              {gi % Math.ceil(groups.length / Math.max(2, Math.floor(innerW / 58))) === 0 ? (
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
    <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
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
      <div className="col grow" style={{ gap: 7, minWidth: 150 }}>
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

export function Sankey({ data, height = 320 }: { data: SankeyInput; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const depths = [0, 1, 2];
  const nodeW = 12;
  const padY = 8;
  const labelW = 120;
  const innerW = Math.max(200, w - labelW * 2);
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

  return (
    <div ref={ref} className="chart-wrap" style={{ height }}>
      <svg width="100%" height={height} style={{ display: "block", overflow: "visible" }}>
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
                  {n.label}
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
  );
}

/* ── small pieces ─────────────────────────────────────────────────────── */

export function Sparkline({ values, tone = "--accent", width = 88, height = 26 }: {
  values: number[]; tone?: string; width?: number; height?: number;
}) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const d = values
    .map((v, i) => `${i ? "L" : "M"}${(i / (values.length - 1)) * width},${height - ((v - lo) / span) * (height - 4) - 2}`)
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
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
  marks: Record<number, { tone: string; amount: number; label: string }[]>;
  onPick?: (day: number) => void;
}) {
  const first = new Date(year, month - 1, 1).getDay();
  const days = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 6 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="tiny faint center">{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((day, i) => (
          <div
            key={i}
            onMouseEnter={() => day && setHover(day)}
            onMouseLeave={() => setHover(null)}
            onClick={() => day && onPick?.(day)}
            style={{
              minHeight: 46, borderRadius: 8, padding: "4px 5px",
              background: day && marks[day]?.length ? "var(--surface-2)" : "transparent",
              border: `1px solid ${day && marks[day]?.length ? "var(--line)" : "transparent"}`,
              position: "relative", cursor: day && marks[day]?.length ? "default" : undefined,
            }}
          >
            {day ? <div className="tiny faint num">{day}</div> : null}
            <div className="row" style={{ gap: 2, flexWrap: "wrap", marginTop: 2 }}>
              {(day && marks[day] ? marks[day] : []).slice(0, 4).map((m, j) => (
                <span key={j} className="dot" style={{ background: color(m.tone), width: 6, height: 6 }} />
              ))}
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
