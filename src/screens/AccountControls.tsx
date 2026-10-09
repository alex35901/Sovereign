import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, RotateCcw } from "lucide-react";
import type { Account, ID } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel } from "../lib/date";
import { Btn, Card, CardHead, ConfirmButton, Toggle, cx } from "../components/ui";

/** One switch and the sentence explaining what it actually does. */
function Row({ title, body, on, onChange }: {
  title: string; body: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 500 }}>{title}</span>
        <span className="small muted">{body}</span>
      </div>
      <Toggle on={on} onChange={onChange} label={null} />
    </div>
  );
}

/**
 * What to do with an account short of editing it: take it out of the lists, out
 * of the totals, out of the figures — or settle it and be done.
 */
export function AccountControls({ account }: { account: Account }) {
  const { actions, notify } = useStore();
  const nav = useNavigate();
  const set = (patch: Partial<Account>) => actions.updateAccount(account.id, patch);

  return (
    <Card>
      <CardHead title="Visibility" sub="Where this account counts, and where it doesn't" />

      <div className="col" style={{ gap: 10 }}>
        <Row
          title="Hide account"
          body="Moves it off the Accounts page into the hidden list. Its balance still counts."
          on={account.hidden}
          onChange={(v) => set({ hidden: v })}
        />
        <Row
          title="Exclude account balance"
          body="Leaves this balance out of net worth and its group total."
          on={!account.includeInNetWorth}
          onChange={(v) => set({ includeInNetWorth: !v })}
        />
        <Row
          title="Hide transactions"
          body="Keeps its transactions out of cash flow, budgets and reports. The history as well as anything new."
          on={Boolean(account.hideTransactions)}
          onChange={(v) => set({ hideTransactions: v })}
        />
      </div>

      <div className="divider" />
      <ReconcileWith account={account} />

      <div className="divider" />
      <CardHead title="Actions" sub={account.closedAt ? `Closed ${dateLabel(account.closedAt, { year: true })}` : undefined} />

      <div className="col" style={{ gap: 10 }}>
        <div className="setting-row">
          <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 500 }}>{account.closedAt ? "Reopen account" : "Close account"}</span>
            <span className="small muted">
              {account.closedAt
                ? "Start tracking it again. Syncing will resume on the next pull."
                : "Sets the balance to $0 and keeps the history. Syncing stops touching it."}
            </span>
          </div>
          {account.closedAt ? (
            <Btn onClick={() => { actions.reopenAccount(account.id); notify(`${account.name} reopened.`); }}>
              <RotateCcw size={14} /> Reopen
            </Btn>
          ) : (
            <ConfirmButton
              label="Close"
              confirmLabel="Click again to close"
              onConfirm={() => { actions.closeAccount(account.id); notify(`${account.name} closed at $0. Its history is intact.`); }}
            />
          )}
        </div>

        <div className="setting-row">
          <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 500 }}>Delete account</span>
            <span className="small muted">
              Removes the account, its transactions and its holdings. It won't come back on the
              next sync: the provider offering it again is remembered and ignored.
            </span>
          </div>
          <ConfirmButton
            label="Delete"
            confirmLabel="Click again to delete"
            onConfirm={() => {
              actions.deleteAccount(account.id);
              notify(`${account.name} deleted. Undo is in the toast if that was a mistake.`);
              nav("/accounts");
            }}
          />
        </div>
      </div>
    </Card>
  );
}

/** The eye that opens the hidden list, as on the accounts page. */
/**
 * Which rollover categories this account is holding the money for.
 *
 * The month-end job somebody does by hand: add up what every rollover category
 * still has left and check it against the account the money actually sits in.
 * Saying which categories belong here is the whole of the setup; the table on
 * the account's own page does the addition from the months already recorded.
 *
 * Only rollover categories are offered. A category that does not carry has
 * nothing left at the end of a month by definition, so it has nothing to be
 * reconciled against and listing it would be offering a sum of zeroes.
 */
function ReconcileWith({ account }: { account: Account }) {
  const db = useDB();
  const { actions } = useStore();
  const chosen = account.rolloverCategoryIds ?? [];
  const able = db.categories
    .filter((c) => c.rollover && !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggle = (id: ID) => actions.updateAccount(account.id, {
    rolloverCategoryIds: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id],
  });

  return (
    <>
      <CardHead
        title="Reconcile against"
        sub={able.length
          ? "The rollover categories this account holds the money for"
          : "Nothing to reconcile against yet"}
      />
      {able.length ? (
        <div className="col" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {able.map((c) => (
              <button
                key={c.id}
                className={cx("chip", chosen.includes(c.id) && "on")}
                aria-pressed={chosen.includes(c.id)}
                onClick={() => toggle(c.id)}
              >
                {c.icon} {c.name}
              </button>
            ))}
          </div>
          <span className="tiny faint">
            {chosen.length
              ? `${chosen.length} chosen. The account's page shows what they came to at the end of each month, beside what the account held.`
              : "Choose some and a table appears on this account's page, checking the two against each other month by month."}
          </span>
        </div>
      ) : (
        <span className="tiny faint">
          Switch rollover on for a category under Categories, and it can be chosen here.
        </span>
      )}
    </>
  );
}

export function HiddenToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button className="hidden-toggle" onClick={onToggle}>
      {open ? <Eye size={14} /> : <EyeOff size={14} />}
      {open ? "Hide" : "Show"} {count} hidden account{count === 1 ? "" : "s"}
    </button>
  );
}
