import { useMemo, useRef, useState } from "react";
import { Download, Link2, RefreshCw, Upload } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel } from "../lib/date";
import { toCSV } from "../lib/csv";
import { download, exportJSON, importJSON } from "../lib/storage";
import { ADAPTERS, CADENCES, DEFAULT_CADENCE, nextSyncAt, syncSimplefin, syncWindowStart, untilLabel } from "../lib/sync";
import type { SyncCadence } from "../lib/sync";
import { pricesDue, refreshPrices } from "../lib/prices";
import { BRAND_COUNT } from "../lib/merchant-domain";
import { breakdown } from "../lib/transfer";
import { Btn, Card, CardHead, ConfirmButton, Field, Money, TextInput, Toggle } from "../components/ui";
import { IntegrationsCard } from "./IntegrationsCard";
import { PlaidCard } from "./PlaidCard";
import { CloudCard } from "./CloudCard";
import { EncryptionCard } from "./EncryptionCard";
import { ImportModal } from "./ImportModal";

export default function Settings() {
  const db = useDB();
  const size = useMemo(() => breakdown(db), [db]);
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
      // Prices ride along, but only if one is owed: this button gets pressed
      // repeatedly while someone waits for a transaction to show up, and a
      // closing price does not change in between. The Refresh now button on
      // the prices card is the one that always asks.
      if (db.settings.priceAutoRefresh !== false && pricesDue(db.settings.lastPricesAt)) {
        await refreshPrices(db, apply).catch(() => {});
      }
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
                  name="sovereign-household"
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
            <CardHead title="What's stored where" sub={`${(size.bytes / 1024 / 1024).toFixed(2)} MB, sent whole on every save`} />
            <div className="col small muted" style={{ gap: 8 }}>
              {/* The size is the interesting part now that two providers meter
                  it. Broken down, because the answer to "what do I do about
                  it" depends entirely on which line is the big one. */}
              <div className="col" style={{ gap: 3 }}>
                {size.parts.map((part) => (
                  <div key={part.label} className="spread tiny">
                    <span className="muted">
                      {part.label}
                      {part.count !== undefined ? <span className="faint"> · {part.count.toLocaleString()}</span> : null}
                    </span>
                    <span className="num faint">
                      {(part.bytes / 1024).toFixed(0)} KB
                      <span className="muted"> · {Math.round((part.bytes / Math.max(1, size.bytes)) * 100)}%</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <Btn onClick={() => actions.compressHistory()}>Compress balance history</Btn>
                <span className="tiny faint" style={{ maxWidth: 320 }}>
                  Drops balance points that repeat the one before them. Charts read the same, because
                  they fill forward from the last change.
                </span>
              </div>
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

        <IntegrationsCard />

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
          <div className="col" style={{ gap: 6 }}>
            <div className="row wrap" style={{ gap: 20 }}>
              <Toggle
                on={db.settings.institutionLogos !== false}
                onChange={(v) => actions.patchSettings({ institutionLogos: v })}
                label={<span className="small">Bank logos</span>}
              />
              <Toggle
                on={db.settings.merchantLogos !== false}
                onChange={(v) => actions.patchSettings({ merchantLogos: v })}
                label={<span className="small">Merchant logos</span>}
              />
            </div>
            <span className="tiny faint" style={{ maxWidth: 620 }}>
              Both are fetched by <code>/api/icon</code> on your behalf, so the icon services see
              your deployment rather than your browser. Merchant logos are looked up only for the
              {" "}{BRAND_COUNT} brands on a built-in list — nothing off a statement is sent anywhere
              to find out what it is, so a name it doesn&rsquo;t recognise keeps its letter. Plaid&rsquo;s
              own logos never leave this app at all. Turn either off to use initials and ask nobody.
            </span>
          </div>

        </Card>

        <CloudCard />
        <EncryptionCard />

        <PlaidCard />

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
          ? "Nothing will pull on its own while the app is open — the 9am job still runs."
          : due
            ? `Next pull ${untilLabel(due, Date.now())}, the next time the app is open.`
            : "The next pull runs as soon as the app is open."}
        {" "}This is the in-app schedule; a scheduled job also pulls at 9am with every browser
        shut. SimpleFIN itself refreshes about once a day, so anything tighter rarely finds
        new data.
      </span>
    </div>
  );
}
