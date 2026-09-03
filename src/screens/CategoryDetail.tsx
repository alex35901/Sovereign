import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download, Pencil } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import type { Transaction } from "../types";
import { dateLabel, monthLabel } from "../lib/date";
import { toCSV } from "../lib/csv";
import { download } from "../lib/storage";
import {
  categoryActivity, categoryBudget, categoryByPeriod, categoryStats, remainingTone,
} from "../lib/select";
import type { Grain } from "../lib/buckets";
import {
  GRAINS, alignsToMonths, bucketLabel, bucketOf, bucketSpan, bucketTitle,
  currentBucket, isGrain, lastBuckets, monthsIn,
} from "../lib/buckets";
import { BarChart } from "../components/charts";
import { Btn, Card, CardHead, Empty, Money, Segmented } from "../components/ui";
import { Row } from "./Transactions";
import { TransactionModal } from "./TransactionModal";
import { CategoryModal } from "./SettingsPanels";

/**
 * One category, broken all the way down.
 *
 * The shape is: a bar per period across the whole history, one of them picked,
 * and everything below the chart describing that one period. Clicking a bar
 * moves the selection, which is the fastest way to answer "was August unusual"
 * — the question a page like this exists for.
 *
 * The grain and the selected period live in the URL. A link to a specific
 * quarter of a specific category is then just a link, the back button works,
 * and a reload lands where you were rather than back at today.
 */

/** How much history to draw at each grain, so the bars stay readable. */
const SPAN: Record<Grain, number> = { day: 60, week: 26, month: 24, quarter: 12, year: 8 };

export default function CategoryDetail() {
  const { id = "" } = useParams();
  const db = useDB();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState(120);

  const category = db.categories.find((c) => c.id === id);
  const group = db.groups.find((g) => g.id === category?.groupId);

  const grainParam = params.get("by") ?? "";
  const grain: Grain = isGrain(grainParam) ? grainParam : "month";

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

  const buckets = useMemo(() => {
    const now = currentBucket(grain);
    if (!earliest) return [now];
    // Newest SPAN periods, counted back from today: a daily chart of four
    // years is a grey smear, and it has to be the recent end that survives.
    return lastBuckets(earliest, bucketSpan(now, grain).to, grain, SPAN[grain]);
  }, [earliest, grain]);

  const setGrain = (by: Grain) => {
    // The period is dropped, not translated: "Q3" is not a week, and guessing
    // would land somewhere the user did not pick. The default is the newest,
    // which is where the eye goes anyway.
    const next = new URLSearchParams(params);
    next.set("by", by);
    next.delete("at");
    setLimit(120);
    setParams(next, { replace: true });
  };
  const setSelected = (at: string) => {
    setLimit(120);
    const next = new URLSearchParams(params);
    next.set("by", grain);
    next.set("at", at);
    setParams(next, { replace: true });
  };

  // Every entry across the whole chart, fetched once and split two ways: the
  // bars want all of it, the detail below wants the selected period.
  const wide = useMemo(() => {
    const from = bucketSpan(buckets[0]!, grain).from;
    const to = bucketSpan(buckets.at(-1)!, grain).to;
    return categoryActivity(db, id, from, to);
  }, [db, id, buckets, grain]);

  const totals = useMemo(
    () => categoryByPeriod(wide.entries, buckets, (d) => bucketOf(d, grain)),
    [wide.entries, buckets, grain],
  );

  /** Which periods actually contain something, which is not the same question
   *  as which ones total something: both halves of a credit card payment land
   *  in one month and cancel, and a month of them is busy, not empty. */
  const populated = useMemo(() => {
    const out = new Set<string>();
    for (const e of wide.entries) out.add(bucketOf(e.txn.date, grain));
    return out;
  }, [wide.entries, grain]);

  /**
   * Which period the detail below describes.
   *
   * The default is the newest one with anything in it, not simply the newest.
   * Daily on a category you touch once a week means most bars are empty, and
   * landing on an empty Tuesday answers no question anybody had.
   */
  const selected = (() => {
    const asked = params.get("at");
    if (asked && buckets.includes(asked)) return asked;
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (populated.has(buckets[i]!)) return buckets[i]!;
    }
    return buckets.at(-1)!;
  })();

  const span = bucketSpan(selected, grain);
  const period = useMemo(
    () => ({
      entries: wide.entries.filter((e) => e.txn.date >= span.from && e.txn.date <= span.to),
      skipped: categoryActivity(db, id, span.from, span.to).skipped,
    }),
    [wide.entries, span.from, span.to, db, id],
  );
  const stats = categoryStats(period.entries);
  const months = monthsIn(selected, grain);
  const budget = useMemo(() => categoryBudget(db, id, months), [db, id, months.join()]);

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

  const tone = category.color;
  // The unselected bars are the category's own colour, dimmed — not a neutral
  // grey, which disappears into the card and makes the chart look like it
  // failed to load. The selected one is the colour at full strength.
  const dim = `color-mix(in srgb, var(${tone}) 38%, var(--surface))`;
  const bars = buckets.map((key) => ({
    label: bucketLabel(key, grain),
    bars: [{
      key: bucketTitle(key, grain),
      // Spending is stored negative and a chart of downward bars reads as
      // losses, not as a grocery bill. Drawn by size, signed in the tooltip.
      value: Math.abs(totals.get(key) ?? 0),
      tone: key === selected ? `var(${tone})` : dim,
    }],
  }));

  const exportCSV = () => {
    const rows = period.entries.map((e) => e.txn);
    download(`${category.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${selected}.csv`, toCSV(db, rows));
  };

  return (
    <>
      <TopBar
        title={`${category.icon} ${category.name}`}
        actions={
          <>
            <Btn onClick={() => setEditing(true)}><Pencil size={14} /> <span className="btn-label">Edit</span></Btn>
            <Btn onClick={exportCSV} disabled={!period.entries.length}>
              <Download size={14} /> <span className="btn-label">Export</span>
            </Btn>
          </>
        }
      />

      <div className="page stack">
        <div className="row wrap" style={{ gap: 10 }}>
          <Link to="/transactions" className="row tiny faint" style={{ gap: 5 }}>
            <ArrowLeft size={13} /> Transactions
          </Link>
          {group ? <span className="tiny faint">· in {group.name}</span> : null}
          {category.excludeFromBudget ? (
            <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>off-budget</span>
          ) : null}
        </div>

        <Card>
          <CardHead
            title="Over time"
            sub={`${bars.length} ${GRAINS.find((g) => g.value === grain)!.label.replace(/ly$/, "").toLowerCase()}${bars.length === 1 ? "" : "s"} — click one to look at it`}
            right={<Segmented value={grain} options={GRAINS} onChange={setGrain} />}
          />
          {earliest ? (
            <BarChart
              groups={bars}
              height={210}
              onClickGroup={(label) => {
                const key = buckets.find((k) => bucketLabel(k, grain) === label);
                if (key) setSelected(key);
              }}
            />
          ) : (
            <div className="small faint" style={{ padding: "28px 0", textAlign: "center" }}>
              Nothing has ever been put in this category.
            </div>
          )}
        </Card>

        <h2 className="period-title">{bucketTitle(selected, grain)}</h2>

        <div className="grid g-2-1">
          <Card pad={false}>
            <CardHead flush title="Transactions" right={<span className="tiny faint">{stats.count.toLocaleString()}</span>} />
            {period.entries.length ? (
              <>
                <div className="list-row tx-grid head">
                  <span />
                  <span />
                  <span className="tiny faint">Merchant</span>
                  <span className="tiny faint tx-account">Account</span>
                  <span className="tiny faint tx-category">Category</span>
                  <span className="tiny faint tx-amount">Amount</span>
                </div>
                {period.entries.slice(0, limit).map((e) => (
                  <div key={e.txn.id}>
                    <div className="date-head tx-grid">
                      <span className="date-head-label">{dateLabel(e.txn.date, { weekday: true, year: true })}</span>
                      <span className="num tx-amount"><Money value={e.amount} colored /></span>
                    </div>
                    <Row txn={e.txn} onEdit={() => setEditTxn(e.txn)} amount={e.partial ? e.amount : undefined} />
                  </div>
                ))}
              </>
            ) : (
              <div className="empty">
                <h3>Nothing in {bucketTitle(selected, grain)}</h3>
                <div className="small">Pick another bar above.</div>
              </div>
            )}
            {period.entries.length > limit ? (
              <div style={{ padding: 12, textAlign: "center" }}>
                <Btn onClick={() => setLimit((n) => n + 240)}>
                  Show more ({(period.entries.length - limit).toLocaleString()} remaining)
                </Btn>
              </div>
            ) : null}
            {period.skipped ? (
              <div className="tiny faint" style={{ padding: "10px 16px", borderTop: "1px solid var(--line-soft)" }}>
                {period.skipped} more {period.skipped === 1 ? "is" : "are"} hidden from reports, or in an account set to
                hide its transactions. They are left out of everything on this page, the same as on the Budget screen.
              </div>
            ) : null}
          </Card>

          <div className="stack">
            <Card>
              <CardHead
                title="Budget"
                sub={months.length === 1 ? monthLabel(months[0]!) : `${monthLabel(months[0]!, true)} – ${monthLabel(months.at(-1)!, true)}`}
              />
              {category.excludeFromBudget ? (
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
                  {!alignsToMonths(grain) ? (
                    <div className="tiny faint">
                      Budgets are set by the month, so this is {months.length === 1 ? "the whole month" : "the whole span"} around
                      the {grain} above — not a slice of it.
                    </div>
                  ) : null}
                </div>
              )}
            </Card>

            <Card>
              <CardHead title="Summary" sub={bucketTitle(selected, grain)} />
              <div className="col" style={{ gap: 9 }}>
                <Line label="Transactions" plain={stats.count.toLocaleString()} />
                <Line label="Average" value={stats.average} signed />
                <Line label="Largest" value={stats.largest} signed />
                <div className="divider" style={{ margin: "3px 0" }} />
                <div className="spread">
                  <span className="small muted">Total</span>
                  <span className="num bold"><Money value={stats.total} colored /></span>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>

      {editTxn ? <TransactionModal txn={editTxn} onClose={() => setEditTxn(null)} /> : null}
      {editing ? <CategoryModal category={category} groupId={category.groupId} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

function Line({ label, value, plain, faint, signed }: {
  label: string; value?: number; plain?: string; faint?: boolean; signed?: boolean;
}) {
  return (
    <div className="spread">
      <span className={`small ${faint ? "faint" : "muted"}`}>{label}</span>
      <span className="num">
        {plain !== undefined ? plain : <Money value={value ?? 0} colored={signed} />}
      </span>
    </div>
  );
}
