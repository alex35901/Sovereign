import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import type { Account, AccountType, ISODate } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, sinceLabel, today } from "../lib/date";
import type { AccountSlice } from "../lib/select";
import {
  ACCOUNT_TYPE_LABEL, accountSlices, balanceAt, earliestHistoryDate, trendTone,
} from "../lib/select";
import { AreaChart, Sparkline } from "../components/charts";
import { Btn, Card, Empty, Field, Modal, Money, MoneyInput, SelectInput, TextInput, Toggle, cx } from "../components/ui";
import { HiddenToggle } from "./AccountControls";
import { InstitutionLogo } from "../components/InstitutionLogo";
import type { RangeKey } from "../lib/range";
import { rangeStart, sampleDates, sampleLabel, spanDays } from "../lib/range";

/**
 * The periods the chart offers, in the order a phone shows them.
 *
 * Two names each: the button is abbreviated because six of them share one
 * line, and the sentence under the headline is not, because "$25,460 (3%) 1M
 * period" is a button label read aloud rather than a sentence.
 */
const SPANS: { value: RangeKey; label: string; period: string }[] = [
  { value: "1m", label: "1M", period: "1 month" },
  { value: "3m", label: "3M", period: "3 months" },
  { value: "6m", label: "6M", period: "6 months" },
  { value: "ytd", label: "YTD", period: "year to date" },
  { value: "1y", label: "1Y", period: "1 year" },
  { value: "all", label: "ALL", period: "all time" },
];

export default function Accounts() {
  const db = useDB();
  const [range, setRange] = useState<RangeKey>("1m");
  const [scope, setScope] = useState("net");
  const [adding, setAdding] = useState(false);

  // The first day of the chosen period, or the first day there is any data —
  // shared by the chart and every figure beside it, so nothing on the screen
  // is measuring a different span from anything else.
  const start = useMemo(() => {
    const earliest = earliestHistoryDate(db.accounts);
    const from = rangeStart(range, earliest);
    return earliest && earliest > from ? earliest : from;
  }, [db.accounts, range]);

  const dates = useMemo(() => sampleDates(start, today()), [start]);
  const slices = useMemo(() => accountSlices(db, dates), [db, dates]);

  // A slice can disappear underneath the selection — the last credit card
  // closed, say — and a screen filtered to nothing is a screen with no way
  // back to itself.
  const current = slices.find((s) => s.key === scope) ?? slices[0];
  const groups = slices.slice(1);
  const shown = current.key === "net" ? groups : groups.filter((g) => g.key === current.key);

  const days = spanDays(start, today());
  const points = current.series.map((value, i) => ({
    label: sampleLabel(dates[i], days),
    value,
    sub: dateLabel(dates[i], { year: true }),
  }));
  const tone = trendTone(current.series);

  // Sparklines are drawn against a coarser sample than the headline chart:
  // two dozen points is all a 60px rule can show, and asking for 300 makes
  // every row redraw the whole period.
  const sparkDates = useMemo(() => sampleDates(start, today(), 24), [start]);

  // A pill chosen from the far end of the run can be half off the screen when
  // the tap lands, which reads as though the tap missed.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bar.current?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [current.key]);

  const hidden = db.accounts.filter((a) => a.hidden);
  const [showHidden, setShowHidden] = useState(false);

  return (
    <>
      <TopBar
        title="Accounts"
        primary={<Btn variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> <span className="btn-label">Account</span></Btn>}
      />
      <div className="page stack">
        {db.accounts.length ? (
          <Card pad={false} className="nw-card">
            {/* Scrolls sideways rather than wrapping: the kinds are a single
                ordered run, and a second line of them reads as a second,
                lesser row of options. */}
            <div className="scope-bar" ref={bar} role="tablist" aria-label="What to show">
              {slices.map((s) => (
                <button
                  key={s.key} role="tab" aria-selected={s.key === current.key}
                  className={cx("scope-pill", s.key === current.key && "on")}
                  onClick={() => setScope(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="nw-head">
              <div className="nw-value num"><Money value={current.total} /></div>
              <Delta slice={current} range={range} />
            </div>

            {/* Edge to edge, and no axis labels: every figure they would carry
                is spelled out in words directly above them. */}
            <AreaChart points={points} height={200} tone={tone} negativeTone={tone} bare />

            <div className="span-bar">
              {SPANS.map((r) => (
                <button
                  key={r.value} className={cx("span-pill", r.value === range && "on")}
                  onClick={() => setRange(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </Card>
        ) : null}

        {shown.map((g) => (
          <Card key={g.key} pad={false}>
            <div className="acct-group-head">
              <div className="spread">
                <h2>{g.label}</h2>
                <span className="num bold" style={{ fontSize: 17 }}><Money value={g.total} /></span>
              </div>
              <div className="spread small">
                <Delta slice={g} range={range} small />
                {g.share !== null ? (
                  <span className="faint">{pctLabel(g.share)} of {g.shareOf}</span>
                ) : null}
              </div>
            </div>
            {g.accounts.map((a) => <AccountRow key={a.id} account={a} dates={sparkDates} />)}
          </Card>
        ))}

        {!db.accounts.length ? (
          <Card>
            <Empty
              title="No accounts yet"
              body="Add them by hand, import a CSV, or connect SimpleFIN from Settings to pull balances automatically."
              action={<Btn variant="primary" onClick={() => setAdding(true)}><Plus size={14} /> Add account</Btn>}
            />
          </Card>
        ) : null}

        {hidden.length ? (
          <Card pad={false}>
            {showHidden ? hidden.map((a) => <AccountRow key={a.id} account={a} dates={sparkDates} />) : null}
            <HiddenToggle count={hidden.length} open={showHidden} onToggle={() => setShowHidden((v) => !v)} />
          </Card>
        ) : null}
      </div>
      {adding ? <AccountModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/** "2.5%", and "<0.1%" rather than a rounded-away nothing. */
function pctLabel(fraction: number): string {
  const p = Math.abs(fraction) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}

/**
 * How a slice moved over the period, in money and in proportion.
 *
 * Signed throughout, liabilities included: they are stored negative, so a card
 * paid down comes out positive and green without a special case. A slice that
 * began at nothing has no proportion to report and simply doesn't.
 */
function Delta({ slice, range, small }: { slice: AccountSlice; range: RangeKey; small?: boolean }) {
  const period = SPANS.find((s) => s.value === range)?.period ?? range;
  if (slice.change === 0) return <span className="muted">No change · {period}</span>;
  const up = slice.change > 0;
  return (
    <span className={cx("row", small ? "tiny-gap" : undefined)} style={{ gap: 7 }}>
      <span className={up ? "pos" : "neg"}>
        {up ? "\u2197" : "\u2198"} <Money value={slice.change} />
        {slice.pct !== null ? ` (${pctLabel(slice.pct)})` : ""}
      </span>
      <span className="faint">{period}</span>
    </span>
  );
}

function AccountRow({ account, dates }: { account: Account; dates: ISODate[] }) {
  // the same days as every other sparkline on the page, so the dashed baseline
  // means "where this account started over the window you're looking at"
  const history = useMemo(() => dates.map((d) => balanceAt(account, d)), [account, dates]);
  return (
    <Link to={`/accounts/${account.id}`} className="list-row click">
      <InstitutionLogo account={account} round />
      <div className="grow col" style={{ gap: 1 }}>
        <span className="truncate" style={{ fontWeight: 500 }}>
          {account.name}{account.mask ? ` (\u2026${account.mask})` : ""}
        </span>
        <span className="tiny faint truncate">
          {ACCOUNT_TYPE_LABEL[account.type]}
          {/* When it last came in, because the only question a balance on a
              list invites is whether it is still true. */}
          {account.lastSyncedAt ? ` · ${sinceLabel(account.lastSyncedAt)}` : ""}
          {account.hidden ? " · hidden" : ""}
          {!account.includeInNetWorth ? " · excluded from net worth" : ""}
        </span>
      </div>
      <span className="acct-spark">
        {history.length > 2 ? <Sparkline values={history} baseline tone={trendTone(history)} /> : null}
      </span>
      <span className="num bold acct-amount">
        <Money value={account.balance} />
      </span>
      <ChevronRight size={15} className="faint acct-chevron" />
    </Link>
  );
}

const TYPE_OPTIONS = Object.entries(ACCOUNT_TYPE_LABEL).map(([value, label]) => ({ value: value as AccountType, label }));

export function AccountModal({ account, onClose }: { account?: Account; onClose: () => void }) {
  const { actions } = useStore();
  const [name, setName] = useState(account?.name ?? "");
  const [institution, setInstitution] = useState(account?.institution ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "checking");
  const [balance, setBalance] = useState(account?.balance ?? 0);
  const [mask, setMask] = useState(account?.mask ?? "");
  const [includeInNetWorth, setInclude] = useState(account?.includeInNetWorth ?? true);
  const [hidden, setHidden] = useState(account?.hidden ?? false);

  const liability = ["credit", "loan", "mortgage", "other_liability"].includes(type);

  const save = () => {
    const signed = liability ? -Math.abs(balance) : balance;
    if (account) {
      actions.updateAccount(account.id, { name, institution, type, mask, includeInNetWorth, hidden });
      if (signed !== account.balance) actions.setAccountBalance(account.id, signed);
    } else {
      actions.addAccount({
        name: name.trim() || "New account", institution: institution.trim() || "Manual", type,
        balance: signed, mask, includeInNetWorth, hidden, syncSource: "manual",
      });
    }
    onClose();
  };

  return (
    <Modal
      title={account ? "Edit account" : "Add account"}
      onClose={onClose}
      footer={
        <>
          {account ? <Btn variant="danger" onClick={() => { actions.deleteAccount(account.id); onClose(); }}>Delete</Btn> : null}
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>{account ? "Save" : "Add account"}</Btn>
        </>
      }
    >
      <div className="row" style={{ gap: 12 }}>
        <Field label="Account name"><TextInput value={name} onChange={setName} placeholder="Everyday Checking" autoFocus /></Field>
        <Field label="Institution"><TextInput value={institution} onChange={setInstitution} placeholder="Chase" /></Field>
      </div>
      <div className="row" style={{ gap: 12 }}>
        <Field label="Type"><SelectInput value={type} onChange={setType} options={TYPE_OPTIONS} /></Field>
        <Field label="Last 4"><TextInput value={mask} onChange={setMask} placeholder="4412" /></Field>
      </div>
      <Field label={liability ? "Amount owed" : "Current balance"} hint={liability ? "Entered as a positive number; stored as a liability." : undefined}>
        <MoneyInput value={liability ? Math.abs(balance) : balance} onChange={setBalance} />
      </Field>
      <Toggle on={includeInNetWorth} onChange={setInclude} label={<span className="small">Include in net worth</span>} />
      <Toggle on={hidden} onChange={setHidden} label={<span className="small">Hide from lists</span>} />
    </Modal>
  );
}
