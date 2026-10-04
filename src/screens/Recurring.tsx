import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Check, Pencil, Plus, TrendingDown, TrendingUp } from "lucide-react";
import type { Recurring as RecurringItem } from "../types";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, longDate, monthEnd, monthLabel, monthStart, parseISO, relativeDayMid, thisMonth, today } from "../lib/date";
import type { RecurringCharge } from "../lib/select";
import { recurringList, recurringMonth, recurringSpend } from "../lib/select";
import { fmt0 } from "../lib/money";
import { priceChanges, yearlyImpact } from "../lib/price-watch";
import { isNewRecurring, isSeen } from "../lib/notifications";
import { UNCATEGORIZED } from "../lib/categories";
import { cadenceLabel } from "../lib/recurring";
import type { RecurringSpend } from "../lib/select";
import { MonthGrid } from "../components/charts";
import { Btn, Card, CardHead, Empty, Money, cx } from "../components/ui";
import { CategoryTag, MonthNav } from "../components/pickers";
import { PHONE, useMediaQuery } from "../lib/media";
import { keep, recall } from "../lib/session-view";
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
  // Added today means it began today. Without this a subscription set up this
  // morning appears in every month of the past, which is the whole reason the
  // field exists; somebody who knows it started earlier can say so.
  startDate: today(),
  kind: "bill",
  detected: false,
});


export default function Recurring() {
  const db = useDB();
  const [editing, setEditing] = useState<{ item: RecurringItem; exists: boolean } | null>(null);

  const list = useMemo(() => recurringList(db), [db]);

  /**
   * Which month the page is showing, remembered for the session.
   *
   * The same arrangement the budget has, and for the same reason: looking at
   * July, opening a merchant and coming back to October throws away the one
   * thing you told the screen. Today's month is still the answer on a fresh
   * start.
   */
  const [month, setMonth] = useState(() => {
    const seen = recall<string | null>("recurring.month", null);
    return seen && /^\d{4}-\d{2}$/.test(seen) ? seen : thisMonth();
  });
  useEffect(() => { keep("recurring.month", month); }, [month]);
  const phone = useMediaQuery(PHONE);
  const now = thisMonth();
  const past = month < now;
  const future = month > now;
  const year = month.slice(0, 4);
  const sameYear = year === now.slice(0, 4);

  // Both figures come off the schedule this page draws, so the tiles and the
  // calendar under them cannot disagree about what a month holds.
  const monthSpend = useMemo(
    () => recurringSpend(list, monthStart(month), monthEnd(month), today()),
    [list, month],
  );
  const yearSpend = useMemo(
    () => recurringSpend(list, `${month.slice(0, 4)}-01-01`, `${month.slice(0, 4)}-12-31`, today()),
    [list, month],
  );

  const [y, m] = month.split("-").map(Number);

  /**
   * The month's charges, behind and ahead, from one walk.
   *
   * The schedule says what is due; the bank says what went. Both are needed:
   * a date in the past is not a payment, and a payment two days early is
   * still this month's. The calendar and the two tables under it read the
   * same answer, so they cannot disagree about what the month holds.
   */
  const charges = useMemo(
    () => recurringMonth(db, list, monthStart(month), monthEnd(month), today()),
    [db, list, month],
  );

  const marks = useMemo(() => {
    const out: Record<number, { tone: string; amount: number; label: string; to: string; paid: boolean }[]> = {};
    for (const c of [...charges.past, ...charges.upcoming]) {
      const day = parseISO(c.date).getDate();
      (out[day] ??= []).push({
        tone: c.item.amount > 0 ? "--pos" : "--bill", amount: c.item.amount, label: c.item.merchant,
        // The same place the row below the calendar goes: one merchant, one
        // page, however you arrived at it.
        to: `/merchants/${encodeURIComponent(c.item.merchant)}`,
        paid: c.paid,
      });
    }
    return out;
  }, [charges]);

  /** What a set of these comes to, counting only money going out. */
  const outflow = (cs: readonly RecurringCharge[]) =>
    cs.reduce((n, c) => n + (c.item.amount < 0 ? -c.item.amount : 0), 0);
  /** Named for the month on screen rather than for today. */
  const inMonth = past || future ? `in ${monthLabel(month)}` : "this month";

  const nav = <MonthNav month={month} onChange={setMonth} heading={phone} />;

  return (
    <>
      <TopBar
        title={phone ? nav : "Recurring"}
        actions={phone ? undefined : nav}
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
          {/* Named for the month being read rather than for today. "This
              month" over July's figures, reached by pressing the arrow twice,
              is the screen disagreeing with itself. */}
          <SpendTile
            label={past || future ? monthLabel(month) : "This month"} spend={monthSpend}
            sub={past
              ? "the month is over"
              : monthSpend.upcoming
                ? `${monthSpend.upcoming} more due${future ? "" : " this month"}`
                : `nothing else due${future ? " then" : " this month"}`}
          />
          <SpendTile
            label={sameYear ? "This year" : year}
            spend={yearSpend}
            sub={year < now.slice(0, 4)
              ? "the year is over"
              : yearSpend.upcoming
                ? `${yearSpend.upcoming} more due ${sameYear ? "this year" : `in ${year}`}`
                : `nothing else due ${sameYear ? "this year" : `in ${year}`}`}
          />
        </div>

        <PriceWatch />

        {/* The calendar first and across the whole page: it is the thing this
            screen is for, and in a third of the width its cells could hold a
            dot and nothing else. */}
        <Card>
          <CardHead
            title={past || future ? monthLabel(month) : "This month"}
            sub={
              <span className="row" style={{ gap: 5 }}>
                <CalendarDays size={13} />
                {past || future ? monthLabel(month) : dateLabel(today(), { year: true })}
              </span>
            }
          />
          <MonthGrid year={y} month={m} marks={marks} />
          <div className="divider" />
          <div className="row" style={{ gap: 16 }}>
            <span className="row tiny muted" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--bill)" }} /> Bills</span>
            <span className="row tiny muted" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--pos)" }} /> Income</span>
            <span className="row tiny muted" style={{ gap: 5 }}><Check size={11} className="cal-tick" strokeWidth={3} /> Paid</span>
          </div>
        </Card>

        {/* What has already gone, between the calendar and what is still to
            come, so the month reads down the page in the order it happens. */}
        <Card pad={false}>
          <CardHead
            flush title="Past"
            sub={charges.past.length
              ? `${fmt0(outflow(charges.past))} already out ${inMonth}, across ${charges.past.length} ${charges.past.length === 1 ? "charge" : "charges"}.`
              : undefined}
          />
          {charges.past.map((c) => (
            <ChargeRow key={`${c.item.id}:${c.date}`} charge={c} onEdit={setEditing} showPaid />
          ))}
          {!charges.past.length ? (
            <Empty
              title={future ? `${monthLabel(month)} has not started` : "Nothing out yet"}
              body={future
                ? "Nothing has come out of a month that is still ahead."
                : `No recurring charge has fallen due ${inMonth} yet.`}
            />
          ) : null}
        </Card>

        <Card pad={false}>
            <CardHead
              flush title="Upcoming"
              sub={charges.upcoming.length
                ? `${fmt0(outflow(charges.upcoming))} still to come ${inMonth}, across ${charges.upcoming.length} ${charges.upcoming.length === 1 ? "charge" : "charges"}. Detected from your transaction history, plus anything you've added.`
                : undefined}
            />
            {charges.upcoming.map((c) => (
              <ChargeRow key={`${c.item.id}:${c.date}`} charge={c} onEdit={setEditing} />
            ))}
            {!charges.upcoming.length ? (
              <Empty
                title={!list.length
                  ? "Nothing recurring found yet"
                  : past ? `${monthLabel(month)} is over` : "Nothing else due"}
                body={!list.length
                  ? "Three or more charges from the same merchant on a steady interval will show up here automatically."
                  : past
                    ? "Everything that month committed to has already happened. The table above has it."
                    : `Nothing further is due ${inMonth}.`}
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
 * One charge, in either table.
 *
 * The row is the merchant, so it goes where every other merchant in this app
 * goes. Editing the schedule is the rarer thing and gets a button rather than
 * the whole row.
 */
function ChargeRow({ charge, onEdit, showPaid }: {
  charge: RecurringCharge;
  onEdit: (e: { item: RecurringItem; exists: boolean }) => void;
  /**
   * Whether to say if the bank has shown this one going out.
   *
   * Only behind you, where the question has an answer. Ahead of today every
   * row would read "not paid", which is not news about anything.
   */
  showPaid?: boolean;
}) {
  const db = useDB();
  const r = charge.item;
  return (
    <Link
      to={`/merchants/${encodeURIComponent(r.merchant)}`}
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
          {cadenceLabel(r.cadence)} · {relativeDayMid(charge.date)}
          {/* A bill that fell due and never arrived is the one thing this
              table knows that the calendar can only show as a missing tick. */}
          {showPaid ? (charge.paid ? " · paid" : " · not seen yet") : ""}
        </span>
      </div>
      <span className="rec-category"><CategoryTag categoryId={r.categoryId} /></span>
      <span className="num bold" style={{ width: 96, textAlign: "right" }}>
        <Money value={r.amount} colored={r.amount > 0} />
      </span>
      <button
        className="btn btn-ghost btn-icon" title="Edit schedule" aria-label={`Edit ${r.merchant}'s schedule`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit({ item: r, exists: true }); }}
      >
        <Pencil size={14} />
      </button>
    </Link>
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
