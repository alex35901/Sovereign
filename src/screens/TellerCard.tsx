import { useState } from "react";
import { Building2, KeyRound, RefreshCw, Stethoscope } from "lucide-react";
import { Link } from "react-router-dom";
import type { TellerEnrollmentRef } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel } from "../lib/date";
import { syncTellerEnrollment } from "../lib/sync";
import { recordRun } from "../lib/usage";
import { diagnoseTeller, tellerSetup } from "../lib/sync/teller";
import type { TellerDiagnosis, TellerSetup } from "../lib/sync/teller";
import { TellerConnectError, openTellerConnect } from "../lib/sync/teller-connect";
import { ACCOUNT_TYPE_LABEL } from "../lib/select";
import { Btn, Card, CardHead, ConfirmButton, cx } from "../components/ui";

/**
 * Teller, for the banks Plaid will not open.
 *
 * Not a rival to the Plaid card and not a replacement for it. Plaid refuses
 * the largest banks until the Plaid account asking has been separately
 * approved for each of them, and that approval is not something a household
 * can argue its way to. Teller has no such gate and its developer tier is free
 * to a hundred live connections, so one bank can come this way while
 * everything else stays where it is.
 *
 * It fetches balances and transactions and nothing else. A brokerage has
 * holdings, and holdings are Plaid's, so an investment account connected here
 * would arrive as a balance and a blank page of positions. The card says so
 * rather than letting somebody find out.
 */

/** What the diagnosis found, in words rather than raw values. */
function Diagnosis({ check }: { check: TellerDiagnosis }) {
  const lines: { ok: boolean; text: string }[] = [];

  lines.push({
    ok: check.appId.length > 0 && check.appId.looksRight,
    text: check.appId.length === 0
      ? "TELLER_APP_ID is missing"
      : check.appId.looksRight
        ? `TELLER_APP_ID is set (${check.appId.length} characters)`
        : `TELLER_APP_ID is set but doesn't start with app_, so it is probably not the application id`,
  });

  // The one mistake worth checking for by name. The certificate and the key
  // are downloaded together, look alike, and swapping them fails with an
  // OpenSSL code rather than a sentence.
  const certOk = check.cert.kind === "CERTIFICATE";
  const keyOk = Boolean(check.key.kind && /PRIVATE KEY/.test(check.key.kind));
  lines.push({
    ok: certOk,
    text: check.cert.length === 0
      ? "TELLER_CERT is missing"
      : certOk
        ? `TELLER_CERT holds a certificate (${check.cert.length} characters)`
        : `TELLER_CERT holds a ${check.cert.kind ?? "value that is not a PEM block"}, not a certificate`,
  });
  lines.push({
    ok: keyOk,
    text: check.key.length === 0
      ? "TELLER_KEY is missing"
      : keyOk
        ? `TELLER_KEY holds a private key (${check.key.length} characters)`
        : `TELLER_KEY holds a ${check.key.kind ?? "value that is not a PEM block"}, not a private key`,
  });
  if (check.cert.repaired || check.key.repaired) {
    lines.push({
      ok: true,
      text: "The line breaks arrived written out as \\n and were turned back into line breaks, which is normal "
        + "for a certificate pasted into an environment variable",
    });
  }
  lines.push({
    ok: true,
    text: check.envVarSet
      ? `TELLER_ENV is set, so this app talks to ${check.environment}`
      : `TELLER_ENV isn't set, so this app talks to ${check.environment} (the default)`,
  });
  lines.push({
    ok: check.probe.ok,
    text: check.probe.ok
      ? "Teller accepted the certificate"
      : `Teller refused the certificate. ${check.probe.error}`,
  });

  return (
    <div className="col" style={{ gap: 5, width: "100%", marginTop: 4 }}>
      {lines.map((l, i) => (
        <div key={i} className={`small ${l.ok ? "muted" : "neg"}`}>
          {l.ok ? "✓" : "✗"} {l.text}
        </div>
      ))}
      {!certOk || !keyOk ? (
        <div className="small" style={{ marginTop: 6 }}>
          <b>Teller issues the pair together.</b> The downloaded file holds a certificate and a private key as
          two blocks; the certificate block goes in TELLER_CERT and the private key block in TELLER_KEY, each
          complete with its own BEGIN and END lines. A Vercel variable only takes effect on the next
          deployment.
        </div>
      ) : null}
    </div>
  );
}

export function TellerCard() {
  const db = useDB();
  const { actions, apply, notify } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<TellerSetup | null>(null);
  const [check, setCheck] = useState<TellerDiagnosis | null>(null);

  const items = db.settings.tellerEnrollments ?? [];

  /**
   * What the dialog needs to open, fetched when it is needed.
   *
   * Not on mount. This card is on the Settings screen, which is opened for
   * every reason there is, and a request to the server on each of those is a
   * request nobody asked for. On a deployment without the function it is also
   * a 404 in the console on every visit, which is noise of exactly the kind
   * that trains people to ignore the console.
   */
  const settings = async (): Promise<TellerSetup | null> => {
    if (setup) return setup;
    try {
      const got = await tellerSetup();
      setSetup(got);
      return got;
    } catch {
      return null;
    }
  };

  const syncItem = async (item: TellerEnrollmentRef) => {
    const out = await syncTellerEnrollment(apply, item);
    notify(out.summary);
    if (out.errors.length) setError(out.errors.join(" · "));
    recordRun(apply, "teller", "ever", { error: out.errors[0] });
    return out;
  };

  /**
   * @param existing the enrollment to sign into again, rather than a new one.
   *
   * Naming it is the difference between repairing a connection and opening a
   * second one to the same bank, and a second one spends another of the
   * hundred while only one of them is ever read.
   */
  const connect = async (existing?: TellerEnrollmentRef) => {
    setBusy(existing?.enrollmentId ?? "connect");
    setError(null);
    try {
      const where = await settings();
      if (!where?.applicationId) {
        setError("Teller isn't configured yet. Add TELLER_APP_ID, TELLER_CERT and TELLER_KEY in Vercel, then "
          + "redeploy. Check configuration below says which of them is missing.");
        return;
      }
      const got = await openTellerConnect({
        applicationId: where.applicationId,
        environment: where.environment,
        ...(existing ? { enrollmentId: existing.enrollmentId } : {}),
      });
      if (!got) return; // closed the dialog, and nothing has changed
      const ref: TellerEnrollmentRef = {
        accessToken: got.accessToken,
        enrollmentId: got.enrollment?.id ?? existing?.enrollmentId ?? "",
        institution: got.enrollment?.institution?.name?.trim() || existing?.institution || "Bank",
        ...(got.enrollment?.institution?.id ? { institutionId: got.enrollment.institution.id } : {}),
        addedAt: existing?.addedAt ?? new Date().toISOString(),
        ...(existing?.lastSyncAt ? { lastSyncAt: existing.lastSyncAt } : {}),
      };
      // Matched on the enrollment id so signing in again replaces the one that
      // was there, keeping its place in the list and its clock.
      const kept = items.some((i) => i.enrollmentId === ref.enrollmentId);
      actions.patchSettings({
        tellerEnrollments: kept
          ? items.map((i) => (i.enrollmentId === ref.enrollmentId ? { ...i, ...ref, lastError: undefined } : i))
          : [...items, ref],
      });
      notify(`${kept ? "Reconnected" : "Connected"} ${ref.institution}. Syncing…`);
      await syncItem(ref);
    } catch (err) {
      setError(err instanceof TellerConnectError
        ? `Teller Connect could not finish. ${err.message}${err.code ? ` (${err.code})` : ""}`
        : err instanceof Error ? err.message : "Could not open Teller Connect.");
    } finally {
      setBusy(null);
    }
  };

  const syncAll = async () => {
    setBusy("sync");
    setError(null);
    try {
      for (const item of items) {
        try { await syncItem(item); } catch { /* the next bank is not this one's problem */ }
      }
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async () => {
    setBusy("check");
    setError(null);
    try {
      setCheck(await diagnoseTeller());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the check.");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = (item: TellerEnrollmentRef) => {
    actions.patchSettings({
      tellerEnrollments: items.filter((i) => i.enrollmentId !== item.enrollmentId),
    });
    notify(`Disconnected ${item.institution}. Its accounts and every transaction stay put, and connecting it again picks them back up by name.`);
  };

  /**
   * The accounts this enrollment brought in.
   *
   * By the enrollment stamped on them, which every pull writes and which tells
   * two logins at one bank apart. The name is the fallback for an enrollment
   * added but not yet pulled, and only until the first pull settles it.
   */
  const accountsOf = (item: TellerEnrollmentRef) => {
    const mine = db.accounts.filter((a) => a.syncSource === "teller");
    const named = mine.filter((a) => a.plaidItemId === item.enrollmentId);
    const held = named.length
      ? named
      : mine.filter((a) => !a.plaidItemId && a.institution === item.institution);
    return held.sort((a, b) =>
      Number(Boolean(a.closedAt)) - Number(Boolean(b.closedAt)) || a.order - b.order);
  };

  return (
    <Card>
      <CardHead
        title="Connections through Teller"
        sub="For a bank Plaid will not open"
        right={items.length ? (
          <Btn variant="primary" onClick={() => void syncAll()} disabled={busy !== null}>
            <RefreshCw size={14} style={busy === "sync" ? { animation: "spin 1s linear infinite" } : undefined} />
            {busy === "sync" ? "Syncing…" : "Sync all"}
          </Btn>
        ) : null}
      />

      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <Btn variant="primary" onClick={() => void connect()} disabled={busy !== null}>
          <Building2 size={14} /> {busy === "connect" ? "Opening…" : "Connect a bank"}
        </Btn>
      </div>

      <div className="small muted" style={{ marginBottom: 12 }}>
        Plaid refuses the largest banks until the Plaid account asking has been approved for each of them
        separately, which is not something you can argue your way to. Teller has no such gate, and its
        developer tier is free to a hundred connections. Use it for the bank Plaid will not open and leave
        everything else where it is. It carries balances and transactions only: a brokerage connected here
        would arrive as a balance with no holdings behind it, so investments belong on Plaid.
      </div>

      {setup && !setup.configured ? (
        <div className="small warn" style={{ marginBottom: 12 }}>
          Teller isn&rsquo;t configured yet. The three variables are below, and the Check configuration button
          says which of them the deployment is missing.
        </div>
      ) : null}

      {items.length ? (
        <>
          <div className="divider" />
          <div className="col" style={{ gap: 8 }}>
            {items.map((item) => {
              const held = accountsOf(item);
              return (
                <div key={item.enrollmentId} className="col plaid-item" style={{ gap: 6 }}>
                  <div className="spread plaid-row">
                    <span className="row plaid-who" style={{ gap: 8, minWidth: 0 }}>
                      <Building2 size={14} className="muted" />
                      <span className="truncate" style={{ fontWeight: 500 }}>{item.institution}</span>
                      <span className="tag" title="Teller carries balances and transactions. Holdings are Plaid's.">
                        bank
                      </span>
                    </span>
                    <span className="row plaid-doings" style={{ gap: 10 }}>
                      <span className="tiny faint nowrap">
                        {item.lastSyncAt ? `synced ${dateLabel(item.lastSyncAt.slice(0, 10))}` : "never synced"}
                      </span>
                      <Btn
                        size="sm"
                        variant={item.lastError ? "primary" : undefined}
                        onClick={() => void connect(item)}
                        disabled={busy !== null}
                        title="Sign in again without opening a second connection to this bank"
                      >
                        <KeyRound size={12} /> {busy === item.enrollmentId ? "Opening…" : "Reconnect"}
                      </Btn>
                      <ConfirmButton
                        label="Disconnect"
                        confirmLabel="Click again to disconnect"
                        onConfirm={() => disconnect(item)}
                      />
                    </span>
                  </div>
                  {held.length ? (
                    <ul className="plaid-accounts">
                      {held.map((a) => (
                        <li key={a.id}>
                          <Link to={`/accounts/${a.id}`} className="truncate">{a.name}</Link>
                          <span className="tiny faint nowrap">{ACCOUNT_TYPE_LABEL[a.type]}</span>
                          {a.closedAt ? <span className="tiny faint nowrap">closed</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="tiny faint">
                      Nothing has come in from this connection yet. Press Sync all, or Reconnect if it is
                      asking for a login.
                    </div>
                  )}
                </div>
              );
            })}
            {items.some((i) => i.lastError) ? (
              <div className="small warn">
                {items.filter((i) => i.lastError).map((i) => `${i.institution}: ${i.lastError!.message}`).join(" · ")}
              </div>
            ) : null}
            {items.some((i) => i.lastNotes?.notes.length) ? (
              <div className="col" style={{ gap: 6 }}>
                {items.filter((i) => i.lastNotes?.notes.length).map((i) => (
                  <div key={i.enrollmentId} className="small" style={{ userSelect: "text" }}>
                    <b>{i.institution}</b>, last pull{" "}
                    {new Date(i.lastNotes!.at).toLocaleString()}: the bank answered, and these rows were
                    left out on purpose.
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {i.lastNotes!.notes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {error ? <div className={cx("small neg")} style={{ marginTop: 10 }}>{error}</div> : null}

      <div className="divider" />
      <div className="row wrap" style={{ gap: 10 }}>
        <Btn onClick={() => void runCheck()} disabled={busy !== null}>
          <Stethoscope size={14} /> {busy === "check" ? "Checking…" : "Check configuration"}
        </Btn>
        {check ? <Diagnosis check={check} /> : null}
      </div>

      <div className="divider" />
      <details>
        <summary className="small muted" style={{ cursor: "pointer" }}>Setup, three environment variables</summary>
        <ol className="small muted" style={{ margin: "10px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
          <li>Sign up at <b>teller.io</b>. The developer tier is free and needs no approval from any bank.</li>
          <li>In the dashboard, create an application and copy its <b>application id</b>, which starts with <code>app_</code>.</li>
          <li>Generate a certificate. Teller hands back two blocks: a certificate and a private key.</li>
          <li>
            In Vercel → your project → Settings → Environment Variables, add <b>TELLER_APP_ID</b>,
            <b> TELLER_CERT</b> (the certificate block) and <b>TELLER_KEY</b> (the private key block). Paste
            each one whole, BEGIN and END lines included. Add <b>TELLER_ENV</b> as <code>sandbox</code> to try
            it against test banks first, otherwise leave it unset.
          </li>
          <li>Redeploy, then press Connect a bank above.</li>
        </ol>
        <div className="tiny faint" style={{ marginTop: 8 }}>
          The private key authenticates this whole application to Teller, which is why it stays on the server
          and never reaches this page. Only the per-connection token is held here. The application id does
          reach the page, because the dialog cannot open without it, and it is not a secret.
        </div>
      </details>
    </Card>
  );
}
