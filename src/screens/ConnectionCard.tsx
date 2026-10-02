import { useState } from "react";
import { CircleHelp, Database, RefreshCw, Signal, Stethoscope } from "lucide-react";
import type { ReactNode } from "react";
import type { Account, DB } from "../types";
import { useDB } from "../store";
import { sinceLabel } from "../lib/date";
import { connectionOf } from "../lib/connection";
import type { ConnectionState } from "../lib/connection";
import { quietFor } from "../lib/quiet";
import { diagnoseItem } from "../lib/sync/plaid";
import { readInstitutionHealth, readItemHealth, verdictOn } from "../lib/sync/health";
import type { Verdict } from "../lib/sync/health";
import { Btn, Card, CardHead, cx } from "../components/ui";
import { SwitchToPlaid } from "./SwitchToPlaid";

/**
 * Where this account's balance comes from, and whether it is still coming.
 *
 * Sits at the foot of the account, which is the right place for it: it is the
 * answer to a question you only ask once the figure above has surprised you.
 */

const TONE: Record<ConnectionState, string> = {
  connected: "pos",
  attention: "neg",
  stale: "warn",
  manual: "muted",
};

function Row({ icon, label, children, help }: {
  icon: ReactNode; label: string; children: ReactNode; help?: string;
}) {
  return (
    <div className="drow">
      <span className="drow-label">
        <span className="conn-icon">{icon}</span>
        {label}
      </span>
      <span className="drow-val">
        {children}
        {help ? <CircleHelp size={13} className="faint" aria-label={help}><title>{help}</title></CircleHelp> : null}
      </span>
    </div>
  );
}

/**
 * The account kinds a statement comes for.
 *
 * A brokerage has holdings rather than a statement, so a connection that
 * hands over no transactions for one is the arrangement rather than a fault.
 * Everything that spends has a statement, and silence on one of these is
 * worth explaining.
 */
const WANTS_TRANSACTIONS = new Set<Account["type"]>([
  "checking", "savings", "credit", "loan", "mortgage",
]);

/**
 * The Plaid item feeding this account, by the same rule the status uses.
 *
 * Its own item id when it has one, the institution otherwise: an account
 * connected before the app recorded the id has only the name to go on.
 */
function itemFor(account: Account, db: DB) {
  return (db.settings.plaidItems ?? []).find((i) => (
    account.plaidItemId ? i.itemId === account.plaidItemId : i.institution === account.institution
  ));
}

/**
 * Ask Plaid whose fault this is.
 *
 * Deliberately a button rather than something the page does on its own. It is
 * two calls to Plaid about a connection that is, by the time anybody presses
 * it, already known to be misbehaving, and running it on every visit to every
 * account would be asking a question nobody had.
 */
function Diagnosis({ account, db }: { account: Account; db: DB }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Verdict | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const item = itemFor(account, db);
  if (!item) return null;

  const run = async () => {
    setBusy(true);
    setFailed(null);
    // Cleared, not left standing. The button reads "Check again" by then, and
    // an answer from four minutes ago sitting under a fresh error would be
    // read as the answer to the question just asked.
    setSaid(null);
    setReference(null);
    try {
      const raw = await diagnoseItem(item);
      setReference(raw.requestId ?? null);
      setSaid(verdictOn(
        readInstitutionHealth(raw.institution),
        readItemHealth(raw.item),
        {
          quiet: quietFor(
            db.transactions.filter((t) => t.accountId === account.id).map((t) => t.date),
          ),
          // Read off this account rather than off the connection it arrived
          // on, because the two can disagree and that disagreement is the
          // fault being looked for: a current account on a connection made for
          // investments is exactly the case where no transactions ever come.
          wantsTransactions: WANTS_TRANSACTIONS.has(account.type),
        },
      ));
    } catch (err) {
      // A diagnosis that fails silently is worse than no diagnosis: the
      // person is already here because something is not saying what is wrong.
      setFailed(err instanceof Error ? err.message : "Plaid could not be reached.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conn-detail col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10 }}>
        <Btn size="sm" onClick={() => void run()} disabled={busy}>
          <Stethoscope size={13} /> {busy ? "Asking Plaid" : said ? "Check again" : "Why is this not updating?"}
        </Btn>
        <span className="tiny faint">
          Asks Plaid how this connection is doing and how the bank is doing for everybody else.
        </span>
      </div>
      {said ? (
        <div className="col" style={{ gap: 3 }}>
          <span className={cx("small bold", said.tone)}>{said.headline}</span>
          <span className="tiny muted">{said.detail}</span>
          {said.action ? <span className="tiny faint">{said.action}</span> : null}
          {/* Plaid's reference for the call that produced this. It is the
              first thing their support asks for and cannot be recovered
              once the answer above has been dismissed. */}
          {reference ? <span className="tiny faint">Plaid's reference: request {reference}.</span> : null}
        </div>
      ) : null}
      {failed ? <span className="tiny neg">{failed}</span> : null}
    </div>
  );
}

export function ConnectionCard({ account }: { account: Account }) {
  const db = useDB();
  const c = connectionOf(account, db);
  // Said it was fed by Plaid, and nothing is feeding it: the connection it
  // came in on has been disconnected.
  const orphaned = account.syncSource === "plaid" && !itemFor(account, db);

  return (
    <Card pad={false}>
      <CardHead flush title="Connection status" />
      <Row
        icon={<RefreshCw size={14} />} label="Last update"
        help="When a balance for this account last arrived."
      >
        {c.lastAt ? sinceLabel(c.lastAt) : <span className="faint">Never</span>}
      </Row>
      <Row
        icon={<Signal size={14} />} label="Status"
        help={c.detail ?? "Whether this account's balance is still arriving on schedule."}
      >
        <span className={cx("row", TONE[c.state])} style={{ gap: 6 }}>
          <span className="dot" style={{ background: "currentColor" }} />
          {c.status}
        </span>
      </Row>
      <Row icon={<Database size={14} />} label="Data provider">
        {c.provider}
      </Row>
      {/* The reason, spelled out, rather than hidden behind the status's own
          tooltip: an account that needs attention needs to say what for. In
          the same colour as the status it explains, because a connection that
          has merely gone quiet is not the same news as one that is broken and
          should not be painted as though it were. */}
      {c.detail ? <div className={cx("conn-detail small", TONE[c.state])}>{c.detail}</div> : null}
      {/* Offered wherever it is a real choice: any account nothing is feeding
          yet. It used to be gated on the account carrying a bridge's tag, so
          the one path that adopts an existing account onto a connection,
          keeping its history instead of filing a second copy beside it, was
          hidden from every account that had been typed in by hand. Not gated
          on Plaid being configured either, because the browser cannot know
          that without asking the server, and the link endpoint already answers
          "PLAID_CLIENT_ID and PLAID_SECRET are not set" in words. */}
      {account.syncSource === "plaid" ? <Diagnosis account={account} db={db} /> : null}
      {/* Offered to an account nothing is feeding, which now includes one
          left behind by a connection that was disconnected. Those keep saying
          they are fed by Plaid, because that is what they were, and without
          this the one path that points an existing account at a connection,
          keeping its history rather than filing a second copy beside it, was
          hidden from exactly the accounts that needed it most. */}
      {account.syncSource !== "plaid" || orphaned ? <SwitchToPlaid account={account} /> : null}
    </Card>
  );
}
