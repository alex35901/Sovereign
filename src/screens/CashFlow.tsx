import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { lastMonths, monthEnd, monthLabel, monthStart } from "../lib/date";
import { fmtPct, pct } from "../lib/money";
import { cashFlowSeries, categoryTotals, merchantTotals, sankeyData } from "../lib/select";
import { BarChart, HBars, Sankey } from "../components/charts";
import { Card, CardHead, Empty, Money, Tile } from "../components/ui";
import { RangePicker, rangeMonths } from "../components/pickers";
import type { RangeKey } from "../components/pickers";

export default function CashFlow() {
  const db = useDB();
  const [range, setRange] = useState<RangeKey>("6m");
  const months = useMemo(() => lastMonths(rangeMonths(range)), [range]);
  const from = monthStart(months[0]);
  const to = monthEnd(months[months.length - 1]);

  const flow = useMemo(() => cashFlowSeries(db, months), [db, months]);
  const income = flow.reduce((s, f) => s + f.income, 0);
  const expense = flow.reduce((s, f) => s + f.expense, 0);
  const saved = income - expense;

  const expenseCats = useMemo(() => categoryTotals(db, from, to, "expense"), [db, from, to]);
  const incomeCats = useMemo(() => categoryTotals(db, from, to, "income"), [db, from, to]);
  const merchants = useMemo(() => merchantTotals(db, from, to, 8), [db, from, to]);
  const sankey = useMemo(() => sankeyData(db, from, to), [db, from, to]);

  const avgMonths = Math.max(1, months.length);

  return (
    <>
      <TopBar title="Cash Flow" actions={<RangePicker value={range} onChange={setRange} />} />
      <div className="page stack">
        <div className="grid g4">
          <Tile label="Income" value={<Money value={income} cents={false} />} tone="pos"
            sub={<span className="muted"><Money value={Math.round(income / avgMonths)} cents={false} />/mo avg</span>} />
          <Tile label="Expenses" value={<Money value={expense} cents={false} />} tone="neg"
            sub={<span className="muted"><Money value={Math.round(expense / avgMonths)} cents={false} />/mo avg</span>} />
          <Tile label="Saved" value={<Money value={saved} cents={false} />} tone={saved >= 0 ? "pos" : "neg"} />
          <Tile label="Savings rate" value={<span className={saved >= 0 ? "pos" : "neg"}>{fmtPct(pct(saved, income || 1), 0)}</span>}
            sub={<span className="muted">of income kept</span>} />
        </div>

        <Card>
          <CardHead title="Income vs. spending" sub={`${monthLabel(months[0], true)} — ${monthLabel(months[months.length - 1], true)}`} />
          <BarChart
            height={250}
            groups={flow.map((f) => ({
              label: monthLabel(f.month, true),
              bars: [
                { key: "Income", value: f.income, tone: "--c3" },
                { key: "Expenses", value: f.expense, tone: "--c9" },
                { key: "Saved", value: f.net, tone: "--c2" },
              ],
            }))}
          />
        </Card>

        <Card>
          <CardHead title="Where the money flows" sub="Income sources on the left, spending groups on the right" />
          {sankey.nodes.length > 1 ? <Sankey data={sankey} height={Math.max(300, sankey.nodes.length * 26)} /> : <Empty title="Not enough data yet" />}
        </Card>

        <div className="grid g2">
          <Card>
            <CardHead
              title="Spending by category" sub={`${expenseCats.length} categories`}
              right={<Link to="/reports" className="link small">Reports</Link>}
            />
            {expenseCats.length ? (
              <HBars rows={expenseCats.slice(0, 12).map((c) => ({
                label: c.category.name, value: c.total, tone: c.category.color, icon: c.category.icon,
                sub: `${Math.round((c.total / (expense || 1)) * 100)}%`,
              }))} />
            ) : <Empty title="No spending in range" />}
          </Card>

          <div className="stack">
            <Card>
              <CardHead title="Income sources" />
              {incomeCats.length ? (
                <HBars rows={incomeCats.map((c) => ({
                  label: c.category.name, value: c.total, tone: c.category.color, icon: c.category.icon,
                }))} />
              ) : <Empty title="No income in range" />}
            </Card>
            <Card>
              <CardHead title="Top merchants" />
              {merchants.length ? (
                <HBars rows={merchants.map((m) => ({
                  label: m.merchant, value: m.total, tone: "--c1", sub: `${m.count}×`,
                }))} />
              ) : <Empty title="No merchants in range" />}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
