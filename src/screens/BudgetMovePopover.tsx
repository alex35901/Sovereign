import { useMemo, useState } from "react";
import { ArrowDown, RotateCcw } from "lucide-react";
import type { Category, MonthKey } from "../types";
import { useDB, useStore } from "../store";
import { fmt0 } from "../lib/money";
import { moveBudget, moveCandidates, suggestCounterpart, suggestedAmount } from "../lib/budget-move";
import { plannedFor, remainingTone } from "../lib/select";
import type { MoveCandidate } from "../lib/budget-move";
import { Money, MoneyInput, Popover, cx } from "../components/ui";
import { CategoryPicker } from "../components/pickers";

/**
 * Clicking what's left in a category opens a transfer from it, or into it.
 * A surplus is offered to the deepest overspend; an overspend is filled from
 * the largest surplus.
 */
export function BudgetMovePopover({ category, month, remaining, onOpenChange }: {
  category: Category;
  month: MonthKey;
  remaining: number;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover
      width={340}
      align="right"
      className="move-menu"
      fill
      onOpenChange={onOpenChange}
      trigger={(open) => (
        <button
          className={cx("btn budget-amount remaining", remainingTone(remaining))}
          onClick={open}
          title="Move money between categories"
        >
          {category.rollover ? <RotateCcw size={11} className="rollover-mark" /> : null}
          <Money value={remaining} cents={false} />
        </button>
      )}
    >
      {(close) => <Panel category={category} month={month} onDone={close} />}
    </Popover>
  );
}

/** How much is left, in the colour that says whether that is good news. */
const leftTone = (remaining: number): string => (remaining > 0 ? "pos" : remaining < 0 ? "neg" : "faint");

function Left({ remaining }: { remaining: number }) {
  return <span className={cx("tiny num nowrap", leftTone(remaining))}>{fmt0(remaining)} left</span>;
}

function Row({ label, candidate, candidates, onPick }: {
  label: string;
  candidate: MoveCandidate | undefined;
  candidates: MoveCandidate[];
  onPick: (id: string) => void;
}) {
  // Keyed so the list can put each category's figure beside its name. Choosing
  // where to take money from is guesswork without them — which is the whole
  // question this panel exists to answer.
  const by = useMemo(() => new Map(candidates.map((c) => [c.categoryId, c])), [candidates]);

  return (
    <div className="move-row">
      <span className="tiny faint" style={{ width: 34 }}>{label}</span>
      <CategoryPicker
        value={candidate?.categoryId ?? ""}
        onChange={onPick}
        // Only the categories this month's plan actually covers: income and
        // transfers have nothing to move, and offering them was a dead end.
        only={(c) => by.has(c.id)}
        note={(c) => <Left remaining={by.get(c.id)!.remaining} />}
        trigger={(cat, open) => (
          <button className="btn btn-sm move-pick" onClick={open}>
            <span>{cat?.icon ?? "❓"}</span>
            <span className="truncate">{cat?.name ?? "Choose a category"}</span>
          </button>
        )}
      />
      {candidate ? <Left remaining={candidate.remaining} /> : <span className="tiny num nowrap muted">—</span>}
    </div>
  );
}

function Panel({ category, month, onDone }: { category: Category; month: MonthKey; onDone: () => void }) {
  const db = useDB();
  const { actions, notify } = useStore();

  const candidates = useMemo(() => moveCandidates(db, month), [db, month]);
  const selected = candidates.find((c) => c.categoryId === category.id);
  const startsAsSource = (selected?.remaining ?? 0) >= 0;

  const [fromId, setFromId] = useState(() =>
    startsAsSource ? category.id : suggestCounterpart(candidates, category.id, "from")?.categoryId ?? "");
  const [toId, setToId] = useState(() =>
    startsAsSource ? suggestCounterpart(candidates, category.id, "to")?.categoryId ?? "" : category.id);

  const from = candidates.find((c) => c.categoryId === fromId);
  const to = candidates.find((c) => c.categoryId === toId);
  const [amount, setAmount] = useState(() => suggestedAmount(from, to));

  const preview = useMemo(
    () => (fromId && toId ? moveBudget(db, month, fromId, toId, amount) : { moved: 0 }),
    [db, month, fromId, toId, amount],
  );
  const capped = preview.moved > 0 && preview.moved < amount;
  const plannedAfter = fromId ? plannedFor(db, month, fromId) - preview.moved : 0;
  const valid = Boolean(fromId && toId && fromId !== toId && preview.moved > 0);

  const apply = () => {
    actions.moveBudget(month, fromId, toId, amount);
    notify(`Moved ${fmt0(preview.moved)} from ${from?.name} to ${to?.name}.`);
    onDone();
  };

  return (
    <div className="move-panel">
      <div className="spread" style={{ marginBottom: 10 }}>
        <span className="bold">Move money</span>
        <span className="tiny faint">this month only</span>
      </div>

      <MoneyInput value={amount} onChange={setAmount} autoFocus />

      <div className="move-rows">
        <Row label="From" candidate={from} candidates={candidates} onPick={setFromId} />
        <div className="move-arrow"><ArrowDown size={13} /></div>
        <Row label="To" candidate={to} candidates={candidates} onPick={setToId} />
      </div>

      {valid ? (
        <div className="tiny muted" style={{ marginTop: 10 }}>
          {from?.name} ends on <b>{fmt0((from?.remaining ?? 0) - preview.moved)}</b>,{" "}
          {to?.name} on <b>{fmt0((to?.remaining ?? 0) + preview.moved)}</b>.
          {capped
            ? ` Capped at ${fmt0(preview.moved)} — that's all ${from?.name} has ${from?.rollover ? "left" : "budgeted"}.`
            : ""}
          {/* The one part of this that surprises people: giving away money that
              carried in drives the month's own plan below zero, which is
              exactly right and looks like a mistake unless it is said. */}
          {plannedAfter < 0 ? (
            <> Its plan for the month lands on <b>{fmt0(plannedAfter)}</b> — {fmt0(-plannedAfter)} of what
              it is giving away carried in rather than being budgeted this month.</>
          ) : null}
        </div>
      ) : (
        <div className="tiny faint" style={{ marginTop: 10 }}>
          {fromId && fromId === toId
            ? "Pick two different categories."
            : !fromId || !toId
              ? "Pick a category on both sides."
              : "That category has nothing budgeted to move."}
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button className="btn btn-sm btn-ghost" onClick={onDone}>Cancel</button>
        <button className="btn btn-sm btn-primary" onClick={apply} disabled={!valid}>Apply</button>
      </div>
    </div>
  );
}
