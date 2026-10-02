import { useMemo, useState } from "react";
import { ArrowRight, Link2 } from "lucide-react";
import type { Account, ID } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel } from "../lib/date";
import { fmt } from "../lib/money";
import { foldInto, replacementsFor, strandedIn, suggestedPairs } from "../lib/sync/reattach";
import { ACCOUNT_TYPE_LABEL } from "../lib/select";
import { Btn, Card, CardHead } from "../components/ui";

/**
 * Putting an account back onto the connection that replaced its own.
 *
 * The repair for a bank that had to be disconnected and connected again. Most
 * of its accounts come back to themselves, because the merge looks for them by
 * name when the id it knew has gone; the ones whose names do not line up
 * arrive as new accounts instead, and the real ones are left holding
 * everything and getting nothing.
 *
 * So: which new one is which old one. It is the only part of this a person
 * knows and the app cannot, and it is one press once it is said.
 */

const LEAVE = "";

function rowsFor(transactions: readonly { accountId: ID }[], id: ID): number {
  return transactions.reduce((n, t) => n + (t.accountId === id ? 1 : 0), 0);
}

/** @param only one account's own page, rather than the list in Settings. */
export function ReattachCard({ only }: { only?: Account }) {
  const db = useDB();
  const { apply, notify } = useStore();
  const [picked, setPicked] = useState<Record<ID, ID> | null>(null);

  const stranded = useMemo(
    () => strandedIn(db).filter((s) => !only || s.account.id === only.id),
    [db, only],
  );
  const options = useMemo(
    () => new Map(stranded.map((s) => [s.account.id, replacementsFor(db, s.account)])),
    [db, stranded],
  );

  // The app's own guess, held separately from what has been chosen so a
  // household that clears one row does not have it filled back in on the next
  // render. Only accounts that have a candidate at all are offered.
  const suggested = useMemo(() => {
    const out: Record<ID, ID> = {};
    for (const p of suggestedPairs(db)) {
      if (stranded.some((s) => s.account.id === p.strandedId)) out[p.strandedId] = p.intoId;
    }
    return out;
  }, [db, stranded]);

  const choice = picked ?? suggested;
  const pairs = stranded
    .map((s) => ({ keepId: s.account.id, dropId: choice[s.account.id] }))
    .filter((p): p is { keepId: ID; dropId: ID } => Boolean(p.dropId));

  const withOptions = stranded.filter((s) => (options.get(s.account.id)?.length ?? 0) > 0);
  if (!withOptions.length) return null;

  const set = (strandedId: ID, intoId: ID) => {
    const next = { ...choice };
    if (intoId === LEAVE) delete next[strandedId];
    else {
      // One new account cannot be two old ones.
      for (const k of Object.keys(next)) if (next[k] === intoId) delete next[k];
      next[strandedId] = intoId;
    }
    setPicked(next);
  };

  const run = () => {
    let moved = 0;
    let rekeyed = 0;
    let next = db;
    for (const p of pairs) {
      const out = foldInto(next, p.keepId, p.dropId);
      next = out.db;
      moved += out.moved;
      rekeyed += out.rekeyed;
    }
    const names = pairs
      .map((p) => db.accounts.find((a) => a.id === p.keepId)?.name)
      .filter(Boolean) as string[];
    apply(
      (cur) => pairs.reduce((acc, p) => foldInto(acc, p.keepId, p.dropId).db, cur),
      names.length === 1 ? `reattach ${names[0]}` : `reattach ${names.length} accounts`,
    );
    setPicked({});
    const said = [
      moved ? `${moved.toLocaleString()} transaction${moved === 1 ? "" : "s"} moved across` : null,
      rekeyed ? `${rekeyed.toLocaleString()} already here now recognised by the new connection` : null,
    ].filter(Boolean).join(", ");
    notify(
      `${names.length === 1 ? names[0] : `${names.length} accounts`} now come${names.length === 1 ? "s" : ""} from the new connection.`
      + (said ? ` ${said[0]!.toUpperCase()}${said.slice(1)}.` : ""),
    );
  };

  const one = withOptions.length === 1;

  const head = (
    <CardHead
      flush={Boolean(only)}
      title={only ? "This account is getting nothing" : "Accounts getting nothing"}
      sub={
        one
          ? "A connection to this bank is working, and is not feeding this account"
          : `${withOptions.length} accounts are not being fed by any connection here`
      }
      right={
        <Btn variant="primary" onClick={run} disabled={!pairs.length}>
          <Link2 size={14} /> {pairs.length > 1 ? `Move ${pairs.length} over` : "Move it over"}
        </Btn>
      }
    />
  );

  const body = (
    <>
      {head}

      <div className="small muted" style={{ marginBottom: 12, maxWidth: 640 }}>
        A bank connected again is a new connection, with new ids for every account behind it. Accounts
        whose names line up come back to themselves; these did not, so the login handed them over as
        new accounts and left these holding your history. Say which new account is which, and the
        account you already have takes it over: same account, same budget, same rules, same
        transactions, now fed by the connection that answers. The new copy and its few days of
        transactions are folded in, and anything already here is kept rather than doubled.
      </div>

      <div className="col" style={{ gap: 10 }}>
        {withOptions.map(({ account, why }) => {
          const choices = options.get(account.id) ?? [];
          const rows = rowsFor(db.transactions, account.id);
          return (
            <div key={account.id} className="reattach-row">
              <div className="col" style={{ gap: 2, minWidth: 0 }}>
                <span className="truncate" style={{ fontWeight: 500 }}>{account.name}</span>
                <span className="tiny faint">
                  {ACCOUNT_TYPE_LABEL[account.type]} · {fmt(account.balance, { sign: false })} ·{" "}
                  {rows.toLocaleString()} transaction{rows === 1 ? "" : "s"}
                  {account.lastSyncedAt ? ` · last fed ${dateLabel(account.lastSyncedAt.slice(0, 10))}` : ""}
                </span>
                <span className="tiny faint">
                  {why === "gone"
                    ? "The connection this came in on is not here any more."
                    : "A connection to this bank pulled and did not recognise this account."}
                </span>
              </div>
              <ArrowRight size={14} className="faint reattach-arrow" />
              <div className="col" style={{ gap: 2, minWidth: 0 }}>
                <select
                  className="select"
                  value={choice[account.id] ?? LEAVE}
                  onChange={(e) => set(account.id, e.target.value)}
                >
                  <option value={LEAVE}>Leave it alone</option>
                  {choices.map((r) => (
                    <option key={r.account.id} value={r.account.id}>
                      {r.account.name}
                      {r.account.type !== account.type ? ` (${ACCOUNT_TYPE_LABEL[r.account.type]})` : ""}
                      {`, ${fmt(r.account.balance, { sign: false })}`}
                      {r.rows ? `, ${r.rows.toLocaleString()} row${r.rows === 1 ? "" : "s"}` : ", nothing on it yet"}
                    </option>
                  ))}
                </select>
                <span className="tiny faint">
                  {/* Named rather than pointed at: the two columns stack on a
                      phone, where "on the left" is nowhere. */}
                  {choice[account.id]
                    ? `Folded into ${account.name}, which keeps its name and everything on it.`
                    : "Nothing happens to this one."}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  // On an account's own page this sits inside the connection card, where a
  // second card around it would be a box inside a box.
  return only ? <div className="conn-detail col" style={{ gap: 10 }}>{body}</div> : <Card>{body}</Card>;
}
