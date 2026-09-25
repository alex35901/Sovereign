import { useRef, useState } from "react";
import { Building2, History, KeyRound, LineChart, RefreshCw, RotateCcw, Stethoscope } from "lucide-react";
import type { PlaidItemRef } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel } from "../lib/date";
import { CADENCES, DEFAULT_CADENCE, nextSyncAt, syncPlaid, syncPlaidItem, untilLabel } from "../lib/sync";
import type { SyncCadence } from "../lib/sync";
import { recordRun } from "../lib/usage";
import { countHistory, createLinkToken, diagnosePlaid, exchangePublicToken, reconnectLinkToken, refreshItem, releaseItem, reportHistory } from "../lib/sync/plaid";
import { FIRST_PULL_DAYS, windowFor } from "../lib/sync/merge";
import { itemFor } from "../lib/sync/adopt";
import { describeReach, needsRaising, waitForHistory } from "../lib/sync/history";
import type { ReachState } from "../lib/sync/history";
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
    lines.push({ ok: false, text: "One of them had stray whitespace, which has been trimmed, worth fixing in Vercel too" });
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
      : `Plaid refused them. ${check.probe.error}`,
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
          <b>These keys work, but only against Plaid's fake banks.</b> Plaid only shows a Production secret
          on the Keys page once your Production access request has been approved; until then the page lists a
          Sandbox secret alone, which is what you have. Two ways forward: set <b>PLAID_ENV</b> to
          <code> sandbox</code> in Vercel and redeploy, to try the whole flow against test banks now, or wait
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
  /** What the Full history wait is doing, while it is doing it. */
  const [note, setNote] = useState<string | null>(null);
  /** What Plaid said it holds, once a press of Full history has finished. */
  const [reach, setReach] = useState<{ itemId: string; line: string; detail: string; state: ReachState } | null>(null);
  /**
   * Items whose backfill was still running when the last wait gave up.
   *
   * Pressing Full history again on one of these should wait again rather than
   * pull straight away, and pressing it on an item that finished long ago
   * should not wait at all. Held for the session only: the question is about
   * something happening right now at Plaid.
   */
  const stillFetching = useRef(new Set<string>());

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
      // A connection is one login and holds every account behind it, so a
      // second one for the same bank is usually a mistake and always costs
      // another of the plan's ten. Said rather than prevented: two logins at
      // one institution is a real arrangement, and only the household knows.
      const twin = itemFor(items, item.institution, kind);
      actions.patchSettings({ plaidItems: [...items, item] });
      notify(`Connected ${item.institution}. Syncing…`);
      if (twin) {
        setNote(`This is a second connection to ${twin.institution}, and it counts separately against the plan's ten. `
          + "One connection already holds every account behind its login, so unless these are two different "
          + "logins, disconnect one of them.");
      }
      await syncItem(item);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect.");
    } finally {
      setBusy(null);
    }
  };

  /** Both of these now live in lib/sync/run beside the SimpleFIN pull, so the
   *  integrations table can offer the same thing without a second copy. */
  const syncItem = async (item: PlaidItemRef, opts: { fullHistory?: boolean } = {}) => {
    const out = await syncPlaidItem(apply, item, opts);
    recordRun(apply, "plaid", "ever", { error: out.errors[0] });
    notify(out.summary);
    // A window Plaid could not be read to the end of has transactions missing
    // from it. Showing the count is the only thing that turns silent data loss
    // into something anyone can act on.
    if (out.errors.length) setError(out.errors.join(" · "));
    // Not an error and not red, but a pull that reports nothing new while
    // quietly dropping a fortnight is the failure that hides for weeks.
    if (out.notes.length) setNote(out.notes.join(" "));
    return out;
  };

  const syncAll = async () => {
    setBusy("sync");
    setError(null);
    setNote(null);
    try {
      const out = await syncPlaid(db, apply);
      notify(out.summary);
      if (out.errors.length) setError(out.errors.join(" · "));
      if (out.notes.length) setNote(out.notes.join(" "));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Reading a connection the other way: as a brokerage, or as a bank.
   *
   * What a Plaid item is for is decided when it is linked, and getting it
   * wrong is easy — a 401(k) at a bank you also bank with is offered under
   * both. It matters because the two are pulled with different calls: a bank
   * item is asked for transactions and never for holdings, so a retirement
   * account connected as a bank arrives as a balance and nothing else, which
   * is exactly what it looks like when something is broken.
   *
   * It cannot be done here alone. The item consented to one product and Plaid
   * refuses the other with ADDITIONAL_CONSENT_REQUIRED however this app labels
   * it, so the switch is a trip through the dialog to ask for the missing
   * consent. The access token survives it, which is what makes it worth doing:
   * no new token to paste into Vercel, and everything already pulled stays.
   */
  const switchKind = async (item: PlaidItemRef) => {
    const to: PlaidItemRef["kind"] = item.kind === "bank" ? "investment" : "bank";
    const product = to === "investment" ? "investments" : "transactions";
    setBusy(item.itemId);
    setError(null);
    setNote(null);
    try {
      const { linkToken } = await reconnectLinkToken(item.accessToken, {
        consentTo: [product],
        // A bank item's reach is worth raising while the dialog is open
        // anyway, the same as a reconnect does.
        ...(to === "bank" ? { historyDays: FIRST_PULL_DAYS } : {}),
      });
      // Only a sign-in that finished granted anything. Relabelling the item
      // after a dialog somebody closed would leave it asking Plaid for a
      // product it still has no permission for, on every pull, for ever.
      if ((await openPlaidLink(linkToken)) === null) {
        setNote(`${item.institution} is still a ${item.kind} connection: the dialog closed before Plaid was asked for ${product}.`);
        return;
      }
      const next: PlaidItemRef = {
        ...item,
        kind: to,
        lastError: undefined,
        ...(to === "bank" ? { historyDays: FIRST_PULL_DAYS } : {}),
      };
      actions.patchSettings({
        plaidItems: items.map((i) => (i.itemId === item.itemId ? next : i)),
      });
      notify(`${item.institution} is now an ${to} connection. Syncing…`);
      await syncItem(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch this connection.");
    } finally {
      setBusy(null);
    }
  };

  /**
   * The login again, on the item that already exists.
   *
   * Plaid calls this update mode, and the thing that matters about it is what
   * it does not do: the access token is unchanged. Removing the bank and
   * adding it back would also work and would mint a new one, which on an
   * encrypted document means editing PLAID_ACCESS_TOKENS in Vercel and
   * redeploying before the overnight pull can see it again.
   */
  const reconnect = async (item: PlaidItemRef) => {
    setBusy(item.itemId);
    setError(null);
    try {
      // A bank item that was refused transactions needs to be asked for them
      // again, which only update mode can do.
      const missing = item.kind === "bank" && /ADDITIONAL_CONSENT_REQUIRED|consent/i.test(item.lastError?.message ?? "");
      const { linkToken } = await reconnectLinkToken(item.accessToken, {
        ...(missing ? { consentTo: ["transactions"] } : {}),
        // Signing in again is also the moment to raise how far back this item
        // reaches, for the ones created before the app asked for two years.
        ...(item.kind === "bank" ? { historyDays: FIRST_PULL_DAYS } : {}),
      });
      // Update mode has nothing to exchange: the item coming back is the one
      // that was already there, with the same access token. Closing the dialog
      // and finishing it look the same from here, and both are fine, except
      // for the reach below: only a sign-in that finished raised anything.
      const signedIn = (await openPlaidLink(linkToken)) !== null;
      // Signing in again raised this item's reach too, so remember it, or Full
      // history will open this very dialog again to ask for what it has. And
      // remember that Plaid is now off fetching the older months, so that the
      // next press waits for them rather than pulling the ninety days that are
      // still all there is.
      const raised = signedIn && item.kind === "bank";
      if (raised) stillFetching.current.add(item.itemId);
      actions.patchSettings({
        plaidItems: items.map((i) => (i.itemId === item.itemId
          ? { ...i, lastError: undefined, ...(raised ? { historyDays: FIRST_PULL_DAYS } : {}) }
          : i)),
      });
      notify(`Reconnected ${item.institution}. Syncing…`);
      await syncItem({ ...item, lastError: undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reconnect.");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Everything the bank still has, rather than everything since last time.
   *
   * Three things stand between a press of this button and two years of
   * history, and only one of them used to be handled.
   *
   * The first is this app's own window, which narrows once a connection has
   * been syncing for a while. The flag below widens it.
   *
   * The second is Plaid's reach, settled when an item is linked and raised
   * only through the Link dialog. That is a sign-in, so it is asked for once
   * and remembered: an item that has already been raised is never sent
   * through it again.
   *
   * The third is time. Plaid does not hand back the older months when the
   * dialog closes; it goes and fetches them, over a minute or several, and
   * until it has, every pull returns the ninety days it already held. So this
   * waits and watches the count climb rather than telling somebody to come
   * back later and press the same button again.
   *
   * Safe to press twice regardless: a transaction already held is recognised
   * by its id and skipped.
   */
  const fullHistory = async (item: PlaidItemRef) => {
    setBusy(item.itemId);
    setError(null);
    setNote(null);
    setReach(null);
    try {
      const since = windowFor(undefined);
      // Raised already, by this app or before it kept track. Either way there
      // is nothing to ask the bank for and no reason to open a dialog.
      const raised = !needsRaising(db, item, FIRST_PULL_DAYS);

      let wait = stillFetching.current.has(item.itemId);
      let refused = false;

      if (!raised) {
        const { linkToken, dropped } = await reconnectLinkToken(item.accessToken, { historyDays: FIRST_PULL_DAYS });
        refused = dropped.includes("transactions");
        const done = await openPlaidLink(linkToken);
        // Closed rather than finished: nothing was raised, so nothing is
        // remembered and the next press asks again.
        if (done !== null && !refused) {
          actions.patchSettings({
            plaidItems: items.map((i) => (i.itemId === item.itemId ? { ...i, historyDays: FIRST_PULL_DAYS } : i)),
          });
          wait = true;
        }
      }

      if (wait) {
        // Raising the reach says what is wanted, not when. Plaid refreshes an
        // item on its own cycle, so without this the wait can be four minutes
        // of watching a figure that was never going to move until tomorrow.
        await refreshItem(item);
        setNote("Plaid is fetching the older months. This takes a few minutes, and this page will pull them in as soon as they arrive.");
        const out = await waitForHistory(() => countHistory(item, since), {
          onProgress: (total) =>
            setNote(`Plaid is fetching the older months. ${total.toLocaleString()} transaction${total === 1 ? "" : "s"} ready so far.`),
        });
        // Still arriving is worth coming back for. Never having arrived is
        // not: a count that has not moved in four minutes is a bank that has
        // nothing more to send, and telling somebody to press again in a few
        // minutes leaves them doing it for ever. The report below says which
        // of the two this was.
        const arriving = out.timedOut && out.grew;
        if (arriving) stillFetching.current.add(item.itemId);
        else stillFetching.current.delete(item.itemId);
        setNote(arriving
          ? `Plaid is still fetching. ${out.total.toLocaleString()} transactions are ready and are being pulled in now; press Full history again in a few minutes for the rest.`
          : null);
      }

      const pulled = await syncItem(item, { fullHistory: true });
      if (refused) {
        setError("Plaid would not take a request for a longer history, so this connection still holds its last 90 days only.");
      }

      // Said out loud on every press, because "it stalled at 101" and "this
      // bank only has 101" look identical from the outside and only one of
      // them is worth pressing the button again for.
      if (item.kind === "bank" && !pulled.errors.length) {
        const said = await reportHistory(item, since).catch(() => null);
        if (said) {
          // What Plaid said last time, read from before this press changed
          // anything, and written back for the next one. Kept on the item so
          // the comparison survives closing the page.
          const told = describeReach(said, item.institution, {
            want: FIRST_PULL_DAYS,
            previous: item.historyTotal,
          });
          // Through apply rather than patchSettings, because the sync above
          // has just stamped this item and the array in hand predates that.
          apply((cur) => ({
            ...cur,
            settings: {
              ...cur.settings,
              plaidItems: (cur.settings.plaidItems ?? []).map((i) =>
                (i.itemId === item.itemId ? { ...i, historyTotal: said.total } : i)),
            },
          }), `record what Plaid holds for ${item.institution}`);
          setReach({ itemId: item.itemId, line: told.line, detail: told.detail, state: told.state });
          // Nothing more is coming for a connection stuck at Plaid's default,
          // so a later press should not sit through a wait for it.
          if (told.state !== "partial") stillFetching.current.delete(item.itemId);
        }
      }
    } catch (err) {
      setNote(null);
      setError(err instanceof Error ? err.message : "Could not fetch the history.");
    } finally {
      setBusy(null);
    }
  };

  /**
   * The same bank, connected again from scratch.
   *
   * How far back Plaid reaches is settled when an item is created. Update mode
   * can ask for more and some banks will not give it: the connection sits at
   * ninety days whatever is requested, which is what the report under the
   * button says when it happens. A new item created asking for two years is
   * the way past that, and this is it without losing anything.
   *
   * What used to make this unthinkable was the cost. A new item mints a new id
   * for every transaction in it, so remaking a connection filed a second copy
   * of everything already held. The merge recognises them now, by account, day
   * and figure, and re-keys what it already has instead of adding to it, so
   * the categories, notes and tags put on those rows survive.
   *
   * The old token is handed back to Plaid afterwards, or the bank being
   * replaced would go on occupying one of the plan's ten connections for ever.
   */
  const remake = async (item: PlaidItemRef) => {
    setBusy(item.itemId);
    setError(null);
    setNote(null);
    setReach(null);
    try {
      const token = await createLinkToken(item.kind);
      const publicToken = await openPlaidLink(token);
      if (!publicToken) return; // closed the dialog, and nothing has changed
      const fresh = await exchangePublicToken(publicToken, item.kind);

      // Swapped in place, so the bank keeps its position in the list, and the
      // reach is recorded because a new item was created asking for it.
      actions.patchSettings({
        plaidItems: items.map((i) =>
          (i.itemId === item.itemId ? { ...fresh, historyDays: FIRST_PULL_DAYS } : i)),
      });
      notify(`Reconnected ${fresh.institution} from scratch. Fetching its history…`);

      // A brand new item does fetch its history by itself, so this waits on
      // that rather than on a backfill that has to be nudged.
      stillFetching.current.add(fresh.itemId);
      await fullHistory({ ...fresh, historyDays: FIRST_PULL_DAYS });

      // Only once the replacement is in place and has been pulled. A token
      // handed back before that is a bank with no way in at all.
      await releaseItem(item);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remake the connection.");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = (item: PlaidItemRef) => {
    actions.patchSettings({ plaidItems: items.filter((i) => i.itemId !== item.itemId) });
    // Handed back, or the bank goes on occupying one of the plan's ten
    // connections with nothing in the app ever mentioning it again. Nothing
    // waits on it and nothing fails if Plaid refuses.
    void releaseItem(item);
    notify(`Disconnected ${item.institution}. Its accounts and history stay put.`);
  };

  return (
    <Card>
      <CardHead
        title="Connections"
        sub="Banks, cards and brokerages, through Plaid"
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
        <b>Investment</b> for IRAs, Roth IRAs, 401(k)s and brokerages: positions, cost basis and prices.
        <b> Bank</b> for chequing, savings and cards: transactions. The two are pulled with different
        calls, so a 401(k) connected as a bank arrives as a balance and nothing else. Press the label
        beside a connection below to read it the other way. An institution offering both can be
        connected twice. The item count against the plan&rsquo;s ceiling is in the integrations table above.
      </div>

      {items.length ? (
        <>
          <div className="divider" />
          <div className="col" style={{ gap: 8 }}>
            {items.map((item) => (
              <div key={item.itemId} className="spread plaid-row">
                <span className="row plaid-who" style={{ gap: 8, minWidth: 0 }}>
                  {item.kind === "investment" ? <LineChart size={14} className="muted" /> : <Building2 size={14} className="muted" />}
                  <span className="truncate" style={{ fontWeight: 500 }}>{item.institution}</span>
                  {/* The label is the switch. A fourth button on the row does
                      not fit a phone, and what this says is exactly what the
                      thing to change is. */}
                  <button
                    className="tag kind-switch"
                    onClick={() => void switchKind(item)}
                    disabled={busy !== null}
                    title={item.kind === "bank"
                      ? "Read as a bank: transactions, no holdings. Press to read it as investments instead, which pulls positions. Plaid will ask you to sign in again."
                      : "Read as investments: positions and prices, no transactions. Press to read it as a bank instead. Plaid will ask you to sign in again."}
                  >
                    {item.kind}
                  </button>
                </span>
                <span className="row plaid-doings" style={{ gap: 10 }}>
                  <span className="tiny faint nowrap">
                    {item.lastSyncAt ? `synced ${dateLabel(item.lastSyncAt.slice(0, 10))}` : "never synced"}
                  </span>
                  {/* Offered on every item, because a bank can start refusing
                      a login without the last pull having failed yet, and
                      made the obvious thing to press on the one that has. */}
                  <Btn
                    size="sm"
                    variant={item.lastError ? "primary" : undefined}
                    onClick={() => void reconnect(item)}
                    disabled={busy !== null}
                    title="Sign in again without changing this item's access token"
                  >
                    <KeyRound size={12} /> {busy === item.itemId ? "Opening…" : "Reconnect"}
                  </Btn>
                  <Btn
                    size="sm"
                    onClick={() => void fullHistory(item)}
                    disabled={busy !== null}
                    title="Ask Plaid for two years of this bank rather than the 90 days it fetches by default"
                  >
                    <History size={12} /> {busy === item.itemId && note ? "Fetching…" : "Full history"}
                  </Btn>
                  <ConfirmButton
                    label="Disconnect"
                    confirmLabel="Click again to disconnect"
                    onConfirm={() => disconnect(item)}
                  />
                </span>
              </div>
            ))}
            {note ? <div className="small muted">{note}</div> : null}
            {reach ? (
              <div className="small muted">
                {reach.line}
                {reach.detail ? <div className="tiny faint" style={{ marginTop: 2 }}>{reach.detail}</div> : null}
                {/* Offered where it is relevant rather than on every row: a
                    fourth button beside the others does not fit a phone, and
                    remaking a connection that reaches back fine is work for
                    nothing. */}
                {reach.state === "default" && items.some((i) => i.itemId === reach.itemId && i.kind === "bank") ? (
                  <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                    <Btn
                      size="sm"
                      onClick={() => {
                        const found = items.find((i) => i.itemId === reach.itemId);
                        if (found) void remake(found);
                      }}
                      disabled={busy !== null}
                      title="Connect this bank again from scratch, which is the only way to widen a reach a reconnect cannot"
                    >
                      <RotateCcw size={12} /> Remake this connection
                    </Btn>
                    <span className="tiny faint">
                      Your categories, notes and tags are kept: rows already held are recognised by their day and
                      figure rather than by an id the bank is about to change.
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {items.some((i) => i.lastError) ? (
              <div className="small warn">
                {items.filter((i) => i.lastError).map((i) => `${i.institution}: ${i.lastError!.message}`).join(" · ")}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}

      <div className="divider" />
      <SyncSchedule />

      {/* The way back from a delete nobody meant. Provider-agnostic, and it
          was on the bank-sync card until that card went. */}
      {(db.settings.deletedAccountKeys?.length ?? 0) > 0 ? (
        <>
          <div className="divider" />
          <div className="spread wrap" style={{ gap: 10 }}>
            <span className="small muted" style={{ maxWidth: 520 }}>
              <b>{db.settings.deletedAccountKeys!.length} deleted account
              {db.settings.deletedAccountKeys!.length === 1 ? " is" : "s are"} ignored on sync.</b>{" "}
              Forgetting them lets the provider offer them again on the next pull, the way back
              from a delete you didn&rsquo;t mean.
            </span>
            <Btn onClick={() => { actions.forgetDeletedAccounts(); notify("Deleted accounts forgotten. They can return on the next sync."); }}>
              Forget them
            </Btn>
          </div>
        </>
      ) : null}

      <div className="divider" />
      <div className="row wrap" style={{ gap: 10 }}>
        <Btn onClick={() => void runCheck()} disabled={busy !== null}>
          <Stethoscope size={14} /> {busy === "check" ? "Checking…" : "Check configuration"}
        </Btn>
        {check ? <Diagnosis check={check} /> : null}
      </div>

      <div className="divider" />
      <details>
        <summary className="small muted" style={{ cursor: "pointer" }}>Setup, two environment variables</summary>
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

      <div className="divider" />
      <div className="small muted">
        {/* Published rather than described: a provider asking for a privacy
            policy is asking for an address, and this is the one to give them.
            Static, so it answers even when the application does not. */}
        What this holds, where it goes, how long it is kept and how to delete it:{" "}
        <a href="/privacy" target="_blank" rel="noreferrer">privacy, retention and deletion</a>.
      </div>
    </Card>
  );
}

/**
 * How often to pull, and when the next one is due.
 *
 * It lived on the bank-sync card, which was the bridge's, and came here when
 * that went: it was never the bridge's schedule, it is the app's, and Plaid is
 * the only thing it drives now.
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
          ? "Nothing will pull on its own while the app is open. The 9am job still runs."
          : due
            ? `Next pull ${untilLabel(due, Date.now())}, the next time the app is open.`
            : "The next pull runs as soon as the app is open."}
        {" "}This is the in-app schedule; a scheduled job also pulls at 9am with every browser
        shut. A bank posts to Plaid about once a day, so anything tighter rarely finds new
        data.
      </span>
    </div>
  );
}
