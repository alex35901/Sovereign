import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, CircleHelp, Plus, Trash2 } from "lucide-react";
import type { Transaction } from "../types";
import { useDB, useStore } from "../store";
import { longDate, today } from "../lib/date";
import { fmt, parseMoney, toInput } from "../lib/money";
import { UNCATEGORIZED } from "../lib/categories";
import { Btn, Modal, Money, MoneyInput, SelectInput, TagPill, Toggle, cx } from "../components/ui";
import { CategoryPicker } from "../components/pickers";
import { ActivityLog } from "../components/ActivityLog";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { MerchantAvatar } from "./Transactions";
import { accountOptions } from "../lib/select";

/**
 * One line of the detail screen: what it is called, and what it is.
 *
 * Label hard left, value hard right, one per line. It is the shape every
 * banking app converges on because it survives any length of value — a
 * merchant with four words in its name and a category with one sit on the
 * same line as each other without a grid to fight over.
 */
function DetailRow({ label, help, children, top }: {
  label: string;
  /** A question mark beside the label, for a value that needs explaining. */
  help?: string;
  children: ReactNode;
  /** Aligns to the first line rather than the middle, for a value that wraps. */
  top?: boolean;
}) {
  return (
    <div className={cx("drow", top && "drow-top")}>
      <span className="drow-label">
        {label}
        {help ? <CircleHelp size={13} className="faint" aria-label={help}><title>{help}</title></CircleHelp> : null}
      </span>
      <span className="drow-val">{children}</span>
    </div>
  );
}

/**
 * A value that becomes its own control when you go to change it.
 *
 * The row reads as a fact — a logo, a name, a chevron — and a form field is
 * conjured only once you have said you want one. That is Monarch's behaviour,
 * and it is also the only way the value stays hard right: a text box wide
 * enough to type into is wider than the words in it, so an input left sitting
 * in the row strands the logo in the middle of it.
 */
function Editable({ view, edit, chevron = true }: {
  view: ReactNode;
  /** Given a way to put the row back to reading; call it on blur or Enter. */
  edit: (close: () => void) => ReactNode;
  chevron?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  // Focus goes back where the click was, or a keyboard is left nowhere.
  const close = () => { setOpen(false); requestAnimationFrame(() => btn.current?.focus()); };
  if (open) return <>{edit(close)}</>;
  return (
    <button ref={btn} className="drow-btn" onClick={() => setOpen(true)}>
      {view}
      {chevron ? <ChevronDown size={14} /> : null}
    </button>
  );
}

/**
 * The amount, big and centred above everything else.
 *
 * Text until you put the cursor in it, and the raw number after: "$31.01" is
 * what you came to read and "31.01" is what you have to edit. An input holding
 * the formatted string would need parsing back on every keystroke, and one
 * holding the raw number would leave the headline of the screen looking like a
 * spreadsheet cell.
 *
 * Green for money in, plain for money out — the same asymmetry the rest of the
 * app uses, and the reason spending is not painted red here: on a screen about
 * one transaction, every figure would be red, and a colour that is always on
 * says nothing.
 */
function AmountHeader({ value, onChange, autoFocus }: {
  value: number; onChange: (cents: number) => void; autoFocus?: boolean;
}) {
  const { db } = useStore();
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <div className="txn-amount">
      <input
        className={cx("num", value > 0 && "pos", db.settings.privacyMode && "blurred")}
        inputMode="decimal" autoFocus={autoFocus} aria-label="Amount"
        value={buf ?? fmt(value)}
        onFocus={(e) => {
          setBuf(toInput(value));
          // After the swap to the raw number, or it selects the formatted
          // string that is about to be replaced.
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onChange={(e) => { setBuf(e.target.value); onChange(parseMoney(e.target.value)); }}
        onBlur={() => setBuf(null)}
      />
    </div>
  );
}

/** Add or edit a transaction, including splits and tags. */
export function TransactionModal({ txn, onClose }: { txn?: Transaction; onClose: () => void }) {
  const db = useDB();
  const { actions, suggestRule } = useStore();
  const editing = Boolean(txn);

  const [date, setDate] = useState(txn?.date ?? today());
  const [merchant, setMerchant] = useState(txn?.merchant ?? "");
  const [amount, setAmount] = useState(txn?.amount ?? 0);
  const [accountId, setAccountId] = useState(txn?.accountId ?? db.accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(txn?.categoryId ?? UNCATEGORIZED);
  const [notes, setNotes] = useState(txn?.notes ?? "");
  const [tags, setTags] = useState<string[]>(txn?.tags ?? []);
  // Editing used to mark a transaction reviewed whether or not you meant to,
  // with no way back. It is a switch now.
  const [reviewed, setReviewed] = useState(txn?.reviewed ?? true);
  const [hideFromReports, setHide] = useState(txn?.hideFromReports ?? false);
  const [splits, setSplits] = useState(txn?.splits?.map((s) => ({ categoryId: s.categoryId, amount: s.amount })) ?? []);

  const account = db.accounts.find((a) => a.id === accountId);
  const splitTotal = splits.reduce((s, x) => s + x.amount, 0);
  const splitOff = splits.length > 0 && splitTotal !== amount;

  const save = () => {
    if (!accountId) return;
    const payload = {
      date, merchant: merchant.trim() || "Unknown", amount, accountId, categoryId,
      notes: notes.trim() || undefined, tags, hideFromReports,
      pending: txn?.pending ?? false, reviewed,
      splits: splits.length ? splits.map((s, i) => ({ ...s, id: txn?.splits?.[i]?.id ?? `s${i}` })) : undefined,
    };
    if (txn) actions.updateTransaction(txn.id, payload);
    else actions.addTransaction({ ...payload, statement: merchant.trim() });
    // Only for an edit that actually changed something — a rule made from a
    // transaction typed in by hand would match nothing yet.
    if (txn && !splits.length) {
      const movedCategory = categoryId !== txn.categoryId;
      const renamed = payload.merchant !== txn.merchant;
      if (movedCategory || renamed) {
        suggestRule({
          // matched on the name as it arrived, so the next one is caught too
          merchant: txn.merchant,
          categoryId: movedCategory ? categoryId : undefined,
          renameTo: renamed ? payload.merchant : undefined,
        });
      }
    }
    onClose();
  };

  return (
    <Modal
      flush
      title={editing ? (txn?.merchant || "Transaction") : "Add transaction"}
      onClose={onClose}
      footer={
        <>
          {txn ? (
            <Btn variant="danger" onClick={() => { actions.deleteTransactions([txn.id]); onClose(); }}>
              <Trash2 size={14} /> Delete
            </Btn>
          ) : null}
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={!accountId || splitOff}>
            {editing ? "Save changes" : "Add transaction"}
          </Btn>
        </>
      }
    >
      <AmountHeader value={amount} onChange={setAmount} autoFocus={!editing} />

      <DetailRow label="Merchant">
        <Editable
          view={<>
            {merchant ? <MerchantAvatar name={merchant} size={22} /> : null}
            <span className={cx("truncate", !merchant && "faint")}>{merchant || "Blue Bottle Coffee"}</span>
          </>}
          edit={(close) => (
            <input
              className="input" value={merchant} placeholder="Blue Bottle Coffee" autoFocus aria-label="Merchant"
              onChange={(e) => setMerchant(e.target.value)} onBlur={close}
              onKeyDown={(e) => { if (e.key === "Enter") close(); }}
            />
          )}
        />
      </DetailRow>

      {txn?.statement ? (
        <DetailRow label="Original statement" help="Exactly as the bank sent it — kept for reference and never edited">
          {/* Its whole value on hover, because the useful half of a statement
              line is often the half that does not fit. */}
          <span className="drow-statement truncate" title={txn.statement}>{txn.statement}</span>
        </DetailRow>
      ) : null}

      <DetailRow label="Account">
        <Editable
          view={<>
            {account ? <InstitutionLogo account={account} size={22} round /> : null}
            <span className="truncate">{account?.name ?? "Choose an account"}</span>
          </>}
          edit={(close) => (
            <SelectInput
              autoFocus onBlur={close}
              value={accountId} onChange={(id) => { setAccountId(id); close(); }}
              options={accountOptions(db.accounts.filter((a) => !a.hidden))}
            />
          )}
        />
      </DetailRow>

      <DetailRow label="Category">
        {splits.length ? (
          <span className="muted">Split across {splits.length}</span>
        ) : (
          <CategoryPicker
            value={categoryId} onChange={setCategoryId}
            trigger={(cat, open) => (
              <button className="drow-btn" onClick={open}>
                <span>{cat?.icon}</span>
                <span className="truncate">{cat?.name ?? "Uncategorized"}</span>
                <ChevronDown size={14} />
              </button>
            )}
          />
        )}
      </DetailRow>

      <DetailRow label="Date">
        <Editable
          view={<span className="truncate">{longDate(date)}</span>}
          edit={(close) => (
            <input
              className="input" type="date" value={date} autoFocus aria-label="Date"
              onChange={(e) => setDate(e.target.value)} onBlur={close}
            />
          )}
        />
      </DetailRow>

      <DetailRow label="Notes">
        <Editable
          chevron={false}
          view={<span className={cx("truncate", !notes && "faint")}>{notes || "Add a note"}</span>}
          edit={(close) => (
            <input
              className="input" value={notes} placeholder="Add a note" autoFocus aria-label="Notes"
              onChange={(e) => setNotes(e.target.value)} onBlur={close}
              onKeyDown={(e) => { if (e.key === "Enter") close(); }}
            />
          )}
        />
      </DetailRow>

      <DetailRow label="Tags" top>
        {db.tags.length ? db.tags.map((t) => (
          <button
            key={t.id}
            className={cx("chip", tags.includes(t.id) && "on")}
            onClick={() => setTags((prev) => (prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]))}
          >
            <TagPill name={t.name} tone={t.color} />
          </button>
        )) : <span className="faint">Create tags in Settings</span>}
      </DetailRow>

      <DetailRow label="Reviewed">
        <Toggle on={reviewed} onChange={setReviewed} />
      </DetailRow>
      <DetailRow label="Hide from reports and budget">
        <Toggle on={hideFromReports} onChange={setHide} />
      </DetailRow>

      <div className="drow-block">
        <div className="spread">
          <span className="small muted">Splits</span>
          <Btn size="sm" onClick={() => setSplits((s) => [...s, { categoryId: UNCATEGORIZED, amount: amount - splitTotal }])}>
            <Plus size={13} /> Add split
          </Btn>
        </div>
        {splits.map((s, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <CategoryPicker
              value={s.categoryId}
              onChange={(id) => setSplits((prev) => prev.map((x, j) => (j === i ? { ...x, categoryId: id } : x)))}
            />
            <div style={{ width: 120 }}>
              <MoneyInput
                value={s.amount}
                onChange={(v) => setSplits((prev) => prev.map((x, j) => (j === i ? { ...x, amount: v } : x)))}
              />
            </div>
            <button className="btn btn-ghost btn-icon" onClick={() => setSplits((prev) => prev.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {splits.length ? (
          <div className={cx("small", splitOff ? "neg" : "muted")}>
            Splits total <Money value={splitTotal} /> of {fmt(amount)}
            {splitOff ? ` — ${fmt(amount - splitTotal)} unassigned` : " ✓"}
          </div>
        ) : null}
      </div>

      {txn ? <div className="drow-block"><ActivityLog txn={txn} /></div> : null}
    </Modal>
  );
}
