import { useMemo, useState } from "react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { monthLabel } from "../lib/date";
import { fmt0 } from "../lib/money";
import { AreaChart } from "../components/charts";
import { Btn, Card, CardHead, Empty, Field, MoneyInput, NumInput, PercentInput, Popover, Segmented, cx } from "../components/ui";
import type { Debt, Order } from "../lib/payoff";
import { compareOrders, debtsFrom, debtsLeftOut } from "../lib/payoff";

/**
 * Where the next spare dollar should go.
 *
 * Two orders, and the app does not pick between them. The avalanche pays the
 * highest rate first and costs strictly less; the snowball clears the smallest
 * balance first and closes an account sooner. One saves money and the other
 * keeps people going, and which of those matters more is not a thing
 * arithmetic knows. So both are run, the difference between them is printed in
 * pounds and months, and the choice is left where it belongs.
 */

const ORDERS: { value: Order; label: string }[] = [
  { value: "avalanche", label: "Highest rate first" },
  { value: "snowball", label: "Smallest balance first" },
];

export default function Payoff() {
  const db = useDB();
  const { actions } = useStore();
  const debts = useMemo(() => debtsFrom(db), [db]);
  const left = useMemo(() => debtsLeftOut(db), [db]);
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
            {/* Two different nothings. A page that says "nothing owed" to
                somebody carrying a balance they have set aside is wrong, and
                would leave them with no way to change their mind. */}
            <Empty
              title={left.length ? "Nothing left to clear" : "Nothing owed"}
              body={left.length
                ? `${left.map((d) => d.name).join(", ")} ${left.length === 1 ? "is" : "are"} owed but left out of this plan.`
                : "Credit cards, loans and mortgages show up here once they carry a balance. Their rates and terms come from the Forecast page."}
              action={left.length ? (
                <Btn onClick={() => left.forEach((d) => actions.updateAccount(d.id, { excludeFromPayoff: false }))}>
                  Put {left.length === 1 ? "it" : "them"} back
                </Btn>
              ) : undefined}
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
            sub="On top of the minimums. Every dollar here goes against the highest rate you carry."
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
                  ? `This order costs ${fmt0(both.costsExtra)} more in interest than paying the highest rate first`
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
            sub={`${plan.order === "avalanche" ? "Highest rate first" : "Smallest balance first"}. `
              + "Each one's minimum rolls into the next when it clears."}
          />
          {debtsFrom(db).length ? plan.cleared.length ? plan.cleared.map((c, i) => {
            const d = debts.find((x) => x.id === c.id)!;
            return (
              <div key={c.id} className="row payoff-row">
                <span className="payoff-rank num">{i + 1}</span>
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="bold">{c.name}</span>
                  <span className="tiny faint payoff-terms">
                    {fmt0(d.balance)} at <RateEditor debt={d} /> · {fmt0(d.minimum)} a month
                    {" · "}{fmt0(c.interest)} of interest
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

        {left.length ? (
          <Card>
            <CardHead
              title="Left out"
              sub="Owed, and counted in net worth, but not a balance this plan tries to clear."
            />
            {left.map((d) => (
              <div key={d.id} className="row payoff-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="bold">{d.name}</span>
                  <span className="tiny faint">{fmt0(d.balance)} owed</span>
                </span>
                <Btn size="sm" onClick={() => actions.updateAccount(d.id, { excludeFromPayoff: false })}>
                  Put it back
                </Btn>
              </div>
            ))}
          </Card>
        ) : null}

        <span className="tiny faint" style={{ padding: "0 2px" }}>
          Press a rate to correct it. Rates and terms are shared with the Forecast page, under Accounts,
          so a change here shows there too. The other order would clear everything
          in {other.months ?? "more than fifty"} months for {fmt0(other.interest)} of interest.
        </span>
      </div>
    </>
  );
}

/**
 * The rate, corrected where it is read.
 *
 * It lives on the forecast's assumptions and was only editable there, which
 * is a page away from the one that prints "at 6%" against a mortgage. A rate
 * nobody can find is a rate nobody fixes, and every figure on this screen is
 * worked out from it.
 *
 * The term comes along for the ride because the two are one setting: the
 * monthly minimum is worked out from the balance, the rate and the years, so
 * correcting the rate alone would leave a payment that no longer matches the
 * loan.
 */
function RateEditor({ debt }: { debt: Debt }) {
  const { actions } = useStore();
  const set = (patch: { apr?: number; termMonths?: number }) =>
    actions.setDebtTerms(debt.id, { apr: debt.apr, termMonths: debt.termMonths, ...patch });

  return (
    <Popover
      width={230}
      trigger={(open) => (
        <button className="payoff-rate" onClick={open} title={`Change ${debt.name}'s rate`}>
          {debt.apr}%
        </button>
      )}
    >
      {() => (
        <div className="col" style={{ gap: 10, padding: 10 }}>
          <span className="small bold">{debt.name}</span>
          <Field label="Interest rate">
            <PercentInput value={debt.apr} onChange={(apr) => set({ apr })} />
          </Field>
          <Field label="Years left" hint="The minimum each month is worked out from these two.">
            <NumInput
              value={Math.round(debt.termMonths / 12)} min={1} max={50}
              onChange={(years) => set({ termMonths: years * 12 })}
            />
          </Field>
          {/* A button rather than a switch: from in here it only ever goes one
              way, and the way back is a row of its own at the foot of the page
              where a reader can see what they have set aside. */}
          <div className="payoff-leave">
            <Btn size="sm" onClick={() => actions.updateAccount(debt.id, { excludeFromPayoff: true })}>
              Leave out of this plan
            </Btn>
            <span className="tiny faint">
              For a card you clear every month. It stays owed, and still counts in net worth.
            </span>
          </div>
        </div>
      )}
    </Popover>
  );
}
