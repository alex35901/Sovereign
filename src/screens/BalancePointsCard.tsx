import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Account } from "../types";
import { useStore } from "../store";
import { dateLabel, today } from "../lib/date";
import { Btn, Card, CardHead, Field, Money, MoneyInput, TextInput } from "../components/ui";

/**
 * Hand-entered balance points, dated.
 *
 * Some institutions — employer 401(k) recordkeepers especially — refuse
 * aggregator access outright, so the only way in is a quarterly statement and
 * a keyboard.
 */
export function BalancePointsCard({ account }: { account: Account }) {
  const { actions } = useStore();
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState(0);
  const [open, setOpen] = useState(false);

  const owed = ["credit", "loan", "mortgage", "other_liability"].includes(account.type);
  const recent = [...account.history].reverse().slice(0, 8);

  const add = () => {
    actions.setBalanceAt(account.id, date, owed ? -Math.abs(amount) : amount);
    setAmount(0);
    setDate(today());
  };

  return (
    <Card>
      <CardHead
        title="Balance points"
        sub={`${account.history.length} recorded · edit or add any date`}
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

      {recent.length ? (
        <div className="col" style={{ gap: 0 }}>
          {recent.map((h) => (
            <div key={h.date} className="spread" style={{ padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
              <span className="small muted">{dateLabel(h.date, { year: true })}</span>
              <span className="row" style={{ gap: 10 }}>
                <Money value={h.balance} cents={false} className="bold" />
                <button
                  className="btn btn-ghost btn-icon" title="Remove this point"
                  onClick={() => actions.deleteBalancePoint(account.id, h.date)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
          {account.history.length > recent.length ? (
            <span className="tiny faint" style={{ paddingTop: 8 }}>
              + {account.history.length - recent.length} older point{account.history.length - recent.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      ) : (
        <span className="small faint">No points yet — add one above, or import a CSV.</span>
      )}
    </Card>
  );
}
