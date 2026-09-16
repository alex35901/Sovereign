import { Fragment, useMemo, useState } from "react";
import { Plus, Printer } from "lucide-react";
import type { Account, EstateContact, EstateDocument, Policy } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { longDate, monthLabel, today } from "../lib/date";
import { fmt0 } from "../lib/money";
import { AreaChart } from "../components/charts";
import {
  Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, PercentInput,
  SelectInput, TextInput, cx,
} from "../components/ui";
import {
  activeScenario, blankPlan, measuredFlows, startingPosition, withDebtDefaults,
} from "../lib/forecast";
import type { EstateSection, Survivorship } from "../lib/estate";
import {
  blankSurvivorship, coverNeeded, estateSummary, lifeCover, runSurvivor,
} from "../lib/estate";

/**
 * What happens to the people who are left.
 *
 * Two halves of one question, in the order a person actually asks them.
 *
 * First: if I do not come home, are they all right? That is arithmetic, and
 * the forecast engine already does it - the same walk with an earner's pay
 * taken out of it, the insurance paid in, and the answer to "how much cover
 * would it take" solved rather than guessed at.
 *
 * Second: would they even be able to find anything? That one is not
 * arithmetic. When somebody dies the hard part is rarely the will, it is that
 * nobody knows which bank, whether there was a policy, or what is still coming
 * out of the card every month. This app has been watching all of it.
 *
 * What this deliberately is not is a will. A will's validity turns on state
 * law - witnesses, whether one of them may also inherit, whether it was
 * notarised - and a document that looks valid and is not would be found out at
 * the one moment nobody can fix it. This is what you take to the attorney.
 * Which is also why nothing here holds a password: the whole point is that it
 * can be printed and left somewhere.
 */

type Ownership = NonNullable<NonNullable<Account["estate"]>["ownership"]>;

const OWNERSHIPS: { value: Ownership; label: string }[] = [
  { value: "sole", label: "Sole" },
  { value: "joint", label: "Joint" },
  { value: "trust", label: "In trust" },
];

const POLICY_KINDS = [
  { value: "life", label: "Life" },
  { value: "disability", label: "Disability" },
  { value: "other", label: "Other" },
];

/** How many points the survivor chart draws, whatever the length of the walk. */
const CHART_POINTS = 90;

export default function Estate() {
  const db = useDB();
  const { actions } = useStore();

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

  /**
   * The survivorship as stored, or one worked out from the accounts.
   *
   * Seeded rather than blank, and the seed is the pessimistic reading: all of
   * the pay stops. A household where both earn corrects it in one edit; one
   * where only one does gets the right answer without touching anything.
   */
  const stored = db.estate?.survivorship;
  const s: Survivorship | null = useMemo(() => {
    if (!a) return null;
    const seed = blankSurvivorship(db, a, flows.income);
    return stored ? { ...seed, ...stored } : seed;
  }, [db, a, flows.income, stored]);

  // The cover in force comes off the policies rather than being typed twice.
  const cover = lifeCover(db);
  const withCover = useMemo(() => (s ? { ...s, cover } : null), [s, cover]);

  const run = useMemo(
    () => (a && withCover ? runSurvivor(position, a, scenario!.events, withCover) : null),
    [position, a, scenario, withCover],
  );
  const needed = useMemo(
    () => (a && withCover ? coverNeeded(position, a, scenario!.events, withCover) : null),
    [position, a, scenario, withCover],
  );

  const sections = useMemo(() => estateSummary(db), [db]);

  if (!a || !s || !withCover || !run) return null;

  /**
   * Money they could actually live on, which is not net worth.
   *
   * The forecast screen charts net worth and is right to: it is asking whether
   * you will be comfortable. This one is asking whether they can pay for
   * things, and a house is not an answer to that. Charted against net worth
   * this line climbed for forty years after the family had run out, because
   * the property kept pace with inflation and the mortgage kept amortising -
   * a rising line under a headline saying they were three million short.
   */
  const mid = run.points;
  const liquid = (i: number): number => mid[i].cash + mid[i].invested;
  const step = Math.max(1, Math.ceil(mid.length / CHART_POINTS));
  const idx = mid.map((_, i) => i).filter((i) => i % step === 0 || i === mid.length - 1);
  const points = idx.map((i) => ({
    label: mid[i].month.slice(0, 4),
    value: liquid(i),
    sub: `${monthLabel(mid[i].month)} · age ${Math.floor(mid[i].age)}`,
  }));
  // Where it hits the floor, named on the chart rather than only in the words
  // underneath it.
  const empty = idx.findIndex((i) => liquid(i) <= 0);
  const marks = run.ranOutAt !== null && empty > 0
    ? [{ index: empty, label: `Nothing left at ${Math.floor(run.ranOutAt)}`, tone: "--neg" }]
    : [];

  const gap = needed === null ? null : needed - cover;
  const ok = gap !== null && gap <= 0;

  return (
    <>
      <TopBar
        title="Estate"
        primary={
          <Btn variant="primary" onClick={() => window.print()}>
            <Printer size={15} /> <span className="btn-label">Print</span>
          </Btn>
        }
      />
      <div className="page stack est-screen">
        {/* ── if something happens to you ───────────────────────────── */}
        <Card pad={false} className="nw-card">
          <div className="fc-head">
            <span className="small muted">If something happened to you today</span>
            <span className={cx("nw-total num", needed !== null && !ok && "neg")}>
              {needed === null
                ? "More than any policy"
                : ok ? "They would be all right" : `${fmt0(gap!)} short`}
            </span>
            <span className="small faint">
              {needed === null
                ? "The shortfall is in the spending rather than in the cover, and no payout fixes that."
                : needed === 0
                  ? `What is left coming in already carries them to ${s.survivorEndAge}.`
                  : `It would take ${fmt0(needed)} of life cover to carry them to ${s.survivorEndAge}. You have ${fmt0(cover)}.`}
            </span>
          </div>
          <div style={{ padding: "0 8px 8px" }}>
            <AreaChart
              points={points} height={220} zeroBase marks={marks}
              tone={ok ? "--pos" : "--accent"}
            />
          </div>
          <div className="est-foot">
            <span className="small faint">
              {run.ranOutAt === null
                ? `On today's cover there is still ${fmt0(liquid(mid.length - 1))} to draw on at ${s.survivorEndAge}. The line is savings and investments, not net worth: a house is not something you can spend.`
                : `On today's cover the money runs out at ${Math.floor(run.ranOutAt)}. The line is savings and investments, not net worth: a house is not something you can spend.`}
            </span>
          </div>
        </Card>

        <Card pad={false}>
          <CardHead
            flush title="What would change"
            sub="Every one of these is a guess, and the conservative guess is the default"
          />
          <div className="fc-grid">
            <Field label="Pay that would stop" hint={`Of ${fmt0(flows.income)} a month coming in now`}>
              <MoneyInput value={s.incomeLost} onChange={(incomeLost) => actions.setSurvivorship({ incomeLost })} />
            </Field>
            <Field label="What they would spend" hint="Of what the household spends now">
              <PercentInput value={s.spendPct} onChange={(spendPct) => actions.setSurvivorship({ spendPct })} />
            </Field>
            <Field label="They were born" hint="The money has to last for them, not for you">
              <YearInput
                value={s.survivorBirthYear}
                onChange={(survivorBirthYear) => actions.setSurvivorship({ survivorBirthYear })}
              />
            </Field>
            <Field label="Carry them to" hint="Their age, not yours">
              <YearInput
                value={s.survivorEndAge} min={1} max={120}
                onChange={(survivorEndAge) => actions.setSurvivorship({ survivorEndAge })}
              />
            </Field>
          </div>
          <Clears db={db} s={s} />
        </Card>

        {/* ── what a family would need to find ───────────────────────── */}
        <div className="est-print">
          <div className="est-print-head">
            <h2>What my family needs to know</h2>
            <span className="small muted">
              Prepared from Sovereign on {longDate(today())}.
              This is not a will. It is the inventory an executor or an attorney asks for first.
            </span>
          </div>

          {/* What is owed, then what would pay it: insurance belongs with the
              balance sheet rather than after the list of subscriptions. It is
              its own card because a policy is something a person types in, and
              the cards either side of it are worked out. */}
          {sections.map((sec) => (
            <Fragment key={sec.key}>
              <Section sec={sec} />
              {sec.key === "owed" ? <Policies /> : null}
            </Fragment>
          ))}

          <Contacts />
          <Papers />
          <Wishes />
        </div>

        <Holdings />
      </div>
    </>
  );
}

/** One derived section of the summary, as it prints. */
function Section({ sec }: { sec: EstateSection }) {
  return (
    <Card pad={false} className="est-section">
      <CardHead
        flush title={sec.title} sub={sec.note}
        right={sec.total !== undefined && sec.lines.length
          ? <span className="num bold"><Money value={sec.total} cents={false} /></span>
          : undefined}
      />
      {sec.lines.length ? sec.lines.map((l) => (
        <div key={l.key} className="row est-line">
          <span className="col grow" style={{ gap: 0 }}>
            <span className="bold">{l.name}</span>
            <span className="tiny faint">
              {l.detail}
              {l.ownership ? ` · ${l.ownership}` : ""}
              {l.beneficiary ? ` · goes to ${l.beneficiary}` : ""}
            </span>
            {l.note ? <span className="tiny muted">{l.note}</span> : null}
          </span>
          <Money value={l.amount} cents={false} className="bold" />
        </div>
      )) : (
        <div style={{ padding: "12px 16px" }}>
          <span className="small faint">Nothing owed.</span>
        </div>
      )}
    </Card>
  );
}

/** A year or an age, typed. Same buffering as the other number fields. */
function YearInput({ value, onChange, min = 1900, max = new Date().getFullYear() }: {
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
        if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
      }}
      onFocus={(e) => { setBuf(e.target.value); e.currentTarget.select(); }}
      onBlur={() => setBuf(null)}
    />
  );
}

/**
 * Which debts the payout would be spent clearing.
 *
 * Worth offering rather than assuming, and worth being honest about: the
 * forecast is as likely to say it was not worth doing as that it was, because
 * a mortgage at less than the money earns is cheap borrowing. That is a real
 * answer, and it is one most people have never been given.
 */
function Clears({ db, s }: { db: ReturnType<typeof useDB>; s: Survivorship }) {
  const { actions } = useStore();
  const owed = db.accounts.filter(
    (x) => !x.hidden && !x.closedAt && x.balance < 0
      && ["mortgage", "loan", "credit", "other_liability"].includes(x.type),
  );
  if (!owed.length) return null;
  return (
    <div className="est-clears">
      <span className="tiny faint">Paid off out of the payout, if there is enough to clear it whole</span>
      <div className="row wrap" style={{ gap: 7, marginTop: 7 }}>
        {owed.map((acc) => {
          const on = s.clears.includes(acc.id);
          return (
            <button
              key={acc.id}
              className={cx("against-pill", on && "on")}
              aria-pressed={on}
              onClick={() => actions.setSurvivorship({
                clears: on ? s.clears.filter((x) => x !== acc.id) : [...s.clears, acc.id],
              })}
            >
              {acc.name} <span className="faint">{fmt0(acc.balance)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── the lists ────────────────────────────────────────────────────────── */

function Policies() {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  const list = db.estate?.policies ?? [];
  return (
    <>
      <Card pad={false} className="est-section">
        <CardHead
          flush title="Insurance" sub="What pays out, from whom, and to whom"
          right={<Btn size="sm" onClick={() => setEditing("new")}><Plus size={14} /> Add</Btn>}
        />
        {list.length ? list.map((p) => (
          <div key={p.id} className="row est-line click" onClick={() => setEditing(p)}>
            <span className="col grow" style={{ gap: 0 }}>
              <span className="bold">{p.insurer}</span>
              <span className="tiny faint">
                {p.kind === "life" ? "Life" : p.kind === "disability" ? "Disability" : "Policy"}
                {p.insures ? ` on ${p.insures}` : ""}
                {p.policyNumber ? ` · no. ${p.policyNumber}` : ""}
                {p.beneficiary ? ` · goes to ${p.beneficiary}` : ""}
              </span>
            </span>
            <Money value={p.coverage} cents={false} className="bold" />
          </div>
        )) : (
          <div style={{ padding: 16 }}>
            <Empty
              title="No policies recorded"
              body="Life cover here is what the forecast above pays in. Include anything through work, which people forget and which is often the larger of the two."
              action={<Btn variant="primary" onClick={() => setEditing("new")}>Add one</Btn>}
            />
          </div>
        )}
      </Card>
      {editing ? (
        <PolicyModal
          policy={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onDelete={editing !== "new" ? () => { actions.deletePolicy(editing.id); setEditing(null); } : undefined}
        />
      ) : null}
    </>
  );
}

function PolicyModal({ policy, onClose, onDelete }: {
  policy?: Policy; onClose: () => void; onDelete?: () => void;
}) {
  const { actions } = useStore();
  const [kind, setKind] = useState<Policy["kind"]>(policy?.kind ?? "life");
  const [insurer, setInsurer] = useState(policy?.insurer ?? "");
  const [coverage, setCoverage] = useState(policy?.coverage ?? 0);
  const [insures, setInsures] = useState(policy?.insures ?? "");
  const [beneficiary, setBeneficiary] = useState(policy?.beneficiary ?? "");
  const [policyNumber, setPolicyNumber] = useState(policy?.policyNumber ?? "");
  const [note, setNote] = useState(policy?.note ?? "");

  const save = () => {
    const next = {
      kind, insurer: insurer.trim() || "Policy", coverage,
      insures: insures.trim() || undefined,
      beneficiary: beneficiary.trim() || undefined,
      policyNumber: policyNumber.trim() || undefined,
      note: note.trim() || undefined,
    };
    if (policy) actions.updatePolicy(policy.id, next);
    else actions.addPolicy(next);
    onClose();
  };

  return (
    <Modal
      title={policy ? "Edit policy" : "Add a policy"}
      onClose={onClose}
      footer={
        <>
          {onDelete ? <Btn variant="danger" onClick={onDelete}>Delete</Btn> : null}
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>{policy ? "Save" : "Add"}</Btn>
        </>
      }
    >
      <Field label="Kind">
        <SelectInput value={kind} options={POLICY_KINDS} onChange={(v) => setKind(v as Policy["kind"])} />
      </Field>
      <Field label="Insurer"><TextInput value={insurer} onChange={setInsurer} placeholder="Northwestern Mutual" autoFocus /></Field>
      <Field label="Pays out" hint={kind === "life" ? "Life cover is what the forecast above pays in" : undefined}>
        <MoneyInput value={coverage} onChange={setCoverage} />
      </Field>
      <Field label="On whose life"><TextInput value={insures} onChange={setInsures} placeholder="Alex" /></Field>
      <Field label="Goes to"><TextInput value={beneficiary} onChange={setBeneficiary} placeholder="Sam" /></Field>
      <Field label="Policy number" hint="What a claim is made with. Never put a password anywhere in here.">
        <TextInput value={policyNumber} onChange={setPolicyNumber} />
      </Field>
      <Field label="Anything else"><TextInput value={note} onChange={setNote} /></Field>
    </Modal>
  );
}

function Contacts() {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState<EstateContact | "new" | null>(null);
  const list = db.estate?.contacts ?? [];
  return (
    <>
      <Card pad={false} className="est-section">
        <CardHead
          flush title="Who to call"
          sub="The executor, the attorney, the accountant, the insurance agent"
          right={<Btn size="sm" onClick={() => setEditing("new")}><Plus size={14} /> Add</Btn>}
        />
        {list.length ? list.map((c) => (
          <div key={c.id} className="row est-line click" onClick={() => setEditing(c)}>
            <span className="col grow" style={{ gap: 0 }}>
              <span className="bold">{c.name}{c.org ? <span className="muted"> · {c.org}</span> : null}</span>
              <span className="tiny faint">
                {c.role}{c.phone ? ` · ${c.phone}` : ""}{c.email ? ` · ${c.email}` : ""}
              </span>
              {c.note ? <span className="tiny muted">{c.note}</span> : null}
            </span>
          </div>
        )) : (
          <div style={{ padding: 16 }}>
            <span className="small faint">Nobody recorded yet.</span>
          </div>
        )}
      </Card>
      {editing ? (
        <ContactModal
          contact={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onDelete={editing !== "new" ? () => { actions.deleteEstateContact(editing.id); setEditing(null); } : undefined}
        />
      ) : null}
    </>
  );
}

function ContactModal({ contact, onClose, onDelete }: {
  contact?: EstateContact; onClose: () => void; onDelete?: () => void;
}) {
  const { actions } = useStore();
  const [role, setRole] = useState(contact?.role ?? "");
  const [name, setName] = useState(contact?.name ?? "");
  const [org, setOrg] = useState(contact?.org ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [note, setNote] = useState(contact?.note ?? "");

  const save = () => {
    const next = {
      role: role.trim() || "Contact", name: name.trim() || "Contact",
      org: org.trim() || undefined, phone: phone.trim() || undefined,
      email: email.trim() || undefined, note: note.trim() || undefined,
    };
    if (contact) actions.updateEstateContact(contact.id, next);
    else actions.addEstateContact(next);
    onClose();
  };

  return (
    <Modal
      title={contact ? "Edit contact" : "Add a contact"}
      onClose={onClose}
      footer={
        <>
          {onDelete ? <Btn variant="danger" onClick={onDelete}>Delete</Btn> : null}
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>{contact ? "Save" : "Add"}</Btn>
        </>
      }
    >
      <Field label="Who they are" hint="Executor, attorney, accountant, financial advisor">
        <TextInput value={role} onChange={setRole} placeholder="Attorney" autoFocus />
      </Field>
      <Field label="Name"><TextInput value={name} onChange={setName} /></Field>
      <Field label="Firm"><TextInput value={org} onChange={setOrg} /></Field>
      <Field label="Phone"><TextInput value={phone} onChange={setPhone} type="tel" /></Field>
      <Field label="Email"><TextInput value={email} onChange={setEmail} type="email" /></Field>
      <Field label="Anything else"><TextInput value={note} onChange={setNote} /></Field>
    </Modal>
  );
}

function Papers() {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState<EstateDocument | "new" | null>(null);
  const list = db.estate?.documents ?? [];
  return (
    <>
      <Card pad={false} className="est-section">
        <CardHead
          flush title="Where the papers are"
          sub="The will, the deed, the birth certificates, the safe deposit key"
          right={<Btn size="sm" onClick={() => setEditing("new")}><Plus size={14} /> Add</Btn>}
        />
        {list.length ? list.map((d) => (
          <div key={d.id} className="row est-line click" onClick={() => setEditing(d)}>
            <span className="col grow" style={{ gap: 0 }}>
              <span className="bold">{d.name}</span>
              <span className="tiny faint">{d.location}</span>
              {d.note ? <span className="tiny muted">{d.note}</span> : null}
            </span>
          </div>
        )) : (
          <div style={{ padding: 16 }}>
            <span className="small faint">Nothing recorded yet.</span>
          </div>
        )}
      </Card>
      {editing ? (
        <PaperModal
          doc={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onDelete={editing !== "new" ? () => { actions.deleteEstateDocument(editing.id); setEditing(null); } : undefined}
        />
      ) : null}
    </>
  );
}

function PaperModal({ doc, onClose, onDelete }: {
  doc?: EstateDocument; onClose: () => void; onDelete?: () => void;
}) {
  const { actions } = useStore();
  const [name, setName] = useState(doc?.name ?? "");
  const [location, setLocation] = useState(doc?.location ?? "");
  const [note, setNote] = useState(doc?.note ?? "");

  const save = () => {
    const next = {
      name: name.trim() || "Document",
      location: location.trim(),
      note: note.trim() || undefined,
    };
    if (doc) actions.updateEstateDocument(doc.id, next);
    else actions.addEstateDocument(next);
    onClose();
  };

  return (
    <Modal
      title={doc ? "Edit document" : "Add a document"}
      onClose={onClose}
      footer={
        <>
          {onDelete ? <Btn variant="danger" onClick={onDelete}>Delete</Btn> : null}
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>{doc ? "Save" : "Add"}</Btn>
        </>
      }
    >
      <Field label="What it is"><TextInput value={name} onChange={setName} placeholder="Will" autoFocus /></Field>
      <Field label="Where it is" hint="Somewhere a person could walk to. Never a password.">
        <TextInput value={location} onChange={setLocation} placeholder="Fireproof box in the bedroom closet" />
      </Field>
      <Field label="Anything else" hint="A copy with the attorney, who else has a key">
        <TextInput value={note} onChange={setNote} />
      </Field>
    </Modal>
  );
}

/**
 * The two things that are not a list and not a number.
 *
 * Guardianship is the reason most people with small children finally write a
 * will, and it is the one thing on this page that has nothing to do with
 * money. It is here anyway, because this is the page somebody opens on the
 * worst day, and because writing it down is what makes the conversation with
 * the attorney take twenty minutes instead of an hour.
 */
function Wishes() {
  const db = useDB();
  const { actions } = useStore();
  const e = db.estate;
  return (
    <Card pad={false} className="est-section">
      <CardHead
        flush title="In your own words"
        sub="Not a legal nomination. What you would want, written down, for the people who have to decide."
      />
      <div className="est-notes">
        <Field label="The children" hint="Who you would want to raise them, and who you would not. Say this to the attorney too: only the will makes it count.">
          <textarea
            className="input" rows={3} value={e?.guardians ?? ""}
            onChange={(ev) => actions.setEstate({ guardians: ev.target.value })}
          />
        </Field>
        <Field label="Anything else">
          <textarea
            className="input" rows={3} value={e?.wishes ?? ""}
            onChange={(ev) => actions.setEstate({ wishes: ev.target.value })}
          />
        </Field>
      </div>
    </Card>
  );
}

/**
 * How each account is held, which is the one thing here the app cannot guess.
 *
 * A joint account passes to the other holder the moment it is needed and never
 * goes near the will. A beneficiary named on a retirement account beats the
 * will outright. Both are routinely wrong, and both are cheap to fix on a
 * Tuesday and ruinous to discover a year into probate.
 */
function Holdings() {
  const db = useDB();
  const { actions } = useStore();
  const live = db.accounts.filter((x) => !x.hidden && !x.closedAt);
  if (!live.length) return null;
  return (
    <Card pad={false} className="est-owners">
      <CardHead
        flush title="How each account is held"
        sub="A joint account and a named beneficiary both pass outside the will. The app cannot see either."
      />
      {live.map((acc: Account) => (
        <div key={acc.id} className="row fc-acc">
          <span className="col grow" style={{ gap: 0 }}>
            <span className="bold">{acc.name}</span>
            <span className="tiny faint">{acc.institution} · {fmt0(acc.balance)}</span>
          </span>
          <SelectInput<Ownership | "">
            value={acc.estate?.ownership ?? ""}
            placeholder="Not said"
            options={OWNERSHIPS}
            onChange={(v) => actions.setAccountEstate(acc.id, { ownership: v || undefined })}
          />
          <span className="est-benef">
            <TextInput
              value={acc.estate?.beneficiary ?? ""}
              placeholder="Beneficiary"
              onChange={(beneficiary) => actions.setAccountEstate(acc.id, { beneficiary })}
            />
          </span>
        </div>
      ))}
    </Card>
  );
}
