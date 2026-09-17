import { useMemo } from "react";
import { TriangleAlert } from "lucide-react";
import type { Account } from "../types";
import { useStore } from "../store";
import { longDate } from "../lib/date";
import { fmt0 } from "../lib/money";
import { badRuns, runOverstatement } from "../lib/repair";
import { Btn, Card, CardHead, Money } from "../components/ui";

/**
 * Readings a provider got wrong, offered for removal.
 *
 * Only shown when there is one, and only ever offered: a balance that falls by
 * almost all of itself is usually a mistake and occasionally a mortgage being
 * paid off, and nothing in the document can tell those apart. What can be said
 * is that the readings on both sides of this stretch disagree with it, which a
 * real payoff never does.
 *
 * The figures are spelled out before the button rather than after it, because
 * this deletes recorded data and the only defensible version of that is one
 * where the person could see exactly what was going.
 */
export function BadRunCard({ account }: { account: Account }) {
  const { actions } = useStore();
  const runs = useMemo(() => badRuns(account), [account]);
  if (!runs.length) return null;

  return (
    <Card pad={false} className="est-section">
      <CardHead
        flush
        title={
          <span className="row" style={{ gap: 7 }}>
            <TriangleAlert size={15} className="warn" />
            {runs.length === 1 ? "These readings look wrong" : `${runs.length} stretches of readings look wrong`}
          </span>
        }
        sub="Reported by the provider, then contradicted by the readings either side. Your charts still carry them."
      />
      {runs.map((run) => {
        const over = runOverstatement(run);
        const days = run.points.length;
        return (
          <div key={`${run.from}:${run.to}`} className="row est-line bad-run">
            <span className="col grow" style={{ gap: 2 }}>
              <span className="bold">
                {run.from === run.to ? longDate(run.from) : `${longDate(run.from)} to ${longDate(run.to)}`}
              </span>
              <span className="tiny faint">
                {days} reading{days === 1 ? "" : "s"} of <Money value={run.reported} cents={false} />
                {" "}where {longDate(run.before.date)} said <Money value={run.before.balance} cents={false} />
                {" "}and {longDate(run.after.date)} said <Money value={run.after.balance} cents={false} />.
              </span>
              <span className="tiny muted">
                {over === 0 ? "It moves nothing." : `That is ${fmt0(Math.abs(over))} ${over > 0 ? "too high" : "too low"} on your net worth for those days.`}
                {" "}Dropping them holds the line at {fmt0(run.before.balance)} until the next real reading.
              </span>
            </span>
            <Btn onClick={() => actions.dropBalanceRun(account.id, run.from, run.to)}>
              Drop {days === 1 ? "it" : "them"}
            </Btn>
          </div>
        );
      })}
    </Card>
  );
}
