import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Plus, TrendingDown, TrendingUp } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import {
  dateLabel, daysInMonth, monthLabel, relativeDay, thisMonth, today,
} from "../lib/date";
import {
  aggregateSeries, budgetSummary, earliestHistoryDate, netWorthAt, portfolioSummary, trendTone,
} from "../lib/select";
import { dueSoon, monthProgress, spendPace } from "../lib/dashboard";
import { CREDIT_MAX, CREDIT_MIN, CREDIT_BANDS, creditSummary } from "../lib/credit";
import { AreaChart, CompareChart } from "../components/charts";
import { BalanceChart } from "../components/BalanceChart";
import {
  Btn, Card, CardHead, Empty, Field, Modal, Money, Progress, TextInput, cx, color,
} from "../components/ui";
import { MerchantAvatar } from "./Transactions";
import type { RangeKey } from "../lib/range";
import { rangeStart, sampleDates, sampleLabel, spanDays } from "../lib/range";

export default function Dashboard() {
  const db = useDB();
  const month = thisMonth();
  const [range, setRange] = useState<RangeKey>("1m");

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
        <NetWorthCard range={range} onRange={setRange} />
        <SpendingCard />
        <BudgetCard month={month} />
        <CreditCard />
        <RecurringCard />
        <InvestmentCard />
      </div>
    </>
  );
}

/* ── net worth ────────────────────────────────────────────────────────── */

function NetWorthCard({ range, onRange }: { range: RangeKey; onRange: (r: RangeKey) => void }) {
  const db = useDB();
  const start = useMemo(() => {
    const earliest = earliestHistoryDate(db.accounts);
    const from = rangeStart(range, earliest);
    return earliest && earliest > from ? earliest : from;
  }, [db.accounts, range]);

  const { series, points, total } = useMemo(() => {
    const dates = sampleDates(start, today());
    const days = spanDays(start, today());
    const values = dates.map((d) => netWorthAt(db, d));
    return {
      series: values,
      points: values.map((value, i) => ({
        label: sampleLabel(dates[i], days), value, sub: dateLabel(dates[i], { year: true }),
      })),
      total: values[values.length - 1] ?? 0,
    };
  }, [db, start]);

  return (
    <Card pad={false} className="nw-card">
      <BalanceChart
        label="Net worth"
        total={total} series={series} points={points}
        tone={trendTone(series)} range={range} onRange={onRange}
        above={
          <div className="dash-head">
            <Link to="/accounts" className="link small">Accounts <ArrowRight size={12} /></Link>
          </div>
        }
      />
    </Card>
  );
}

/* ── spending, against last month ─────────────────────────────────────── */

function SpendingCard() {
  const db = useDB();
  const pace = useMemo(() => spendPace(db), [db]);
  // Like for like: what had been spent by this day last month, not by the end
  // of it. Comparing a fifth of one month against the whole of another is how
  // a dashboard tells you every month that you are doing well.
  const soFarLast = pace.lastMonth.find((p) => p.day === pace.thisMonth.length)?.total
    ?? pace.spentLast;
  const diff = pace.spent - soFarLast;

  return (
    <Card>
      <CardHead
        title="Spending"
        sub="This month vs. last month"
        right={<Link to="/cash-flow" className="link small">Cash flow <ArrowRight size={12} /></Link>}
      />
      {pace.thisMonth.length ? (
        <>
          <div className="row wrap" style={{ gap: 10, marginBottom: 6 }}>
            <span className="num bold" style={{ fontSize: 22 }}><Money value={pace.spent} /></span>
            <span className={cx("small", diff > 0 ? "neg" : "pos")}>
              {diff > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{" "}
              <Money value={Math.abs(diff)} cents={false} /> {diff > 0 ? "more" : "less"} than by this day last month
            </span>
          </div>
          <CompareChart
            span={pace.days}
            current={pace.thisMonth.map((p) => [p.day, p.total] as [number, number])}
            previous={pace.lastMonth.map((p) => [p.day, p.total] as [number, number])}
            tone="--c9"
            label="This month"
            priorLabel="Last month"
          />
        </>
      ) : <Empty title="Nothing spent yet this month" />}
    </Card>
  );
}

/* ── budget ───────────────────────────────────────────────────────────── */

/** One side of the month's plan, with today's place in it marked. */
function BudgetLine({ label, planned, actual, doneWord, tone }: {
  label: string; planned: number; actual: number; doneWord: string; tone: string;
}) {
  const remaining = planned - actual;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="spread small">
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span className="muted num"><Money value={planned} cents={false} /> planned</span>
      </div>
      {/* The mark is where today is in the month, so the bar answers "am I
          ahead of the calendar or behind it" rather than only "how much is
          left" — which is the question a plan spread over a month invites. */}
      <Progress
        value={actual} max={Math.max(planned, actual, 1)} color={tone}
        over={planned > 0 && actual > planned}
        mark={Math.max(planned, actual, 1) * monthProgress(thisMonth())}
        markTitle="Where today falls in the month"
      />
      <div className="spread small">
        <span className="num bold"><Money value={actual} cents={false} /> {doneWord}</span>
        <span className={remaining < 0 ? "neg" : "pos"}>
          <span className="num bold"><Money value={Math.abs(remaining)} cents={false} /></span>{" "}
          <span className="muted">{remaining < 0 ? "over" : "remaining"}</span>
        </span>
      </div>
    </div>
  );
}

function BudgetCard({ month }: { month: string }) {
  const db = useDB();
  const b = useMemo(() => budgetSummary(db, month), [db, month]);
  const day = Number(today().slice(8, 10));
  return (
    <Card>
      <CardHead
        title="Budget" sub={`${monthLabel(month)} · day ${day} of ${daysInMonth(month)}`}
        right={<Link to="/budget" className="link small">Open <ArrowRight size={12} /></Link>}
      />
      {b.plannedIncome || b.plannedExpense ? (
        <div className="col" style={{ gap: 18 }}>
          <BudgetLine label="Income" planned={b.plannedIncome} actual={b.actualIncome} doneWord="earned" tone="--pos" />
          <BudgetLine label="Expenses" planned={b.plannedExpense} actual={b.actualExpense} doneWord="spent" tone="--pos" />
        </div>
      ) : (
        <Empty title="No budget set for this month" action={<Link to="/budget"><Btn>Set one up</Btn></Link>} />
      )}
    </Card>
  );
}

/* ── credit score ─────────────────────────────────────────────────────── */

function CreditCard() {
  const db = useDB();
  const { actions } = useStore();
  const c = useMemo(() => creditSummary(db), [db]);
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(today());
  const [score, setScore] = useState(0);

  return (
    <Card>
      <CardHead
        title="Credit score"
        sub={c.latest ? `Last recorded ${dateLabel(c.latest.date, { year: true })}` : "No readings yet"}
        right={<Btn size="sm" onClick={() => setAdding(true)}><Plus size={13} /> Add reading</Btn>}
      />
      {c.latest && c.band ? (
        <>
          <div className="row wrap" style={{ gap: 14, alignItems: "baseline", marginBottom: 12 }}>
            <span className="num" style={{ fontSize: 38, fontWeight: 650, color: color(c.band.tone) }}>
              {c.latest.score}
            </span>
            <span className="tag" style={{ background: "var(--surface-3)", color: color(c.band.tone) }}>{c.band.label}</span>
            {c.change !== 0 ? (
              <span className={c.change > 0 ? "pos small" : "neg small"}>
                {c.change > 0 ? "+" : ""}{c.change} points
              </span>
            ) : <span className="small faint">No change</span>}
            {c.latest.source ? <span className="tiny faint">via {c.latest.source}</span> : null}
          </div>

          {/* The bands, in order, with where this score sits along them. */}
          <div className="credit-scale">
            {[...CREDIT_BANDS].reverse().map((b) => (
              <i key={b.label} style={{ background: color(b.tone) }} title={`${b.label}, from ${b.from}`} />
            ))}
            <span className="credit-pin" style={{ left: `${c.position * 100}%` }} />
          </div>
          <div className="spread tiny faint" style={{ marginTop: 4 }}>
            <span>{CREDIT_MIN}</span><span>{CREDIT_MAX}</span>
          </div>

          {c.readings.length > 1 ? (
            <div style={{ marginTop: 10 }}>
              <AreaChart
                height={150} tone={c.band.tone} negativeTone={c.band.tone}
                format={(v) => String(Math.round(v))}
                points={c.readings.map((r) => ({
                  label: dateLabel(r.date), value: r.score, sub: dateLabel(r.date, { year: true }),
                }))}
              />
            </div>
          ) : null}
        </>
      ) : (
        <Empty
          title="No credit score recorded"
          body="Nothing here reads a bureau yet. Add a score by hand and the history is kept — a provider, when there is one, writes to the same place."
          action={<Btn variant="primary" onClick={() => setAdding(true)}><Plus size={14} /> Add a reading</Btn>}
        />
      )}

      {adding ? (
        <Modal
          title="Add a credit score" onClose={() => setAdding(false)}
          footer={
            <>
              <div className="grow" />
              <Btn onClick={() => setAdding(false)}>Cancel</Btn>
              <Btn
                variant="primary"
                disabled={score < CREDIT_MIN || score > CREDIT_MAX}
                onClick={() => { actions.setCreditScore(date, score); setAdding(false); }}
              >
                Save
              </Btn>
            </>
          }
        >
          <div className="row" style={{ gap: 12 }}>
            <Field label="As of"><TextInput type="date" value={date} onChange={setDate} /></Field>
            <Field label="Score" hint={`${CREDIT_MIN}–${CREDIT_MAX}`}>
              <input
                className="input num" type="number" min={CREDIT_MIN} max={CREDIT_MAX} autoFocus
                value={score || ""} onChange={(e) => setScore(Number(e.target.value))}
              />
            </Field>
          </div>
          {c.readings.length ? (
            <div className="col" style={{ gap: 0 }}>
              <span className="small muted" style={{ marginBottom: 6 }}>Recorded so far</span>
              {[...c.readings].reverse().slice(0, 8).map((r) => (
                <div key={r.date} className="spread balance-point">
                  <span className="small muted">{dateLabel(r.date, { year: true })}</span>
                  <span className="row" style={{ gap: 10 }}>
                    <span className="num bold">{r.score}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => actions.forgetCreditScore(r.date)}>Remove</button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </Card>
  );
}

/* ── recurring ────────────────────────────────────────────────────────── */

function RecurringCard() {
  const db = useDB();
  const due = useMemo(() => dueSoon(db), [db]);
  return (
    <Card pad={false}>
      <div className="dash-card-head">
        <div className="spread">
          <h2>Recurring</h2>
          <Link to="/recurring" className="link small">All <ArrowRight size={12} /></Link>
        </div>
        <span className="small muted">
          <Money value={due.remaining} className="bold" /> still due this month
        </span>
      </div>
      {due.items.map((r) => (
        <Link key={r.id} to="/recurring" className="list-row click">
          <MerchantAvatar name={r.merchant} size={30} />
          <div className="grow col" style={{ gap: 1, minWidth: 0 }}>
            <span className="truncate" style={{ fontWeight: 500 }}>{r.merchant}</span>
            <span className="tiny faint truncate">Every {cadenceWord(r.cadence)}</span>
          </div>
          <div className="col" style={{ gap: 1, alignItems: "flex-end" }}>
            <Money value={r.amount} colored={r.amount > 0} className="bold" />
            <span className="tiny faint">{relativeDay(r.nextDate)}</span>
          </div>
        </Link>
      ))}
      {!due.items.length ? <Empty title="Nothing due" body="Recurring charges are spotted from your transactions." /> : null}
    </Card>
  );
}

const CADENCE_WORD: Record<string, string> = {
  weekly: "week", biweekly: "2 weeks", monthly: "month",
  quarterly: "quarter", semiannual: "6 months", yearly: "year",
};
const cadenceWord = (c: string): string => CADENCE_WORD[c] ?? c;

/* ── investments ──────────────────────────────────────────────────────── */

function InvestmentCard() {
  const db = useDB();
  const p = useMemo(() => portfolioSummary(db), [db]);
  // Month to date, from the accounts' own balance history — the holdings only
  // carry today's price, so a per-holding mover needs a price history this
  // app does not keep yet.
  const change = useMemo(() => {
    const first = `${thisMonth()}-01`;
    const [start, end] = aggregateSeries(p.invAccounts, [first, today()]);
    return { start, delta: end - start };
  }, [p.invAccounts]);

  if (!p.invAccounts.length) return null;
  const up = change.delta >= 0;

  return (
    <Card>
      <CardHead
        title="Investments" sub={`${monthLabel(thisMonth())} so far`}
        right={<Link to="/investments" className="link small">Open <ArrowRight size={12} /></Link>}
      />
      <div className="row wrap" style={{ gap: 12, alignItems: "baseline" }}>
        <span className="num bold" style={{ fontSize: 26 }}><Money value={p.accountsValue} cents={false} /></span>
        <span className={up ? "pos" : "neg"}>
          {up ? "↗" : "↘"} <Money value={change.delta} cents={false} />
          {change.start ? ` (${Math.round((change.delta / Math.abs(change.start)) * 1000) / 10}%)` : ""}
        </span>
      </div>
      {p.byClass.length ? (
        <div className="col" style={{ gap: 8, marginTop: 14 }}>
          {p.byClass.slice(0, 4).map((c) => (
            <div key={c.key} className="col" style={{ gap: 4 }}>
              <div className="spread small">
                <span className="muted">{c.label}</span>
                <span className="num"><Money value={c.value} cents={false} /></span>
              </div>
              <Progress value={c.value} max={p.value || 1} color="--c2" />
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
