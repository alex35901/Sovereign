import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Target } from "lucide-react";
import type { Goal } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, monthLabel } from "../lib/date";
import { goalProgress } from "../lib/select";
import { goalOutlook, goalSources } from "../lib/goal-funding";
import { fmt0 } from "../lib/money";
import {
  Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, PercentInput, Progress, TextInput,
  Tile, cx,
} from "../components/ui";
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
            // The same projection the goal's own page runs, rather than a
            // second one beside it: dividing what is left by the months to go
            // ignores the growth the goal assumes, which for a retirement pot
            // thirty years out is most of the answer — it read "funded by
            // 2079" for a goal that arrives in the forties.
            const o = goalOutlook(db, g.id);
            return (
              <Card key={g.id}>
                <CardHead
                  title={
                    <Link to={`/goals/${g.id}`} className="row cat-open" style={{ gap: 8 }}>
                      <span style={{ fontSize: 20 }}>{g.emoji}</span> {g.name}
                    </Link>
                  }
                  sub={g.targetDate ? `Target ${monthLabel(g.targetDate.slice(0, 7))}` : "No target date"}
                  right={
                    <span className="row" style={{ gap: 6 }}>
                      <Btn size="sm" onClick={() => setEditing(g)}>Edit</Btn>
                      <Link to={`/goals/${g.id}`}><Btn size="sm" variant="ghost">Open</Btn></Link>
                    </span>
                  }
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
                  {o.needed !== null ? (
                    <div className="col">
                      <span className="tile-label">Needed</span>
                      <span className={cx("num bold", o.status === "behind" || o.status === "stalled" ? "neg" : "pos")}>
                        <Money value={o.needed} cents={false} />/mo
                      </span>
                    </div>
                  ) : null}
                  <div className="col">
                    <span className="tile-label">Funded by</span>
                    <span className="num bold">
                      {o.status === "reached" ? "Now" : o.projected ? monthLabel(o.projected) : "—"}
                    </span>
                  </div>
                  {o.growth > 0 ? (
                    <div className="col">
                      <span className="tile-label">Growth</span>
                      <span className="num bold">{o.growth}%/yr</span>
                    </div>
                  ) : null}
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
                {o.status === "behind" && o.projected ? (
                  <div className="tiny neg" style={{ marginTop: 8 }}>
                    Behind pace — arrives {monthLabel(o.projected)}, past the {dateLabel(g.targetDate!)} target.
                    Raise the monthly amount to {fmt0(o.needed ?? 0)}, or move the date.
                  </div>
                ) : o.status === "stalled" ? (
                  <div className="tiny neg" style={{ marginTop: 8 }}>
                    At this rate it never gets there — the amount going in, or the growth assumed, has to change.
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

export function GoalModal({ goal, onClose }: { goal?: Goal; onClose: () => void }) {
  const { actions } = useStore();
  const [name, setName] = useState(goal?.name ?? "");
  const [emoji, setEmoji] = useState(goal?.emoji ?? "🎯");
  const [targetAmount, setTarget] = useState(goal?.targetAmount ?? 0);
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? "");
  const [monthlyContribution, setMonthly] = useState(goal?.monthlyContribution ?? 0);
  const [startingAmount, setStarting] = useState(goal?.startingAmount ?? 0);
  const [growthRate, setGrowth] = useState(goal?.growthRate ?? 0);
  // Carried through untouched: superseded by allocations, kept so an older
  // document is not quietly rewritten by opening this dialog.
  const accountIds = goal?.accountIds ?? [];

  const save = () => {
    const payload = {
      name: name.trim() || "New goal", emoji, targetAmount, targetDate: targetDate || undefined,
      monthlyContribution, startingAmount, accountIds,
      // Stored only when it says something, so a goal nobody set a rate on
      // stays visibly without one rather than carrying a zero around.
      growthRate: growthRate || undefined,
    };
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
      <Field
        label="Assumed annual growth"
        hint="Zero for money sitting in cash. For anything invested, a projection without it is badly wrong by the time a goal is decades out — and the right number is a judgement about where the money is, so it is yours."
      >
        <PercentInput value={growthRate} onChange={setGrowth} />
      </Field>
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
