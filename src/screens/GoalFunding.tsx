import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Info, Settings2, Sparkles, TriangleAlert, Wallet } from "lucide-react";
import type { Account, Goal } from "../types";
import { useDB, useStore } from "../store";
import { canValue } from "../lib/property";
import { ceilingFor, claimOn, funding } from "../lib/goal-funding";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { Btn, Card, Modal, Money, MoneyInput, SelectInput, Toggle } from "../components/ui";
import { accountOptions } from "../lib/select";

/**
 * The money behind the goals, and what has not been given a job yet.
 *
 * A goal used to name accounts and count all of them, so an account could back
 * exactly one goal and money arriving in it was absorbed without anybody being
 * told. Here the balances are pooled and divided instead: every goal holds an
 * amount, the total can never pass what is there, and the difference — money
 * that has arrived and has not been assigned — is the headline.
 *
 * An account with one obvious purpose can skip all of that: point it at a goal
 * and its leftovers belong there, so a 401(k) never asks to be allocated
 * again.
 */
export function GoalFunding() {
  const db = useDB();
  const [open, setOpen] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [allocating, setAllocating] = useState<Account | null>(null);

  const f = funding(db);
  const goals = db.goals.filter((g) => !g.archived).sort((a, b) => a.priority - b.priority);

  if (!f.accounts.length) {
    return (
      <>
        <Card>
          <div className="col" style={{ gap: 10 }}>
            <span className="row" style={{ gap: 8 }}><Wallet size={16} className="muted" /> <b>No accounts are backing your goals yet.</b></span>
            <div className="small muted" style={{ maxWidth: 620 }}>
              Say which accounts hold money set aside — a savings account, an ISA, the retirement
              accounts — and their balances become the pool your goals are funded from. Everything else
              stays out of it, because &ldquo;available for goals&rdquo; means nothing if it includes the rent.
            </div>
            <div className="row">
              <Btn variant="primary" onClick={() => setPicking(true)}><Settings2 size={14} /> Choose goal accounts</Btn>
            </div>
          </div>
        </Card>
        {picking ? <GoalAccountsModal onClose={() => setPicking(false)} /> : null}
      </>
    );
  }

  return (
    <>
      <Card pad={false}>
        <div
          className="col" style={{
            gap: 2, padding: "18px 16px", alignItems: "center", textAlign: "center",
            background: f.available > 0 ? "var(--pos-soft)" : f.available < 0 ? "var(--neg-soft)" : "var(--surface-2)",
            borderBottom: "1px solid var(--line-soft)",
          }}
        >
          {/* Below zero is a real reading, not an error state: it is the size
              of the cut the goals need before the balances can cover them. */}
          <span className={`tile-value ${tone(f.available)}`}>
            <Money value={f.available} />
          </span>
          <span className={`small row ${tone(f.available)}`} style={{ gap: 5 }}>
            Available for goals
            <span title={
              `${db.accounts.filter((a) => a.goalAccount).length} accounts hold ${fmtish(f.pooled)} between them. `
              + (f.available < 0
                ? `${fmtish(f.allocated + f.auto + f.over)} is assigned to goals — ${fmtish(f.over)} more than those balances hold.`
                : `${fmtish(f.allocated + f.auto)} is assigned to goals; the rest has arrived and has not been given a job.`)
            }>
              <Info size={13} />
            </span>
          </span>
        </div>

        {f.over > 0 ? (
          <div className="setting-row" style={{ margin: 12, borderColor: "var(--neg)", background: "var(--neg-soft)" }}>
            <span className="small row" style={{ gap: 8, alignItems: "flex-start" }}>
              <TriangleAlert size={15} className="neg" style={{ flex: "none", marginTop: 2 }} />
              <span>
                <b><Money value={f.over} /> is assigned to goals that the accounts no longer hold.</b>{" "}
                A balance has fallen since it was allocated. The goals below report what is really there;
                open the account to put the figures back in step.
              </span>
            </span>
          </div>
        ) : null}

        <div style={{ maxHeight: 420, overflowY: "auto" }}>
          {f.accounts.map((row) => {
            const expanded = open === row.account.id;
            return (
              <div key={row.account.id}>
                <div
                  className="list-row click" onClick={() => setOpen(expanded ? null : row.account.id)}
                  style={{ gap: 10 }}
                >
                  {expanded ? <ChevronDown size={14} className="faint" /> : <ChevronRight size={14} className="faint" />}
                  <InstitutionLogo account={row.account} size={26} round />
                  <span className="grow truncate" style={{ fontWeight: 500 }}>{row.account.name}</span>
                  {/* No "$200 over" tag beside it any more: the figure is
                      signed, so the tag was the same news twice. */}
                  <span className={`num ${tone(row.available)}`}>
                    {row.available > 0 ? <>+<Money value={row.available} /></> : <Money value={row.available} />}
                  </span>
                </div>

                {expanded ? (
                  /* The balance, then what each goal holds of it, then what is
                     left — which says "everything here goes to Retirement"
                     better than the sentence that used to, because it shows
                     the figures the claim is made of. */
                  <div className="col" style={{ gap: 8, padding: "6px 16px 14px 42px", background: "var(--surface-2)" }}>
                    <div className="spread small">
                      <span style={{ fontWeight: 500 }}>Account balance</span>
                      <span className="num" style={{ fontWeight: 500 }}><Money value={row.balance} /></span>
                    </div>

                    {goals.map((g) => {
                      const held = Math.min(claimOn(g, row.account.id), row.balance)
                        + (row.account.autoGoalId === g.id ? row.auto : 0);
                      if (!held) return null;
                      return (
                        <Link
                          key={g.id} to={`/goals/${g.id}`}
                          className="spread small cat-open" style={{ marginLeft: 6 }}
                        >
                          <span className="row truncate" style={{ gap: 6, minWidth: 0 }}>
                            <span>{g.emoji}</span>
                            <span className="truncate">{g.name}</span>
                            {row.account.autoGoalId === g.id ? (
                              <span className="tiny faint nowrap">· all of it</span>
                            ) : null}
                          </span>
                          <span className="num"><Money value={held} /></span>
                        </Link>
                      );
                    })}

                    {row.over > 0 ? (
                      <div className="spread small neg" style={{ marginLeft: 6 }}>
                        <span>Assigned beyond the balance</span>
                        <span className="num"><Money value={row.over} /></span>
                      </div>
                    ) : null}

                    <div className="divider" style={{ margin: "2px 0" }} />
                    <div className="spread small">
                      <span style={{ fontWeight: 500 }}>Available</span>
                      <span className={`num ${tone(row.available)}`} style={{ fontWeight: 500 }}>
                        {row.available > 0 ? <>+<Money value={row.available} /></> : <Money value={row.available} />}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="col" style={{ gap: 8, padding: 12, borderTop: "1px solid var(--line-soft)" }}>
          <Btn
            variant="primary"
            disabled={!goals.length || (f.free <= 0 && f.allocated <= 0)}
            onClick={() => setAllocating(
              // The account that needs a decision comes first, then one with
              // money to hand out. Opening on a settled account when another
              // is short is a wasted trip.
              (f.accounts.find((a) => a.available < 0)
                ?? f.accounts.find((a) => a.available > 0)
                ?? f.accounts[0]!).account,
            )}
          >
            <Sparkles size={14} /> Allocate funds
          </Btn>
          <Btn onClick={() => setPicking(true)}>Edit goal accounts</Btn>
        </div>
      </Card>

      {picking ? <GoalAccountsModal onClose={() => setPicking(false)} /> : null}
      {allocating ? <AllocateModal account={allocating} onClose={() => setAllocating(null)} /> : null}
    </>
  );
}

/**
 * Green above nothing, red below, grey at rest.
 *
 * One helper because the same figure is shown in four places and they have to
 * agree — a headline that says minus two hundred over a row that says nothing
 * is worse than either on its own.
 */
const tone = (cents: number): string => (cents > 0 ? "pos" : cents < 0 ? "neg" : "muted");

/** Whole dollars, for prose where the cents would be noise. */
const fmtish = (cents: number): string =>
  `$${Math.round(cents / 100).toLocaleString()}`;

/**
 * Which accounts hold money set aside.
 *
 * Liabilities and property are not offered: a mortgage is not savings, and a
 * house cannot be allocated a bit at a time.
 */
function GoalAccountsModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  const goals = db.goals.filter((g) => !g.archived);
  const eligible = db.accounts.filter(
    (a) => !a.closedAt && !canValue(a.type) && !["credit", "loan", "mortgage", "other_liability"].includes(a.type),
  );

  return (
    <Modal wide title="Goal accounts" onClose={onClose} footer={<Btn variant="primary" onClick={onClose}>Done</Btn>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="small muted" style={{ maxWidth: 640 }}>
          The accounts whose balances are money set aside. Their total is what goals can be funded from,
          and anything not assigned shows as available. An account with one purpose can be pointed
          straight at a goal, and then it looks after itself.
        </div>
        <div className="card flush" style={{ maxHeight: 420, overflowY: "auto" }}>
          {eligible.map((a) => (
            <div key={a.id} className="list-row" style={{ gap: 10 }}>
              <Toggle on={!!a.goalAccount} onChange={(v) => actions.setGoalAccount(a.id, v)} />
              <InstitutionLogo account={a} size={26} round />
              <div className="grow col" style={{ gap: 1, minWidth: 0 }}>
                <span className="truncate">{a.name}</span>
                <span className="tiny faint"><Money value={a.balance} /></span>
              </div>
              {a.goalAccount ? (
                <select
                  className="select" style={{ width: "auto", maxWidth: 210 }}
                  value={a.autoGoalId ?? ""}
                  onChange={(e) => actions.setAutoGoal(a.id, e.target.value || null)}
                >
                  <option value="">Allocate by hand</option>
                  {goals.map((g) => <option key={g.id} value={g.id}>All of it → {g.name}</option>)}
                </select>
              ) : null}
            </div>
          ))}
          {!eligible.length ? <div style={{ padding: 16 }}><span className="small faint">No cash or investment accounts yet.</span></div> : null}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Handing one account's money out among the goals.
 *
 * One account at a time on purpose: the constraint being obeyed is per
 * account, so the number that must not be exceeded is on screen the whole
 * time, next to the fields that change it.
 */
function AllocateModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const db = useDB();
  const goals = db.goals.filter((g) => !g.archived).sort((a, b) => a.priority - b.priority);
  // Worked out once rather than three times, and recomputed on every render —
  // which is what makes the figure below follow what is typed into the rows.
  const rows = funding(db).accounts;
  const row = rows.find((a) => a.account.id === account.id);

  const [which, setWhich] = useState<string>(account.id);
  const current = rows.find((a) => a.account.id === which);
  const active = current?.account ?? account;
  const spare = current?.available ?? 0;

  if (!row) return null;

  return (
    <Modal
      wide title="Allocate funds" onClose={onClose}
      footer={<Btn variant="primary" onClick={onClose}>Done</Btn>}
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="row wrap" style={{ gap: 10, alignItems: "center" }}>
          <span className="small muted">From</span>
          {/* Just the names, grouped like every other account dropdown. The
              figure that matters is on the line below, where it moves as the
              allocations are typed. */}
          <SelectInput
            style={{ width: "auto", maxWidth: 300 }}
            value={which} onChange={setWhich}
            options={accountOptions(rows.map((r) => r.account))}
          />
        </div>

        {active.autoGoalId ? (
          <div className="setting-row">
            <span className="small">
              Everything in <b>{active.name}</b> already goes to{" "}
              <b>{goals.find((g) => g.id === active.autoGoalId)?.name}</b>. Change that under
              &ldquo;Edit goal accounts&rdquo; if you want to split it by hand instead.
            </span>
          </div>
        ) : (
          <>
            <div className="spread small">
              <span className="muted">Available funds</span>
              <span className={`num bold ${tone(spare)}`}>
                <Money value={spare} />
              </span>
            </div>
            <div className="col" style={{ gap: 0 }}>
              {goals.map((g) => (
                <AllocationRow key={g.id} goal={g} accountId={which} />
              ))}
              {!goals.length ? <span className="small faint">Add a goal first.</span> : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function AllocationRow({ goal, accountId }: { goal: Goal; accountId: string }) {
  const db = useDB();
  const { actions } = useStore();
  const held = claimOn(goal, accountId);
  const ceiling = ceilingFor(db, goal.id, accountId);

  return (
    <div className="list-row" style={{ gap: 10 }}>
      <span style={{ fontSize: 15, width: 22 }}>{goal.emoji}</span>
      <div className="grow col" style={{ gap: 1, minWidth: 0 }}>
        <span className="truncate">{goal.name}</span>
        <span className="tiny faint">up to <Money value={ceiling} /> from this account</span>
      </div>
      <div style={{ width: 130 }}>
        <MoneyInput value={held} onChange={(v) => actions.allocateToGoal(goal.id, accountId, v)} />
      </div>
      <Btn
        size="sm" variant="ghost" disabled={ceiling <= held}
        onClick={() => actions.allocateToGoal(goal.id, accountId, ceiling)}
        title="Give this goal everything that is unassigned here"
      >
        Max
      </Btn>
    </div>
  );
}
