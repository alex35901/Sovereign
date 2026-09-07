import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, Pencil, X } from "lucide-react";
import type { Cadence, Recurring as RecurringItem } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, monthEnd, monthStart, parseISO, relativeDay, thisMonth, today } from "../lib/date";
import { occurrences, recurringList, recurringSpend } from "../lib/select";
import type { RecurringSpend } from "../lib/select";
import { MonthGrid } from "../components/charts";
import { Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, SelectInput, cx } from "../components/ui";
import { CategoryPicker, CategoryTag } from "../components/pickers";
import { MerchantAvatar } from "./Transactions";

const CADENCES: { value: Cadence; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semiannual", label: "Twice a year" },
  { value: "yearly", label: "Yearly" },
];

export default function Recurring() {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState<RecurringItem | null>(null);

  const list = useMemo(() => recurringList(db), [db]);
  const bills = list.filter((r) => r.amount < 0);

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
    const out: Record<number, { tone: string; amount: number; label: string }[]> = {};
    for (const r of list) {
      // Every occurrence in the visible month, walked the same way the totals
      // above are — days already paid included, since they are what the month
      // has spent.
      for (const date of occurrences(r, monthStart(month), monthEnd(month))) {
        const day = parseISO(date).getDate();
        (out[day] ??= []).push({
          tone: r.amount > 0 ? "--c3" : "--c9", amount: r.amount, label: r.merchant,
        });
      }
    }
    return out;
  }, [list, month]);

  return (
    <>
      <TopBar title="Recurring" />
      <div className="page stack">
        {/* How much of what is committed has already gone, so what is left is
            a figure to plan against rather than a total to work out. */}
        <div className="grid g2">
          <SpendTile
            label="This month" spend={thisMonthSpend}
            sub={`${bills.length} bill${bills.length === 1 ? "" : "s"} & subscriptions`}
          />
          <SpendTile
            label={`${month.slice(0, 4)} so far`} spend={thisYearSpend}
            sub={thisYearSpend.upcoming
              ? `${thisYearSpend.upcoming} more due this year`
              : "nothing else due this year"}
          />
        </div>

        {/* The calendar first and across the whole page: it is the thing this
            screen is for, and in a third of the width its cells could hold a
            dot and nothing else. */}
        <Card>
          <CardHead title="This month" sub={<span className="row" style={{ gap: 5 }}><CalendarDays size={13} /> {dateLabel(today(), { year: true })}</span>} />
          <MonthGrid year={y} month={m} marks={marks} />
          <div className="divider" />
          <div className="row" style={{ gap: 16 }}>
            <span className="row tiny muted" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--c9)" }} /> Bills</span>
            <span className="row tiny muted" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--c3)" }} /> Income</span>
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
                    {r.detected ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--faint)" }}>auto</span> : null}
                  </span>
                  <span className="tiny faint truncate">
                    {CADENCES.find((c) => c.value === r.cadence)?.label} · next {relativeDay(r.nextDate).toLowerCase()} ({dateLabel(r.nextDate)})
                  </span>
                </div>
                <span className="rec-category"><CategoryTag categoryId={r.categoryId} /></span>
                <span className="num bold" style={{ width: 96, textAlign: "right" }}>
                  <Money value={r.amount} colored={r.amount > 0} />
                </span>
                <button
                  className="btn btn-ghost btn-icon" title="Edit schedule" aria-label={`Edit ${r.merchant}'s schedule`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(r); }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="btn btn-ghost btn-icon" title="Not recurring" aria-label={`${r.merchant} is not recurring`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); actions.dismissRecurring(r); }}
                >
                  <X size={14} />
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
      {editing ? <RecurringModal item={editing} onClose={() => setEditing(null)} /> : null}
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

function RecurringModal({ item, onClose }: { item: RecurringItem; onClose: () => void }) {
  const { actions } = useStore();
  const [merchant, setMerchant] = useState(item.merchant);
  const [amount, setAmount] = useState(item.amount);
  const [cadence, setCadence] = useState<Cadence>(item.cadence);
  const [nextDate, setNextDate] = useState(item.nextDate);
  const [categoryId, setCategoryId] = useState(item.categoryId);

  return (
    <Modal
      title="Recurring item"
      onClose={onClose}
      footer={
        <>
          <Btn variant="danger" onClick={() => { actions.dismissRecurring(item); onClose(); }}>Not recurring</Btn>
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              actions.upsertRecurring({ ...item, merchant, amount, cadence, nextDate, categoryId, detected: false });
              onClose();
            }}
          >
            Save
          </Btn>
        </>
      }
    >
      <Field label="Merchant">
        <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
      </Field>
      <div className="row" style={{ gap: 12 }}>
        <Field label="Amount" hint="Negative for bills"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Cadence"><SelectInput value={cadence} onChange={setCadence} options={CADENCES} /></Field>
      </div>
      <div className="row" style={{ gap: 12 }}>
        <Field label="Next date">
          <input className="input" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
        </Field>
        <Field label="Category"><CategoryPicker value={categoryId} onChange={setCategoryId} /></Field>
      </div>
      <span className={cx("tiny", "faint")}>
        {item.detected ? "This was detected automatically — saving turns it into a manual entry you control." : "Manually added."}
      </span>
    </Modal>
  );
}
