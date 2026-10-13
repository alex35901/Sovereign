import { useMemo, useState } from "react";
import { Building2, Link2, RefreshCw, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { Account, DB } from "../types";
import { useDB, useStore } from "../store";
import { claimSetupToken } from "../lib/sync/simplefin";
import { syncSimplefin } from "../lib/sync";
import { reason } from "../lib/usage";
import { ACCOUNT_TYPE_LABEL } from "../lib/select";
import { dateLabel, sinceLabel } from "../lib/date";
import { Btn, Card, CardHead, Field } from "../components/ui";

/**
 * The banks behind the bridge, each with what came in through it.
 *
 * The same shape the Plaid card draws, because it is the same question: one
 * connection is a sign-in and every account behind it, and which account is
 * behind which sign-in is the thing you need to know before changing how one
 * of them is read. The bridge holds one credential for every bank authorised
 * at it, so the grouping is by institution rather than by login: that is what
 * a person has at the bridge, and what they would go there to repair.
 *
 * Grouped off the accounts themselves rather than off the last payload, which
 * is not kept: the document is the record of what arrived, and it is the thing
 * still true the morning after a pull that failed.
 */
interface Behind {
  institution: string;
  accounts: Account[];
  /** The newest the bridge has said anything about any of them. */
  seen?: string;
  /** Nothing in the last pull was for this bank, and it is not closed. */
  quiet: boolean;
}

function behindBridge(db: DB, lastPull?: string): Behind[] {
  const groups = new Map<string, Account[]>();
  for (const a of db.accounts) {
    if (a.syncSource !== "simplefin") continue;
    const who = a.institution || "Unnamed";
    groups.set(who, [...(groups.get(who) ?? []), a]);
  }
  return [...groups.entries()]
    .map(([institution, held]) => {
      // Closed last, then in the household's own order, the same way the
      // connections above are listed.
      const accounts = [...held].sort((a, b) =>
        Number(Boolean(a.closedAt)) - Number(Boolean(b.closedAt)) || a.order - b.order);
      const open = accounts.filter((a) => !a.closedAt);
      const seen = open.reduce<string | undefined>(
        (best, a) => (a.lastSyncedAt && (!best || a.lastSyncedAt > best) ? a.lastSyncedAt : best),
        undefined,
      );
      return {
        institution,
        accounts,
        seen,
        // A closed account is settled on purpose and stops being pulled, so a
        // bank with nothing open behind it is not a bank gone quiet.
        quiet: open.length > 0 && !!lastPull && (!seen || seen < lastPull),
      };
    })
    .sort((x, y) => Math.min(...x.accounts.map((a) => a.order))
      - Math.min(...y.accounts.map((a) => a.order)));
}

/**
 * The bridge, connected by pasting one token.
 *
 * SimpleFIN is a protocol rather than a company. There is no application to
 * register, no certificate to download and nobody to sign up with: the
 * household authorises their own banks at a bridge, the bridge shows them a
 * setup token, and that token is exchanged once for the credential this app
 * keeps. Which is why it is here at all, after two providers withdrew.
 *
 * The token can be claimed once. A second attempt with the same one fails, so
 * what comes back has to be kept, and the field is cleared the moment it is.
 */
export function SimplefinCard() {
  const db = useDB();
  const { apply, actions, notify } = useStore();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ref = db.settings.simplefin;
  const banks = useMemo(() => behindBridge(db, ref?.lastSyncAt), [db, ref?.lastSyncAt]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { accessUrl } = await claimSetupToken(token);
      actions.patchSettings({ simplefin: { accessUrl, addedAt: new Date().toISOString() } });
      // Cleared immediately: the token is spent, and leaving it on screen
      // invites somebody to press the button again and be told it is used.
      setToken("");
      notify("SimpleFIN is connected. The first pull starts in a moment.");
    } catch (err) {
      setError(reason(err, "The bridge could not be reached."));
    } finally {
      setBusy(false);
    }
  };

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await syncSimplefin(db, apply);
      // What it did is on the card; only what it could not do needs saying.
      if (out.errors.length) setError(out.errors.join(" · "));
    } catch (err) {
      setError(reason(err, "That sync failed."));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Disconnecting takes the whole connection out, not just the credential.
   *
   * The first time this bridge existed, disconnecting blanked an access URL,
   * and restoring a backup from before that put the credential back and had
   * the app pulling again unattended. Nothing reads anything but this object,
   * so removing it is the whole of the disconnection.
   *
   * The accounts stay. They hold the household's history, and what they need
   * is a new provider rather than deleting, which is what the card below this
   * one is for.
   */
  const disconnect = () => {
    actions.patchSettings({ simplefin: undefined });
    notify("SimpleFIN is disconnected. The accounts it fed are still here.");
  };

  return (
    <Card>
      <CardHead
        title="SimpleFIN"
        sub={ref
          ? "Connected. Every bank you authorised at the bridge arrives through it."
          : "A bridge you authorise your own banks at, and the way most accounts should come in. One subscription carries every bank you add there, and there is nothing to sign up for here."}
        right={ref ? (
          <div className="row" style={{ gap: 8 }}>
            <Btn size="sm" onClick={() => void pull()} disabled={busy}>
              <RefreshCw size={13} /> {busy ? "Syncing" : "Sync now"}
            </Btn>
            <Btn size="sm" variant="danger" onClick={disconnect} disabled={busy}>
              <Trash2 size={13} /> Disconnect
            </Btn>
          </div>
        ) : undefined}
      />

      {ref ? (
        <div className="col" style={{ gap: 4 }}>
          <span className="small faint">
            {ref.lastSyncAt
              ? `Last pulled ${sinceLabel(ref.lastSyncAt)}.`
              : "Connected, and not yet pulled."}
          </span>
          {ref.lastError ? (
            <span className="small neg">
              {ref.lastError.message} Last tried {sinceLabel(ref.lastError.at)}.
            </span>
          ) : null}
          <span className="tiny faint">
            Adding or removing a bank is done at the bridge rather than here. Its accounts arrive on
            the next pull.
          </span>

          {banks.length ? (
            <>
              <div className="divider" />
              <div className="col" style={{ gap: 8 }}>
                {banks.map((bank) => (
                  <div key={bank.institution} className="col conn-item" style={{ gap: 6 }}>
                    <div className="spread conn-row">
                      <span className="row conn-who" style={{ gap: 8, minWidth: 0 }}>
                        <Building2 size={14} className="muted" />
                        <span className="truncate" style={{ fontWeight: 500 }}>{bank.institution}</span>
                      </span>
                      <span className="row conn-doings" style={{ gap: 10 }}>
                        <span className="tiny faint nowrap">
                          {bank.seen ? `synced ${dateLabel(bank.seen.slice(0, 10))}` : "never synced"}
                        </span>
                      </span>
                    </div>
                    <ul className="conn-accounts">
                      {bank.accounts.map((a) => (
                        <li key={a.id}>
                          <Link to={`/accounts/${a.id}`} className="truncate">{a.name}</Link>
                          <span className="tiny faint nowrap">{ACCOUNT_TYPE_LABEL[a.type]}</span>
                          {a.closedAt ? <span className="tiny faint nowrap">closed</span> : null}
                        </li>
                      ))}
                    </ul>
                    {/* The bridge's version of a bank that needs signing into
                        again. There is no button for it here because the
                        repair is at the bridge, so what this can do is say
                        which bank to go and look at. */}
                    {bank.quiet ? (
                      <div className="tiny warn">
                        Nothing came in for this bank on the last pull. It may need signing into
                        again at the bridge.
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <span className="tiny faint">
              Nothing has come in through the bridge yet. Press Sync now, or add your banks at the
              bridge if you have not yet.
            </span>
          )}
        </div>
      ) : (
        <>
          <Field
            label="Setup token"
            hint="The long string the bridge shows you after you have added your banks. It can be used once."
          >
            <input
              className="input" value={token} placeholder="Paste the token"
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          <Btn variant="primary" onClick={() => void connect()} disabled={busy || !token.trim()}>
            <Link2 size={14} /> {busy ? "Connecting" : "Connect"}
          </Btn>
        </>
      )}
      {error ? <span className="small neg">{error}</span> : null}
    </Card>
  );
}
