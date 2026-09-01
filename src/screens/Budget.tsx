import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronDown, ChevronRight, Copy, RotateCcw, Sparkles } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { monthLabel, thisMonth, addMonths } from "../lib/date";
import { budgetSummary, remainingTone } from "../lib/select";
import type { BudgetGroupRow } from "../lib/select";
import { Btn, Card, Money, Popover, Progress, Toggle, cx } from "../components/ui";
import { BudgetAmountPopover } from "./BudgetAmountPopover";
import { BudgetMovePopover } from "./BudgetMovePopover";
import { MonthNav } from "../components/pickers";

export default function Budget() {
  const db = useDB();
  const { actions } = useStore();
  const [month, setMonth] = useState(thisMonth());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const summary = useMemo(() => budgetSummary(db, month), [db, month]);

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <>
      <TopBar
        title="Budget"
        actions={
          <>
            <Btn onClick={() => actions.copyPreviousMonth(month)} title={`Copy ${monthLabel(addMonths(month, -1))}`}>
              <Copy size={14} /> Copy last month
            </Btn>
            <Btn onClick={() => actions.autofillBudget(month)} title="Fill from the last three months' average">
              <Sparkles size={14} /> Auto-fill
            </Btn>
            <Btn variant="ghost" onClick={() => actions.clearBudget(month)}><RotateCcw size={14} /></Btn>
          </>
        }
      />
      <div className="page stack">
        <Card>
          <div className="spread wrap" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              <MonthNav month={month} onChange={setMonth} max={addMonths(thisMonth(), 6)} />
              <Btn
                onClick={() => setMonth(thisMonth())}
                disabled={month === thisMonth()}
                title={`Jump back to ${monthLabel(thisMonth())}`}
              >
                <CalendarDays size={14} /> This month
              </Btn>
            </div>
            <div className="row wrap" style={{ gap: 26 }}>
              <Stat label="Planned income" value={summary.plannedIncome} actual={summary.actualIncome} />
              <Stat label="Planned expenses" value={summary.plannedExpense} actual={summary.actualExpense} />
              <div className="col">
                <span className="tile-label">Left to budget</span>
                <span className={cx("num bold", summary.leftToBudget < 0 ? "neg" : "pos")} style={{ fontSize: 20 }}>
                  <Money value={summary.leftToBudget} cents={false} />
                </span>
              </div>
              <div className="col">
                <span className="tile-label">Actual saved</span>
                <span className={cx("num bold", summary.actualSavings < 0 ? "neg" : "pos")} style={{ fontSize: 20 }}>
                  <Money value={summary.actualSavings} cents={false} />
                </span>
              </div>
            </div>
          </div>
          <div className="divider" />
          <Progress
            value={summary.actualExpense} max={Math.max(summary.plannedExpense, summary.actualExpense, 1)}
            over={summary.actualExpense > summary.plannedExpense}
          />
          <div className="spread small muted" style={{ marginTop: 6 }}>
            <span><Money value={summary.actualExpense} cents={false} /> spent</span>
            <span>
              {summary.plannedExpense >= summary.actualExpense
                ? <><Money value={summary.plannedExpense - summary.actualExpense} cents={false} /> left of <Money value={summary.plannedExpense} cents={false} /></>
                : <span className="neg"><Money value={summary.actualExpense - summary.plannedExpense} cents={false} /> over budget</span>}
            </span>
          </div>
        </Card>

        {summary.table.map((g) => (
          <GroupCard
            key={g.group.id} data={g} month={month}
            collapsed={collapsed.has(g.group.id)} onToggle={() => toggleGroup(g.group.id)}
          />
        ))}
      </div>
    </>
  );
}

function Stat({ label, value, actual }: { label: string; value: number; actual: number }) {
  return (
    <div className="col">
      <span className="tile-label">{label}</span>
      <span className="num bold" style={{ fontSize: 20 }}><Money value={value} cents={false} /></span>
      <span className="tiny faint">actual <Money value={actual} cents={false} /></span>
    </div>
  );
}

function GroupCard({ data, month, collapsed, onToggle }: {
  data: BudgetGroupRow; month: string; collapsed: boolean; onToggle: () => void;
}) {
  const { actions } = useStore();
  const income = data.group.kind === "income";
  return (
    <Card pad={false}>
      <div className="card-head flush" style={{ cursor: "pointer" }} onClick={onToggle}>
        <div className="row" style={{ gap: 7 }}>
          {collapsed ? <ChevronRight size={15} className="faint" /> : <ChevronDown size={15} className="faint" />}
          <h2>{data.group.name}</h2>
          <span className="tiny faint">{data.rows.length}</span>
        </div>
        <div className="row budget-head">
          <div className="bcol bcol-plan">
            <div className="tile-label">Planned</div>
            <div className="num small bold"><Money value={data.planned} cents={false} /></div>
          </div>
          <div className="bcol bcol-actual">
            <div className="tile-label">Actual</div>
            <div className="num small bold"><Money value={data.actual} cents={false} /></div>
          </div>
          <div className="bcol bcol-left">
            <div className="tile-label">Remaining</div>
            <div className={cx("num small bold", remainingTone(data.remaining))}>
              <Money value={data.remaining} cents={false} />
            </div>
          </div>
          <span className="bcol-menu" />
        </div>
      </div>

      {collapsed ? null : data.rows.map((r) => {
        const over = !income && r.remaining < 0;
        return (
          <div key={r.category.id} className="list-row">
            <span style={{ fontSize: 15, width: 22 }}>{r.category.icon}</span>
            <div className="grow col" style={{ gap: 5, minWidth: 0 }}>
              <div className="spread">
                <span className="truncate" style={{ fontWeight: 500 }}>
                  {r.category.name}
                  {r.rollover > 0 ? (
                    <span className="tiny faint"> · <Money value={r.rollover} cents={false} /> rolled over</span>
                  ) : null}
                </span>
              </div>
              <Progress
                value={r.actual} max={Math.max(r.planned + r.rollover, r.actual, 1)}
                color={r.category.color} over={over}
              />
            </div>

            <div className="bcol bcol-plan">
              <BudgetAmountPopover category={r.category} month={month} kind={income ? "income" : "expense"} />
            </div>
            <Link
              to={`/transactions?category=${r.category.id}&month=${month}`}
              className="num right bcol bcol-actual"
            >
              <Money value={r.actual} cents={false} />
            </Link>
            <div className="bcol bcol-left">
              {income ? (
                <span className={cx("btn budget-amount remaining", remainingTone(r.remaining))}>
                  <Money value={r.remaining} cents={false} />
                </span>
              ) : (
                <BudgetMovePopover category={r.category} month={month} remaining={r.remaining} />
              )}
            </div>
            <Popover
              align="right"
              trigger={(open) => <button className="btn btn-ghost btn-icon bcol-menu" onClick={open}>⋯</button>}
            >
              {() => (
                <div style={{ padding: "6px 8px" }}>
                  <Toggle
                    on={r.category.rollover}
                    onChange={(v) => actions.updateCategory(r.category.id, { rollover: v })}
                    label={<span className="small">Roll over leftovers</span>}
                  />
                  <div className="tiny faint" style={{ marginTop: 6, maxWidth: 190 }}>
                    Unspent money in this category carries into next month.
                  </div>
                </div>
              )}
            </Popover>
          </div>
        );
      })}
    </Card>
  );
}
