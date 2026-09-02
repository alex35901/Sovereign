import { useMemo, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import type { Cadence, Recurring as RecurringItem } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { addDays, dateLabel, parseISO, relativeDay, thisMonth, today } from "../lib/date";
import { monthlyRecurringCost, recurringList } from "../lib/select";
import { MonthGrid } from "../components/charts";
import { Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, SelectInput, Tile, cx } from "../components/ui";
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
  const income = list.filter((r) => r.amount > 0);
  const monthly = monthlyRecurringCost(list);
  const soon = list.filter((r) => r.nextDate <= addDays(today(), 7));
  const soonTotal = soon.filter((r) => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0);

  const [y, m] = thisMonth().split("-").map(Number);
  const marks = useMemo(() => {
    const out: Record<number, { tone: string; amount: number; label: string }[]> = {};
    for (const r of list) {
      // show every occurrence that lands in the visible month
      const step = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, semiannual: 182, yearly: 365 }[r.cadence];
      // walk back before nextDate as well, so days already paid this month still
      // show up on the calendar
      for (let i = -6; i <= 6; i++) {
        const dt = parseISO(addDays(r.nextDate, step * i));
        if (dt.getFullYear() !== y || dt.getMonth() + 1 !== m) continue;
        const day = dt.getDate();
        (out[day] ??= []).push({
          tone: r.amount > 0 ? "--c3" : "--c9", amount: r.amount, label: r.merchant,
        });
      }
    }
    return out;
  }, [list, y, m]);

  return (
    <>
      <TopBar title="Recurring" />
      <div className="page stack">
        <div className="grid g4">
          <Tile label="Recurring / month" value={<Money value={monthly} cents={false} />}
            sub={<span className="muted">{bills.length} bills & subscriptions</span>} />
          <Tile label="Annualized" value={<Money value={monthly * 12} cents={false} />} />
          <Tile label="Next 7 days" value={<Money value={soonTotal} cents={false} />}
            sub={<span className="muted">{soon.length} item{soon.length === 1 ? "" : "s"} due</span>} />
          <Tile label="Recurring income" value={<Money value={income.reduce((s, r) => s + r.amount, 0)} cents={false} />} tone="pos" />
        </div>

        <div className="grid g-2-1">
          <Card pad={false}>
            <CardHead flush title="Upcoming" sub="Detected from your transaction history, plus anything you've added" />
            {list.map((r) => (
              <div key={r.id} className="list-row click" onClick={() => setEditing(r)}>
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
                  className="btn btn-ghost btn-icon" title="Not recurring"
                  onClick={(e) => { e.stopPropagation(); actions.dismissRecurring(r); }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {!list.length ? (
              <Empty
                title="Nothing recurring found yet"
                body="Three or more charges from the same merchant on a steady interval will show up here automatically."
              />
            ) : null}
          </Card>

          <Card>
            <CardHead title="This month" sub={<span className="row" style={{ gap: 5 }}><CalendarDays size={13} /> {dateLabel(today(), { year: true })}</span>} />
            <MonthGrid year={y} month={m} marks={marks} />
            <div className="divider" />
            <div className="row" style={{ gap: 16 }}>
              <span className="row tiny muted" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--c9)" }} /> Bills</span>
              <span className="row tiny muted" style={{ gap: 5 }}><span className="dot" style={{ background: "var(--c3)" }} /> Income</span>
            </div>
          </Card>
        </div>
      </div>
      {editing ? <RecurringModal item={editing} onClose={() => setEditing(null)} /> : null}
    </>
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
