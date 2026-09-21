import { useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import type { Account, PlaidItemRef } from "../types";
import { useDB, useStore } from "../store";
import { today } from "../lib/date";
import { fmt } from "../lib/money";
import { createLinkToken, exchangePublicToken, fetchItem } from "../lib/sync/plaid";
import { openPlaidLink } from "../lib/sync/plaid-link";
import { syncPlaidItem } from "../lib/sync";
import { adopt, floorFor } from "../lib/sync/adopt";
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

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await createLinkToken("bank");
      const publicToken = await openPlaidLink(token);
      if (!publicToken) return; // closed the dialog
      const fresh = await exchangePublicToken(publicToken, "bank");

      // A one-day window: this call is only here to find out which accounts
      // the new connection holds, and the transactions come with the sync
      // afterwards.
      const payload = await fetchItem(fresh, today());
      if (!payload.accounts.length) {
        setError("That connection reported no accounts. Nothing has been changed.");
        return;
      }
      setItem(fresh);
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
      actions.patchSettings({ plaidItems: [...(db.settings.plaidItems ?? []), item] });
      apply((cur) => ({
        ...cur,
        accounts: cur.accounts.map((a) => (a.id === account.id ? adopt(a, pick, from) : a)),
      }), `move ${account.name} to Plaid`);
      setChoices(null);
      notify(`${account.name} now comes from Plaid. Its history is untouched; anything from ${from} is taken from the new connection.`);
      await syncPlaidItem(db, apply, item);
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
          Connects the same bank through Plaid and points this account at it. Everything already
          here stays: only what arrives from now on comes the new way.
        </div>
        {error ? <div className="small neg" style={{ marginTop: 6 }}>{error}</div> : null}
      </div>

      {choices ? (
        <Modal
          title={`Which one is ${account.name}?`}
          onClose={() => { setChoices(null); setItem(null); }}
          footer={<Btn onClick={() => { setChoices(null); setItem(null); }}>Not now</Btn>}
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
