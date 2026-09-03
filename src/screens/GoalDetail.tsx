import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, monthLabel, thisMonth } from "../lib/date";
import { fmt0 } from "../lib/money";
import { goalOutlook, goalProjection, goalSources } from "../lib/goal-funding";
import type { GoalStatus } from "../lib/goal-funding";
import { AreaChart } from "../components/charts";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { Btn, Card, CardHead, Empty, Money, Progress, Tile } from "../components/ui";
import { GoalModal } from "./Goals";

/**
 * One goal, and everything behind it.
 *
 * The headline figure on the Goals page is a total; this is where it comes
 * from — which accounts hold it, when it gets there at the rate money is going
 * in, and what has actually moved lately.
 */
export default function GoalDetail() {
  const { id = "" } = useParams();
  const db = useDB();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);

  const goal = db.goals.find((g) => g.id === id);
  const outlook = useMemo(() => goalOutlook(db, id), [db, id]);
  const sources = useMemo(() => goalSources(db, id), [db, id]);
  const projection = useMemo(() => goalProjection(db, id), [db, id]);

  if (!goal) {
    return (
      <>
        <TopBar title="Goal" />
        <div className="page">
          <Empty
            title="No such goal"
            body="It may have been deleted."
            action={<Btn variant="primary" onClick={() => nav("/goals")}>All goals</Btn>}
          />
        </div>
      </>
    );
  }

  const pct = goal.targetAmount ? Math.min(100, (outlook.saved / goal.targetAmount) * 100) : 0;

  return (
    <>
      <TopBar
        title={`${goal.emoji} ${goal.name}`}
        primary={<Btn variant="primary" onClick={() => setEditing(true)}><Pencil size={14} /> <span className="btn-label">Edit</span></Btn>}
      />

      <div className="page stack">
        <Link to="/goals" className="row tiny faint" style={{ gap: 5 }}>
          <ArrowLeft size={13} /> Goals
        </Link>

        <Card>
          <div className="col" style={{ gap: 10 }}>
            <div className="spread wrap" style={{ gap: 12 }}>
              <span className="row wrap" style={{ gap: 8 }}>
                <StatusPill status={outlook.status} />
                <span className="small muted">{whenLine(outlook)}</span>
              </span>
              <span className="row" style={{ gap: 8 }}>
                {sources.slice(0, 6).map((s) => (
                  <InstitutionLogo key={s.account.id} account={s.account} size={22} round />
                ))}
                {sources.length > 6 ? <span className="tiny faint">+{sources.length - 6}</span> : null}
              </span>
            </div>
            <div className="spread wrap" style={{ gap: 12, alignItems: "baseline" }}>
              <span className="tile-value"><Money value={outlook.saved} /></span>
              <span className="small muted">
                {pct.toFixed(0)}% of <Money value={goal.targetAmount} />
              </span>
            </div>
            <Progress value={outlook.saved} max={goal.targetAmount || 1} color="--pos" />
          </div>
        </Card>

        <div className="grid g4">
          <Tile label="Saved" value={<Money value={outlook.saved} cents={false} />} tone="pos" />
          <Tile label="Left to save" value={<Money value={outlook.remaining} cents={false} />} />
          <Tile
            label="Going in"
            value={<span><Money value={outlook.monthly} cents={false} />/mo</span>}
            sub={outlook.monthly ? undefined : <span className="muted">nothing set</span>}
          />
          <Tile
            label="Reached"
            value={outlook.projected ? monthLabel(outlook.projected, true) : "—"}
            sub={outlook.slack !== null
              ? <span className={outlook.slack >= 0 ? "pos" : "neg"}>
                  {Math.abs(outlook.slack)} month{Math.abs(outlook.slack) === 1 ? "" : "s"}{" "}
                  {outlook.slack >= 0 ? "early" : "late"}
                </span>
              : <span className="muted">{outlook.monthly ? "no target date" : "add a monthly amount"}</span>}
          />
        </div>

        <Card>
          <CardHead
            title="Timeline"
            sub={projection.length
              ? "What is saved now, plus the monthly amount — no assumed growth, so a long goal will beat this"
              : "Set a monthly amount or a target date to see where this is heading"}
          />
          {projection.length ? (
            <AreaChart
              points={projection.map((p) => ({
                label: monthLabel(p.month, true),
                value: p.value,
                sub: monthLabel(p.month),
              }))}
              height={220}
              tone="--pos"
              negativeTone="--pos"
              zeroBase
              markLine={goal.targetAmount}
              markLabel={`target ${fmt0(goal.targetAmount, { compact: true })}`}
            />
          ) : (
            <div className="small faint" style={{ padding: "28px 0", textAlign: "center" }}>
              Nothing to project yet.
            </div>
          )}
        </Card>

        <div className="grid g-2-1" style={{ alignItems: "start" }}>
          <Card pad={false}>
            <CardHead flush title="Allocation" sub="The accounts this goal's money is actually sitting in" />
            {sources.length ? (
              sources.map((s) => (
                <Link key={s.account.id} to={`/accounts/${s.account.id}`} className="list-row click" style={{ gap: 10 }}>
                  <InstitutionLogo account={s.account} size={26} round />
                  <div className="grow col" style={{ gap: 1, minWidth: 0 }}>
                    <span className="truncate">{s.account.name}</span>
                    {s.auto ? <span className="tiny faint">all of it, including whatever arrives next</span> : null}
                  </div>
                  <span className="num pos">+<Money value={s.amount} /></span>
                </Link>
              ))
            ) : (
              <div style={{ padding: 16 }}>
                <span className="small faint">
                  Nothing is allocated to this goal yet. Assign some from the card at the top of the Goals page.
                </span>
              </div>
            )}
          </Card>

          <div className="stack">
            <Card>
              <CardHead title="Details" right={<Btn size="sm" onClick={() => setEditing(true)}>Edit</Btn>} />
              <div className="col" style={{ gap: 9 }}>
                <Row label="Status" value={<StatusPill status={outlook.status} />} />
                <Row label="Target amount" value={<Money value={goal.targetAmount} />} />
                <Row
                  label="Target date"
                  value={goal.targetDate ? dateLabel(goal.targetDate, { year: true }) : <span className="muted">none</span>}
                />
                <Row label="Monthly contribution" value={<span><Money value={goal.monthlyContribution} />/mo</span>} />
                {goal.startingAmount ? <Row label="Counted by hand" value={<Money value={goal.startingAmount} />} /> : null}
              </div>
            </Card>

            <Activity goalId={id} />
          </div>
        </div>
      </div>

      {editing ? <GoalModal goal={goal} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="spread">
      <span className="small muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

const STATUS: Record<GoalStatus, { text: string; tone: string }> = {
  reached: { text: "Reached", tone: "pos" },
  ahead: { text: "Ahead", tone: "pos" },
  behind: { text: "Behind", tone: "neg" },
  "on track": { text: "On track", tone: "pos" },
  "no date": { text: "No target date", tone: "muted" },
  "no plan": { text: "Nothing going in", tone: "muted" },
};

function StatusPill({ status }: { status: GoalStatus }) {
  const s = STATUS[status];
  return (
    <span
      className="tag"
      style={{
        background: s.tone === "pos" ? "var(--pos-soft)" : s.tone === "neg" ? "var(--neg-soft)" : "var(--surface-3)",
        color: s.tone === "pos" ? "var(--pos)" : s.tone === "neg" ? "var(--neg)" : "var(--muted)",
      }}
    >
      {s.text}
    </span>
  );
}

/** The sentence beside the pill: when, and how that compares to the plan. */
function whenLine(o: ReturnType<typeof goalOutlook>): string {
  if (o.status === "reached") return "Fully funded";
  if (!o.projected) {
    return o.targetMonth ? `Due ${monthLabel(o.targetMonth)} — nothing going in yet` : "No monthly amount set";
  }
  const when = monthLabel(o.projected);
  if (o.slack === null) return `${when} at the current rate`;
  const n = Math.abs(o.slack);
  if (o.slack === 0) return `${when}, exactly on the target date`;
  return `${when} (${n} month${n === 1 ? "" : "s"} ${o.slack > 0 ? "ahead of" : "past"} the target date)`;
}

/**
 * What has actually moved lately.
 *
 * Balance changes on the accounts backing this goal — the only record there is
 * of the money arriving, since a goal is funded by balances rather than by
 * transactions of its own.
 */
function Activity({ goalId }: { goalId: string }) {
  const db = useDB();
  const rows = useMemo(() => {
    const out: { date: string; accountId: string; name: string; delta: number }[] = [];
    for (const s of goalSources(db, goalId)) {
      const h = s.account.history;
      for (let i = 1; i < h.length; i++) {
        const delta = h[i]!.balance - h[i - 1]!.balance;
        if (!delta) continue;
        out.push({ date: h[i]!.date, accountId: s.account.id, name: s.account.name, delta });
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  }, [db, goalId]);

  return (
    <Card pad={false}>
      <CardHead flush title="Activity" sub="Balance changes on the accounts behind it" />
      {rows.length ? rows.map((r, i) => (
        <div key={`${r.accountId}-${r.date}-${i}`} className="list-row" style={{ gap: 10 }}>
          <div className="grow col" style={{ gap: 1, minWidth: 0 }}>
            <span className="small truncate">{r.name}</span>
            <span className="tiny faint">{dateLabel(r.date, { year: true })}</span>
          </div>
          <span className={`num small ${r.delta > 0 ? "pos" : "neg"}`}>
            {r.delta > 0 ? "+" : ""}{fmt0(r.delta)}
          </span>
        </div>
      )) : (
        <div style={{ padding: 16 }}>
          <span className="small faint">
            No balance history on the accounts behind this goal yet — it appears as they sync.
          </span>
        </div>
      )}
      <div className="tiny faint" style={{ padding: "10px 16px", borderTop: "1px solid var(--line-soft)" }}>
        As of {monthLabel(thisMonth())}.
      </div>
    </Card>
  );
}
