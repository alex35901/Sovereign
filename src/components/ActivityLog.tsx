import { useState } from "react";
import { ChevronDown, ChevronRight, Pencil, Plus } from "lucide-react";
import type { Transaction } from "../types";
import { useDB } from "../store";
import { eventDetail, eventTitle, eventWhen, history } from "../lib/activity";

/**
 * A transaction's history: how it arrived, and everything changed since.
 *
 * Collapsed by default — it is a record to consult when a figure looks wrong,
 * not something to read every time the transaction is opened.
 */
export function ActivityLog({ txn }: { txn: Transaction }) {
  const db = useDB();
  const [open, setOpen] = useState(false);
  const account = db.accounts.find((a) => a.id === txn.accountId);
  const events = [...history(txn, account?.syncSource)].reverse();

  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="small muted">Activity</span>
      <div className="activity">
        <button className="activity-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown size={15} className="faint" /> : <ChevronRight size={15} className="faint" />}
          <span style={{ fontWeight: 600 }}>
            {events.length} event{events.length === 1 ? "" : "s"}
          </span>
        </button>
        {open ? (
          <div className="activity-list">
            {events.map((e, i) => (
              <div key={`${e.at}-${i}`} className="activity-row">
                <span className="activity-mark">
                  {e.kind === "added" ? <Plus size={13} /> : <Pencil size={12} />}
                </span>
                <div className="col" style={{ gap: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{eventTitle(e)}</span>
                  <span className="tiny faint">{eventWhen(e.at)} — {eventDetail(e)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
