import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, RotateCcw } from "lucide-react";
import type { Account } from "../types";
import { useStore } from "../store";
import { dateLabel } from "../lib/date";
import { Btn, Card, CardHead, ConfirmButton, Toggle } from "../components/ui";

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
          body="Keeps its transactions out of cash flow, budgets and reports — the history as well as anything new."
          on={Boolean(account.hideTransactions)}
          onChange={(v) => set({ hideTransactions: v })}
        />
      </div>

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
              next sync — the provider offering it again is remembered and ignored.
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
export function HiddenToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button className="hidden-toggle" onClick={onToggle}>
      {open ? <Eye size={14} /> : <EyeOff size={14} />}
      {open ? "Hide" : "Show"} {count} hidden account{count === 1 ? "" : "s"}
    </button>
  );
}
