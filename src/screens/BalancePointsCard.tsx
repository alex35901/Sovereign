import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { Account } from "../types";
import { useStore } from "../store";
import { dateLabel, today } from "../lib/date";
import { Btn, Card, CardHead, Field, Money, MoneyInput, TextInput } from "../components/ui";

/** How many points to show before the list has to be asked for in full. */
const PREVIEW = 8;

/**
 * Hand-entered balance points, dated.
 *
 * Some institutions — employer 401(k) recordkeepers especially — refuse
 * aggregator access outright, so the only way in is a quarterly statement and
 * a keyboard. Any point can also be corrected here: a synced balance that
 * arrived wrong, or a typo in an imported file.
 */
export function BalancePointsCard({ account }: { account: Account }) {
  const { actions, notify } = useStore();
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState(0);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(0);

  const owed = ["credit", "loan", "mortgage", "other_liability"].includes(account.type);
  const newest = [...account.history].reverse();
  const shown = all ? newest : newest.slice(0, PREVIEW);

  const add = () => {
    actions.setBalanceAt(account.id, date, owed ? -Math.abs(amount) : amount);
    setAmount(0);
    setDate(today());
  };

  const startEdit = (h: { date: string; balance: number }) => {
    setEditing(h.date);
    // typed as a positive figure for a debt, the way it reads on a statement
    setDraft(owed ? Math.abs(h.balance) : h.balance);
  };

  const commit = (on: string) => {
    actions.setBalanceAt(account.id, on, owed ? -Math.abs(draft) : draft);
    setEditing(null);
    notify(`${dateLabel(on, { year: true })} set to ${owed ? "-" : ""}${(Math.abs(draft) / 100).toFixed(2)}.`);
  };

  return (
    <Card>
      <CardHead
        title="Edit balance history"
        sub={`${account.history.length} point${account.history.length === 1 ? "" : "s"} · change any value, or add a date`}
        right={<Btn onClick={() => setOpen((o) => !o)}><Plus size={14} /> Add a balance</Btn>}
      />

      {open ? (
        <div className="row wrap" style={{ gap: 12, alignItems: "flex-end", marginBottom: 14 }}>
          <Field label="As of">
            <TextInput type="date" value={date} onChange={setDate} />
          </Field>
          <Field label={owed ? "Amount owed" : "Balance"}>
            <MoneyInput value={amount} onChange={setAmount} autoFocus />
          </Field>
          <Btn variant="primary" onClick={add} disabled={!date}>Save point</Btn>
        </div>
      ) : null}

      {shown.length ? (
        <div className="col" style={{ gap: 0 }}>
          {shown.map((h) => (
            <div key={h.date} className="spread balance-point">
              <span className="small muted">{dateLabel(h.date, { year: true })}</span>
              {editing === h.date ? (
                <span className="row" style={{ gap: 6 }}>
                  <div style={{ width: 140 }}>
                    <MoneyInput value={draft} onChange={setDraft} autoFocus />
                  </div>
                  <button className="btn btn-primary btn-icon" title="Save" onClick={() => commit(h.date)}>
                    <Check size={14} />
                  </button>
                  <button className="btn btn-ghost btn-icon" title="Cancel" onClick={() => setEditing(null)}>
                    <X size={14} />
                  </button>
                </span>
              ) : (
                <span className="row" style={{ gap: 10 }}>
                  <Money value={h.balance} cents={false} className="bold" />
                  <button className="btn btn-ghost btn-icon" title="Change this balance" onClick={() => startEdit(h)}>
                    <Pencil size={13} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon" title="Remove this point"
                    onClick={() => actions.deleteBalancePoint(account.id, h.date)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              )}
            </div>
          ))}
          {newest.length > PREVIEW ? (
            <button
              className="btn btn-ghost btn-sm"
              style={{ alignSelf: "flex-start", marginTop: 8 }}
              onClick={() => setAll((v) => !v)}
            >
              {all ? "Show fewer" : `Show all ${newest.length} points`}
            </button>
          ) : null}
        </div>
      ) : (
        <span className="small faint">No points yet — add one above, or import a CSV.</span>
      )}
    </Card>
  );
}
