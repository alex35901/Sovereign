import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronDown, ChevronRight, RotateCcw, Sparkles } from "lucide-react";
import { useDB, useStore } from "../store";
import { IconAction, TopBar } from "../shell/TopBar";
import { monthLabel, thisMonth } from "../lib/date";
import { budgetSummary, remainingTone, spentShare } from "../lib/select";
import { fmt0 } from "../lib/money";
import type { BudgetGroupRow, BudgetRow } from "../lib/select";
import { Btn, Card, HoverCard, Money, Progress, cx } from "../components/ui";
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
            <IconAction
              title="Auto-fill from the last three months' average"
              onClick={() => actions.autofillBudget(month)}
            >
              <Sparkles size={16} />
            </IconAction>
            <IconAction title="Clear this month's plan" onClick={() => actions.clearBudget(month)}>
              <RotateCcw size={16} />
            </IconAction>
          </>
        }
      />
      <div className="page stack">
        <Card>
          <div className="spread wrap" style={{ gap: 12 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              {/* No forward limit: planning two or ten years out is the point
                  of a standing amount, and a cap at six months made the sheet
                  stop dead in the middle of next year. */}
              <MonthNav month={month} onChange={setMonth} />
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
        </div>
      </div>

      {collapsed ? null : data.rows.map((r) => (
        <RowLine key={r.category.id} row={r} month={month} income={income} />
      ))}
    </Card>
  );
}

/**
 * One category. Holds whether its move panel is open, so the hover card can be
 * suppressed while that panel covers the same spot.
 */
function RowLine({ row: r, month, income }: { row: BudgetRow; month: string; income: boolean }) {
  const [moving, setMoving] = useState(false);
  return (
          <div className="list-row">
            <span style={{ fontSize: 15, width: 22 }}>{r.category.icon}</span>
            {/* The name opens the category's own page; Actual, further along,
                still goes to the transactions behind this month's figure. */}
            <Link to={`/categories/${r.category.id}`} className="grow truncate cat-open" style={{ fontWeight: 500 }}>
              {r.category.name}
            </Link>

            <div className="bcol bcol-plan">
              <BudgetAmountPopover category={r.category} month={month} kind={income ? "income" : "expense"} />
            </div>
            <Link
              to={`/transactions?category=${r.category.id}&month=${month}`}
              className="num bcol bcol-actual"
            >
              <Money value={r.actual} cents={false} />
            </Link>
            <div className="bcol bcol-left">
              <HoverCard fill width={266} disabled={moving} card={<RemainingCard row={r} />}>
                {income ? (
                  <span className={cx("btn budget-amount remaining", remainingTone(r.remaining))}>
                    {r.category.rollover ? <RotateCcw size={11} className="rollover-mark" /> : null}
                    <Money value={r.remaining} cents={false} />
                  </span>
                ) : (
                  <BudgetMovePopover
                    category={r.category} month={month} remaining={r.remaining}
                    onOpenChange={setMoving}
                  />
                )}
              </HoverCard>
            </div>
          </div>
  );
}

/** The whole month for one category, shown when you point at what's left. */
function RemainingCard({ row }: { row: BudgetRow }) {
  const available = row.rollover + row.planned;
  const share = spentShare(available, row.actual);
  return (
    <>
      <div className="hc-title">{row.category.icon} {row.category.name}</div>
      <div className="hc-body">
        {row.rollover ? <HcLine label="Rollover from last month" value={row.rollover} tone="pos" /> : null}
        <HcLine label="Planned" value={row.planned} />
        <HcLine label="Available to spend" value={available} />
        <HcLine label="Actual" value={row.actual} />
      </div>
      <div className="hc-foot">
        <HcLine label="Remaining" value={row.remaining} tone={remainingTone(row.remaining)} bold />
        <Progress
          value={row.actual} max={Math.max(available, row.actual, 1)}
          color={row.category.color} over={row.remaining < 0}
        />
        <div className="tiny faint">
          {share === null
            ? `Nothing planned — ${fmt0(row.actual)} spent`
            : `${share}% of the ${fmt0(available)} available spent`}
        </div>
      </div>
    </>
  );
}

function HcLine({ label, value, tone, bold }: { label: string; value: number; tone?: string; bold?: boolean }) {
  return (
    <div className="hc-line">
      <span className="lbl">{label}</span>
      <span className={cx(tone, bold && "bold")}><Money value={value} cents={false} /></span>
    </div>
  );
}
