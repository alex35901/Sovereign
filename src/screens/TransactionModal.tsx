import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, CircleHelp, Copy, Plus, Repeat, Trash2 } from "lucide-react";
import type { Bucket, Transaction } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel, longDate, today } from "../lib/date";
import { fmt, parseMoney, toInput } from "../lib/money";
import { UNCATEGORIZED } from "../lib/categories";
import { Btn, Modal, Money, MoneyInput, SelectInput, TagPill, Toggle, cx } from "../components/ui";
import { CategoryPicker } from "../components/pickers";
import { ActivityLog } from "../components/ActivityLog";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { MerchantAvatar } from "./Transactions";
import { accountOptions, bucketIndex, bucketOf, hasBuckets, recurringList } from "../lib/select";
import { cadenceLabel, fromTransaction, scheduleFor } from "../lib/recurring";
import { RecurringEditor } from "./RecurringEditor";
import { cachedExplanation, explainFacts, explainTransaction, rememberExplanation } from "../lib/hopper/explain";
import type { ExplainFacts } from "../lib/hopper/explain";

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
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <div className="txn-amount">
      <input
        className={cx("num", value > 0 && "pos")}
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
  const { actions, suggestRule, notify } = useStore();
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
  const [bucket, setBucket] = useState<Bucket | "">(txn?.bucket ?? "");
  // Named rather than left blank: "Follow the account" is only a useful answer
  // if it says which one that is, and the account can be changed in this same
  // dialog a row above.
  const inherited = bucketOf({ accountId, bucket: undefined } as Transaction, bucketIndex(db));
  const [splits, setSplits] = useState(txn?.splits?.map((s) => ({ categoryId: s.categoryId, amount: s.amount })) ?? []);
  const [explaining, setExplaining] = useState<ExplainFacts | null>(null);
  const [scheduling, setScheduling] = useState(false);

  // Found by merchant rather than stored on the row, so every transaction at
  // a merchant agrees about whether it repeats, including the ones that
  // arrived before anybody said so.
  const schedule = useMemo(
    () => scheduleFor(db, txn?.merchant ?? "", txn ? recurringList(db) : []),
    [db, txn],
  );

  const account = db.accounts.find((a) => a.id === accountId);
  const splitTotal = splits.reduce((s, x) => s + x.amount, 0);
  const splitOff = splits.length > 0 && splitTotal !== amount;

  const asTyped = () => ({
    date, merchant: merchant.trim() || "Unknown", amount, accountId, categoryId,
    notes: notes.trim() || undefined, tags, hideFromReports,
    bucket: bucket || undefined,
    pending: txn?.pending ?? false, reviewed,
    splits: splits.length ? splits.map((s, i) => ({ ...s, id: txn?.splits?.[i]?.id ?? `s${i}` })) : undefined,
  });

  /**
   * A second one like this, leaving the original alone.
   *
   * From what is on the screen rather than from what is stored, which is both
   * what anybody would expect from a button sitting under a form and useful
   * in its own right: change the date, press this, and the second occurrence
   * is in. The original keeps whatever it had, exactly as Cancel would.
   *
   * The importer's duplicate check is a good one and still occasionally wrong
   * - two rent payments of the same amount on the same day from two tenants
   * are one key and two real transactions - so there has to be a way to put
   * back what it decided was a copy.
   */
  const duplicate = () => {
    if (!accountId || !txn) return;
    // The original's own statement text, not the tidied merchant name: the
    // copy stands for the same line on the same statement.
    actions.duplicateTransaction({ ...asTyped(), statement: txn.statement, importKey: txn.importKey });
    notify("Duplicated. The copy is yours to edit.");
    onClose();
  };

  const save = () => {
    if (!accountId) return;
    const payload = asTyped();
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
            <>
              <Btn variant="danger" onClick={() => { actions.deleteTransactions([txn.id]); onClose(); }}>
                <Trash2 size={14} /> Delete
              </Btn>
              <Btn onClick={duplicate} disabled={!accountId || splitOff}>
                <Copy size={14} /> Duplicate
              </Btn>
            </>
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
        <DetailRow label="Original statement" help="Exactly as the bank sent it, kept for reference and never edited">
          {/* Its whole value on hover, because the useful half of a statement
              line is often the half that does not fit. */}
          <span className="drow-statement truncate" title={txn.statement}>{txn.statement}</span>
          {/* The one question the app cannot answer from its own data: what
              PAY*CITY OF FISHERS actually was. */}
          <button
            className="drow-explain" onClick={() => setExplaining(explainFacts(db, txn))}
            title="What is this?" aria-label="Explain this statement"
          >
            <CircleHelp size={14} />
          </button>
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
      {/* Only once there is more than one set of books to choose between. The
          case this exists for is a client lunch on a personal card, which is
          also why the default is "whatever the account says" rather than a
          value: an override that has to be set on every row is one nobody
          sets on any row. */}
      {hasBuckets(db) ? (
        <DetailRow label="Books">
          <SelectInput<Bucket | "">
            value={bucket}
            onChange={setBucket}
            options={[
              { value: "", label: `Follow the account (${inherited})` },
              { value: "personal", label: "Personal" },
              { value: "business", label: "Business" },
              { value: "rental", label: "Rental" },
            ]}
          />
        </DetailRow>
      ) : null}

      {/* Under Books deliberately: everything above is what this charge is,
          and this is the first row that says something about the ones still
          to come. Only offered for a transaction that exists, because a
          schedule is found by merchant and a row being typed in has not
          settled on one yet. */}
      {txn ? (
        <DetailRow label="Recurring">
          <button className="drow-btn" onClick={() => setScheduling(true)}>
            <Repeat size={14} className={schedule.item ? "pos" : undefined} />
            <span className="truncate">
              {schedule.item
                ? `${cadenceLabel(schedule.item.cadence)}, next ${dateLabel(schedule.item.nextDate)}`
                : schedule.dismissed ? "Not recurring" : "Set up"}
            </span>
            <ChevronDown size={14} />
          </button>
        </DetailRow>
      ) : null}

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
            {splitOff ? `. ${fmt(amount - splitTotal)} unassigned` : " ✓"}
          </div>
        ) : null}
      </div>

      {txn ? <div className="drow-block"><ActivityLog txn={txn} /></div> : null}

      {explaining ? <ExplainModal facts={explaining} onClose={() => setExplaining(null)} /> : null}
      {scheduling && txn ? (
        <RecurringEditor
          item={schedule.item ?? fromTransaction({ ...txn, ...asTyped() })}
          exists={!!schedule.item}
          nameLocked
          onClose={() => setScheduling(false)}
        />
      ) : null}
    </Modal>
  );
}

/**
 * What a statement line was, asked of the model.
 *
 * Asked once per merchant and then kept: the same city payment portal charges
 * every month, and the answer to "what is PAY*CITY OF FISHERS" does not change
 * between charges. A cached answer opens instantly and costs nothing, which is
 * a better saving than any discount on asking again.
 */
function ExplainModal({ facts, onClose }: { facts: ExplainFacts; onClose: () => void }) {
  const db = useDB();
  const { apply } = useStore();
  const cached = cachedExplanation(db, facts.statement);
  const [text, setText] = useState(cached ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(!cached);
  const asked = useRef(false);

  useEffect(() => {
    if (cached || asked.current) return;
    asked.current = true;
    void (async () => {
      try {
        const answer = await explainTransaction(facts, setText);
        setText(answer);
        // No label: nobody wants "undo: explained a transaction" sitting on
        // top of the edit they actually want back.
        apply((cur) => rememberExplanation(cur, facts.statement, answer));
      } catch (err) {
        setError(err instanceof Error ? err.message : "The explanation could not be fetched.");
      } finally {
        setBusy(false);
      }
    })();
  }, [cached, facts, apply]);

  return (
    <Modal title="Transaction Explanation" onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      <div className="col" style={{ gap: 16 }}>
        <div className="col" style={{ gap: 4 }}>
          <span className="tiny faint">Original Transaction</span>
          <span className="explain-statement">{facts.statement}</span>
        </div>
        <div className="col" style={{ gap: 4 }}>
          <span className="tiny faint">Explanation</span>
          {error ? <span className="small neg">{error}</span> : null}
          {text ? <div className="explain-body">{text}</div> : null}
          {busy && !text ? <span className="small muted">Working it out…</span> : null}
        </div>
      </div>
    </Modal>
  );
}
