import { useMemo, useState } from "react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { monthLabel } from "../lib/date";
import { fmt0 } from "../lib/money";
import { AreaChart } from "../components/charts";
import { Card, CardHead, Empty, MoneyInput, Segmented, cx } from "../components/ui";
import type { Order } from "../lib/payoff";
import { compareOrders, debtsFrom } from "../lib/payoff";

/**
 * Where the next spare dollar should go.
 *
 * Two orders, and the app does not pick between them. The avalanche pays the
 * dearest rate first and costs strictly less; the snowball clears the smallest
 * balance first and closes an account sooner. One saves money and the other
 * keeps people going, and which of those matters more is not a thing
 * arithmetic knows. So both are run, the difference between them is printed in
 * pounds and months, and the choice is left where it belongs.
 */

const ORDERS: { value: Order; label: string }[] = [
  { value: "avalanche", label: "Dearest rate first" },
  { value: "snowball", label: "Smallest balance first" },
];

export default function Payoff() {
  const db = useDB();
  const debts = useMemo(() => debtsFrom(db), [db]);
  const [extra, setExtra] = useState(0);
  const [order, setOrder] = useState<Order>("avalanche");

  const both = useMemo(() => compareOrders(debts, extra), [debts, extra]);
  const plan = both[order];
  const other = both[order === "avalanche" ? "snowball" : "avalanche"];

  if (!debts.length) {
    return (
      <>
        <TopBar title="Debt" />
        <div className="page stack">
          <Card>
            <Empty
              title="Nothing owed"
              body="Credit cards, loans and mortgages show up here once they carry a balance. Their rates and terms come from the Forecast page."
            />
          </Card>
        </div>
      </>
    );
  }

  const owed = debts.reduce((n, d) => n + d.balance, 0);
  const points = plan.curve.map((c, i) => ({
    label: c.month.slice(0, 4),
    value: -c.owed,
    sub: `${monthLabel(c.month)} · ${i + 1} month${i === 0 ? "" : "s"} in`,
  }));

  return (
    <>
      <TopBar title="Debt" />
      <div className="page stack">
        <Card pad={false} className="nw-card">
          <div className="fc-head">
            <span className="small muted">
              {plan.debtFree ? "Debt free in" : "At this rate"}
            </span>
            <span className={cx("nw-total num", !plan.debtFree && "neg")}>
              {plan.debtFree
                ? `${plan.months} month${plan.months === 1 ? "" : "s"}`
                : "Never"}
            </span>
            <span className="small faint">
              {plan.debtFree
                ? `${monthLabel(plan.debtFree)}, paying ${fmt0(plan.monthly)} a month against ${fmt0(owed)} owed. `
                  + `${fmt0(plan.interest)} of that is interest.`
                : "The minimums do not cover the interest on at least one of these. Put something extra against it, or the balance grows for ever."}
            </span>
          </div>
          {points.length ? (
            <div style={{ padding: "0 8px 8px" }}>
              <AreaChart points={points} height={200} tone="--pos" negativeTone="--accent" zeroBase />
            </div>
          ) : null}
        </Card>

        <Card pad={false}>
          <CardHead
            flush title="What you put at it"
            sub="On top of the minimums. Every dollar here is paid at the dearest rate you carry."
          />
          <div className="fc-grid">
            <div className="field">
              <label>Extra a month</label>
              <MoneyInput value={extra} onChange={setExtra} />
              <span className="tiny faint">
                Minimums come to {fmt0(plan.monthly - extra)}
              </span>
            </div>
          </div>
          <div className="payoff-order">
            <Segmented value={order} options={ORDERS} onChange={setOrder} spread />
            {/* The trade, in the two units that actually differ. Said plainly
                rather than recommended: one of these saves money and the other
                closes an account sooner, and only the person paying knows
                which of those they need. */}
            <span className="tiny faint">
              {both.costsExtra > 0
                ? order === "snowball"
                  ? `This order costs ${fmt0(both.costsExtra)} more in interest than paying the dearest rate first`
                    + (both.firstWinSooner > 0
                      ? `, and closes your first account ${both.firstWinSooner} month${both.firstWinSooner === 1 ? "" : "s"} sooner.`
                      : ", and closes your first account no sooner.")
                  : `This is the cheaper order. Clearing the smallest balance first would cost ${fmt0(both.costsExtra)} more in interest`
                    + (both.firstWinSooner > 0
                      ? `, though it would close your first account ${both.firstWinSooner} month${both.firstWinSooner === 1 ? "" : "s"} sooner.`
                      : ".")
                : "Both orders cost the same here, so take whichever you will stick to."}
            </span>
          </div>
        </Card>

        <Card pad={false}>
          {/* Named off the plan rather than off the switch: this card shows
              what a particular plan does, and saying which rule produced it is
              both useful and the one thing that would look right if the wrong
              plan were rendered. */}
          <CardHead
            flush title="In the order they go"
            sub={`${plan.order === "avalanche" ? "Dearest rate first" : "Smallest balance first"}. `
              + "Each one's minimum rolls into the next when it clears."}
          />
          {debtsFrom(db).length ? plan.cleared.length ? plan.cleared.map((c, i) => {
            const d = debts.find((x) => x.id === c.id)!;
            return (
              <div key={c.id} className="row payoff-row">
                <span className="payoff-rank num">{i + 1}</span>
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="bold">{c.name}</span>
                  <span className="tiny faint">
                    {fmt0(d.balance)} at {d.apr}% · {fmt0(d.minimum)} a month · {fmt0(c.interest)} of interest
                  </span>
                </span>
                <span className="col" style={{ gap: 0, textAlign: "right" }}>
                  <span className="num bold">{monthLabel(c.month)}</span>
                  <span className="tiny faint">{c.after} month{c.after === 1 ? "" : "s"}</span>
                </span>
              </div>
            );
          }) : (
            <div style={{ padding: 16 }}>
              <span className="small faint">Nothing clears at this rate.</span>
            </div>
          ) : null}
          {plan.cleared.length < debts.length ? (
            <div className="row payoff-row">
              <span className="payoff-rank num faint">-</span>
              <span className="col grow" style={{ gap: 0 }}>
                <span className="bold">
                  {debts.filter((d) => !plan.cleared.some((c) => c.id === d.id)).map((d) => d.name).join(", ")}
                </span>
                <span className="tiny faint">Not cleared inside fifty years at this rate</span>
              </span>
            </div>
          ) : null}
        </Card>

        <span className="tiny faint" style={{ padding: "0 2px" }}>
          Rates and terms come from the Forecast page, under Accounts. Change them there and this follows.
          The other order would clear everything in {other.months ?? "more than fifty"} months
          for {fmt0(other.interest)} of interest.
        </span>
      </div>
    </>
  );
}
