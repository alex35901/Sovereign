import { useMemo, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { Category, MonthKey } from "../types";
import { useDB, useStore } from "../store";
import { fmt0 } from "../lib/money";
import { moveBudget, moveCandidates, suggestCounterpart, suggestedAmount } from "../lib/budget-move";
import { remainingTone } from "../lib/select";
import type { MoveCandidate } from "../lib/budget-move";
import { Money, MoneyInput, Popover, cx } from "../components/ui";
import { CategoryPicker } from "../components/pickers";

/**
 * Clicking what's left in a category opens a transfer from it, or into it.
 * A surplus is offered to the deepest overspend; an overspend is filled from
 * the largest surplus.
 */
export function BudgetMovePopover({ category, month, remaining }: {
  category: Category;
  month: MonthKey;
  remaining: number;
}) {
  return (
    <Popover
      width={340}
      align="right"
      className="move-menu"
      fill
      trigger={(open) => (
        <button
          className={cx("btn budget-amount remaining", remainingTone(remaining))}
          onClick={open}
          title="Move money between categories"
        >
          <Money value={remaining} cents={false} />
        </button>
      )}
    >
      {(close) => <Panel category={category} month={month} onDone={close} />}
    </Popover>
  );
}

function Row({ label, candidate, onPick }: {
  label: string;
  candidate: MoveCandidate | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <div className="move-row">
      <span className="tiny faint" style={{ width: 34 }}>{label}</span>
      <CategoryPicker
        value={candidate?.categoryId ?? ""}
        onChange={onPick}
        trigger={(cat, open) => (
          <button className="btn btn-sm move-pick" onClick={open}>
            <span>{cat?.icon ?? "❓"}</span>
            <span className="truncate">{cat?.name ?? "Choose a category"}</span>
          </button>
        )}
      />
      <span className={cx("tiny num nowrap", candidate && candidate.remaining < 0 ? "neg" : "muted")}>
        {candidate ? `${fmt0(candidate.remaining)} left` : "—"}
      </span>
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
        <Row label="From" candidate={from} onPick={setFromId} />
        <div className="move-arrow"><ArrowDown size={13} /></div>
        <Row label="To" candidate={to} onPick={setToId} />
      </div>

      {valid ? (
        <div className="tiny muted" style={{ marginTop: 10 }}>
          {from?.name} ends on <b>{fmt0((from?.remaining ?? 0) - preview.moved)}</b>,{" "}
          {to?.name} on <b>{fmt0((to?.remaining ?? 0) + preview.moved)}</b>.
          {capped ? ` Capped at ${fmt0(preview.moved)} — that's all ${from?.name} has budgeted.` : ""}
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
