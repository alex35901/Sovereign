import { AlertTriangle, ExternalLink } from "lucide-react";
import { useDB, useStore } from "../store";
import { escalation, escalationAdvice, patternsIn } from "../lib/sync/link-log";
import { Btn } from "../components/ui";

/**
 * Sign-ins that did not finish, and what to do once waiting has stopped
 * working.
 *
 * The app's advice on a bank that will not hand over a sign-in is "it is not
 * answering Plaid at the moment, try again later", which is right the first
 * afternoon and wrong by the second week. Nothing here could tell those apart,
 * because nothing was counting: every attempt was a toast, and a new
 * connection has no item to write an error onto.
 *
 * So this counts, and once a bank has refused the same way on different days
 * it says the thing waiting will not fix. It also prints every reference
 * Plaid's support will ask for, which is the one thing a household cannot get
 * back once the dialog has closed.
 */
export function LinkTrouble() {
  const db = useDB();
  const { actions, notify } = useStore();
  const log = db.settings.linkFailures ?? [];
  if (!log.length) return null;

  const worst = escalation(log);
  const patterns = patternsIn(log);

  const when = (at: string) => new Date(at).toLocaleString();

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="spread wrap" style={{ gap: 10 }}>
        <span className="small" style={{ fontWeight: 500 }}>
          {log.length === 1 ? "A sign-in that did not finish" : `${log.length} sign-ins that did not finish`}
        </span>
        <Btn
          size="sm"
          onClick={() => { actions.forgetLinkFailures(); notify("Forgotten. The next failed sign-in starts the count again."); }}
        >
          Forget these
        </Btn>
      </div>

      {/* The one sentence this whole card exists for, and only once it has
          been earned: three attempts, on different days, with the same
          refusal. Said in the warning colour because the advice it replaces
          was "try again later", and somebody has by now tried again later. */}
      {worst ? (
        <div className="small warn" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <AlertTriangle size={14} style={{ flex: "none", marginTop: 2 }} />
          <span>{escalationAdvice(worst)}</span>
        </div>
      ) : null}

      {/* Selectable, because the answer to "why will this bank not connect" is
          a thing people paste into a support ticket. */}
      <div className="col link-refs" style={{ gap: 4 }}>
        {patterns.map((p) => (
          <div key={`${p.institution}|${p.code}`} className="tiny muted">
            <b>{p.institution}</b>, {p.code}, {p.count === 1 ? "once" : `${p.count} times`}
            {p.count > 1 ? ` between ${when(p.firstAt)} and ${when(p.lastAt)}` : ` at ${when(p.lastAt)}`}
            {p.references.length ? (
              <ul style={{ margin: "3px 0 0", paddingLeft: 18 }}>
                {p.references.map((r) => (
                  <li key={`${r.at}${r.sessionId ?? r.requestId ?? ""}`}>
                    {r.sessionId ? `session ${r.sessionId}` : ""}
                    {r.sessionId && r.requestId ? ", " : ""}
                    {r.requestId ? `request ${r.requestId}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
        {/* Attempts Link never named a bank or a code for: it failed before it
            got that far, or closed without saying. Counted rather than listed,
            because there is nothing in them to read. */}
        {log.length > patterns.reduce((n, p) => n + p.count, 0) ? (
          <div className="tiny faint">
            {log.length - patterns.reduce((n, p) => n + p.count, 0)} more stopped before Plaid named a bank
            or a reason.
          </div>
        ) : null}
      </div>

      {/* What the person can do that the app cannot. Worth spelling out
          because it is the obvious thing to want and there is no way to tell
          from inside the dialog that it exists. */}
      <details>
        <summary className="small muted" style={{ cursor: "pointer" }}>
          Making a bank forget a connection, from your side
        </summary>
        <div className="small muted" style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
          <span>
            A sign-in that will not finish is sometimes a stale permission sitting at one end or the other.
            Disconnect above hands this app&rsquo;s own access token back to Plaid, which is all this app is
            able to do: Plaid&rsquo;s API has no call that revokes a person&rsquo;s own consent at their bank.
            Two places outside it can.
          </span>
          <span>
            <a href="https://my.plaid.com" target="_blank" rel="noreferrer">
              my.plaid.com <ExternalLink size={11} />
            </a>{" "}
            is Plaid&rsquo;s portal for the person rather than for the app. Sign in with the phone number or
            email you used in the dialog and it lists every connection you have made through Plaid, whichever
            app made it, with a way to disconnect each one.
          </span>
          <span>
            <b>The bank&rsquo;s own site.</b> Most keep a list of connected apps under security or privacy
            settings. Some treat Plaid as one entry covering every app connected through it, so removing it
            there removes it for all of them at once, which is worth knowing before pressing it. Wells Fargo
            files this under data sharing, in the security and privacy part of its settings.
          </span>
          <span className="tiny faint">
            Either way, nothing here is lost. Accounts and transactions already in this document stay, and a
            connection made again is matched back to them by name.
          </span>
        </div>
      </details>
    </div>
  );
}
