import { useRef, useState } from "react";
import { Download, Link2, RefreshCw, Upload } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel } from "../lib/date";
import { toCSV } from "../lib/csv";
import { download, exportJSON, importJSON } from "../lib/storage";
import { ADAPTERS, mergeSync, syncWindowStart } from "../lib/sync";
import { Btn, Card, CardHead, ConfirmButton, Field, Money, TextInput, Toggle } from "../components/ui";
import { CategoriesPanel, RulesPanel, TagsPanel } from "./SettingsPanels";
import { ImportModal } from "./ImportModal";

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
    const accessUrl = db.settings.simplefinAccessUrl;
    if (!accessUrl) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await adapter.fetch(accessUrl, syncWindowStart(db));
      let summary = "";
      apply((cur) => {
        const res = mergeSync(cur, payload, "simplefin");
        summary = `${res.transactionsAdded} new transaction${res.transactionsAdded === 1 ? "" : "s"}, ${res.accountsUpdated} account${res.accountsUpdated === 1 ? "" : "s"} updated${res.accountsAdded ? `, ${res.accountsAdded} added` : ""}.`;
        return res.db;
      }, "sync from SimpleFIN");
      notify(summary);
      if (payload.errors.length) setError(payload.errors.join(" · "));
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

          <div className="divider" />
          <div className="small muted">
            <b>Other providers.</b> Plaid's Trial plan is free for up to 10 institutions and is the only option here with
            real holdings-level investment data; Teller is free for up to 100 connections but US-only and thin on retirement
            accounts. Both slot in as another adapter in <code>src/lib/sync/</code> — the rest of the app doesn't change.
          </div>
        </Card>

        <Card>
          <CardHead
            title="Import transactions"
            sub="Monarch, Mint, YNAB or any bank CSV — columns are mapped on screen and duplicates are skipped"
            right={<Btn variant="primary" onClick={() => setImporting(true)}><Upload size={14} /> Import CSV</Btn>}
          />
        </Card>

        <RulesPanel />
        <TagsPanel />
        <CategoriesPanel />

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
