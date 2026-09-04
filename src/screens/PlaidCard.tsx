import { useState } from "react";
import { Building2, LineChart, RefreshCw, Stethoscope } from "lucide-react";
import type { PlaidItemRef } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel } from "../lib/date";
import { syncPlaid, syncPlaidItem } from "../lib/sync";
import { recordRun } from "../lib/usage";
import { createLinkToken, diagnosePlaid, exchangePublicToken } from "../lib/sync/plaid";
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
  const other = check.environment === "production" ? "sandbox" : "production";
  if (wrongKeys && check.worksIn) {
    lines.push({ ok: false, text: `These are ${check.worksIn} credentials, and this app is asking ${check.environment}` });
  }

  return (
    <div className="col" style={{ gap: 5, width: "100%", marginTop: 4 }}>
      {lines.map((l, i) => (
        <div key={i} className={`small ${l.ok ? "muted" : "neg"}`}>
          {l.ok ? "✓" : "✗"} {l.text}
        </div>
      ))}
      {wrongKeys && check.worksIn === "sandbox" ? (
        <div className="small" style={{ marginTop: 6 }}>
          <b>These keys work — but only against Plaid's fake banks.</b> Plaid only shows a Production secret
          on the Keys page once your Production access request has been approved; until then the page lists a
          Sandbox secret alone, which is what you have. Two ways forward: set <b>PLAID_ENV</b> to
          <code> sandbox</code> in Vercel and redeploy, to try the whole flow against test banks now — or wait
          for approval, then paste the Production secret and remove PLAID_ENV. Either way, a Vercel variable
          only takes effect on the next deployment.
        </div>
      ) : wrongKeys ? (
        <div className="small muted" style={{ marginTop: 6 }}>
          Plaid issues a <b>separate secret for each environment</b>, and the Keys page lists them separately.
          These were refused by {check.environment} and by {other}, so the pair doesn't match: check that the
          client_id and the secret were copied from the same dashboard account, with no characters missing.
          Changing a variable in Vercel only takes effect on the next deployment, so redeploy afterwards.
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

  /** Both of these now live in lib/sync/run beside the SimpleFIN pull, so the
   *  integrations table can offer the same thing without a second copy. */
  const syncItem = async (item: PlaidItemRef) => {
    const out = await syncPlaidItem(db, apply, item);
    recordRun(apply, "plaid", "ever", { error: out.errors[0] });
    notify(out.summary);
    // A window Plaid could not be read to the end of has transactions missing
    // from it. Showing the count is the only thing that turns silent data loss
    // into something anyone can act on.
    if (out.errors.length) setError(out.errors.join(" · "));
  };

  const syncAll = async () => {
    setBusy("sync");
    setError(null);
    try {
      const out = await syncPlaid(db, apply);
      notify(out.summary);
      if (out.errors.length) setError(out.errors.join(" · "));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = (item: PlaidItemRef) => {
    actions.patchSettings({ plaidItems: items.filter((i) => i.itemId !== item.itemId) });
    notify(`Disconnected ${item.institution}. Its accounts and history stay put.`);
  };

  return (
    <Card>
      <CardHead
        title="Plaid"
        sub="The only route here that returns holdings"
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
        <b>Investment</b> for IRAs, Roth IRAs, 401(k)s and brokerages — positions, cost basis and prices.
        <b> Bank</b> for chequing, savings and cards — transactions. An institution offering both can be
        connected twice. The item count against the plan's ceiling is in the integrations table above.
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
