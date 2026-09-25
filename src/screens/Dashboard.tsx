import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, relativeDay, thisMonth, today } from "../lib/date";
import {
  accountSlices, aggregateSeries, budgetSummary, earliestHistoryDate, portfolioSummary, trendTone,
} from "../lib/select";
import { dueSoon, goalMoves, monthProgress, overPace } from "../lib/dashboard";
import { COMPARE_MODES, DEFAULT_MODE, compareSpending, readMode } from "../lib/spend-compare";
import type { CompareMode } from "../lib/spend-compare";
import { CompareChart } from "../components/charts";
import { BalanceChart, ScopeBar } from "../components/BalanceChart";
import { Btn, Card, CardHead, Empty, Money, Progress, cx, color } from "../components/ui";
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
        <RecurringCard />
        <GoalsCard />
        <InvestmentCard />
      </div>
    </>
  );
}

/**
 * A card that is itself the link to its page.
 *
 * The link is a transparent sheet laid over the whole card rather than a
 * wrapper around it, because a card holds links of its own — a goal, a
 * merchant — and an anchor inside an anchor is neither valid markup nor
 * something the router will route. Laying it over instead leaves those as
 * siblings, and anything that must stay clickable is lifted back above the
 * sheet with .dash-through.
 *
 * It keeps a real href and its own focus ring, so the card is reachable by
 * keyboard and can be opened in a new tab like any other link.
 */
function DashCard({ to, label, pad, className, children }: {
  to: string; label: string; pad?: boolean; className?: string; children: ReactNode;
}) {
  return (
    <Card pad={pad} className={cx("dash-card", className)}>
      <Link to={to} className="dash-sheet" aria-label={label} />
      {children}
    </Card>
  );
}

/* ── what is left before payday ───────────────────────────────────────── */

/* ── net worth ────────────────────────────────────────────────────────── */

function NetWorthCard({ range, onRange }: { range: RangeKey; onRange: (r: RangeKey) => void }) {
  const db = useDB();
  const [scope, setScope] = useState("net");

  const start = useMemo(() => {
    const earliest = earliestHistoryDate(db.accounts);
    const from = rangeStart(range, earliest);
    return earliest && earliest > from ? earliest : from;
  }, [db.accounts, range]);

  const dates = useMemo(() => sampleDates(start, today()), [start]);
  // The same slices the Accounts page cuts, so "Cash" here and "Cash" there
  // are the same set of accounts rather than two answers that agree by
  // accident. The first of them is net worth, which is what this card was.
  const slices = useMemo(() => accountSlices(db, dates), [db, dates]);
  // A kind can disappear underneath the selection when its last account is
  // closed, and a card filtered to nothing has no way back to itself.
  const current = slices.find((s) => s.key === scope) ?? slices[0]!;

  const points = useMemo(() => {
    const days = spanDays(start, today());
    return current.series.map((value, i) => ({
      label: sampleLabel(dates[i], days), value, sub: dateLabel(dates[i], { year: true }),
    }));
  }, [current.series, dates, start]);

  return (
    <DashCard to="/accounts" label="Accounts" pad={false} className="nw-card">
      <BalanceChart
        total={current.total} series={current.series} points={points}
        tone={trendTone(current.series)} range={range} onRange={onRange}
        above={<ScopeBar slices={slices} value={current.key} onChange={setScope} />}
      />
    </DashCard>
  );
}

/* ── spending, against an earlier stretch ─────────────────────────────── */

const COMPARE_KEY = "sovereign.dashboard.compare";

function SpendingCard() {
  const db = useDB();
  /**
   * Which comparison the chart is drawing.
   *
   * In localStorage rather than in the document: it is one viewer's way of
   * reading their own spending on one device, not anything about the
   * household's money. Read lazily and written in an effect, both guarded,
   * because storage throws in a private window and comes back empty when site
   * data is cleared, and neither is a reason for the dashboard not to render.
   */
  const [mode, setMode] = useState<CompareMode>(() => {
    try {
      return readMode(localStorage.getItem(COMPARE_KEY));
    } catch {
      return DEFAULT_MODE;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(COMPARE_KEY, mode);
    } catch { /* a preference not remembered is not worth failing over */ }
  }, [mode]);

  const cmp = useMemo(() => compareSpending(db, mode), [db, mode]);
  // Like for like: what had been spent by this day of the earlier period, not
  // by the end of it. Worked out for every mode in one place, so the headline
  // and the chart can never disagree about what is being compared.
  const diff = cmp.spent - cmp.priorSoFar;
  // Against nothing is not a comparison: a first month has no last month to be
  // a percentage of, and dividing by it would print Infinity.
  const pct = cmp.priorSoFar > 0 ? Math.round((Math.abs(diff) / cmp.priorSoFar) * 100) : null;

  return (
    <DashCard to="/reports" label="Reports" className="spend-card">
      {/* The same shape as every other sub-heading here: which way it moved,
          by how much, and how much of the earlier period that is. What it is
          against is the chart directly below, which is labelled. */}
      <CardHead
        title="Spending"
        sub={cmp.current.length ? (
          <span className={diff > 0 ? "neg" : "pos"}>
            {diff > 0 ? "↗" : "↘"} <Money value={Math.abs(diff)} cents={false} />
            {pct === null ? "" : ` (${pct}% ${diff > 0 ? "higher" : "lower"})`}
          </span>
        ) : undefined}
        right={
          <select
            className="select cmp-mode" aria-label="Compare spending against"
            value={mode} onChange={(e) => setMode(readMode(e.target.value))}
          >
            {COMPARE_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        }
      />
      {cmp.current.length ? (
        <CompareChart
          span={cmp.span}
          current={cmp.current}
          previous={cmp.previous}
          tone="--c9"
          label={cmp.label}
          priorLabel={cmp.priorLabel}
          tickLabel={cmp.tickLabel}
        />
      ) : <Empty title="Nothing spent yet" />}
    </DashCard>
  );
}

/* ── budget ───────────────────────────────────────────────────────────── */

/** One side of the month's plan, with today's place in it marked. */
function BudgetLine({ label, planned, actual, doneWord, pace }: {
  label: string; planned: number; actual: number; doneWord: string;
  /** Whether being ahead of the calendar is bad news. True for spending. */
  pace?: boolean;
}) {
  const remaining = planned - actual;
  const progress = monthProgress(thisMonth());
  // Red once more has gone than the month has used up — which is what the
  // mark is for. Income is left green whatever it does: being behind on money
  // coming in is not the same kind of news as being ahead on money going out.
  const hot = pace === true && overPace(planned, actual, progress);
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
        value={actual} max={Math.max(planned, actual, 1)} color="--pos"
        over={hot}
        mark={Math.max(planned, actual, 1) * progress}
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
  return (
    <DashCard to="/budget" label="Budget">
      <CardHead title="Budget" />
      {b.plannedIncome || b.plannedExpense ? (
        <div className="col" style={{ gap: 18 }}>
          <BudgetLine label="Income" planned={b.plannedIncome} actual={b.actualIncome} doneWord="earned" />
          <BudgetLine label="Expenses" planned={b.plannedExpense} actual={b.actualExpense} doneWord="spent" pace />
        </div>
      ) : (
        <Empty title="No budget set for this month" action={<Link to="/budget" className="dash-through"><Btn>Set one up</Btn></Link>} />
      )}
    </DashCard>
  );
}

/* ── recurring ────────────────────────────────────────────────────────── */

function RecurringCard() {
  const db = useDB();
  const due = useMemo(() => dueSoon(db), [db]);
  return (
    <DashCard to="/recurring" label="Recurring" pad={false}>
      <div className="dash-card-head">
        <h2>Recurring</h2>
        <span className="small muted">
          <Money value={due.remaining} className="bold" /> still due this month
        </span>
      </div>
      {due.items.map((r) => (
        <Link key={r.id} to={`/merchants/${encodeURIComponent(r.merchant)}`} className="list-row click dash-through">
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
    </DashCard>
  );
}

const CADENCE_WORD: Record<string, string> = {
  weekly: "week", biweekly: "2 weeks", monthly: "month",
  quarterly: "quarter", semiannual: "6 months", yearly: "year",
};
const cadenceWord = (c: string): string => CADENCE_WORD[c] ?? c;

/* ── goals ────────────────────────────────────────────────────────────── */

/** What each outlook is called on a card, and what colour its bar wears. */
const GOAL_STATE: Record<string, { label: string; tone: string; badge: boolean }> = {
  reached: { label: "Completed", tone: "--pos", badge: true },
  ahead: { label: "Ahead", tone: "--pos", badge: true },
  "on track": { label: "On track", tone: "--pos", badge: true },
  behind: { label: "At risk", tone: "--c5", badge: true },
  stalled: { label: "At risk", tone: "--c5", badge: true },
  "no date": { label: "No target date", tone: "--pos", badge: false },
  "no plan": { label: "No plan yet", tone: "--muted", badge: false },
};

function GoalsCard() {
  const db = useDB();
  const moves = useMemo(() => goalMoves(db), [db]);
  if (!moves.goals.length) return null;
  const up = moves.change >= 0;

  return (
    <DashCard to="/goals" label="Goals" pad={false}>
      <div className="dash-card-head">
        <h2>Goals</h2>
        <span className="small row" style={{ gap: 7 }}>
          <span className={up ? "pos" : "neg"}>
            {up ? "↗" : "↘"} <Money value={moves.change} />
            {moves.pct ? ` (${Math.round(moves.pct * 10000) / 100}%)` : ""}
          </span>
          <span className="faint">this month</span>
        </span>
      </div>
      {moves.goals.map((m) => {
        const state = GOAL_STATE[m.status] ?? GOAL_STATE["no plan"];
        return (
          <Link key={m.goal.id} to={`/goals/${m.goal.id}`} className="goal-row dash-through">
            <span className="goal-mark">{m.goal.emoji}</span>
            <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
              <div className="spread">
                <span className="truncate" style={{ fontWeight: 600 }}>{m.goal.name}</span>
                <span className="num bold"><Money value={m.saved} /></span>
              </div>
              <div className="spread small">
                {state.badge ? (
                  <span className="tag" style={{ background: "var(--surface-3)", color: color(state.tone) }}>
                    {state.label}
                  </span>
                ) : <span className="faint">{state.label}</span>}
                {m.change === 0 ? (
                  <span className="muted num"><Money value={0} /></span>
                ) : (
                  <span className={m.change > 0 ? "pos" : "neg"}>
                    {m.change > 0 ? "↗" : "↘"} <Money value={m.change} />
                    {m.pct !== null ? ` (${Math.round(m.pct * 10000) / 100}%)` : ""}
                  </span>
                )}
              </div>
              {/* Tinted by how it is going, not by how full it is: a bar that
                  is only ever green says nothing about whether the goal
                  arrives on time, which is the question a target date asks. */}
              <Progress value={m.saved} max={m.goal.targetAmount || m.saved || 1} color={state.tone} />
            </div>
          </Link>
        );
      })}
    </DashCard>
  );
}

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
    <DashCard to="/investments" label="Investments">
      <CardHead title="Investments" />
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
    </DashCard>
  );
}
