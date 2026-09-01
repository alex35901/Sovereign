import { useRef, useState } from "react";
import { Download, Link2, RefreshCw, Upload } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel } from "../lib/date";
import { toCSV } from "../lib/csv";
import { download, exportJSON, importJSON } from "../lib/storage";
import { ADAPTERS, CADENCES, DEFAULT_CADENCE, nextSyncAt, syncSimplefin, syncWindowStart, untilLabel } from "../lib/sync";
import type { SyncCadence } from "../lib/sync";
import { canValue, estimateHomeValue } from "../lib/property";
import { Btn, Card, CardHead, ConfirmButton, Field, Money, TextInput, Toggle } from "../components/ui";
import { Link } from "react-router-dom";
import { PlaidCard } from "./PlaidCard";
import { CloudCard } from "./CloudCard";
import { ImportModal } from "./ImportModal";

function PropertyValuesCard() {
  const db = useDB();
  const { actions, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = db.settings.rentcastApiKey ?? "";
  const properties = db.accounts.filter((a) => canValue(a.type) && !a.hidden);
  const withAddress = properties.filter((a) => a.address?.trim());

  const refreshAll = async () => {
    setBusy(true);
    setError(null);
    let done = 0;
    const failures: string[] = [];
    for (const account of withAddress) {
      try {
        const estimate = await estimateHomeValue(key, account.address ?? "");
        actions.updateAccount(account.id, {
          valuation: { source: "rentcast", low: estimate.low, high: estimate.high, at: estimate.asOf },
        });
        actions.setAccountBalance(account.id, estimate.value);
        done++;
      } catch (err) {
        failures.push(`${account.name}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    setBusy(false);
    if (failures.length) setError(failures.join(" · "));
    notify(`Updated ${done} of ${withAddress.length} propert${withAddress.length === 1 ? "y" : "ies"}.`);
  };

  return (
    <Card>
      <CardHead
        title="Property values"
        sub="Bank sync carries no property values — these come from RentCast instead"
        right={
          <Btn variant="primary" onClick={() => void refreshAll()} disabled={busy || !key || !withAddress.length}>
            <RefreshCw size={14} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
            {busy ? "Updating…" : `Update ${withAddress.length || ""} now`}
          </Btn>
        }
      />
      <div className="row wrap" style={{ gap: 10, marginBottom: 12 }}>
        <span className="chip on">RentCast</span>
        <span className="small muted">Free tier — 50 lookups per month, no card required</span>
      </div>

      <ol className="small muted" style={{ margin: "0 0 12px", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
        <li>Sign up at <b>rentcast.io</b> and create an API key on the Developer (free) plan.</li>
        <li>Paste it below, then add each property's address on its account page.</li>
        <li>Refresh whenever you like — monthly is plenty, and 2 properties uses 2 of the 50.</li>
      </ol>

      <Field label="RentCast API key">
        <TextInput
          value={key}
          onChange={(v) => actions.patchSettings({ rentcastApiKey: v.trim() || undefined })}
          placeholder="Paste your API key"
        />
      </Field>

      {properties.length ? (
        <>
          <div className="divider" />
          <div className="col" style={{ gap: 8 }}>
            {properties.map((a) => (
              <div key={a.id} className="spread small">
                <Link to={`/accounts/${a.id}`} className="link truncate">{a.name}</Link>
                <span className="muted truncate" style={{ maxWidth: 320 }}>
                  {a.address?.trim()
                    ? `${a.address}${a.valuation ? ` · checked ${dateLabel(a.valuation.at.slice(0, 10))}` : " · never checked"}`
                    : "no address set"}
                </span>
                <Money value={a.balance} cents={false} className="bold" />
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="small faint" style={{ marginTop: 10 }}>
          No property accounts yet. Add one with type <b>Real Estate</b> from the Accounts page.
        </div>
      )}

      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}
    </Card>
  );
}

export default function Settings() {
  const db = useDB();
  const { actions, apply, notify } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adapter = ADAPTERS[0];
  const connected = adapter.isConnected(db.settings);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { accessUrl } = await adapter.connect(token);
      actions.patchSettings({ simplefinAccessUrl: accessUrl });
      setToken("");
      notify("Connected to SimpleFIN. Run a sync to pull balances and transactions.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    if (!db.settings.simplefinAccessUrl) return;
    setBusy(true);
    setError(null);
    try {
      const { summary, errors } = await syncSimplefin(db, apply);
      notify(summary);
      if (errors.length) setError(errors.join(" · "));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File) => {
    try {
      actions.loadDB(importJSON(await file.text()));
      notify("Backup restored.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be read.");
    }
  };

  return (
    <>
      <TopBar title="Settings" />
      <div className="page stack">
        <div className="grid g2">
          <Card>
            <CardHead title="Preferences" />
            <div className="col" style={{ gap: 14 }}>
              <Field label="Household name">
                <TextInput
                  value={db.settings.householdName}
                  onChange={(v) => actions.patchSettings({ householdName: v })}
                />
              </Field>
              <Toggle
                on={db.settings.theme === "dark"} onChange={actions.toggleTheme}
                label={<span className="small">Dark theme</span>}
              />
              <Toggle
                on={db.settings.privacyMode}
                onChange={(v) => actions.patchSettings({ privacyMode: v })}
                label={<span className="small">Privacy mode — blur every amount</span>}
              />
            </div>
          </Card>

          <Card>
            <CardHead title="What's stored where" />
            <div className="col small muted" style={{ gap: 8 }}>
              <span>
                Everything lives in this browser's local storage — {db.transactions.length.toLocaleString()} transactions,{" "}
                {db.accounts.length} accounts. Nothing is sent anywhere unless you connect a sync provider below.
              </span>
              <span>
                Because it's per-browser, take a JSON backup before clearing site data or switching machines.
              </span>
              <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>
                <Btn onClick={() => download(`sovereign-backup-${new Date().toISOString().slice(0, 10)}.json`, exportJSON(db))}>
                  <Download size={14} /> Back up JSON
                </Btn>
                <Btn onClick={() => download("transactions.csv", toCSV(db, db.transactions), "text/csv")}>
                  <Download size={14} /> Export CSV
                </Btn>
                <Btn onClick={() => fileRef.current?.click()}><Upload size={14} /> Restore backup</Btn>
                <input
                  ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void restore(f); }}
                />
              </div>
            </div>
          </Card>
        </div>

        <Card>
          <CardHead
            title="Bank sync"
            sub="Pull balances and transactions automatically instead of importing CSVs"
            right={connected ? (
              <Btn variant="primary" onClick={() => void sync()} disabled={busy}>
                <RefreshCw size={14} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
                {busy ? "Syncing…" : "Sync now"}
              </Btn>
            ) : null}
          />

          <div className="row wrap" style={{ gap: 10, marginBottom: 14 }}>
            <span className="chip on">{adapter.label}</span>
            <span className="small muted">{adapter.cost}</span>
          </div>

          {connected ? (
            <div className="col" style={{ gap: 10 }}>
              <span className="small pos">✓ Connected</span>
              <span className="small muted">
                Last sync:{" "}
                {db.settings.lastSyncAt ? `${dateLabel(db.settings.lastSyncAt.slice(0, 10))} at ${new Date(db.settings.lastSyncAt).toLocaleTimeString()}` : "never"}
                {" · "}next pull starts from {syncWindowStart(db)}
              </span>
              <SyncSchedule />
              <div>
                <ConfirmButton
                  label="Disconnect"
                  confirmLabel="Click again to disconnect"
                  onConfirm={() => { actions.patchSettings({ simplefinAccessUrl: undefined }); notify("SimpleFIN disconnected."); }}
                />
              </div>
            </div>
          ) : (
            <div className="col" style={{ gap: 12 }}>
              <ol className="small muted" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                <li>Create an account at <b>bridge.simplefin.org</b> and connect your banks there ($15/yr, up to 25 institutions).</li>
                <li>Generate a <b>setup token</b> — a long base64 string. It can only be claimed once.</li>
                <li>Paste it below. The token is exchanged for a durable access URL that stays in this browser.</li>
              </ol>
              <div className="row wrap" style={{ gap: 8 }}>
                <div className="grow" style={{ minWidth: 240 }}>
                  <TextInput value={token} onChange={setToken} placeholder="Paste setup token" />
                </div>
                <Btn variant="primary" onClick={() => void connect()} disabled={busy || !token.trim()}>
                  <Link2 size={14} /> {busy ? "Connecting…" : "Connect"}
                </Btn>
              </div>
              <span className="tiny faint">
                Requires the bundled <code>/api/simplefin</code> function to be running — it forwards the request server-side,
                because the bridge sends no CORS headers. Works on Vercel, or locally with <code>vercel dev</code>.
              </span>
            </div>
          )}

          {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}

          {(db.settings.deletedAccountKeys?.length ?? 0) > 0 ? (
            <>
              <div className="divider" />
              <div className="spread wrap" style={{ gap: 10 }}>
                <span className="small muted" style={{ maxWidth: 520 }}>
                  <b>{db.settings.deletedAccountKeys!.length} deleted account
                  {db.settings.deletedAccountKeys!.length === 1 ? " is" : "s are"} ignored on sync.</b>{" "}
                  Forgetting them lets the provider offer them again on the next pull — the way back
                  from a delete you didn't mean.
                </span>
                <Btn onClick={() => { actions.forgetDeletedAccounts(); notify("Deleted accounts forgotten. They can return on the next sync."); }}>
                  Forget them
                </Btn>
              </div>
            </>
          ) : null}

          <div className="divider" />
          <div className="small muted">
            <b>Not everything is reachable this way.</b> SimpleFIN rides on MX, which carries no property values and
            no holdings, and some institutions — employer 401(k) recordkeepers especially — refuse aggregator access
            altogether. Plaid is set up below for investment accounts; property values have their own card; anything
            left over can be kept current by hand from the Balance points card on the account.
          </div>
        </Card>

        <CloudCard />

        <PlaidCard />

        <PropertyValuesCard />

        <Card>
          <CardHead
            title="Import transactions"
            sub="Monarch, Mint, YNAB or any bank CSV — columns are mapped on screen and duplicates are skipped"
            right={<Btn variant="primary" onClick={() => setImporting(true)}><Upload size={14} /> Import CSV</Btn>}
          />
        </Card>


        <Card>
          <CardHead title="Danger zone" />
          <div className="row wrap" style={{ gap: 10 }}>
            <ConfirmButton
              label="Reload demo data" confirmLabel="Click again — this replaces everything"
              onConfirm={() => { actions.resetDemo(); notify("Demo data reloaded."); }}
              variant="default"
            />
            <ConfirmButton
              label="Erase everything" confirmLabel="Click again to erase"
              onConfirm={() => { actions.resetEmpty(); notify("All data erased."); }}
            />
            <span className="small faint row">
              Net worth today: <Money value={db.accounts.reduce((s, a) => s + (a.includeInNetWorth ? a.balance : 0), 0)} cents={false} />
            </span>
          </div>
        </Card>
      </div>
      {importing ? <ImportModal onClose={() => setImporting(false)} /> : null}
    </>
  );
}

/**
 * How often to pull, and when the next one is due.
 *
 * The app is the browser tab, so it says plainly that nothing runs while the
 * tab is shut — a schedule that quietly does nothing overnight would be worse
 * than no schedule at all.
 */
function SyncSchedule() {
  const db = useDB();
  const { actions } = useStore();
  const cadence = db.settings.syncCadence ?? DEFAULT_CADENCE;
  const due = nextSyncAt(cadence, db.settings.lastSyncAt);

  return (
    <div className="col" style={{ gap: 7 }}>
      <div className="row wrap" style={{ gap: 10 }}>
        <span className="small" style={{ fontWeight: 500 }}>Sync automatically</span>
        <select
          className="select" style={{ width: "auto", minWidth: 200 }}
          value={cadence}
          onChange={(e) => actions.patchSettings({ syncCadence: e.target.value as SyncCadence })}
        >
          {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      <span className="tiny faint" style={{ maxWidth: 520 }}>
        {cadence === "off"
          ? "Nothing will pull on its own — use Sync now above."
          : due
            ? `Next pull ${untilLabel(due, Date.now())}, the next time the app is open.`
            : "The next pull runs as soon as the app is open."}
        {" "}Checks happen while this tab is open; there is no server here, so nothing
        runs overnight with the browser shut — the first check after you open it catches up.
        SimpleFIN itself refreshes about once a day, so anything tighter than daily rarely
        finds new data.
      </span>
    </div>
  );
}
