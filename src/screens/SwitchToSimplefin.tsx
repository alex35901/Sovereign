import { useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import type { Account } from "../types";
import { useDB, useStore } from "../store";
import { today } from "../lib/date";
import { fmt } from "../lib/money";
import { fetchBridge } from "../lib/sync/simplefin";
import { syncSimplefin } from "../lib/sync";
import { adopt, floorFor, sameInstitution } from "../lib/sync/adopt";
import { accountKeys } from "../lib/sync/merge";
import { reason } from "../lib/usage";
import { Btn, Modal } from "../components/ui";

/**
 * Putting an account already here onto the bridge, without losing what is on
 * it.
 *
 * The mirror of SwitchToPlaid, and the direction a household actually travels
 * now: Plaid bills for every connection every month, and the bridge is one
 * subscription for the lot. What makes it more than a note in a readme is that
 * authorising the same bank at the bridge and letting the next pull find it
 * would file a second account beside this one and refile years of
 * transactions under ids nothing recognises. This says which account the
 * bridge's is, which is the only part a person knows and the app cannot.
 *
 * The move is one write to one account. The bridge's own connection is
 * already there, so nothing is connected, nothing is signed into, and the
 * worst case is picking the wrong account and switching it back.
 */

interface Candidate {
  syncId: string;
  name: string;
  institution: string;
  balance: number;
  logo?: string;
  domain?: string;
}

export function SwitchToSimplefin({ account }: { account: Account }) {
  const db = useDB();
  const { apply, actions, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Candidate[] | null>(null);

  const ref = db.settings.simplefin;
  if (!ref) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // A one-day window: this call is only here to find out which accounts
      // the bridge is carrying, and the transactions come with the sync
      // afterwards.
      const day = today();
      const payload = await fetchBridge(ref, day, day);
      // The ones another account here is already pointed at are not choices:
      // two accounts on one id leaves the second silently unfed while the
      // bridge goes on reporting itself healthy.
      const taken = new Set(
        db.accounts
          .filter((a) => a.id !== account.id && a.syncSource === "simplefin" && a.syncId)
          .map((a) => a.syncId!),
      );
      const free = payload.accounts.filter((a) => !taken.has(a.syncId));
      if (!free.length) {
        setError(payload.accounts.length
          ? "Every account the bridge is carrying is already pointed at something here. If the bridge has already filed its own copy of this account, delete that copy and try again, or fold this one into it under Accounts getting nothing in Settings. Otherwise authorise this bank at the bridge first."
          : "The bridge reported no accounts. Nothing has been changed.");
        return;
      }
      setChoices(free
        .map((a) => ({
          syncId: a.syncId, name: a.name, institution: a.institution,
          balance: a.balance, logo: a.logo, domain: a.domain,
        }))
        // The same bank first. Two providers rarely spell an institution the
        // same way, so this is a sort rather than a filter: being wrong about
        // it must not hide the account somebody came here to pick.
        .sort((x, y) =>
          Number(sameInstitution(y.institution, account.institution ?? ""))
          - Number(sameInstitution(x.institution, account.institution ?? ""))));
    } catch (err) {
      setError(reason(err, "The bridge could not be reached."));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (pick: Candidate) => {
    setBusy(true);
    setError(null);
    try {
      const from = floorFor(db, account.id, account.lastSyncedAt?.slice(0, 10) ?? today());
      // Whatever this account was called when it was deleted here before, it
      // is being adopted on purpose now. Leaving the tombstone would have
      // every later pull turn it away at the door and say nothing.
      const buried = accountKeys({ syncId: pick.syncId, name: pick.name, institution: pick.institution });
      const held = db.settings.deletedAccountKeys ?? [];
      const tombstones = held.filter((k) => !buried.includes(k));
      if (tombstones.length !== held.length) actions.patchSettings({ deletedAccountKeys: tombstones });
      apply((cur) => ({
        ...cur,
        accounts: cur.accounts.map((a) => (a.id === account.id ? adopt(a, pick, from, "simplefin") : a)),
      }), `move ${account.name} to SimpleFIN`);
      setChoices(null);
      notify(`${account.name} now comes from SimpleFIN. Its history is untouched; anything from ${from} is taken from the bridge. Disconnect the old connection for this bank so you stop paying for it.`);
      await syncSimplefin(db, apply);
    } catch (err) {
      setError(reason(err, "Could not finish the switch."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="conn-detail">
        <Btn variant={account.syncSource === "plaid" ? "primary" : undefined} onClick={() => void start()} disabled={busy}>
          <ArrowRightLeft size={14} /> {busy ? "Asking the bridge…" : "Move this account to SimpleFIN"}
        </Btn>
        <div className="tiny faint" style={{ marginTop: 6 }}>
          Authorise the bank at the bridge first, then point this account at it here. Everything
          already here stays: only what arrives from now on comes the new way.
        </div>
        {error ? <div className="small neg" style={{ marginTop: 6 }}>{error}</div> : null}
      </div>

      {choices ? (
        <Modal
          title={`Which one is ${account.name}?`}
          onClose={() => setChoices(null)}
          footer={<Btn onClick={() => setChoices(null)}>Not now</Btn>}
        >
          <div className="small muted">
            The bridge is carrying these. Pick the one this account already is, and its
            transactions, budget and rules carry straight over.
          </div>
          <div className="col" style={{ gap: 8 }}>
            {choices.map((c) => (
              <Btn key={c.syncId} onClick={() => void choose(c)} disabled={busy}>
                <span className="col grow" style={{ gap: 0, minWidth: 0, textAlign: "left" }}>
                  <span className="truncate">{c.name}</span>
                  <span className="tiny faint truncate">{c.institution}</span>
                </span>
                <span className="num">{fmt(c.balance, { sign: false })}</span>
              </Btn>
            ))}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
