import { useState } from "react";
import { Building2, LineChart, RefreshCw, Stethoscope } from "lucide-react";
import type { PlaidItemRef } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel } from "../lib/date";
import { mergeSync, syncWindowStart } from "../lib/sync";
import { createLinkToken, diagnosePlaid, exchangePublicToken, fetchItem } from "../lib/sync/plaid";
import type { PlaidDiagnosis } from "../lib/sync/plaid";
import { openPlaidLink } from "../lib/sync/plaid-link";
import { Btn, Card, CardHead, ConfirmButton } from "../components/ui";

/** What the function sees, in words rather than raw values. */
function Diagnosis({ check }: { check: PlaidDiagnosis }) {
  const lines: { ok: boolean; text: string }[] = [];

  lines.push({
    ok: check.clientId.length > 0,
    text: check.clientId.length ? `PLAID_CLIENT_ID is set (${check.clientId.length} characters)` : "PLAID_CLIENT_ID is missing",
  });
  lines.push({
    ok: check.secret.length > 0,
    text: check.secret.length ? `PLAID_SECRET is set (${check.secret.length} characters)` : "PLAID_SECRET is missing",
  });
  if (check.clientId.trimmed || check.secret.trimmed) {
    lines.push({ ok: false, text: "One of them had stray whitespace, which has been trimmed — worth fixing in Vercel too" });
  }
  lines.push({
    ok: true,
    text: check.envVarSet
      ? `PLAID_ENV is set, so this app talks to ${check.environment}`
      : `PLAID_ENV isn't set, so this app talks to ${check.environment} (the default)`,
  });
  lines.push({
    ok: check.probe.ok,
    text: check.probe.ok
      ? `Plaid accepted these credentials for ${check.environment}`
      : `Plaid refused them — ${check.probe.error}`,
  });

  const wrongKeys = check.probe.error === "INVALID_API_KEYS";

  return (
    <div className="col" style={{ gap: 5, width: "100%", marginTop: 4 }}>
      {lines.map((l, i) => (
        <div key={i} className={`small ${l.ok ? "muted" : "neg"}`}>
          {l.ok ? "✓" : "✗"} {l.text}
        </div>
      ))}
      {wrongKeys ? (
        <div className="small muted" style={{ marginTop: 6 }}>
          Plaid issues a <b>separate secret for each environment</b>. The Keys page in the Plaid dashboard lists
          Sandbox and Production separately — a Sandbox secret will always be rejected here, because this app
          asks for {check.environment}. Either paste the {check.environment} secret, or set
          <b> PLAID_ENV=sandbox</b> to try it against Plaid's fake banks first. Changing a variable in Vercel
          only takes effect on the next deployment, so redeploy afterwards.
        </div>
      ) : null}
    </div>
  );
}

/** Connect and sync Plaid items — the route to retirement and brokerage holdings. */
export function PlaidCard() {
  const db = useDB();
  const { actions, apply, notify } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<PlaidDiagnosis | null>(null);

  const runCheck = async () => {
    setBusy("check");
    setError(null);
    try {
      setCheck(await diagnosePlaid());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the check.");
    } finally {
      setBusy(null);
    }
  };

  const items = db.settings.plaidItems ?? [];

  const connect = async (kind: "bank" | "investment") => {
    setBusy(kind);
    setError(null);
    try {
      const token = await createLinkToken(kind);
      const publicToken = await openPlaidLink(token);
      if (!publicToken) return; // closed the dialog
      const item = await exchangePublicToken(publicToken, kind);
      actions.patchSettings({ plaidItems: [...items, item] });
      notify(`Connected ${item.institution}. Syncing…`);
      await syncItem(item);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect.");
    } finally {
      setBusy(null);
    }
  };

  const syncItem = async (item: PlaidItemRef) => {
    const payload = await fetchItem(item, syncWindowStart(db));
    let summary = "";
    apply((cur) => {
      const res = mergeSync(cur, payload, "plaid");
      summary =
        `${item.institution}: ${res.transactionsAdded} new transaction${res.transactionsAdded === 1 ? "" : "s"}` +
        `, ${res.accountsAdded + res.accountsUpdated} account${res.accountsAdded + res.accountsUpdated === 1 ? "" : "s"}` +
        (res.holdingsUpdated ? `, ${res.holdingsUpdated} holdings` : "");
      const stamped = (cur.settings.plaidItems ?? []).map((i) =>
        i.itemId === item.itemId ? { ...i, lastSyncAt: payload.fetchedAt } : i);
      return { ...res.db, settings: { ...res.db.settings, plaidItems: stamped } };
    }, `sync ${item.institution}`);
    notify(summary);
  };

  const syncAll = async () => {
    setBusy("sync");
    setError(null);
    const failures: string[] = [];
    for (const item of items) {
      try {
        await syncItem(item);
      } catch (err) {
        failures.push(`${item.institution}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    if (failures.length) setError(failures.join(" · "));
    setBusy(null);
  };

  const disconnect = (item: PlaidItemRef) => {
    actions.patchSettings({ plaidItems: items.filter((i) => i.itemId !== item.itemId) });
    notify(`Disconnected ${item.institution}. Its accounts and history stay put.`);
  };

  return (
    <Card>
      <CardHead
        title="Plaid"
        sub="Billed per connected login per month — and the only route here that returns holdings"
        right={items.length ? (
          <Btn variant="primary" onClick={() => void syncAll()} disabled={busy !== null}>
            <RefreshCw size={14} style={busy === "sync" ? { animation: "spin 1s linear infinite" } : undefined} />
            {busy === "sync" ? "Syncing…" : "Sync all"}
          </Btn>
        ) : null}
      />

      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <Btn onClick={() => void connect("investment")} disabled={busy !== null}>
          <LineChart size={14} /> {busy === "investment" ? "Opening…" : "Connect an investment account"}
        </Btn>
        <Btn onClick={() => void connect("bank")} disabled={busy !== null}>
          <Building2 size={14} /> {busy === "bank" ? "Opening…" : "Connect a bank or card"}
        </Btn>
      </div>

      <div className="small muted" style={{ marginBottom: 12 }}>
        Use <b>investment</b> for IRAs, Roth IRAs, 401(k)s and brokerages — that pulls positions, cost basis
        and prices into the Investments screen. Use <b>bank</b> for chequing, savings and credit cards, which
        returns transactions instead. An institution offering both can be connected twice.
      </div>

      <div className="small muted" style={{ marginBottom: 12 }}>
        <b>What each connection costs.</b> On Plaid's pay-as-you-go rates an investment login is
        $0.18/month and a bank login is $0.30/month — charged per login per month, not per sync, so
        syncing daily costs the same as syncing once. Three retirement accounts come to about
        <b> $6.50 a year</b>. This app deliberately never calls Plaid's expensive endpoints: no Auth or
        Identity ($1.50 each), no Balance ($0.10 a call), and no on-demand Refresh ($0.12 a call) — it
        reads cached balances instead. Check Plaid's current rate card before connecting a lot of
        institutions.
      </div>

      {items.length ? (
        <>
          <div className="divider" />
          <div className="col" style={{ gap: 8 }}>
            {items.map((item) => (
              <div key={item.itemId} className="spread">
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  {item.kind === "investment" ? <LineChart size={14} className="muted" /> : <Building2 size={14} className="muted" />}
                  <span className="truncate" style={{ fontWeight: 500 }}>{item.institution}</span>
                  <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>{item.kind}</span>
                </span>
                <span className="row" style={{ gap: 10 }}>
                  <span className="tiny faint nowrap">
                    {item.lastSyncAt ? `synced ${dateLabel(item.lastSyncAt.slice(0, 10))}` : "never synced"}
                  </span>
                  <ConfirmButton
                    label="Disconnect"
                    confirmLabel="Click again to disconnect"
                    onConfirm={() => disconnect(item)}
                  />
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}

      <div className="divider" />
      <div className="row wrap" style={{ gap: 10 }}>
        <Btn onClick={() => void runCheck()} disabled={busy !== null}>
          <Stethoscope size={14} /> {busy === "check" ? "Checking…" : "Check configuration"}
        </Btn>
        {check ? <Diagnosis check={check} /> : null}
      </div>

      <div className="divider" />
      <details>
        <summary className="small muted" style={{ cursor: "pointer" }}>Setup — two environment variables</summary>
        <ol className="small muted" style={{ margin: "10px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
          <li>Sign up at <b>dashboard.plaid.com</b> and request Production access. Pay-as-you-go has no monthly minimum, so you pay only for the logins you connect.</li>
          <li>Copy your <b>client_id</b> and the <b>Production</b> secret from Team Settings → Keys.</li>
          <li>
            In Vercel → your project → Settings → Environment Variables, add <b>PLAID_CLIENT_ID</b> and
            <b> PLAID_SECRET</b>. Add <b>PLAID_ENV</b> as <code>sandbox</code> if you want to test against fake
            banks first, otherwise leave it unset.
          </li>
          <li>Redeploy, then press Connect above.</li>
        </ol>
        <div className="tiny faint" style={{ marginTop: 8 }}>
          Those two values authorise every request for every connected bank, which is why they stay on the
          server and never reach this page. Only the per-connection access token is held here.
        </div>
      </details>
    </Card>
  );
}
