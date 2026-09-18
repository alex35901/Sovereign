import { useState } from "react";
import type { Cadence, Recurring } from "../types";
import { useDB, useStore } from "../store";
import { Btn, Field, Modal, MoneyInput, SelectInput, Toggle, cx } from "../components/ui";
import { CategoryPicker } from "../components/pickers";
import { CADENCES, KINDS, recurringIdFor } from "../lib/recurring";
import { accountOptions } from "../lib/select";
import { markRead } from "../lib/notifications";
import { MerchantAvatar } from "./Transactions";

/**
 * Everything about one merchant's repeating charge, on one screen.
 *
 * Reached from the merchant's own schedule and from any transaction at it,
 * and the same editor either way. The two questions it answers are "does this
 * repeat" and "what does it look like when it does", in that order, which is
 * why the switch is at the top and everything under it is hidden until the
 * answer to the first one is yes.
 *
 * The name is fixed when this is opened from a transaction. A schedule is
 * found by merchant, so renaming it there would quietly unhook it from the
 * very transaction it was opened from, and the transaction already has a
 * merchant field of its own a few rows up.
 */
export function RecurringEditor({ item, exists, startOn = exists, nameLocked, onClose }: {
  item: Recurring;
  /** Whether this schedule is live now, as opposed to a shape offered for one. */
  exists: boolean;
  /**
   * Where the switch starts. It follows `exists` from a transaction, where
   * the honest answer is "no, not yet" - but not from the Recurring page's
   * add button, where pressing it was the answer.
   */
  startOn?: boolean;
  nameLocked?: boolean;
  onClose: () => void;
}) {
  const db = useDB();
  const { actions, apply } = useStore();
  const [on, setOn] = useState(startOn);
  const [merchant, setMerchant] = useState(item.merchant);
  const [amount, setAmount] = useState(item.amount);
  const [cadence, setCadence] = useState<Cadence>(item.cadence);
  const [kind, setKind] = useState<Recurring["kind"]>(item.kind);
  const [nextDate, setNextDate] = useState(item.nextDate);
  const [categoryId, setCategoryId] = useState(item.categoryId);
  const [accountId, setAccountId] = useState(item.accountId ?? "");

  // Acting on it is having seen it, so the "New" tag and the notification
  // clear together rather than the row staying flagged after you have dealt
  // with it.
  const acknowledge = () => apply((cur) => markRead(cur, [`recurring:${item.id}`]));

  const save = () => {
    const name = merchant.trim() || item.merchant;
    if (on) {
      actions.upsertRecurring({
        ...item,
        // Derived from the name so a hand-written schedule and a detected one
        // for the same merchant stay the same row rather than both showing.
        id: recurringIdFor(name),
        merchant: name,
        amount, cadence, kind, nextDate, categoryId,
        accountId: accountId || undefined,
        detected: false,
        dismissed: false,
      });
    } else if (exists) {
      actions.dismissRecurring(item);
    }
    acknowledge();
    onClose();
  };

  return (
    <Modal
      title="Recurring"
      onClose={onClose}
      footer={
        <>
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>Save</Btn>
        </>
      }
    >
      <div className="row" style={{ gap: 12 }}>
        <MerchantAvatar name={merchant} size={40} />
        {nameLocked ? (
          <div className="col" style={{ gap: 1, minWidth: 0 }}>
            <span className="bold truncate">{merchant}</span>
            <span className="tiny faint">Rename it on the transaction itself</span>
          </div>
        ) : (
          <div className="grow">
            <Field label="Merchant">
              <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
            </Field>
          </div>
        )}
      </div>

      <div className="rec-switch">
        <div className="col grow" style={{ gap: 2 }}>
          <span className="bold">Mark this merchant as recurring</span>
          <span className="small muted">
            It shows on the Recurring page and in the calendar, with the charges it still expects.
          </span>
        </div>
        <Toggle on={on} onChange={setOn} />
      </div>

      {on ? (
        <>
          <div className="row" style={{ gap: 12 }}>
            <Field label="Frequency"><SelectInput value={cadence} onChange={setCadence} options={CADENCES} /></Field>
            <Field label="Type"><SelectInput value={kind} onChange={setKind} options={KINDS} /></Field>
          </div>
          <Field label="Next date" hint="Used to work out the charges still to come at this merchant">
            <input className="input" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </Field>
          <div className="row" style={{ gap: 12 }}>
            <Field label="Amount" hint="Negative for anything going out">
              <MoneyInput value={amount} onChange={setAmount} />
            </Field>
            <Field label="Category"><CategoryPicker value={categoryId} onChange={setCategoryId} /></Field>
          </div>
          <Field label="Account" hint="Which one it is expected to land on">
            <SelectInput
              value={accountId}
              onChange={setAccountId}
              options={[{ value: "", label: "Any account" }, ...accountOptions(db.accounts.filter((a) => !a.hidden))]}
            />
          </Field>
          {/* Only about a schedule that already exists. On one being set up
              for the first time it would be describing what it is about to
              become, which is not news. */}
          {exists ? (
            <span className={cx("tiny", "faint")}>
              {item.detected
                ? "Found in your history. Saving turns it into an entry you control."
                : "Entered by hand."}
            </span>
          ) : null}
        </>
      ) : (
        <span className="tiny faint">
          {exists
            ? "Turning this off takes it off the Recurring page and stops it being expected again."
            : "Turn this on to have Sovereign expect this charge and show it on the Recurring page."}
        </span>
      )}
    </Modal>
  );
}
