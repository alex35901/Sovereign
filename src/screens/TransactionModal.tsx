import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Transaction } from "../types";
import { useDB, useStore } from "../store";
import { today } from "../lib/date";
import { fmt } from "../lib/money";
import { UNCATEGORIZED } from "../lib/categories";
import { Btn, Field, Modal, Money, MoneyInput, SelectInput, TagPill, TextInput, Toggle, cx } from "../components/ui";
import { CategoryPicker } from "../components/pickers";
import { ActivityLog } from "../components/ActivityLog";

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
      title={editing ? "Edit transaction" : "Add transaction"}
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
      <div className="row" style={{ gap: 12 }}>
        <Field label="Date"><TextInput type="date" value={date} onChange={setDate} /></Field>
        <Field label="Amount" hint="Negative for spending, positive for income">
          <MoneyInput value={amount} onChange={setAmount} autoFocus={!editing} />
        </Field>
      </div>
      <Field label="Merchant"><TextInput value={merchant} onChange={setMerchant} placeholder="Blue Bottle Coffee" /></Field>
      <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
        <Field label="Account">
          <SelectInput
            value={accountId} onChange={setAccountId}
            options={db.accounts.filter((a) => !a.hidden).map((a) => ({ value: a.id, label: `${a.name} · ${a.institution}` }))}
          />
        </Field>
        <Field label="Category">
          {splits.length ? (
            <span className="small muted" style={{ padding: "7px 0" }}>Split across {splits.length}</span>
          ) : (
            <CategoryPicker value={categoryId} onChange={setCategoryId} />
          )}
        </Field>
      </div>

      <Field label="Notes"><TextInput value={notes} onChange={setNotes} placeholder="Optional" /></Field>

      <div className="col" style={{ gap: 7 }}>
        <span className="small muted">Tags</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {db.tags.map((t) => (
            <button
              key={t.id}
              className={cx("chip", tags.includes(t.id) && "on")}
              onClick={() => setTags((prev) => (prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]))}
            >
              <TagPill name={t.name} tone={t.color} />
            </button>
          ))}
          {!db.tags.length ? <span className="tiny faint">Create tags in Settings.</span> : null}
        </div>
      </div>

      <div className="col" style={{ gap: 8 }}>
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

      <div className="col" style={{ gap: 8 }}>
        <Toggle on={reviewed} onChange={setReviewed} label={<span className="small">Reviewed</span>} />
        <Toggle on={hideFromReports} onChange={setHide} label={<span className="small">Hide from reports and budget</span>} />
      </div>

      {txn ? <ActivityLog txn={txn} /> : null}
    </Modal>
  );
}
