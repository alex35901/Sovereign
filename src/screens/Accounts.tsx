import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import type { Account, AccountType, ISODate } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, today } from "../lib/date";
import { ACCOUNT_GROUPS, ACCOUNT_TYPE_LABEL, aggregateSeries, balanceAt, earliestHistoryDate, netWorthAt, netWorthNow, netWorthSplitAt, trendTone } from "../lib/select";
import { AreaChart, Sparkline } from "../components/charts";
import { Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, SelectInput, TextInput, Tile, Toggle } from "../components/ui";
import { RangePicker } from "../components/pickers";
import { HiddenToggle } from "./AccountControls";
import { InstitutionLogo } from "../components/InstitutionLogo";
import type { RangeKey } from "../lib/range";
import { rangeStart, sampleDates, sampleLabel, spanDays } from "../lib/range";

export default function Accounts() {
  const db = useDB();
  const [range, setRange] = useState<RangeKey>("1y");
  const [adding, setAdding] = useState(false);
  const nw = netWorthNow(db);

  // The first day of the chosen period, or the first day there is any data —
  // shared so the tiles and the chart can't measure over different spans.
  const start = useMemo(() => {
    const earliest = earliestHistoryDate(db.accounts);
    const from = rangeStart(range, earliest);
    return earliest && earliest > from ? earliest : from;
  }, [db.accounts, range]);

  const series = useMemo(() => {
    const end = today();
    const days = spanDays(start, end);
    return sampleDates(start, end).map((d) => ({
      label: sampleLabel(d, days),
      value: netWorthAt(db, d),
      sub: dateLabel(d, { year: true }),
    }));
  }, [db, start]);

  // Where the line ended against where it began, which is what colours it.
  const netWorthTone = trendTone(series.map((p) => p.value));

  const then = useMemo(() => netWorthSplitAt(db, start), [db, start]);
  const change = nw.net - then.net;
  const assetChange = nw.assets - then.assets;
  // Liabilities are stored negative, so a rise is debt shrinking.
  const owedChange = nw.liabilities - then.liabilities;

  // every sparkline on the page covers the same days as the chart above them
  const dates = useMemo(() => {
    const earliest = earliestHistoryDate(db.accounts);
    const from = rangeStart(range, earliest);
    const start = earliest && earliest > from ? earliest : from;
    return sampleDates(start, today(), 24);
  }, [db.accounts, range]);

  const groups = ACCOUNT_GROUPS.map((g) => {
    const accounts = db.accounts
      .filter((a) => g.types.includes(a.type) && !a.hidden)
      .sort((a, b) => a.order - b.order);
    const series = aggregateSeries(accounts, dates);
    return {
      ...g,
      accounts,
      series,
      change: series.length > 1 ? series[series.length - 1] - series[0] : 0,
      total: accounts.reduce((s, a) => s + a.balance, 0),
    };
  }).filter((g) => g.accounts.length);

  const hidden = db.accounts.filter((a) => a.hidden);
  const [showHidden, setShowHidden] = useState(false);

  return (
    <>
      <TopBar
        title="Accounts"
        primary={<Btn variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> <span className="btn-label">Account</span></Btn>}
      />
      <div className="page stack">
        <div className="grid g3">
          <Tile label="Net worth" value={<Money value={nw.net} cents={false} />}
            sub={<span className={change >= 0 ? "pos" : "neg"}><Money value={change} cents={false} sign={change >= 0} /> over {range.toUpperCase()}</span>} />
          <Tile
            label="Assets" value={<Money value={nw.assets} cents={false} />} tone="pos"
            sub={<Change amount={assetChange} range={range} />}
          />
          <Tile
            label="Liabilities" value={<Money value={nw.liabilities} cents={false} />} tone="neg"
            sub={<Change amount={owedChange} range={range} />}
          />
        </div>

        <Card>
          <CardHead
            title="Net worth over time"
            sub={series.length ? `${series[0].sub} — today` : undefined}
            right={<RangePicker value={range} onChange={setRange} />}
          />
          {/* One colour across the whole line, decided by where it ended
              against where it started — the dashed line the chart draws at the
              opening value. Not by its sign: a net worth under water all year
              and climbing is good news, and the range picker above is what
              decides which "started" we mean. */}
          <AreaChart points={series} height={230} tone={netWorthTone} negativeTone={netWorthTone} startLine />
        </Card>

        {groups.map((g) => (
          <Card key={g.key} pad={false}>
            <CardHead
              flush
              title={g.label}
              sub={
                g.change !== 0 ? (
                  <span className={g.change > 0 ? "pos" : "neg"}>
                    <Money value={g.change} cents={false} sign={g.change > 0} /> over the period
                  </span>
                ) : undefined
              }
              right={
                <span className="row" style={{ gap: 12 }}>
                  <span className="acct-spark">
                    {g.series.length > 2 ? <Sparkline values={g.series} baseline tone={trendTone(g.series)} /> : null}
                  </span>
                  <span className="num bold acct-amount"><Money value={g.total} cents={false} /></span>
                  {/* stands in for the row chevron, so the totals column lines up */}
                  <span className="acct-chevron" />
                </span>
              }
            />
            {g.accounts.map((a) => <AccountRow key={a.id} account={a} dates={dates} />)}
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
            {showHidden ? hidden.map((a) => <AccountRow key={a.id} account={a} dates={dates} />) : null}
            <HiddenToggle count={hidden.length} open={showHidden} onToggle={() => setShowHidden((v) => !v)} />
          </Card>
        ) : null}
      </div>
      {adding ? <AccountModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/**
 * How a figure moved over the period.
 *
 * Signed throughout, liabilities included: they are stored negative, so the
 * delta already reads the right way round — debt growing is a fall, and comes
 * out negative and red.
 */
function Change({ amount, range }: { amount: number; range: RangeKey }) {
  const over = ` over ${range.toUpperCase()}`;
  if (amount === 0) return <span className="muted">No change{over}</span>;
  return (
    <span className={amount > 0 ? "pos" : "neg"}>
      <Money value={amount} cents={false} sign={amount > 0} />{over}
    </span>
  );
}

function AccountRow({ account, dates }: { account: Account; dates: ISODate[] }) {
  // the same days as every other sparkline on the page, so the dashed baseline
  // means "where this account started over the window you're looking at"
  const history = useMemo(() => dates.map((d) => balanceAt(account, d)), [account, dates]);
  return (
    <Link to={`/accounts/${account.id}`} className="list-row click">
      <InstitutionLogo account={account} />
      <div className="grow col" style={{ gap: 1 }}>
        <span className="truncate" style={{ fontWeight: 500 }}>{account.name}</span>
        <span className="tiny faint">
          {account.institution} · {ACCOUNT_TYPE_LABEL[account.type]}
          {account.mask ? ` ••${account.mask}` : ""}
          {account.hidden ? " · hidden" : ""}
          {!account.includeInNetWorth ? " · excluded from net worth" : ""}
        </span>
      </div>
      <span className="acct-spark">
        {history.length > 2 ? <Sparkline values={history} baseline tone={trendTone(history)} /> : null}
      </span>
      <span className="num bold acct-amount">
        <Money value={account.balance} cents={false} />
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
