import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import type { Category, MonthKey } from "../types";
import { useDB, useStore } from "../store";
import { addMonths, monthLabel } from "../lib/date";
import { fmt0 } from "../lib/money";
import { budgetSummary, categoryAverage, categoryHistory, plannedFor } from "../lib/select";
import { coarsePointer } from "../lib/pointer";
import { BarChart } from "../components/charts";
import { Money, MoneyInput, Popover } from "../components/ui";

const WINDOW = 6;

/** The fixed nudges, in cents. Round amounts, because that is how people top a line up. */
const QUICK = [25_00, 50_00, 100_00];

/**
 * The budget figure, and the history behind it.
 *
 * Clicking the amount opens what the number is for: what was actually spent in
 * recent months, the average, and one click to adopt either — plus the standing
 * amount that saves setting the same figure twelve times.
 */
export function BudgetAmountPopover({ category, month, kind }: {
  category: Category;
  month: MonthKey;
  kind: "income" | "expense";
}) {
  const db = useDB();
  const planned = plannedFor(db, month, category.id);

  return (
    <Popover
      width={330}
      align="right"
      className="budget-menu"
      fill
      trigger={(open) => (
        <button className="btn budget-amount" onClick={open} title="Set this budget">
          <Money value={planned} cents={false} />
        </button>
      )}
    >
      {(close) => <Panel category={category} month={month} kind={kind} onDone={close} />}
    </Popover>
  );
}

function Panel({ category, month, kind, onDone }: {
  category: Category;
  month: MonthKey;
  kind: "income" | "expense";
  onDone: () => void;
}) {
  const db = useDB();
  const { actions } = useStore();

  const months = useMemo(
    () => Array.from({ length: WINDOW }, (_, i) => addMonths(month, -(WINDOW - i))),
    [month],
  );
  const history = useMemo(() => categoryHistory(db, category.id, months), [db, category.id, months]);
  const average = categoryAverage(history);
  const lastMonth = history[history.length - 1]?.actual ?? 0;

  const [amount, setAmount] = useState(() => plannedFor(db, month, category.id));
  // Off every time the panel opens: ticking it does a thing, it does not
  // describe a state the document is in. Nothing about it is remembered.
  const [forward, setForward] = useState(false);

  const commit = (next: number) => {
    setAmount(next);
    if (forward) actions.applyPlannedForward(month, category.id, next);
    else actions.setPlanned(month, category.id, next);
  };

  const toggleForward = (on: boolean) => {
    setForward(on);
    if (on) actions.applyPlannedForward(month, category.id, amount);
  };

  const verb = kind === "income" ? "Earned" : "Spent";

  // Read live rather than captured when the panel opened, so the button empties
  // the moment it is pressed and cannot be pressed twice into an overdraft.
  // Same figure as the "Left to budget" tile at the top of the screen.
  const left = budgetSummary(db, month).leftToBudget;

  return (
    <div className="budget-panel">
      <div className="spread" style={{ marginBottom: 10 }}>
        <span className="row" style={{ gap: 7 }}>
          <span>{category.icon}</span>
          <span className="bold">{category.name}</span>
        </span>
        <span className="tiny faint">{monthLabel(month, true)}</span>
      </div>

      {/* Not focused on a touch screen: focusing it there raises the keyboard
          over the panel, which hides the buttons most people opened it for. */}
      <MoneyInput value={amount} onChange={commit} autoFocus={!coarsePointer()} />

      <div className="budget-quick">
        {QUICK.map((q) => (
          <button key={q} className="btn btn-sm" onClick={() => commit(amount + q)}>+{fmt0(q)}</button>
        ))}
      </div>
      {/* Spending only. On an income line, adding what is unassigned would
          plan more income to cover a gap, which is the wrong way round. */}
      {kind === "expense" ? (
        <button
          className="btn btn-sm budget-quick-left"
          onClick={() => commit(amount + left)}
          disabled={left <= 0}
        >
          {left > 0 ? `Add the ${fmt0(left)} left to budget` : "Nothing left to budget"}
        </button>
      ) : null}

      <div className="tile-label" style={{ marginTop: 12 }}>History</div>

      <div className="grid g2" style={{ gap: 8, marginTop: 6 }}>
        <button className="budget-stat" onClick={() => commit(lastMonth)} disabled={!lastMonth}>
          <span className="num bold" style={{ fontSize: 17 }}>{fmt0(lastMonth)}</span>
          <span className="tiny faint">{verb} last month</span>
        </button>
        <button className="budget-stat" onClick={() => commit(average)} disabled={!average}>
          <span className="num bold" style={{ fontSize: 17 }}>{fmt0(average)}</span>
          <span className="tiny faint">Monthly average</span>
        </button>
      </div>

      <div className="budget-chart">
        <BarChart
          height={128}
          compact
          groups={history.map((h) => ({
            label: monthLabel(h.month, true).split(" ")[0].toUpperCase(),
            bars: [{ key: verb, value: h.actual, tone: kind === "income" ? "--c3" : category.color }],
          }))}
          onClickGroup={(i) => {
            const hit = history[i];
            if (hit) commit(hit.actual);
          }}
        />
      </div>

      <label className="budget-forward">
        <input
          type="checkbox" className="cb" checked={forward}
          onChange={(e) => toggleForward(e.target.checked)}
        />
        <span className="small">Apply {fmt0(amount)} to all future months</span>
        <span
          className="faint"
          title="Writes this figure into this month and the five years after it, once. Months already past are untouched, and changing a single month afterwards changes only that month."
        >
          <Info size={13} />
        </span>
      </label>

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <button className="btn btn-sm btn-primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
