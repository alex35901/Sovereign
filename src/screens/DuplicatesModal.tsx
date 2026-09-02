import { useMemo, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useDB, useStore } from "../store";
import type { DupeOptions } from "../lib/dedupe";
import { DEFAULT_OPTIONS, findDuplicates, idsToDrop, isSynced, summarise } from "../lib/dedupe";
import { Btn, Modal, Money, SelectInput, Toggle } from "../components/ui";
import { dateLabel } from "../lib/date";

/**
 * Finding and removing transactions imported twice.
 *
 * Nothing is deleted until the list has been shown and the button pressed. The
 * looser the match, the more real transactions it can sweep up — two coffees on
 * one day at one price are not a mistake — so the settings say what they cost
 * and the default is the strict one.
 */
export function DuplicatesModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const { actions, notify } = useStore();
  const [opts, setOpts] = useState<DupeOptions>(DEFAULT_OPTIONS);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState(false);

  const groups = useMemo(() => findDuplicates(db.transactions, opts), [db.transactions, opts]);
  const kept = groups.filter((g) => !excluded.has(g.keep.id));
  const sum = summarise(kept);

  const set = (patch: Partial<DupeOptions>) => {
    setOpts((o) => ({ ...o, ...patch }));
    setExcluded(new Set());
    setArmed(false);
  };

  const remove = () => {
    const ids = idsToDrop(kept);
    if (!ids.length) return;
    actions.deleteTransactions(ids);
    notify(`Deleted ${ids.length} duplicate${ids.length === 1 ? "" : "s"}. Undo puts them all back.`);
    onClose();
  };

  const accountOf = (id: string) => db.accounts.find((a) => a.id === id)?.name ?? "an account";

  return (
    <Modal wide title="Find duplicate transactions" onClose={onClose}>
      <div className="col" style={{ gap: 14 }}>
        <div className="small muted" style={{ maxWidth: 660 }}>
          Transactions that look like the same thing more than once. Each group keeps one — the one the
          bank still syncs, or the one you have already categorised — and offers the rest for deletion.
          Nothing goes until you press the button, and one undo brings it all back.
        </div>

        <div className="row wrap" style={{ gap: 18, alignItems: "flex-start" }}>
          <div className="col" style={{ gap: 9 }}>
            <Toggle
              on={opts.sameMerchant}
              onChange={(v) => set({ sameMerchant: v })}
              label={<span className="small">Merchant must match too</span>}
            />
            <Toggle
              on={opts.sameAccount}
              onChange={(v) => set({ sameAccount: v })}
              label={<span className="small">Same account only</span>}
            />
          </div>
          <div className="col" style={{ gap: 4, minWidth: 190 }}>
            <span className="tiny faint">Dates may differ by</span>
            <SelectInput
              value={String(opts.dayTolerance)}
              onChange={(v) => set({ dayTolerance: Number(v) })}
              options={[
                { value: "0", label: "the same day" },
                { value: "1", label: "1 day" },
                { value: "2", label: "2 days" },
                { value: "3", label: "3 days" },
              ]}
            />
          </div>
        </div>

        {!opts.sameMerchant || !opts.sameAccount || opts.dayTolerance > 0 ? (
          <div className="setting-row" style={{ borderColor: "var(--neg)", background: "var(--neg-soft)" }}>
            <span className="small row" style={{ gap: 8, alignItems: "flex-start" }}>
              <AlertTriangle size={15} className="neg" style={{ flex: "none", marginTop: 2 }} />
              <span>
                <b>This is matching loosely.</b>{" "}
                {!opts.sameMerchant
                  ? "Ignoring the merchant will pair up two different things bought for the same amount on the same day. "
                  : ""}
                {!opts.sameAccount ? "Ignoring the account will pair up the same purchase made on two cards. " : ""}
                {opts.dayTolerance > 0 ? "A date window pairs up anything repeating within it — a daily coffee, for one. " : ""}
                Read the list before deleting.
              </span>
            </span>
          </div>
        ) : null}

        <div className="row wrap" style={{ gap: 16 }}>
          <span className="small">
            <b>{sum.groups}</b> group{sum.groups === 1 ? "" : "s"}, <b>{sum.duplicates}</b> to delete
          </span>
          {sum.duplicates ? (
            <span className="small muted">
              worth <Money value={-sum.amount} colored /> back
            </span>
          ) : null}
          {excluded.size ? <span className="small muted">{excluded.size} group{excluded.size === 1 ? "" : "s"} set aside</span> : null}
        </div>

        {groups.length ? (
          <div className="card flush" style={{ maxHeight: 420, overflowY: "auto" }}>
            {groups.map((g) => {
              const off = excluded.has(g.keep.id);
              return (
                <div key={g.keep.id} className="list-row" style={{ alignItems: "flex-start", opacity: off ? 0.45 : 1 }}>
                  <div className="grow col" style={{ gap: 4, minWidth: 0 }}>
                    <span className="small row" style={{ gap: 8 }}>
                      <span className="pos" style={{ flex: "none", width: 44 }}>keep</span>
                      <span className="truncate"><b>{g.keep.merchant}</b></span>
                      <span className="faint tiny">
                        {dateLabel(g.keep.date)} · {accountOf(g.keep.accountId)}
                        {isSynced(g.keep) ? " · from the bank" : ""}
                        {g.keep.reviewed ? " · reviewed" : ""}
                      </span>
                      <span className="num" style={{ marginLeft: "auto" }}><Money value={g.keep.amount} colored /></span>
                    </span>
                    {g.drop.map((d) => (
                      <span key={d.id} className="small row" style={{ gap: 8 }}>
                        <span className="neg" style={{ flex: "none", width: 44 }}>delete</span>
                        <span className="truncate faint">{d.merchant}</span>
                        <span className="faint tiny">
                          {dateLabel(d.date)} · {accountOf(d.accountId)}
                          {d.reviewed ? " · reviewed" : ""}
                        </span>
                        <span className="num faint" style={{ marginLeft: "auto" }}><Money value={d.amount} /></span>
                      </span>
                    ))}
                  </div>
                  <Btn
                    size="sm"
                    onClick={() => {
                      setExcluded((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.keep.id)) next.delete(g.keep.id);
                        else next.add(g.keep.id);
                        return next;
                      });
                      setArmed(false);
                    }}
                  >
                    {off ? "Include" : "Keep both"}
                  </Btn>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="small muted">
            Nothing matches these settings. If you know there are duplicates, try turning off
            &ldquo;Merchant must match&rdquo; — a second import that mapped a different column is the usual
            reason two copies look different to the app but the same to you.
          </div>
        )}

        <div className="row wrap" style={{ gap: 8 }}>
          <Btn
            variant={armed ? "danger" : "primary"}
            disabled={!sum.duplicates}
            onClick={() => (armed ? remove() : setArmed(true))}
          >
            <Trash2 size={14} />
            {armed
              ? `Click again to delete ${sum.duplicates}`
              : `Delete ${sum.duplicates || ""} duplicate${sum.duplicates === 1 ? "" : "s"}`}
          </Btn>
          <Btn onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}
