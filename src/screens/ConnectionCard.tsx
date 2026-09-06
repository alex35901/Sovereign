import { CircleHelp, Database, RefreshCw, Signal } from "lucide-react";
import type { ReactNode } from "react";
import type { Account } from "../types";
import { useDB } from "../store";
import { sinceLabel } from "../lib/date";
import { connectionOf } from "../lib/connection";
import type { ConnectionState } from "../lib/connection";
import { Card, CardHead, cx } from "../components/ui";

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

export function ConnectionCard({ account }: { account: Account }) {
  const db = useDB();
  const c = connectionOf(account, db);

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
          tooltip: an account that needs attention needs to say what for. */}
      {c.detail ? <div className="conn-detail neg small">{c.detail}</div> : null}
    </Card>
  );
}
