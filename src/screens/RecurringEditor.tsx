import { useMemo, useState } from "react";
import type { Cadence, Recurring } from "../types";
import { useDB, useStore } from "../store";
import { Btn, Field, Modal, MoneyInput, SelectInput, Toggle, cx } from "../components/ui";
import { Plus } from "lucide-react";
import { CategoryPicker } from "../components/pickers";
import { CADENCES, KINDS, anotherRecurringId, sameMerchant } from "../lib/recurring";
import { accountOptions, recurringList } from "../lib/select";
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
 *
 * A merchant may hold more than one of these. Two tenants paying the same rent
 * through the same service are one name and two expectations, so the label
 * field and the Add another button below are what keep them apart.
 */
export function RecurringEditor({ item, exists, startOn = exists, nameLocked, sibling, onSwitch, onClose }: {
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
  /**
   * Deliberately an extra schedule at a merchant that already has one.
   *
   * It decides which ids the new one has to avoid. A name typed into the add
   * button is allowed to land on a pattern the detector found, because that is
   * how a found schedule becomes one you control; pressing Add another is a
   * statement that this is a different charge, so it steps over the detected
   * one as well as the written ones.
   */
  sibling?: boolean;
  /**
   * Hands the parent a different schedule to open this on.
   *
   * Used by Add another, and by the way out of "this merchant already has
   * one": without it the only route to the schedule being warned about is to
   * cancel and go looking for it.
   */
  onSwitch?: (next: { item: Recurring; exists: boolean; sibling?: boolean }) => void;
  onClose: () => void;
}) {
  const db = useDB();
  const { actions, apply } = useStore();
  const [on, setOn] = useState(startOn);
  const [merchant, setMerchant] = useState(item.merchant);
  const [label, setLabel] = useState(item.label ?? "");
  const [amount, setAmount] = useState(item.amount);
  const [cadence, setCadence] = useState<Cadence>(item.cadence);
  const [kind, setKind] = useState<Recurring["kind"]>(item.kind);
  const [nextDate, setNextDate] = useState(item.nextDate);
  const [startDate, setStartDate] = useState(item.startDate ?? "");
  const [categoryId, setCategoryId] = useState(item.categoryId);
  const [accountId, setAccountId] = useState(item.accountId ?? "");

  // Acting on it is having seen it, so the "New" tag and the notification
  // clear together rather than the row staying flagged after you have dealt
  // with it.
  const acknowledge = () => apply((cur) => markRead(cur, [`recurring:${item.id}`]));

  const live = useMemo(() => recurringList(db), [db]);
  // What else is already expected at this name. Read off the typed name rather
  // than the saved one, so it answers while the name is still being decided.
  const others = useMemo(
    () => sameMerchant(live, merchant.trim()).filter((r) => r.id !== item.id),
    [live, merchant, item.id],
  );

  /**
   * The id this will be saved under.
   *
   * An existing schedule keeps its own: renaming one must not leave the old id
   * behind as a second row. A new one derives the merchant's id, which is how
   * writing down a charge the detector already found edits that one instead of
   * leaving two of it on the page, and steps past the ids already in use so
   * that a second schedule at a merchant is a second row rather than an
   * overwrite of the first.
   */
  const idFor = (name: string): string =>
    exists ? item.id : anotherRecurringId(name, (sibling ? live : db.recurring).map((r) => r.id));

  /** The same charge again, for the other tenant: same shape, no label. */
  const addAnother = () => {
    const name = merchant.trim() || item.merchant;
    onSwitch?.({
      item: { ...item, id: anotherRecurringId(name, live.map((r) => r.id)), merchant: name, label: "" },
      exists: false,
      sibling: true,
    });
  };

  const save = () => {
    const name = merchant.trim() || item.merchant;
    if (on) {
      const started = startDate.trim();
      actions.upsertRecurring({
        ...item,
        id: idFor(name),
        merchant: name,
        // Trimmed away rather than stored blank, so a label cleared out leaves
        // the row showing its merchant's name and nothing else.
        ...(label.trim() ? { label: label.trim() } : { label: undefined }),
        amount, cadence, kind, nextDate, categoryId,
        // The key is left out rather than set to nothing when the field is
        // blank. A manual entry is spread over the detected one it shadows,
        // so writing undefined here would wipe the start date the detector
        // read off the first charge, every time anything else was edited.
        ...(started ? { startDate: started } : {}),
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
          {/* Only on one that already exists, and only where the parent can
              reopen this on something else. Offered beside the schedule it
              copies, because the second tenant's rent is the first one's shape
              with a different name on it. */}
          {exists && on && onSwitch ? (
            <Btn onClick={addAnother}>
              <Plus size={14} /> Add another
            </Btn>
          ) : null}
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

      {/* Said before it happens rather than discovered afterwards. A second
          schedule at one merchant is the point of this, and silently editing
          the first would lose whatever it said; silently adding a second when
          somebody meant to edit is a duplicate they can see and delete. So the
          safe default is to add, with the other way out offered here. */}
      {on && others.length ? (
        <div className="rec-aside">
          <span className="small">
            {exists
              ? `One of ${others.length + 1} schedules at ${merchant.trim() || item.merchant}.`
              : others.length === 1
                ? `${merchant.trim()} already has a schedule. Saving adds a second one.`
                : `${merchant.trim()} already has ${others.length} schedules. Saving adds another.`}
            {" "}
            {others.some((r) => !r.label?.trim()) || !label.trim()
              ? "Label them to tell them apart on the page."
              : "Labels keep them apart on the page."}
          </span>
          {!exists && onSwitch ? (
            <Btn onClick={() => onSwitch({ item: others[0], exists: true })}>
              Edit the existing one
            </Btn>
          ) : null}
        </div>
      ) : null}

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
          <div className="row" style={{ gap: 12 }}>
            <Field label="Next date" hint="Used to work out the charges still to come at this merchant">
              <input className="input" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
            </Field>
            {/* Only looking back needs this, which is why it is allowed to be
                empty: a schedule that has run longer than anybody remembers
                has no honest start date, and made-up ones are worse than
                none. Blank means it has always been here. */}
            <Field label="Started" hint="Left blank, it is treated as having always run">
              <input
                className="input" type="date" value={startDate}
                max={nextDate || undefined}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </Field>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <Field label="Amount" hint="Negative for anything going out">
              <MoneyInput value={amount} onChange={setAmount} />
            </Field>
            <Field label="Category"><CategoryPicker value={categoryId} onChange={setCategoryId} /></Field>
          </div>
          {/* Optional, and most merchants never need it. It earns its place on
              the one that does: two rents arriving from the same service are
              identical rows until somebody can say which is which. */}
          <Field label="Label" hint="Only needed when a merchant has more than one, like Unit 1 and Unit 2">
            <input
              className="input" value={label} placeholder="Optional"
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
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
