import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Copy, RotateCcw, Sparkles } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { monthLabel, thisMonth, addMonths } from "../lib/date";
import { budgetSummary } from "../lib/select";
import type { BudgetGroupRow } from "../lib/select";
import { Btn, Card, CardHead, Money, Popover, Progress, Toggle, cx } from "../components/ui";
import { BudgetAmountPopover } from "./BudgetAmountPopover";
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

  const unplanned = db.categories.filter(
    (c) => !c.excludeFromBudget && !c.archived && !(db.budgets[month]?.[c.id]) &&
      !summary.table.some((g) => g.rows.some((r) => r.category.id === c.id)),
  );

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
            <MonthNav month={month} onChange={setMonth} max={addMonths(thisMonth(), 6)} />
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

        {unplanned.length ? (
          <Card>
            <CardHead title="Not budgeted" sub="Categories with no plan and no activity this month" />
            <div className="row wrap" style={{ gap: 6 }}>
              {unplanned.slice(0, 24).map((c) => (
                <button
                  key={c.id} className="chip"
                  onClick={() => actions.setPlanned(month, c.id, 10000)}
                  title="Add to this month's budget at $100"
                >
                  {c.icon} {c.name} +
                </button>
              ))}
            </div>
          </Card>
        ) : null}
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
        <div className="row" style={{ gap: 22 }}>
          <span className="num small muted">planned <b><Money value={data.planned} cents={false} /></b></span>
          <span className="num small muted">actual <b><Money value={data.actual} cents={false} /></b></span>
          <span className={cx("num small bold", !income && data.remaining < 0 ? "neg" : "")} style={{ width: 92, textAlign: "right" }}>
            <Money value={data.remaining} cents={false} />
          </span>
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

            <div style={{ width: 116 }}>
              <BudgetAmountPopover category={r.category} month={month} kind={income ? "income" : "expense"} />
            </div>
            <Link
              to={`/transactions?category=${r.category.id}&month=${month}`}
              className="num right" style={{ width: 100 }}
            >
              <Money value={r.actual} cents={false} />
            </Link>
            <span className={cx("num right bold", over ? "neg" : r.remaining > 0 ? "muted" : "")} style={{ width: 100 }}>
              <Money value={r.remaining} cents={false} />
            </span>
            <Popover
              align="right"
              trigger={(open) => <button className="btn btn-ghost btn-icon" onClick={open}>⋯</button>}
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
