import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Account, ID } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { addMonths, monthLabel, thisMonth } from "../lib/date";
import { fmt0 } from "../lib/money";
import { ACCOUNT_TYPE_LABEL } from "../lib/select";
import { AreaChart } from "../components/charts";
import {
  Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, PercentInput,
  SelectInput, TextInput, Toggle, cx,
} from "../components/ui";
import type { Assumptions, EventKind, ForecastEvent, Scenario, TaxTreatment } from "../lib/forecast";
import {
  DEBT_DEFAULTS, activeScenario, blankPlan, defaultTreatment, earliestRetirement,
  levelPayment, measuredFlows, monthAtAge, runBand, startingPosition, withDebtDefaults,
} from "../lib/forecast";

/**
 * What the money does between now and the end.
 *
 * Every other screen in this app reports. This one projects, and the whole
 * design follows from how differently those two things should be read:
 *
 *   - The answer is drawn as a band, not a line. Thirty years of markets at a
 *     number somebody typed into a box is not a figure worth four decimal
 *     places, and a single line invites exactly that reading.
 *   - Every assumption behind it is on the page, editable, in plain words.
 *     None of them is a constant buried in a file.
 *   - Scenarios sit side by side, because the useful question is never "what
 *     will happen" but "what changes if I do this instead".
 */

/** How many points the chart draws, whatever the length of the walk. */
const CHART_POINTS = 90;

const KINDS: { value: EventKind; label: string }[] = [
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
  { value: "oneOff", label: "One-off" },
  { value: "home", label: "Home purchase" },
];

const TREATMENTS: { value: TaxTreatment; label: string }[] = [
  { value: "taxable", label: "Taxable" },
  { value: "traditional", label: "Pre-tax" },
  { value: "roth", label: "Roth" },
];

const LIABILITY_TYPES = new Set(["credit", "loan", "mortgage", "other_liability"]);
const INVESTED_TYPES = new Set(["investment", "retirement", "crypto"]);

export default function Forecast() {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState<ForecastEvent | "new" | null>(null);

  // Never written on load. A document that has not touched this screen has no
  // plan in it, and the one shown here is what the first edit would save.
  const plan = useMemo(() => db.forecast ?? blankPlan(db), [db]);
  const scenario = activeScenario(plan);
  const a = useMemo(
    () => (scenario ? withDebtDefaults(scenario.assumptions, db) : null),
    [scenario, db],
  );

  const flows = useMemo(() => measuredFlows(db), [db]);
  const position = useMemo(
    () => startingPosition(db, flows.income, flows.spend),
    [db, flows],
  );

  const events = scenario?.events ?? [];
  const band = useMemo(
    () => (a ? runBand(position, a, events) : null),
    [position, a, events],
  );
  const earliest = useMemo(
    () => (a ? earliestRetirement(position, a, events) : null),
    [position, a, events],
  );

  if (!scenario || !a || !band) return null;

  const mid = band.mid.points;
  // One in every nth month. A thirty-year walk is 660 readings and the chart
  // is 700 pixels wide, so drawing them all is three lines per pixel.
  const step = Math.max(1, Math.ceil(mid.length / CHART_POINTS));
  const idx = mid.map((_, i) => i).filter((i) => i % step === 0 || i === mid.length - 1);
  const points = idx.map((i) => ({
    label: mid[i].month.slice(0, 4),
    value: mid[i].net,
    sub: `${monthLabel(mid[i].month)} · age ${Math.floor(mid[i].age)}`,
  }));
  const shade = {
    low: idx.map((i) => band.low.points[i].net),
    high: idx.map((i) => band.high.points[i].net),
  };

  /** Where a month falls among the points actually drawn. */
  const markAt = (month: string): number =>
    idx.findIndex((i) => mid[i].month >= month);

  const retireMonth = monthAtAge(a.birthYear, a.retireAge);
  const marks = [
    { index: markAt(retireMonth), label: `Retire at ${a.retireAge}`, tone: "--accent" },
    ...events.map((e) => ({ index: markAt(e.at), label: e.name, tone: "--muted" })),
  ].filter((m) => m.index > 0);

  const ran = band.mid.ranOutAt;
  const money = a.realDollars ? "in today's money" : "in the money of the day";

  return (
    <>
      <TopBar
        title="Forecast"
        primary={
          <Btn variant="primary" onClick={() => setEditing("new")}>
            <Plus size={15} /> <span className="btn-label">Life event</span>
          </Btn>
        }
      />
      <div className="page stack">
        <Scenarios plan={plan} />

        <Card pad={false} className="nw-card">
          <div className="fc-head">
            <span className="small muted">Net worth at {a.retireAge}</span>
            <span className="nw-total num"><Money value={band.mid.atRetirement} cents={false} /></span>
            <span className="small faint">
              {money}, somewhere between <Money value={band.low.atRetirement} cents={false} compact /> and{" "}
              <Money value={band.high.atRetirement} cents={false} compact /> depending on the market
            </span>
          </div>
          <div style={{ padding: "0 8px 8px" }}>
            <AreaChart points={points} band={shade} marks={marks} height={260} zeroBase />
          </div>
        </Card>

        <div className="grid g3">
          <Card>
            <div className="col" style={{ gap: 6 }}>
              <span className="tile-label">Money lasts to</span>
              <span className={cx("tile-value", "num", ran !== null && "neg")}>
                {ran === null ? `${a.endAge}+` : `Age ${Math.floor(ran)}`}
              </span>
              <span className="small muted">
                {ran === null
                  ? `Still has ${fmt0(band.mid.atEnd)} left at ${a.endAge}`
                  : `Savings run out before the plan ends at ${a.endAge}`}
              </span>
            </div>
          </Card>
          <Card>
            <div className="col" style={{ gap: 6 }}>
              <span className="tile-label">Could retire at</span>
              <span className={cx("tile-value", "num", earliest === null && "neg")}>
                {earliest === null ? "Not yet" : earliest}
              </span>
              <span className="small muted">
                {earliest === null
                  ? "At this rate the money does not last however long you work"
                  : `The earliest age the money still lasts to ${a.endAge}`}
              </span>
            </div>
          </Card>
          <Card>
            <div className="col" style={{ gap: 6 }}>
              <span className="tile-label">Measured each month</span>
              <span className="tile-value num">
                <Money value={flows.income - flows.spend} cents={false} sign />
              </span>
              <span className="small muted">
                <Money value={flows.income} cents={false} /> in, <Money value={flows.spend} cents={false} /> out,
                averaged over the last year of transactions
              </span>
            </div>
          </Card>
        </div>

        <Card pad={false}>
          <CardHead
            flush title="Life events"
            sub="Things the walk cannot read off your transactions"
            right={<Btn size="sm" onClick={() => setEditing("new")}><Plus size={14} /> Add</Btn>}
          />
          {events.length ? (
            events.map((e) => (
              <div key={e.id} className="list-row click" onClick={() => setEditing(e)}>
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="bold">{e.name}</span>
                  <span className="tiny faint">{eventLine(e)}</span>
                </span>
                {e.kind === "home" && e.home
                  ? <Money value={-e.home.price} cents={false} className="bold" />
                  : <Money value={e.kind === "expense" ? -Math.abs(e.amount) : e.amount} cents={false} sign className="bold" />}
              </div>
            ))
          ) : (
            <div style={{ padding: 16 }}>
              <Empty
                title="No life events"
                body="A pension starting, a child leaving home, a house. Anything with a date on it that the last year of spending cannot predict."
                action={<Btn variant="primary" onClick={() => setEditing("new")}>Add one</Btn>}
              />
            </div>
          )}
        </Card>

        <AssumptionsCard a={a} onChange={actions.setAssumptions} />
        <AccountsCard a={a} />
      </div>

      {editing ? (
        <EventModal
          event={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

/** What an event does, in one line, in the words somebody would use. */
function eventLine(e: ForecastEvent): string {
  const when = monthLabel(e.at);
  if (e.kind === "oneOff") return `One-off, ${when}`;
  if (e.kind === "home") {
    const h = e.home;
    return h
      ? `Bought ${when} with ${fmt0(h.downPayment)} down, ${h.apr}% over ${Math.round(h.termMonths / 12)} years`
      : `Bought ${when}`;
  }
  const until = e.untilAge !== undefined ? `until ${e.untilAge}` : "for the rest of the plan";
  return `A month, from ${when} ${until}`;
}

/* ── scenarios ────────────────────────────────────────────────────────── */

/**
 * The saved plans, side by side.
 *
 * A pill rather than a dropdown: the point of having more than one is to flick
 * between them and watch the chart move, and a menu that closes on every
 * choice makes that three clicks instead of one.
 */
function Scenarios({ plan }: { plan: { scenarios: Scenario[]; activeId: ID } }) {
  const { actions } = useStore();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const active = activeScenario(plan);

  return (
    <div className="row wrap fc-scenarios">
      {plan.scenarios.map((s) => (
        <button
          key={s.id}
          className={cx("scope-pill", s.id === plan.activeId && "on")}
          aria-selected={s.id === plan.activeId}
          onClick={() => actions.selectScenario(s.id)}
        >
          {s.name}
        </button>
      ))}
      <Btn size="sm" variant="ghost" onClick={() => { setName(`${active?.name ?? "Plan"} copy`); setNaming(true); }}>
        <Plus size={14} /> Scenario
      </Btn>
      {plan.scenarios.length > 1 && active ? (
        <Btn size="sm" variant="ghost" title={`Delete ${active.name}`} onClick={() => actions.deleteScenario(active.id)}>
          <Trash2 size={14} />
        </Btn>
      ) : null}

      {naming ? (
        <Modal
          title="New scenario"
          onClose={() => setNaming(false)}
          footer={
            <>
              <Btn onClick={() => setNaming(false)}>Cancel</Btn>
              <Btn variant="primary" onClick={() => { actions.addScenario(name); setNaming(false); }}>Create</Btn>
            </>
          }
        >
          <Field label="Name" hint="It starts as a copy of the scenario showing, so you only change what you are asking about.">
            <TextInput value={name} onChange={setName} autoFocus />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}

/* ── the numbers behind the picture ───────────────────────────────────── */

/**
 * A whole number, typed.
 *
 * Buffered like MoneyInput and for the same reason: clearing the field to
 * retype it leaves it empty for a keystroke, and a field that snaps to zero
 * the moment it is empty cannot be retyped at all.
 */
function NumInput({ value, onChange, min, max }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number;
}) {
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <input
      className="input num" inputMode="numeric"
      value={buf ?? String(value)}
      onChange={(e) => {
        setBuf(e.target.value);
        const n = Number.parseInt(e.target.value, 10);
        if (!Number.isFinite(n)) return;
        onChange(Math.min(max ?? n, Math.max(min ?? n, n)));
      }}
      onFocus={(e) => { setBuf(e.target.value); e.currentTarget.select(); }}
      onBlur={() => setBuf(null)}
    />
  );
}

function AssumptionsCard({ a, onChange }: {
  a: Assumptions; onChange: (patch: Partial<Assumptions>) => void;
}) {
  const age = new Date().getFullYear() - a.birthYear;
  return (
    <Card pad={false}>
      <CardHead
        flush title="Assumptions"
        sub="Every one of them is a guess. They are here so you can see whose guess, and change it."
      />
      <div className="fc-grid">
        <Field label="Born" hint={`Which makes you about ${age}`}>
          <NumInput value={a.birthYear} onChange={(birthYear) => onChange({ birthYear })} min={1900} max={new Date().getFullYear()} />
        </Field>
        <Field label="Retire at" hint="The age the pay stops">
          <NumInput value={a.retireAge} onChange={(retireAge) => onChange({ retireAge })} min={age} max={110} />
        </Field>
        <Field label="Plan through" hint="A horizon, not a prediction">
          <NumInput value={a.endAge} onChange={(endAge) => onChange({ endAge })} min={a.retireAge + 1} max={120} />
        </Field>
        <Field label="Investment return" hint="A year, before inflation">
          <PercentInput value={a.returnPct} onChange={(returnPct) => onChange({ returnPct })} />
        </Field>
        <Field label="Give or take" hint="How wide the shaded band is drawn">
          <PercentInput value={a.returnSpreadPct} onChange={(returnSpreadPct) => onChange({ returnSpreadPct })} />
        </Field>
        <Field label="Inflation" hint="What prices do while you wait">
          <PercentInput value={a.inflationPct} onChange={(inflationPct) => onChange({ inflationPct })} />
        </Field>
        <Field label="Pay rises" hint="Level with inflation means flat in real terms">
          <PercentInput value={a.wageGrowthPct} onChange={(wageGrowthPct) => onChange({ wageGrowthPct })} />
        </Field>
        <Field label="Retirement spending" hint="Of what you spend now">
          <PercentInput value={a.retirementSpendPct} onChange={(retirementSpendPct) => onChange({ retirementSpendPct })} />
        </Field>
        <Field label="Tax on withdrawals" hint="The effective rate on pre-tax money">
          <PercentInput value={a.taxRatePct} onChange={(taxRatePct) => onChange({ taxRatePct })} />
        </Field>
        <Field label="Saved from gross pay" hint="A 401(k) contribution your transactions never see">
          <MoneyInput
            value={a.monthlyRetirementContribution}
            onChange={(monthlyRetirementContribution) => onChange({ monthlyRetirementContribution })}
          />
        </Field>
      </div>
      <div className="fc-foot">
        <Toggle
          on={a.realDollars}
          onChange={(realDollars) => onChange({ realDollars })}
          label={<span className="small">Show today's money</span>}
        />
        <span className="tiny faint">
          {a.realDollars
            ? "Every figure is deflated back to what it would buy now, so it is comparable with the balance on your dashboard."
            : "Figures are in the money of the year they fall in, which is a larger number for the same groceries."}
        </span>
      </div>
    </Card>
  );
}

/**
 * Where each account's money sits for tax, and what each debt costs.
 *
 * Neither is anywhere else in the document: a brokerage and a Roth IRA are the
 * same kind of account to everything else this app does, and the difference
 * only starts to matter the moment somebody draws on them.
 */
function AccountsCard({ a }: { a: Assumptions }) {
  const db = useDB();
  const { actions } = useStore();
  const invested = db.accounts.filter(
    (x) => !x.hidden && !x.closedAt && x.includeInNetWorth && INVESTED_TYPES.has(x.type),
  );
  const owed = db.accounts.filter(
    (x) => !x.hidden && !x.closedAt && x.includeInNetWorth && LIABILITY_TYPES.has(x.type),
  );
  if (!invested.length && !owed.length) return null;

  const guess = (acc: Account): TaxTreatment =>
    acc.taxTreatment ?? defaultTreatment(acc.type, acc.name) ?? "taxable";

  return (
    <Card pad={false}>
      <CardHead
        flush title="Accounts"
        sub="How each pot is taxed on the way out, and what each debt costs"
      />
      {invested.map((acc) => (
        <div key={acc.id} className="row fc-acc">
          <span className="col grow" style={{ gap: 0 }}>
            <span className="bold">{acc.name}</span>
            <span className="tiny faint">{ACCOUNT_TYPE_LABEL[acc.type]} · {fmt0(acc.balance)}</span>
          </span>
          <SelectInput
            value={guess(acc)}
            options={TREATMENTS}
            onChange={(taxTreatment) => actions.updateAccount(acc.id, { taxTreatment })}
          />
        </div>
      ))}
      {owed.map((acc) => {
        const terms = a.debts[acc.id] ?? DEBT_DEFAULTS[acc.type] ?? DEBT_DEFAULTS.other_liability;
        return (
          <div key={acc.id} className="row fc-acc">
            <span className="col grow" style={{ gap: 0 }}>
              <span className="bold">{acc.name}</span>
              {/* The payment the terms imply, said out loud. It is not typed in
                  anywhere, it is worked out from the balance, the rate and the
                  years, and it is what the walk takes out of spending the month
                  the debt clears - so a reader changing either number should be
                  able to see what they just changed. */}
              <span className="tiny faint">
                {ACCOUNT_TYPE_LABEL[acc.type]} · {fmt0(acc.balance)} ·{" "}
                <span className="fc-pay">{fmt0(levelPayment(acc.balance, terms.apr, terms.termMonths))} a month</span>
              </span>
            </span>
            {/* Read as a sentence: "at 6.5% for 25 years". Two bare boxes at
                the end of a row say nothing about which is which. */}
            <span className="tiny faint">at</span>
            <span className="fc-terms">
              <PercentInput
                value={terms.apr}
                onChange={(apr) => actions.setDebtTerms(acc.id, { ...terms, apr })}
              />
            </span>
            <span className="tiny faint">for</span>
            <span className="fc-terms">
              <NumInput
                value={Math.round(terms.termMonths / 12)}
                min={1} max={50}
                onChange={(years) => actions.setDebtTerms(acc.id, { ...terms, termMonths: years * 12 })}
              />
            </span>
            <span className="tiny faint">years</span>
          </div>
        );
      })}
    </Card>
  );
}

/* ── adding something with a date on it ───────────────────────────────── */

const BLANK_HOME = { price: 500_000_00, downPayment: 100_000_00, apr: 6.5, termMonths: 360, monthlyCosts: 600_00 };

function EventModal({ event, onClose }: { event?: ForecastEvent; onClose: () => void }) {
  const { actions } = useStore();
  const [kind, setKind] = useState<EventKind>(event?.kind ?? "income");
  const [name, setName] = useState(event?.name ?? "");
  const [at, setAt] = useState(event?.at ?? addMonths(thisMonth(), 12));
  const [amount, setAmount] = useState(event?.amount ?? 0);
  const [untilAge, setUntilAge] = useState<number | null>(event?.untilAge ?? null);
  const [home, setHome] = useState(event?.home ?? BLANK_HOME);

  const save = () => {
    const next = {
      kind, name: name.trim() || KINDS.find((k) => k.value === kind)!.label, at,
      // An expense is a cost whichever way it was typed, and a one-off keeps
      // its sign because an inheritance and a wedding are the same event.
      amount: kind === "expense" ? Math.abs(amount) : amount,
      untilAge: kind === "income" || kind === "expense" ? untilAge ?? undefined : undefined,
      home: kind === "home" ? home : undefined,
    };
    if (event) actions.updateForecastEvent(event.id, next);
    else actions.addForecastEvent(next);
    onClose();
  };

  return (
    <Modal
      title={event ? "Edit life event" : "Add a life event"}
      onClose={onClose}
      footer={
        <>
          {event ? (
            <Btn variant="danger" onClick={() => { actions.deleteForecastEvent(event.id); onClose(); }}>Delete</Btn>
          ) : null}
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>{event ? "Save" : "Add"}</Btn>
        </>
      }
    >
      <Field label="What is it">
        <SelectInput value={kind} options={KINDS} onChange={(v) => setKind(v as EventKind)} />
      </Field>
      <Field label="Name">
        <TextInput value={name} onChange={setName} placeholder="Pension starts" autoFocus />
      </Field>
      <Field label={kind === "home" ? "Bought" : "Starts"}>
        <TextInput type="month" value={at} onChange={(v) => setAt(v || at)} />
      </Field>

      {kind === "home" ? (
        <>
          <Field label="Price"><MoneyInput value={home.price} onChange={(price) => setHome({ ...home, price })} /></Field>
          <Field label="Down payment" hint="Taken out of cash the month it happens">
            <MoneyInput value={home.downPayment} onChange={(downPayment) => setHome({ ...home, downPayment })} />
          </Field>
          <Field label="Mortgage rate">
            <PercentInput value={home.apr} onChange={(apr) => setHome({ ...home, apr })} />
          </Field>
          <Field label="Over how many years">
            <NumInput
              value={Math.round(home.termMonths / 12)} min={1} max={50}
              onChange={(years) => setHome({ ...home, termMonths: years * 12 })}
            />
          </Field>
          <Field label="Running costs a month" hint="Tax, insurance, upkeep. The mortgage payment is worked out for you.">
            <MoneyInput value={home.monthlyCosts} onChange={(monthlyCosts) => setHome({ ...home, monthlyCosts })} />
          </Field>
        </>
      ) : (
        <Field
          label={kind === "oneOff" ? "Amount" : "Amount a month"}
          hint={kind === "oneOff"
            ? "Negative for something you pay out, like a wedding"
            : "In today's money. It keeps pace with inflation on its own."}
        >
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
      )}

      {kind === "income" || kind === "expense" ? (
        <Field label="Until age" hint="Leave empty to run to the end of the plan">
          <input
            className="input num" inputMode="numeric" placeholder="-"
            value={untilAge === null ? "" : String(untilAge)}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setUntilAge(Number.isFinite(n) ? n : null);
            }}
          />
        </Field>
      ) : null}
    </Modal>
  );
}
