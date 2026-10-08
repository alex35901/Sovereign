import { useState } from "react";
import { Link2, RefreshCw, Trash2 } from "lucide-react";
import { useDB, useStore } from "../store";
import { claimSetupToken } from "../lib/sync/simplefin";
import { syncSimplefin } from "../lib/sync";
import { reason } from "../lib/usage";
import { sinceLabel } from "../lib/date";
import { Btn, Card, CardHead, Field } from "../components/ui";

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
          : "A bridge you authorise your own banks at, for the ones Plaid will not open. Nothing to sign up for here."}
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
