import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { addMonths, dateLabel, lastMonths, monthEnd, monthLabel, monthStart, relativeDay, thisMonth } from "../lib/date";
import { fmtPct, pct } from "../lib/money";
import {
  budgetSummary, cashFlowSeries, categoryTotals, goalProgress, netWorthSeries,
  netWorthNow, recurringList,
} from "../lib/select";
import { AreaChart, BarChart, Donut, HBars } from "../components/charts";
import { Btn, Card, CardHead, Empty, Money, Progress, Tile } from "../components/ui";
import { MerchantAvatar } from "./Transactions";
import { CategoryTag } from "../components/pickers";

export default function Dashboard() {
  const db = useDB();
  const month = thisMonth();
  const nw = netWorthNow(db);

  const netWorth = useMemo(() => netWorthSeries(db, lastMonths(13)), [db]);
  const flow = useMemo(() => cashFlowSeries(db, lastMonths(6)), [db]);
  const budget = useMemo(() => budgetSummary(db, month), [db, month]);
  const spend = useMemo(() => categoryTotals(db, monthStart(month), monthEnd(month)), [db, month]);
  const upcoming = useMemo(() => recurringList(db).slice(0, 5), [db]);
  const recent = db.transactions.slice(0, 7);

  const monthAgo = netWorth[netWorth.length - 2]?.net ?? nw.net;
  const nwChange = nw.net - monthAgo;
  const current = flow[flow.length - 1] ?? { income: 0, expense: 0, net: 0 };
  const savingsRate = current.income > 0 ? pct(current.net, current.income) : 0;

  if (!db.accounts.length) {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="page">
          <Card>
            <Empty
              title="Nothing here yet"
              body="Add an account by hand, import a CSV from your bank, or load the demo data to look around."
              action={<Link to="/settings"><Btn variant="primary">Go to settings</Btn></Link>}
            />
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar title="Dashboard" />
      <div className="page stack">
        <div className="grid g4">
          <Tile
            label="Net worth"
            value={<Money value={nw.net} cents={false} />}
            sub={
              <span className={nwChange >= 0 ? "pos" : "neg"}>
                {nwChange >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}{" "}
                <Money value={nwChange} cents={false} sign={nwChange >= 0} /> this month
              </span>
            }
          />
          <Tile
            label={`${monthLabel(month, true)} income`}
            value={<Money value={current.income} cents={false} />}
            sub={<span className="muted">across {db.accounts.filter((a) => !a.hidden).length} accounts</span>}
          />
          <Tile
            label={`${monthLabel(month, true)} spending`}
            value={<Money value={current.expense} cents={false} />}
            sub={<span className="muted">{spend.length} categories</span>}
          />
          <Tile
            label="Savings rate"
            value={<span className={savingsRate >= 0 ? "pos" : "neg"}>{fmtPct(savingsRate, 0)}</span>}
            sub={<span className="muted">saved <Money value={current.net} cents={false} /></span>}
          />
        </div>

        <div className="grid g-2-1">
          <Card>
            <CardHead
              title="Net worth"
              sub={`${monthLabel(netWorth[0]?.month ?? month, true)} — today`}
              right={<Link to="/accounts" className="link small">Accounts <ArrowRight size={12} /></Link>}
            />
            <AreaChart
              points={netWorth.map((p) => ({
                label: monthLabel(p.month, true),
                value: p.net,
                sub: `assets ${(p.assets / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}`,
              }))}
              height={210}
            />
          </Card>

          <Card>
            <CardHead title={`${monthLabel(month, true)} budget`} right={<Link to="/budget" className="link small">Open</Link>} />
            <div className="col" style={{ gap: 4, marginBottom: 12 }}>
              <div className="spread">
                <span className="small muted">Spent of planned</span>
                <span className="num small bold">
                  <Money value={budget.actualExpense} cents={false} /> / <Money value={budget.plannedExpense} cents={false} />
                </span>
              </div>
              <Progress
                value={budget.actualExpense} max={budget.plannedExpense || 1}
                over={budget.actualExpense > budget.plannedExpense}
              />
            </div>
            <div className="col" style={{ gap: 10 }}>
              {budget.expense
                .flatMap((g) => g.rows)
                .sort((a, b) => b.actual - a.actual)
                .slice(0, 5)
                .map((r) => (
                  <div key={r.category.id} className="col" style={{ gap: 4 }}>
                    <div className="spread">
                      <span className="small truncate">{r.category.icon} {r.category.name}</span>
                      <span className={`num tiny ${r.remaining < 0 ? "neg" : "muted"}`}>
                        <Money value={Math.abs(r.remaining)} cents={false} /> {r.remaining < 0 ? "over" : "left"}
                      </span>
                    </div>
                    <Progress value={r.actual} max={r.planned || r.actual || 1} color={r.category.color} over={r.remaining < 0} />
                  </div>
                ))}
              {!budget.expense.length ? <span className="small faint">No budget set for this month.</span> : null}
            </div>
          </Card>
        </div>

        <div className="grid g-2-1">
          <Card>
            <CardHead title="Cash flow" sub="Income vs. spending, last 6 months" right={<Link to="/cash-flow" className="link small">Details</Link>} />
            <BarChart
              height={210}
              groups={flow.map((f) => ({
                label: monthLabel(f.month, true),
                bars: [
                  { key: "Income", value: f.income, tone: "--c3" },
                  { key: "Expenses", value: f.expense, tone: "--c9" },
                ],
              }))}
            />
          </Card>

          <Card>
            <CardHead title="Where it went" sub={monthLabel(month)} right={<Link to="/reports" className="link small">Reports</Link>} />
            {spend.length ? (
              <Donut
                size={150}
                slices={spend.slice(0, 6).map((c) => ({ label: c.category.name, value: c.total, tone: c.category.color }))}
                center={
                  <div className="col" style={{ gap: 0 }}>
                    <span className="tiny muted">Total</span>
                    <Money value={spend.reduce((s, c) => s + c.total, 0)} cents={false} className="bold" />
                  </div>
                }
              />
            ) : <Empty title="No spending yet this month" />}
          </Card>
        </div>

        <div className="grid g-2-1">
          <Card pad={false}>
            <CardHead flush title="Recent transactions" right={<Link to="/transactions" className="link small">See all</Link>} />
            {recent.map((t) => (
              <Link key={t.id} to="/transactions" className="list-row click">
                <MerchantAvatar name={t.merchant} size={28} />
                <div className="grow col" style={{ gap: 0 }}>
                  <span className="truncate" style={{ fontWeight: 500 }}>{t.merchant}</span>
                  <span className="tiny faint">{dateLabel(t.date)} · {db.accounts.find((a) => a.id === t.accountId)?.name}</span>
                </div>
                <CategoryTag categoryId={t.categoryId} />
                <span className="num bold" style={{ width: 92, textAlign: "right" }}>
                  <Money value={t.amount} colored={t.amount > 0} />
                </span>
              </Link>
            ))}
            {!recent.length ? <Empty title="No transactions yet" /> : null}
          </Card>

          <div className="stack">
            <Card pad={false}>
              <CardHead flush title="Upcoming" right={<Link to="/recurring" className="link small">All</Link>} />
              {upcoming.map((r) => (
                <div key={r.id} className="list-row">
                  <MerchantAvatar name={r.merchant} size={26} />
                  <div className="grow col" style={{ gap: 0 }}>
                    <span className="truncate small" style={{ fontWeight: 500 }}>{r.merchant}</span>
                    <span className="tiny faint">{relativeDay(r.nextDate)}</span>
                  </div>
                  <Money value={r.amount} cents={false} colored={r.amount > 0} className="bold small" />
                </div>
              ))}
              {!upcoming.length ? <Empty title="Nothing detected yet" /> : null}
            </Card>

            <Card>
              <CardHead title="Goals" right={<Link to="/goals" className="link small">All</Link>} />
              <div className="col" style={{ gap: 12 }}>
                {db.goals.filter((g) => !g.archived).slice(0, 3).map((g) => {
                  const p = goalProgress(db, g.id);
                  return (
                    <div key={g.id} className="col" style={{ gap: 5 }}>
                      <div className="spread">
                        <span className="small">{g.emoji} {g.name}</span>
                        <span className="tiny muted num">
                          <Money value={p.saved} cents={false} /> / <Money value={g.targetAmount} cents={false} />
                        </span>
                      </div>
                      <Progress value={p.saved} max={g.targetAmount} color="--c3" />
                    </div>
                  );
                })}
                {!db.goals.length ? <span className="small faint">No goals yet.</span> : null}
              </div>
            </Card>
          </div>
        </div>

        <Card>
          <CardHead title="Spending by category" sub={`${monthLabel(addMonths(month, -1))} vs ${monthLabel(month)}`} />
          <HBars
            rows={spend.slice(0, 8).map((c) => ({
              label: c.category.name, value: c.total, tone: c.category.color,
              icon: c.category.icon, sub: `${c.count} txn`,
            }))}
          />
        </Card>
      </div>
    </>
  );
}
