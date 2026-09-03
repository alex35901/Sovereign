import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, Pencil } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { monthLabel } from "../lib/date";
import { toCSV } from "../lib/csv";
import { download } from "../lib/storage";
import { categoryActivity, categoryBudget, remainingTone } from "../lib/select";
import { alignsToMonths, monthsIn } from "../lib/buckets";
import { Btn, Card, CardHead, Empty, Money } from "../components/ui";
import { CategoryModal } from "./SettingsPanels";
import type { Period } from "./Drilldown";
import { Drilldown, Line, SummaryCard } from "./Drilldown";

/**
 * One category, broken all the way down.
 *
 * The chart, the period and the transaction list are Drilldown's, shared with
 * the merchant page. What belongs only here is the budget: the plan for the
 * months the period covers, and how much of it is left.
 */
export default function CategoryDetail() {
  const { id = "" } = useParams();
  const db = useDB();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);

  const category = db.categories.find((c) => c.id === id);
  const group = db.groups.find((g) => g.id === category?.groupId);

  // Bars run from the first transaction in this category up to today, so the
  // chart still has a present-day edge for a category that stopped months ago.
  const earliest = useMemo(() => {
    let first: string | null = null;
    for (const t of db.transactions) {
      const mine = t.categoryId === id || t.splits?.some((s) => s.categoryId === id);
      if (mine && (first === null || t.date < first)) first = t.date;
    }
    return first;
  }, [db.transactions, id]);

  const load = useCallback(
    (from: string, to: string) => categoryActivity(db, id, from, to),
    [db, id],
  );

  if (!category) {
    return (
      <>
        <TopBar title="Category" />
        <div className="page">
          <Empty
            title="No such category"
            body="It may have been deleted or renamed."
            action={<Btn variant="primary" onClick={() => nav("/categories")}>All categories</Btn>}
          />
        </div>
      </>
    );
  }

  const exportCSV = (period: Period) => {
    const slug = category.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    download(`${slug}-${period.key}.csv`, toCSV(db, period.entries.map((e) => e.txn)));
  };

  return (
    <>
      <Drilldown
        title={`${category.icon} ${category.name}`}
        actions={(period) => (
          <>
            <Btn onClick={() => setEditing(true)}><Pencil size={14} /> <span className="btn-label">Edit</span></Btn>
            <Btn onClick={() => exportCSV(period)} disabled={!period.entries.length}>
              <Download size={14} /> <span className="btn-label">Export</span>
            </Btn>
          </>
        )}
        tone={category.color}
        earliest={earliest}
        load={load}
        nothingEver="Nothing has ever been put in this category."
        crumb={
          <>
            <Link to="/transactions" className="row tiny faint" style={{ gap: 5 }}>
              <ArrowLeft size={13} /> Transactions
            </Link>
            {group ? <span className="tiny faint">· in {group.name}</span> : null}
            {category.excludeFromBudget ? (
              <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>off-budget</span>
            ) : null}
          </>
        }
        aside={(period) => (
          <>
            <BudgetCard categoryId={id} period={period} excluded={category.excludeFromBudget} />
            <SummaryCard period={period} />
          </>
        )}
      />
      {editing ? <CategoryModal category={category} groupId={category.groupId} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

function BudgetCard({ categoryId, period, excluded }: {
  categoryId: string; period: Period; excluded: boolean;
}) {
  const db = useDB();
  const months = monthsIn(period.key, period.grain);
  const budget = useMemo(
    () => categoryBudget(db, categoryId, months),
    [db, categoryId, months.join()],
  );

  return (
    <Card>
      <CardHead
        title="Budget"
        sub={months.length === 1
          ? monthLabel(months[0]!)
          : `${monthLabel(months[0]!, true)} – ${monthLabel(months.at(-1)!, true)}`}
      />
      {excluded ? (
        <div className="small faint">
          This category is set to stay out of the budget, so nothing is planned for it and it is not
          counted as spending anywhere.
        </div>
      ) : (
        <div className="col" style={{ gap: 9 }}>
          <Line label="Planned" value={budget.planned} />
          <Line label="Actual" value={budget.actual} />
          {budget.rollover ? <Line label="Rolled over" value={budget.rollover} faint /> : null}
          <div className="divider" style={{ margin: "3px 0" }} />
          <div className="spread">
            <span className="small muted">Remaining</span>
            <span className={`num bold ${remainingTone(budget.remaining)}`}>
              <Money value={budget.remaining} />
            </span>
          </div>
          {!alignsToMonths(period.grain) ? (
            <div className="tiny faint">
              Budgets are set by the month, so this is {months.length === 1 ? "the whole month" : "the whole span"} around
              the {period.grain} above — not a slice of it.
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
