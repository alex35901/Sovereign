import { useState } from "react";
import { Plus, Target } from "lucide-react";
import type { Goal } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { addMonths, dateLabel, monthLabel, thisMonth } from "../lib/date";
import { goalProgress } from "../lib/select";
import { goalSources } from "../lib/goal-funding";
import { fmt0 } from "../lib/money";
import { Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, Progress, TextInput, Tile, cx } from "../components/ui";
import { EmojiPicker } from "../components/EmojiPicker";
import { GoalFunding } from "./GoalFunding";

export default function Goals() {
  const db = useDB();
  const [editing, setEditing] = useState<Goal | null>(null);
  const [adding, setAdding] = useState(false);
  const goals = db.goals.filter((g) => !g.archived).sort((a, b) => a.priority - b.priority);

  const totalTarget = goals.reduce((s, g) => s + g.targetAmount, 0);
  const totalSaved = goals.reduce((s, g) => s + goalProgress(db, g.id).saved, 0);
  const monthly = goals.reduce((s, g) => s + g.monthlyContribution, 0);

  return (
    <>
      <TopBar
        title="Goals"
        primary={<Btn variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> <span className="btn-label">Goal</span></Btn>}
      />
      <div className="page stack">
        <div className="grid g3">
          <Tile label="Saved toward goals" value={<Money value={totalSaved} cents={false} />}
            sub={<span className="muted">of <Money value={totalTarget} cents={false} /> targeted</span>} />
          <Tile label="Monthly contributions" value={<Money value={monthly} cents={false} />} />
          <Tile label="Active goals" value={String(goals.length)} />
        </div>

        <GoalFunding />

        <div className="grid g2">
          {goals.map((g) => {
            const p = goalProgress(db, g.id);
            const needed = p.monthsLeft && p.monthsLeft > 0 ? Math.max(0, Math.round((g.targetAmount - p.saved) / p.monthsLeft)) : 0;
            return (
              <Card key={g.id}>
                <CardHead
                  title={<span className="row" style={{ gap: 8 }}><span style={{ fontSize: 20 }}>{g.emoji}</span> {g.name}</span>}
                  sub={g.targetDate ? `Target ${monthLabel(g.targetDate.slice(0, 7))}` : "No target date"}
                  right={<Btn size="sm" onClick={() => setEditing(g)}>Edit</Btn>}
                />
                <div className="spread" style={{ marginBottom: 6 }}>
                  <span className="num bold" style={{ fontSize: 20 }}><Money value={p.saved} cents={false} /></span>
                  <span className="small muted">of <Money value={g.targetAmount} cents={false} /></span>
                </div>
                <Progress value={p.saved} max={g.targetAmount} color="--c3" />
                <div className="spread small muted" style={{ marginTop: 8 }}>
                  <span>{p.pct.toFixed(0)}% funded</span>
                  <span>
                    <Money value={Math.max(0, g.targetAmount - p.saved)} cents={false} /> to go
                  </span>
                </div>
                <div className="divider" />
                <div className="row wrap" style={{ gap: 22 }}>
                  <div className="col">
                    <span className="tile-label">Contributing</span>
                    <span className="num bold"><Money value={g.monthlyContribution} cents={false} />/mo</span>
                  </div>
                  {p.monthsLeft !== null ? (
                    <div className="col">
                      <span className="tile-label">Needed</span>
                      <span className={cx("num bold", p.onTrack ? "pos" : "neg")}>
                        <Money value={needed} cents={false} />/mo
                      </span>
                    </div>
                  ) : null}
                  <div className="col">
                    <span className="tile-label">Funded by</span>
                    <span className="num bold">
                      {g.monthlyContribution > 0
                        ? monthLabel(addMonths(thisMonth(), Math.ceil(Math.max(0, g.targetAmount - p.saved) / g.monthlyContribution)))
                        : "—"}
                    </span>
                  </div>
                </div>
                {(() => {
                  // Where the money actually is, rather than which accounts the
                  // goal happens to name — a shared savings backs three goals
                  // and each of them holds only its own share of it.
                  const from = goalSources(db, g.id);
                  if (!from.length) return null;
                  return (
                    <div className="tiny faint" style={{ marginTop: 10 }}>
                      {from.map((x) => `${x.account.name} ${fmt0(x.amount)}${x.auto ? " (all of it)" : ""}`).join(" · ")}
                    </div>
                  );
                })()}
                {p.monthsLeft !== null && !p.onTrack ? (
                  <div className="tiny neg" style={{ marginTop: 8 }}>
                    Behind pace — raise the monthly amount or push the target date past {dateLabel(g.targetDate!)}.
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>

        {!goals.length ? (
          <Card>
            <Empty
              title="No goals yet"
              body="Set a target, link the account holding the money, and Sovereign tracks whether your monthly contribution gets you there in time."
              action={<Btn variant="primary" onClick={() => setAdding(true)}><Target size={14} /> Create a goal</Btn>}
            />
          </Card>
        ) : null}
      </div>
      {adding || editing ? <GoalModal goal={editing ?? undefined} onClose={() => { setAdding(false); setEditing(null); }} /> : null}
    </>
  );
}

function GoalModal({ goal, onClose }: { goal?: Goal; onClose: () => void }) {
  const { actions } = useStore();
  const [name, setName] = useState(goal?.name ?? "");
  const [emoji, setEmoji] = useState(goal?.emoji ?? "🎯");
  const [targetAmount, setTarget] = useState(goal?.targetAmount ?? 0);
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? "");
  const [monthlyContribution, setMonthly] = useState(goal?.monthlyContribution ?? 0);
  const [startingAmount, setStarting] = useState(goal?.startingAmount ?? 0);
  // Carried through untouched: superseded by allocations, kept so an older
  // document is not quietly rewritten by opening this dialog.
  const accountIds = goal?.accountIds ?? [];

  const save = () => {
    const payload = { name: name.trim() || "New goal", emoji, targetAmount, targetDate: targetDate || undefined, monthlyContribution, startingAmount, accountIds };
    if (goal) actions.updateGoal(goal.id, payload);
    else actions.addGoal(payload);
    onClose();
  };

  return (
    <Modal
      title={goal ? "Edit goal" : "New goal"}
      onClose={onClose}
      footer={
        <>
          {goal ? <Btn variant="danger" onClick={() => { actions.deleteGoal(goal.id); onClose(); }}>Delete</Btn> : null}
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>{goal ? "Save" : "Create goal"}</Btn>
        </>
      }
    >
      <div className="row" style={{ gap: 12 }}>
        <div style={{ width: 120 }}>
          <Field label="Icon"><EmojiPicker value={emoji} onChange={setEmoji} /></Field>
        </div>
        <Field label="Name"><TextInput value={name} onChange={setName} placeholder="Emergency fund" autoFocus /></Field>
      </div>
      <div className="row" style={{ gap: 12 }}>
        <Field label="Target amount"><MoneyInput value={targetAmount} onChange={setTarget} /></Field>
        <Field label="Target date (optional)">
          <input className="input" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </Field>
      </div>
      <div className="row" style={{ gap: 12 }}>
        <Field label="Monthly contribution"><MoneyInput value={monthlyContribution} onChange={setMonthly} /></Field>
        <Field label="Already saved" hint="Used when no account is linked">
          <MoneyInput value={startingAmount} onChange={setStarting} />
        </Field>
      </div>
      <div className="setting-row">
        <span className="small">
          <b>Money is assigned to a goal, not tracked by it.</b> Nominate the accounts that hold money set
          aside under &ldquo;Edit goal accounts&rdquo; on this page, then allocate from them — one account can
          back several goals, and each holds only its own share.
        </span>
      </div>
    </Modal>
  );
}
