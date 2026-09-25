import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronDown, ChevronRight } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { addMonths, monthLabel, thisMonth } from "../lib/date";
import { PHONE, useMediaQuery } from "../lib/media";
import { useSwipe } from "../lib/swipe";
import { budgetSummary, remainingTone, spentShare } from "../lib/select";
import { fmt0 } from "../lib/money";
import type { BudgetGroupRow, BudgetRow } from "../lib/select";
import { Btn, Card, HoverCard, Money, Progress, cx } from "../components/ui";
import { BudgetAmountPopover } from "./BudgetAmountPopover";
import { BudgetMovePopover } from "./BudgetMovePopover";
import { MonthNav } from "../components/pickers";
import { COLUMN_LABEL, DEFAULT_COLUMN, otherColumn, readColumn, toggleHint } from "../lib/budget-column";
import type { BudgetColumn } from "../lib/budget-column";

/** Where the column choice is remembered, per browser. */
const COLUMN_KEY = "sovereign.budget.column";

export default function Budget() {
  const db = useDB();
  const [month, setMonth] = useState(thisMonth());
  const phone = useMediaQuery(PHONE);

  /**
   * Which way the last swipe went, until the slide it starts has finished.
   *
   * The gesture needs an answer: a sheet that changes silently under a finger
   * reads as a misfire, and the direction is the part worth confirming. Set on
   * the swipe and cleared when the animation ends, so a reader who prefers no
   * motion gets the new month and nothing else.
   */
  const [swiped, setSwiped] = useState<"next" | "previous" | null>(null);
  const turn = (by: number) => {
    setMonth((m) => addMonths(m, by));
    setSwiped(by > 0 ? "next" : "previous");
  };
  const swipe = useSwipe(() => turn(1), () => turn(-1));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const summary = useMemo(() => budgetSummary(db, month), [db, month]);

  /**
   * Which of Actual and Remaining a narrow screen shows. Wide screens show
   * both and never read this.
   *
   * In localStorage rather than in the document, because it is one viewer's
   * convenience on one device rather than anything about the household's
   * money, and a phone choosing Remaining should not change what the laptop
   * shows. Read lazily and written in an effect, both guarded: storage throws
   * in a private window and comes back empty when site data is cleared, and
   * neither is a reason for the budget not to render.
   */
  const [column, setColumn] = useState<BudgetColumn>(() => {
    try {
      return readColumn(localStorage.getItem(COLUMN_KEY));
    } catch {
      return DEFAULT_COLUMN;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_KEY, column);
    } catch { /* a preference not remembered is not worth failing over */ }
  }, [column]);

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const back = (
    <Btn
      onClick={() => setMonth(thisMonth())}
      disabled={month === thisMonth()}
      title={`Jump back to ${monthLabel(thisMonth())}`}
    >
      <CalendarDays size={14} /> <span className="btn-label">This month</span>
    </Btn>
  );
  const nav = <MonthNav month={month} onChange={setMonth} heading={phone} />;

  return (
    <>
      {/* The month is the whole context for this screen: every figure on it is
          about one month, and the way to another one used to sit inside the
          first card, where it scrolled away with the card.
          On a phone it is the heading as well. The word "Budget" is already on
          the rail at the bottom of the screen, and spending a third of the bar
          repeating it left the month sharing what was left with a button. */}
      <TopBar
        title={phone ? nav : "Budget"}
        actions={phone ? back : <>{nav}{back}</>}
      />
      {/* The chosen column is read in CSS rather than in each row: the rule
          that hides the other one belongs with the widths it is trading
          against, and a row should not have to know how wide the screen is. */}
      <div
        className={cx("page stack", swiped && "month-turned", swiped === "next" && "from-right")}
        data-bcol={column}
        // A flick left is next, the way every calendar on the device works.
        {...swipe}
        // This element's own slide, not a chart's wipe inside it: animation
        // events bubble, and a bar finishing first would cut the slide short.
        onAnimationEnd={(e) => { if (e.target === e.currentTarget) setSwiped(null); }}
      >
        <Card>
          <div className="spread wrap" style={{ gap: 12 }}>
            {/* An even grid rather than a row of content-sized columns: four
                figures of different lengths left-aligned under labels of
                different lengths never looked like four of the same thing. */}
            <div className="budget-stats">
              <Stat label="Planned income" value={summary.plannedIncome} actual={summary.actualIncome} />
              <Stat label="Planned expenses" value={summary.plannedExpense} actual={summary.actualExpense} />
              <Stat label="Left to budget" value={summary.leftToBudget} tone />
              <Stat label="Actual saved" value={summary.actualSavings} tone />
            </div>
          </div>
          <div className="divider" />
          {/* Green while the spending is inside the plan, red once it is not,
              and the plan itself marked — because once spending passes it the
              bar grows past it too, and the plan stops being the bar's end. */}
          <Progress
            value={summary.actualExpense} max={Math.max(summary.plannedExpense, summary.actualExpense, 1)}
            over={summary.actualExpense > summary.plannedExpense}
            color="--pos"
            mark={summary.plannedExpense}
            markTitle={`Planned ${fmt0(summary.plannedExpense)}`}
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
            column={column} onColumn={setColumn}
          />
        ))}
      </div>
    </>
  );
}

function Stat({ label, value, actual, tone }: {
  label: string; value: number;
  /** The figure that actually happened, under the one that was planned. */
  actual?: number;
  /** Green or red on its sign, for the two figures that are a verdict. */
  tone?: boolean;
}) {
  return (
    <div className="col">
      <span className="tile-label">{label}</span>
      <span className={cx("num bold", tone && (value < 0 ? "neg" : "pos"))} style={{ fontSize: 20 }}>
        <Money value={value} cents={false} />
      </span>
      {actual !== undefined ? <span className="tiny faint">actual <Money value={actual} cents={false} /></span> : null}
    </div>
  );
}

function GroupCard({ data, month, collapsed, onToggle, column, onColumn }: {
  data: BudgetGroupRow; month: string; collapsed: boolean; onToggle: () => void;
  column: BudgetColumn; onColumn: (c: BudgetColumn) => void;
}) {
  const income = data.group.kind === "income";
  return (
    <Card pad={false}>
      <div className="card-head flush bgroup-head" style={{ cursor: "pointer" }} onClick={onToggle}>
        <div className="row" style={{ gap: 7 }}>
          {collapsed ? <ChevronRight size={15} className="faint" /> : <ChevronDown size={15} className="faint" />}
          <h2>{data.group.name}</h2>
        </div>
        <div className="row budget-head">
          <div className="bcol bcol-plan">
            <div className="tile-label">Planned</div>
            <div className="num small bold"><Money value={data.planned} cents={false} /></div>
          </div>
          <div className="bcol bcol-actual">
            <ColumnHead column="actual" showing={column} onColumn={onColumn} />
            <div className="num small bold"><Money value={data.actual} cents={false} /></div>
          </div>
          <div className="bcol bcol-left">
            <ColumnHead column="remaining" showing={column} onColumn={onColumn} />
            <div className={cx("num small bold", remainingTone(data.remaining, data.group.kind as "income" | "expense" | "transfer"))}>
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
 * A column's heading, which on a narrow screen is how the other column is
 * asked for.
 *
 * Both headings are always rendered. On a wide screen both columns are there
 * and this is an ordinary label that does nothing; on a narrow one the other
 * column is hidden, so exactly one of these is on screen and it is the switch.
 * That is why the dotted underline is applied by the same media query that
 * does the hiding rather than here: the affordance and the behaviour have to
 * appear together or it is a label that lies.
 */
function ColumnHead({ column, showing, onColumn }: {
  column: BudgetColumn; showing: BudgetColumn; onColumn: (c: BudgetColumn) => void;
}) {
  return (
    <button
      type="button"
      className="tile-label bcol-toggle"
      // The card head collapses the group, and this sits inside it.
      onClick={(e) => { e.stopPropagation(); onColumn(otherColumn(showing)); }}
      aria-label={`${COLUMN_LABEL[column]}. ${toggleHint(showing)}`}
    >
      {COLUMN_LABEL[column]}
    </button>
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
                  <span className={cx("btn budget-amount remaining", remainingTone(r.remaining, r.kind))}>
                    {/* No rollover mark: income does not roll over, whatever
                        the category's flag happens to say. */}
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

/**
 * The whole month for one category, shown when you point at what's left.
 *
 * Every line here was written for an expense and read as nonsense on income:
 * money earned was "spent", what you expect to be paid was "available to
 * spend", and being paid more than planned filled the bar as an overspend.
 * Same figures, said the way the category actually works.
 */
function RemainingCard({ row }: { row: BudgetRow }) {
  const income = row.kind === "income";
  const available = row.rollover + row.planned;
  const share = spentShare(available, row.actual);
  // For income the last line is about what has arrived, which can be more than
  // was expected, so the bar is full rather than over.
  const over = !income && row.remaining < 0;
  return (
    <>
      <div className="hc-title">{row.category.icon} {row.category.name}</div>
      <div className="hc-body">
        {/* Shown at zero too, for a category with rollover switched on. A
            line that appears only when something carried leaves "rollover is
            off" and "rollover is on and nothing was left" looking identical,
            which is the difference somebody is actually trying to see. */}
        {row.category.rollover && !income
          ? <HcLine label="Carried in" value={row.rollover} tone={row.rollover ? "pos" : undefined} />
          : null}
        <HcLine label={income ? "Expected" : "Planned"} value={row.planned} />
        {income ? null : <HcLine label="Available to spend" value={available} />}
        <HcLine label={income ? "Received" : "Actual"} value={row.actual} />
      </div>
      <div className="hc-foot">
        <HcLine
          label={income ? (row.remaining < 0 ? "More than expected" : "Still to come") : "Remaining"}
          value={income ? Math.abs(row.remaining) : row.remaining}
          tone={remainingTone(row.remaining, row.kind)}
          bold
        />
        <Progress
          value={row.actual} max={Math.max(available, row.actual, 1)}
          color={row.category.color} over={over}
        />
        {row.category.rollover && !income && !row.rollover ? (
          <div className="tiny faint">Nothing was left over in the months before this one.</div>
        ) : null}
        <div className="tiny faint">
          {income
            ? (share === null
              ? `Nothing expected. ${fmt0(row.actual)} received`
              : `${share}% of the ${fmt0(available)} expected has arrived`)
            : (share === null
              ? `Nothing planned. ${fmt0(row.actual)} spent`
              : `${share}% of the ${fmt0(available)} available spent`)}
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
