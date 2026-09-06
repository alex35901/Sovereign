import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { lastMonths, monthEnd, monthLabel, monthOf, monthStart } from "../lib/date";
import { fmt0 } from "../lib/money";
import { cashFlowSeries } from "../lib/select";
import { breakdown, flowBuckets, sankeyData, summarise } from "../lib/reports";
import type { Facet, Grain, Side, Slice } from "../lib/reports";
import { Donut, FlowChart, Sankey } from "../components/charts";
import { Card, CardHead, Empty, Money, Segmented, SelectInput, color, cx } from "../components/ui";
import { RangePicker } from "../components/pickers";
import type { RangeKey } from "../lib/range";
import { rangeMonths } from "../lib/range";

type Tab = "flow" | "spending" | "income";
type Shape = "bar" | "sankey";

/** How many rows the legend shows before it has to be asked for the rest. */
const LEGEND = 6;

export default function Reports() {
  const db = useDB();
  const [tab, setTab] = useState<Tab>("flow");
  const [range, setRange] = useState<RangeKey>("1y");
  const [shape, setShape] = useState<Shape>("bar");
  const [grain, setGrain] = useState<Grain>("monthly");
  const [facet, setFacet] = useState<Facet>("category");

  const earliestMonth = useMemo(() => {
    const dates = db.transactions.map((t) => t.date);
    return dates.length ? monthOf(dates.reduce((a, b) => (a < b ? a : b))) : undefined;
  }, [db.transactions]);
  const months = useMemo(() => {
    // a five-year window on two years of data should show two years, not three
    // years of empty buckets
    const window = lastMonths(rangeMonths(range, earliestMonth));
    const clamped = earliestMonth ? window.filter((m) => m >= earliestMonth) : window;
    return clamped.length ? clamped : window.slice(-1);
  }, [range, earliestMonth]);
  const from = monthStart(months[0]);
  const to = monthEnd(months[months.length - 1]);
  const span = `${monthLabel(months[0])} — ${monthLabel(months[months.length - 1])}`;

  return (
    <>
      <TopBar title="Reports" actions={<RangePicker value={range} onChange={setRange} />} />
      <div className="page stack">
        <Segmented
          value={tab} onChange={setTab} spread
          options={[
            { value: "flow", label: "Cash Flow" },
            { value: "spending", label: "Spending" },
            { value: "income", label: "Income" },
          ]}
        />

        {tab === "flow" ? (
          <FlowTab
            from={from} to={to} months={months} span={span}
            shape={shape} onShape={setShape}
            grain={grain} onGrain={setGrain}
            facet={facet} onFacet={setFacet}
          />
        ) : (
          <SideTab side={tab === "income" ? "income" : "expense"} from={from} to={to} span={span} />
        )}
      </div>
    </>
  );
}

/* ── cash flow ────────────────────────────────────────────────────────── */

function FlowTab({ from, to, months, span, shape, onShape, grain, onGrain, facet, onFacet }: {
  from: string; to: string; months: string[]; span: string;
  shape: Shape; onShape: (s: Shape) => void;
  grain: Grain; onGrain: (g: Grain) => void;
  facet: Facet; onFacet: (f: Facet) => void;
}) {
  const db = useDB();
  const flow = useMemo(() => cashFlowSeries(db, months), [db, months]);
  const buckets = useMemo(
    () => flowBuckets(flow, grain).map((b) => ({
      ...b, label: grain === "monthly" ? monthLabel(b.key, true) : b.key,
    })),
    [flow, grain],
  );
  const sankey = useMemo(() => sankeyData(db, from, to, facet), [db, from, to, facet]);

  const income = flow.reduce((s, f) => s + f.income, 0);
  const expense = flow.reduce((s, f) => s + f.expense, 0);

  return (
    <>
      <Card>
        <div className="row wrap report-controls" style={{ gap: 12, marginBottom: 14 }}>
          <label className="field">
            <span>Chart</span>
            <SelectInput
              value={shape} onChange={(v) => onShape(v as Shape)}
              options={[{ value: "bar", label: "Bar" }, { value: "sankey", label: "Sankey" }]}
            />
          </label>
          {/* Each chart takes one further question, and only its own: a grain
              means nothing to a sankey, and a grouping means nothing to bars
              already bucketed by time. */}
          {shape === "bar" ? (
            <label className="field">
              <span>Timeframe</span>
              <SelectInput
                value={grain} onChange={(v) => onGrain(v as Grain)}
                options={[{ value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }]}
              />
            </label>
          ) : (
            <label className="field">
              <span>Group by</span>
              <SelectInput
                value={facet} onChange={(v) => onFacet(v as Facet)}
                options={[
                  { value: "category", label: "Category" },
                  { value: "group", label: "Category group" },
                  { value: "merchant", label: "Merchant" },
                ]}
              />
            </label>
          )}
        </div>

        {shape === "bar" ? (
          buckets.length ? <FlowChart buckets={buckets} height={260} /> : <Empty title="Nothing in this period" />
        ) : (
          sankey.nodes.length > 1
            ? (
              <Sankey
                data={sankey} height={Math.max(320, sankey.nodes.length * 30)}
                /* Below this the three columns and their labels stop being
                   readable, so the diagram keeps its size and the card
                   scrolls sideways instead. */
                minWidth={640}
              />
            )
            : <Empty title="Not enough to draw a flow" body="It needs both money coming in and money going out." />
        )}
      </Card>

      <Card>
        <CardHead title="Summary" sub={span} />
        <div className="col" style={{ gap: 0 }}>
          <SumRow label="Total income" value={income} tone="pos" />
          <SumRow label="Total expenses" value={expense} tone="neg" />
          <SumRow label="Savings" value={income - expense} tone={income - expense >= 0 ? "pos" : "neg"} />
        </div>
      </Card>

      <BreakdownCard title="Income" side="income" from={from} to={to} />
      <BreakdownCard title="Expenses" side="expense" from={from} to={to} />
    </>
  );
}

function SumRow({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="spread report-sum">
      <span>{label}</span>
      <span className={cx("num bold", tone)}><Money value={value} /></span>
    </div>
  );
}

/**
 * One side of the ledger, ranked, with the bar behind each row showing its
 * share of the whole — which is the comparison the figure alone cannot make.
 */
function BreakdownCard({ title, side, from, to }: { title: string; side: Side; from: string; to: string }) {
  const db = useDB();
  const [facet, setFacet] = useState<Facet>("category");
  const [all, setAll] = useState(false);
  const rows = useMemo(() => breakdown(db, from, to, side, facet), [db, from, to, side, facet]);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const shown = all ? rows : rows.slice(0, 6);

  return (
    <Card pad={false}>
      <div className="dash-card-head">
        <div className="spread">
          <h2>{title}</h2>
          <span className="num bold"><Money value={total} cents={false} /></span>
        </div>
        <Segmented
          value={facet} onChange={setFacet} spread
          options={[
            { value: "category", label: "Category" },
            { value: "group", label: "Group" },
            { value: "merchant", label: "Merchant" },
          ]}
        />
      </div>
      {shown.map((r) => <Row key={r.key} row={r} total={total} side={side} />)}
      {!rows.length ? <Empty title={`No ${side === "income" ? "income" : "spending"} in this period`} /> : null}
      {rows.length > 6 ? (
        <div style={{ padding: 12 }}>
          <button className="btn view-all" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </button>
        </div>
      ) : null}
    </Card>
  );
}

function Row({ row, total, side }: { row: Slice; total: number; side: Side }) {
  const share = total > 0 ? row.total / total : 0;
  const body = (
    <>
      {/* The share, drawn behind the row rather than beside it, so the name
          and the figure keep the full width they need. */}
      <span
        className="report-fill"
        style={{ width: `${share * 100}%`, background: color(side === "income" ? "--pos-soft" : "--neg-soft") }}
      />
      <span className="report-row-body">
        {row.icon ? <span style={{ fontSize: 15 }}>{row.icon}</span> : <span className="dot" style={{ background: color(row.tone) }} />}
        <span className="grow truncate" style={{ fontWeight: 500 }}>{row.label}</span>
        <span className="num bold"><Money value={row.total} cents={false} /></span>
        <span className="tiny faint report-share">{fmtShare(share)}</span>
        {row.to ? <ChevronRight size={14} className="faint" /> : <span style={{ width: 14 }} />}
      </span>
    </>
  );
  return row.to
    ? <Link to={row.to} className="report-row click">{body}</Link>
    : <div className="report-row">{body}</div>;
}

const fmtShare = (share: number): string => {
  const p = share * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
};

/* ── spending and income ──────────────────────────────────────────────── */

function SideTab({ side, from, to, span }: { side: Side; from: string; to: string; span: string }) {
  const db = useDB();
  const [facet, setFacet] = useState<Facet>("category");
  const [all, setAll] = useState(false);
  const rows = useMemo(() => breakdown(db, from, to, side, facet), [db, from, to, side, facet]);
  const sum = useMemo(() => summarise(db, from, to, side), [db, from, to, side]);

  /**
   * The ring and its key, with the long tail folded into one band.
   *
   * Folded rather than dropped: thirty categories is a fringe of hairlines and
   * a key nobody reads, but a ring whose slices do not add up to the figure in
   * the middle of it is worse than either. The fold is labelled, so the money
   * is still on the chart and still accounted for.
   */
  const slices = useMemo(() => {
    if (all || rows.length <= LEGEND + 1) {
      return rows.map((r) => ({ label: r.label, value: r.total, tone: r.tone }));
    }
    const head = rows.slice(0, LEGEND);
    const tail = rows.slice(LEGEND).reduce((s, r) => s + r.total, 0);
    return [
      ...head.map((r) => ({ label: r.label, value: r.total, tone: r.tone })),
      { label: `Everything else (${rows.length - LEGEND})`, value: tail, tone: "--c12" },
    ];
  }, [rows, all]);

  return (
    <>
      <Card>
        <div className="row wrap report-controls" style={{ gap: 12, marginBottom: 14 }}>
          <label className="field">
            <span>Display by</span>
            <SelectInput
              value={facet} onChange={(v) => setFacet(v as Facet)}
              options={[
                { value: "category", label: "Category" },
                { value: "group", label: "Category group" },
                { value: "merchant", label: "Merchant" },
              ]}
            />
          </label>
        </div>

        {rows.length ? (
          <>
            <Donut size={210} slices={slices} center={
              <div className="col" style={{ gap: 0, alignItems: "center" }}>
                <span className="num bold" style={{ fontSize: 20 }}><Money value={sum.total} cents={false} /></span>
                <span className="tiny muted">Total</span>
              </div>
            } />
            {rows.length > LEGEND ? (
              <button className="btn btn-ghost report-more" onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${rows.length}`}
              </button>
            ) : null}
          </>
        ) : <Empty title={`No ${side === "income" ? "income" : "spending"} in this period`} />}
      </Card>

      <Card>
        <CardHead title="Summary" sub={span} />
        <div className="col" style={{ gap: 0 }}>
          <SumRow
            label={side === "income" ? "Total income" : "Total spending"}
            value={sum.total} tone={side === "income" ? "pos" : "neg"}
          />
          <div className="spread report-sum">
            <span>Total transactions</span>
            <span className="num bold">{sum.count.toLocaleString()}</span>
          </div>
          <div className="spread report-sum">
            <span>Largest transaction</span>
            <span className="num bold">{fmt0(sum.largest)}</span>
          </div>
          <div className="spread report-sum">
            <span>Average transaction</span>
            <span className="num bold">{fmt0(sum.average)}</span>
          </div>
        </div>
      </Card>

      <BreakdownCard title={side === "income" ? "Income" : "Expenses"} side={side} from={from} to={to} />
    </>
  );
}
