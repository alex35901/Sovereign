import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Check, Pencil, Plus, TrendingDown, TrendingUp } from "lucide-react";
import type { Recurring as RecurringItem } from "../types";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, longDate, monthEnd, monthStart, parseISO, relativeDayMid, thisMonth, today } from "../lib/date";
import { occurrences, paidOccurrences, recurringList, recurringSpend } from "../lib/select";
import { priceChanges, yearlyImpact } from "../lib/price-watch";
import { isNewRecurring, isSeen } from "../lib/notifications";
import { UNCATEGORIZED } from "../lib/categories";
import { cadenceLabel } from "../lib/recurring";
import type { RecurringSpend } from "../lib/select";
import { MonthGrid } from "../components/charts";
import { Btn, Card, CardHead, Empty, Money, cx } from "../components/ui";
import { CategoryTag } from "../components/pickers";
import { RecurringEditor } from "./RecurringEditor";
import { MerchantAvatar } from "./Transactions";

/**
 * A new item, ready to be filled in.
 *
 * The id is a placeholder: saving re-derives it from the merchant, so adding
 * one by hand for a name the detector already found edits that one rather
 * than leaving two of it on the page. A date rather than a blank, because a
 * schedule with no next date is not a schedule.
 */
const blank = (): RecurringItem => ({
  id: `rec_manual_${Date.now().toString(36)}`,
  merchant: "",
  categoryId: UNCATEGORIZED,
  amount: 0,
  cadence: "monthly",
  nextDate: today(),
  kind: "bill",
  detected: false,
});


export default function Recurring() {
  const db = useDB();
  const [editing, setEditing] = useState<{ item: RecurringItem; exists: boolean } | null>(null);

  const list = useMemo(() => recurringList(db), [db]);

  // Both figures come off the schedule this page draws, so the tiles and the
  // calendar under them cannot disagree about what a month holds.
  const month = thisMonth();
  const thisMonthSpend = useMemo(
    () => recurringSpend(list, monthStart(month), monthEnd(month), today()),
    [list, month],
  );
  const thisYearSpend = useMemo(
    () => recurringSpend(list, `${month.slice(0, 4)}-01-01`, `${month.slice(0, 4)}-12-31`, today()),
    [list, month],
  );

  const [y, m] = month.split("-").map(Number);
  const marks = useMemo(() => {
    const out: Record<number, { tone: string; amount: number; label: string; to: string; paid: boolean }[]> = {};
    for (const r of list) {
      // The schedule says what is due; the bank says what went. Both are
      // needed here: a date in the past is not a payment, and a payment two
      // days early is still this month's.
      const settled = paidOccurrences(db, r, monthStart(month), monthEnd(month));
      // Every occurrence in the visible month, walked the same way the totals
      // above are — days already paid included, since they are what the month
      // has spent.
      for (const date of occurrences(r, monthStart(month), monthEnd(month))) {
        const day = parseISO(date).getDate();
        (out[day] ??= []).push({
          tone: r.amount > 0 ? "--pos" : "--bill", amount: r.amount, label: r.merchant,
          // The same place the row below the calendar goes: one merchant, one
          // page, however you arrived at it.
          to: `/merchants/${encodeURIComponent(r.merchant)}`,
          paid: settled.has(date),
        });
      }
    }
    return out;
  }, [db, list, month]);

  return (
    <>
      <TopBar
        title="Recurring"
        primary={
          <Btn variant="primary" onClick={() => setEditing({ item: blank(), exists: false })}>
            <Plus size={14} /> Recurring
          </Btn>
        }
      />
      <div className="page stack">
        {/* How much of what is committed has already gone, so what is left is
            a figure to plan against rather than a total to work out. */}
        <div className="grid g2">
          <SpendTile
            label="This month" spend={thisMonthSpend}
            sub={thisMonthSpend.upcoming
              ? `${thisMonthSpend.upcoming} more due this month`
              : "nothing else due this month"}
          />
          <SpendTile
            label="This year" spend={thisYearSpend}
            sub={thisYearSpend.upcoming
              ? `${thisYearSpend.upcoming} more due this year`
              : "nothing else due this year"}
          />
        </div>

        <PriceWatch />

        {/* The calendar first and across the whole page: it is the thing this
            screen is for, and in a third of the width its cells could hold a
            dot and nothing else. */}
        <Card>
          <CardHead title="This month" sub={<span className="row" style={{ gap: 5 }}><CalendarDays size={13} /> {dateLabel(today(), { year: true })}</span>} />
          <MonthGrid year={y} month={m} marks={marks} />
          <div className="divider" />
          <div className="row" style={{ gap: 16 }}>
            <span className="row tiny muted" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--bill)" }} /> Bills</span>
            <span className="row tiny muted" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--pos)" }} /> Income</span>
            <span className="row tiny muted" style={{ gap: 5 }}><Check size={11} className="cal-tick" strokeWidth={3} /> Paid</span>
          </div>
        </Card>

        <Card pad={false}>
            <CardHead flush title="Upcoming" sub="Detected from your transaction history, plus anything you've added" />
            {list.map((r) => (
              // The row is the merchant, so it goes where every other merchant
              // on this app goes. Editing the schedule is the rarer thing and
              // gets a button rather than the whole row.
              <Link
                key={r.id} to={`/merchants/${encodeURIComponent(r.merchant)}`}
                className="list-row click rec-row"
              >
                <MerchantAvatar name={r.merchant} size={30} />
                <div className="grow col" style={{ gap: 1 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="truncate" style={{ fontWeight: 500 }}>{r.merchant}</span>
                    {isNewRecurring(r) && !isSeen(db, `recurring:${r.id}`)
                      ? <span className="tag rec-new">New</span>
                      : r.detected ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--faint)" }}>auto</span> : null}
                  </span>
                  <span className="tiny faint truncate rec-when">
                    {cadenceLabel(r.cadence)} · next {relativeDayMid(r.nextDate)}
                  </span>
                </div>
                <span className="rec-category"><CategoryTag categoryId={r.categoryId} /></span>
                <span className="num bold" style={{ width: 96, textAlign: "right" }}>
                  <Money value={r.amount} colored={r.amount > 0} />
                </span>
                <button
                  className="btn btn-ghost btn-icon" title="Edit schedule" aria-label={`Edit ${r.merchant}'s schedule`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing({ item: r, exists: true }); }}
                >
                  <Pencil size={14} />
                </button>
              </Link>
            ))}
            {!list.length ? (
              <Empty
                title="Nothing recurring found yet"
                body="Three or more charges from the same merchant on a steady interval will show up here automatically."
              />
            ) : null}
        </Card>
      </div>
      {editing ? (
        <RecurringEditor item={editing.item} exists={editing.exists} startOn onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

/**
 * Spent against committed, as one figure rather than two.
 *
 * "$5,000 of $7,800" says both what has gone and what is still coming; either
 * number on its own leaves the other to be worked out, and the one worth
 * knowing on a page about what happens next is the remainder.
 */
function SpendTile({ label, spend, sub }: { label: string; spend: RecurringSpend; sub: string }) {
  const share = spend.total > 0 ? Math.min(1, spend.spent / spend.total) : 0;
  return (
    <Card>
      <div className="col" style={{ gap: 7 }}>
        <span className="tile-label">{label}</span>
        <span className="tile-value num">
          <Money value={spend.spent} cents={false} />
          <span className="spend-of"> of <Money value={spend.total} cents={false} /></span>
        </span>
        <span className="spend-bar"><i style={{ width: `${share * 100}%` }} /></span>
        <span className="spread tiny muted">
          <span>{sub}</span>
          <span className="num"><Money value={spend.left} cents={false} /> to go</span>
        </span>
      </div>
    </Card>
  );
}

/**
 * What has quietly changed price.
 *
 * Nobody notices two dollars. Six of them over a year is a car service, and
 * the only reason it goes unnoticed is that the charge keeps the name it
 * always had. Cuts are listed beside the rises rather than hidden: a card that
 * only ever brings bad news gets scrolled past.
 *
 * Absent entirely when nothing has moved. An empty "no price rises" card is a
 * thing to read every time the page opens in exchange for saying nothing.
 */
function PriceWatch() {
  const db = useDB();
  const changes = useMemo(() => priceChanges(db), [db]);
  if (!changes.length) return null;

  const impact = yearlyImpact(changes);
  const risen = changes.filter((c) => c.delta > 0).length;

  return (
    <Card pad={false}>
      <CardHead
        flush title="What has changed price"
        sub={`${risen ? `${risen} went up` : "None went up"}`
          + `${changes.length - risen ? `, ${changes.length - risen} came down` : ""}. `
          + "Counted only where the old price had settled, so a bill that swings each month is left out."}
        right={
          <span className="col" style={{ gap: 0, textAlign: "right" }}>
            <span className={cx("num bold", impact > 0 ? "neg" : "pos")}>
              <Money value={Math.abs(impact)} cents={false} />
            </span>
            <span className="tiny faint">{impact > 0 ? "more a year" : "less a year"}</span>
          </span>
        }
      />
      {changes.map((c) => (
        <div key={c.id} className="row price-row">
          <span className={cx("price-arrow", c.delta > 0 ? "neg" : "pos")}>
            {c.delta > 0 ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
          </span>
          <span className="col grow" style={{ gap: 0 }}>
            <span className="bold">{c.merchant}</span>
            <span className="tiny faint">
              <Money value={c.was} cents /> to <Money value={c.now} cents />
              {" "}per {c.cadence === "monthly" ? "month" : c.cadence === "yearly" ? "year" : c.cadence}
              {" · "}from {longDate(c.at)}
            </span>
          </span>
          <span className="col" style={{ gap: 0, textAlign: "right" }}>
            <span className={cx("num bold", c.delta > 0 ? "neg" : "pos")}>
              {c.delta > 0 ? "+" : ""}{c.share}%
            </span>
            <span className="tiny faint">
              {c.delta > 0 ? "costs " : "saves "}
              <Money value={Math.abs(c.yearly)} cents={false} /> a year
            </span>
          </span>
        </div>
      ))}
    </Card>
  );
}
