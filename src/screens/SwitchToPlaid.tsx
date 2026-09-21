import { useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import type { Account, PlaidItemRef } from "../types";
import { useDB, useStore } from "../store";
import { today } from "../lib/date";
import { fmt } from "../lib/money";
import { createLinkToken, exchangePublicToken, fetchItem } from "../lib/sync/plaid";
import { openPlaidLink } from "../lib/sync/plaid-link";
import { syncPlaidItem } from "../lib/sync";
import { adopt, floorFor, itemFor } from "../lib/sync/adopt";
import { Btn, Modal } from "../components/ui";

/**
 * Moving one account from SimpleFIN to Plaid without losing what is on it.
 *
 * Connecting the same bank through Plaid on its own would make a second
 * account and refile two years of transactions under ids nothing recognises,
 * leaving two of everything and a budget attached to the wrong half. This does
 * the same connection, then says which existing account the new one is, which
 * is the only part a person actually knows and the app cannot.
 */

interface Candidate {
  syncId: string;
  name: string;
  institution: string;
  balance: number;
  logo?: string;
  domain?: string;
}

export function SwitchToPlaid({ account }: { account: Account }) {
  const db = useDB();
  const { apply, actions, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Candidate[] | null>(null);
  const [item, setItem] = useState<PlaidItemRef | null>(null);

  /**
   * The connection this bank already has, which is almost always the one to
   * use. A Plaid connection is one login and holds every account behind it, so
   * a household moving its chequing and its savings across should end up with
   * one connection, not two of the plan's ten fighting over the same accounts.
   */
  const held = itemFor(db.settings.plaidItems ?? [], account.institution ?? "", "bank");

  /**
   * @param anotherLogin skips the connection already held and opens Plaid, for
   * the bank where the second account really does sit behind a second login.
   */
  const start = async (anotherLogin = false) => {
    setBusy(true);
    setError(null);
    try {
      const use = !anotherLogin && held
        ? held
        : await (async () => {
          const token = await createLinkToken("bank");
          const publicToken = await openPlaidLink(token);
          if (!publicToken) return null; // closed the dialog
          return exchangePublicToken(publicToken, "bank");
        })();
      if (!use) return;

      // A one-day window: this call is only here to find out which accounts
      // the connection holds, and the transactions come with the sync
      // afterwards.
      const payload = await fetchItem(use, today());
      if (!payload.accounts.length) {
        setError("That connection reported no accounts. Nothing has been changed.");
        return;
      }
      setItem(use);
      setChoices(payload.accounts.map((a) => ({
        syncId: a.syncId, name: a.name, institution: a.institution,
        balance: a.balance, logo: a.logo, domain: a.domain,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open Plaid.");
    } finally {
      setBusy(false);
    }
  };

  const choose = async (pick: Candidate) => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      const from = floorFor(db, account.id, account.lastSyncedAt?.slice(0, 10) ?? today());
      // The item first, then the account, in one write each so a failure
      // between them leaves a connected item rather than an account pointing
      // at one that is not there.
      // Appended only when it is new. Moving a second account onto a
      // connection already held must not file that connection twice.
      const kept = db.settings.plaidItems ?? [];
      if (!kept.some((i) => i.itemId === item.itemId)) {
        actions.patchSettings({ plaidItems: [...kept, item] });
      }
      apply((cur) => ({
        ...cur,
        accounts: cur.accounts.map((a) => (a.id === account.id ? adopt(a, pick, from) : a)),
      }), `move ${account.name} to Plaid`);
      setChoices(null);
      notify(`${account.name} now comes from Plaid. Its history is untouched; anything from ${from} is taken from the new connection.`);
      await syncPlaidItem(apply, item);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish the switch.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="conn-detail">
        <Btn onClick={() => void start()} disabled={busy}>
          <ArrowRightLeft size={14} /> {busy ? "Opening…" : "Move this account to Plaid"}
        </Btn>
        <div className="tiny faint" style={{ marginTop: 6 }}>
          {held
            ? `Uses the ${held.institution} connection you already have, so this costs no extra Plaid connection. `
            : "Connects the same bank through Plaid and points this account at it. "}
          Everything already here stays: only what arrives from now on comes the new way.
        </div>
        {error ? <div className="small neg" style={{ marginTop: 6 }}>{error}</div> : null}
      </div>

      {choices ? (
        <Modal
          title={`Which one is ${account.name}?`}
          onClose={() => { setChoices(null); setItem(null); }}
          footer={
            <>
              {/* The same bank behind a second login is a real thing, and the
                  accounts listed above are the proof of which case this is. */}
              <Btn onClick={() => { setChoices(null); setItem(null); void start(true); }} disabled={busy}>
                Use a different login
              </Btn>
              <Btn onClick={() => { setChoices(null); setItem(null); }}>Not now</Btn>
            </>
          }
        >
          <div className="small muted">
            Plaid found these behind that login. Pick the one this account already is, and its
            transactions, budget and rules carry straight over.
          </div>
          <div className="col" style={{ gap: 8 }}>
            {choices.map((c) => (
              <Btn key={c.syncId} onClick={() => void choose(c)} disabled={busy}>
                <span className="grow truncate" style={{ textAlign: "left" }}>{c.name}</span>
                <span className="num">{fmt(c.balance, { sign: false })}</span>
              </Btn>
            ))}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
