import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { lastMonths, monthEnd, monthLabel, monthOf, monthStart } from "../lib/date";
import { fmt0 } from "../lib/money";
import { categoryKind, cashFlowSeries, categoryTotals, lines, merchantTotals, netWorthSeries } from "../lib/select";
import { AreaChart, BarChart, Donut, HBars, Sparkline } from "../components/charts";
import { Card, CardHead, Empty, Money, Segmented } from "../components/ui";
import { RangePicker, rangeMonths } from "../components/pickers";
import type { RangeKey } from "../components/pickers";

type Tab = "spending" | "income" | "savings" | "networth";
type GroupBy = "category" | "group" | "merchant" | "account";

export default function Reports() {
  const db = useDB();
  const [tab, setTab] = useState<Tab>("spending");
  const [range, setRange] = useState<RangeKey>("6m");
  const [groupBy, setGroupBy] = useState<GroupBy>("category");

  const months = useMemo(() => lastMonths(rangeMonths(range)), [range]);
  const from = monthStart(months[0]);
  const to = monthEnd(months[months.length - 1]);

  const flow = useMemo(() => cashFlowSeries(db, months), [db, months]);
  const netWorth = useMemo(() => netWorthSeries(db, months), [db, months]);

  /** Rows for the active tab, with a per-month series for the sparkline column. */
  const rows = useMemo(() => {
    const wantIncome = tab === "income";
    if (groupBy === "merchant") {
      return merchantTotals(db, from, to, 25).map((m) => ({
        key: m.merchant, label: m.merchant, tone: "--c1", icon: undefined as string | undefined,
        total: m.total, count: m.count,
        series: months.map((mo) =>
          db.transactions
            .filter((t) => t.merchant === m.merchant && monthOf(t.date) === mo && t.amount < 0)
            .reduce((s, t) => s + -t.amount, 0)),
      }));
    }
    if (groupBy === "account") {
      return db.accounts.filter((a) => !a.hidden).map((a) => {
        const txns = db.transactions.filter(
          (t) => t.accountId === a.id && t.date >= from && t.date <= to && !t.hideFromReports &&
            categoryKind(db, t.categoryId) !== "transfer" && (wantIncome ? t.amount > 0 : t.amount < 0));
        return {
          key: a.id, label: a.name, tone: "--c2", icon: undefined as string | undefined,
          total: txns.reduce((s, t) => s + Math.abs(t.amount), 0), count: txns.length,
          series: months.map((mo) =>
            txns.filter((t) => monthOf(t.date) === mo).reduce((s, t) => s + Math.abs(t.amount), 0)),
        };
      }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
    }
    const cats = categoryTotals(db, from, to, wantIncome ? "income" : "expense");
    if (groupBy === "group") {
      const byGroup = new Map<string, { total: number; count: number; tone: string }>();
      for (const c of cats) {
        const cur = byGroup.get(c.category.groupId) ?? { total: 0, count: 0, tone: c.category.color };
        cur.total += c.total;
        cur.count += c.count;
        byGroup.set(c.category.groupId, cur);
      }
      return [...byGroup.entries()].map(([gid, v]) => {
        const catIds = new Set(db.categories.filter((c) => c.groupId === gid).map((c) => c.id));
        return {
          key: gid, label: db.groups.find((g) => g.id === gid)?.name ?? gid, tone: v.tone,
          icon: undefined as string | undefined, total: v.total, count: v.count,
          series: months.map((mo) =>
            db.transactions
              .filter((t) => monthOf(t.date) === mo && !t.hideFromReports)
              .flatMap(lines)
              .filter((l) => catIds.has(l.categoryId) && (wantIncome ? l.amount > 0 : l.amount < 0))
              .reduce((s, l) => s + Math.abs(l.amount), 0)),
        };
      }).sort((a, b) => b.total - a.total);
    }
    return cats.map((c) => ({
      key: c.categoryId, label: c.category.name, tone: c.category.color, icon: c.category.icon,
      total: c.total, count: c.count,
      series: months.map((mo) =>
        db.transactions
          .filter((t) => monthOf(t.date) === mo && !t.hideFromReports)
          .flatMap(lines)
          .filter((l) => l.categoryId === c.categoryId)
          .reduce((s, l) => s + Math.abs(l.amount), 0)),
    }));
  }, [db, tab, groupBy, from, to, months]);

  const total = rows.reduce((s, r) => s + r.total, 0);

  return (
    <>
      <TopBar
        title="Reports"
        actions={<RangePicker value={range} onChange={setRange} />}
      />
      <div className="page stack">
        <div className="row wrap" style={{ gap: 10 }}>
          <Segmented
            value={tab} onChange={setTab}
            options={[
              { value: "spending", label: "Spending" },
              { value: "income", label: "Income" },
              { value: "savings", label: "Savings" },
              { value: "networth", label: "Net worth" },
            ]}
          />
          {tab === "spending" || tab === "income" ? (
            <Segmented
              value={groupBy} onChange={setGroupBy}
              options={[
                { value: "category", label: "Category" },
                { value: "group", label: "Group" },
                { value: "merchant", label: "Merchant" },
                { value: "account", label: "Account" },
              ]}
            />
          ) : null}
          <div className="grow" />
          <span className="small muted">
            {monthLabel(months[0], true)} — {monthLabel(months[months.length - 1], true)} · total{" "}
            <b className="num"><Money value={total} cents={false} /></b>
          </span>
        </div>

        {tab === "networth" ? (
          <Card>
            <CardHead title="Net worth" sub="Assets minus liabilities, month by month" />
            <AreaChart points={netWorth.map((p) => ({ label: monthLabel(p.month, true), value: p.net }))} height={280} />
            <div className="divider" />
            <div className="grid g2">
              <div>
                <span className="section-title">Assets</span>
                <AreaChart points={netWorth.map((p) => ({ label: monthLabel(p.month, true), value: p.assets }))} height={150} tone="--c3" />
              </div>
              <div>
                <span className="section-title">Liabilities</span>
                <AreaChart points={netWorth.map((p) => ({ label: monthLabel(p.month, true), value: p.liabilities }))} height={150} tone="--c9" />
              </div>
            </div>
          </Card>
        ) : tab === "savings" ? (
          <Card>
            <CardHead title="Saved each month" sub="Income minus spending, transfers excluded" />
            <BarChart
              height={280}
              groups={flow.map((f) => ({
                label: monthLabel(f.month, true),
                bars: [{ key: "Saved", value: f.net, tone: f.net >= 0 ? "--c3" : "--c9" }],
              }))}
            />
            <div className="divider" />
            <div className="row wrap" style={{ gap: 28 }}>
              <div className="col">
                <span className="tile-label">Best month</span>
                <span className="num bold">
                  <Money value={Math.max(...flow.map((f) => f.net))} cents={false} />
                </span>
              </div>
              <div className="col">
                <span className="tile-label">Worst month</span>
                <span className="num bold">
                  <Money value={Math.min(...flow.map((f) => f.net))} cents={false} />
                </span>
              </div>
              <div className="col">
                <span className="tile-label">Average</span>
                <span className="num bold">
                  <Money value={Math.round(flow.reduce((s, f) => s + f.net, 0) / Math.max(1, flow.length))} cents={false} />
                </span>
              </div>
              <div className="col">
                <span className="tile-label">Months in the black</span>
                <span className="num bold">{flow.filter((f) => f.net > 0).length} / {flow.length}</span>
              </div>
            </div>
          </Card>
        ) : (
          <div className="grid g-2-1">
            <Card pad={false}>
              <CardHead flush title={tab === "income" ? "Income" : "Spending"} sub={`by ${groupBy}`} />
              {rows.length ? (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{groupBy}</th>
                      <th className="right">Total</th>
                      <th className="right">Avg / mo</th>
                      <th className="right">Share</th>
                      <th style={{ width: 100 }}>Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td>
                          <Link
                            to={groupBy === "category" ? `/transactions?category=${r.key}` : "/transactions"}
                            className="row" style={{ gap: 7 }}
                          >
                            {r.icon ? <span>{r.icon}</span> : <span className="dot" style={{ background: `var(${r.tone})` }} />}
                            <span className="truncate">{r.label}</span>
                            <span className="tiny faint">{r.count}</span>
                          </Link>
                        </td>
                        <td className="right num bold"><Money value={r.total} cents={false} /></td>
                        <td className="right num muted"><Money value={Math.round(r.total / months.length)} cents={false} /></td>
                        <td className="right num muted">{total ? ((r.total / total) * 100).toFixed(1) : "0.0"}%</td>
                        <td><Sparkline values={r.series} tone={r.tone} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <Empty title="Nothing to report in this range" />}
            </Card>

            <div className="stack">
              <Card>
                <CardHead title="Breakdown" />
                {rows.length ? (
                  <Donut
                    size={160}
                    slices={rows.slice(0, 7).map((r) => ({ label: r.label, value: r.total, tone: r.tone }))}
                    center={<div className="col" style={{ gap: 0 }}>
                      <span className="tiny muted">Total</span>
                      <span className="bold num">{fmt0(total, { compact: true })}</span>
                    </div>}
                  />
                ) : <Empty title="No data" />}
              </Card>
              <Card>
                <CardHead title="Biggest movers" sub="Largest lines in range" />
                <HBars rows={rows.slice(0, 8).map((r) => ({ label: r.label, value: r.total, tone: r.tone, icon: r.icon }))} />
              </Card>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
