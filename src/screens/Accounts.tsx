import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Plus } from "lucide-react";
import type { Account, AccountType } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, today } from "../lib/date";
import { ACCOUNT_GROUPS, ACCOUNT_TYPE_LABEL, earliestHistoryDate, netWorthAt, netWorthNow } from "../lib/select";
import { AreaChart, Sparkline } from "../components/charts";
import { Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, SelectInput, TextInput, Tile, Toggle } from "../components/ui";
import { RangePicker } from "../components/pickers";
import type { RangeKey } from "../lib/range";
import { rangeStart, sampleDates, sampleLabel, spanDays } from "../lib/range";

export default function Accounts() {
  const db = useDB();
  const [range, setRange] = useState<RangeKey>("1y");
  const [adding, setAdding] = useState(false);
  const nw = netWorthNow(db);
  const series = useMemo(() => {
    const earliest = earliestHistoryDate(db.accounts);
    const from = rangeStart(range, earliest);
    const start = earliest && earliest > from ? earliest : from;
    const end = today();
    const days = spanDays(start, end);
    return sampleDates(start, end).map((d) => ({
      label: sampleLabel(d, days),
      value: netWorthAt(db, d),
      sub: dateLabel(d, { year: true }),
    }));
  }, [db, range]);
  const first = series[0]?.value ?? 0;
  const change = nw.net - first;

  const groups = ACCOUNT_GROUPS.map((g) => {
    const accounts = db.accounts
      .filter((a) => g.types.includes(a.type) && !a.hidden)
      .sort((a, b) => a.order - b.order);
    return { ...g, accounts, total: accounts.reduce((s, a) => s + a.balance, 0) };
  }).filter((g) => g.accounts.length);

  const hidden = db.accounts.filter((a) => a.hidden);

  return (
    <>
      <TopBar title="Accounts" actions={<Btn onClick={() => setAdding(true)}><Plus size={15} /> Account</Btn>} />
      <div className="page stack">
        <div className="grid g3">
          <Tile label="Net worth" value={<Money value={nw.net} cents={false} />}
            sub={<span className={change >= 0 ? "pos" : "neg"}><Money value={change} cents={false} sign={change >= 0} /> over {range.toUpperCase()}</span>} />
          <Tile label="Assets" value={<Money value={nw.assets} cents={false} />} />
          <Tile label="Liabilities" value={<Money value={nw.liabilities} cents={false} />} />
        </div>

        <Card>
          <CardHead
            title="Net worth over time"
            sub={series.length ? `${series[0].sub} — today` : undefined}
            right={<RangePicker value={range} onChange={setRange} />}
          />
          <AreaChart points={series} height={230} />
        </Card>

        {groups.map((g) => (
          <Card key={g.key} pad={false}>
            <CardHead
              flush title={g.label}
              right={<span className="num bold"><Money value={g.total} cents={false} /></span>}
            />
            {g.accounts.map((a) => <AccountRow key={a.id} account={a} />)}
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
            <CardHead flush title="Hidden" sub={`${hidden.length} account${hidden.length === 1 ? "" : "s"}`} />
            {hidden.map((a) => <AccountRow key={a.id} account={a} />)}
          </Card>
        ) : null}
      </div>
      {adding ? <AccountModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function AccountRow({ account }: { account: Account }) {
  const history = account.history.slice(-14).map((h) => h.balance);
  return (
    <Link to={`/accounts/${account.id}`} className="list-row click">
      <span
        className="avatar"
        style={{ background: `color-mix(in srgb, var(--c2) 16%, transparent)`, color: "var(--c2)", fontWeight: 700, fontSize: 12 }}
      >
        {account.institution.slice(0, 2).toUpperCase()}
      </span>
      <div className="grow col" style={{ gap: 1 }}>
        <span className="truncate" style={{ fontWeight: 500 }}>{account.name}</span>
        <span className="tiny faint">
          {account.institution} · {ACCOUNT_TYPE_LABEL[account.type]}
          {account.mask ? ` ••${account.mask}` : ""}
          {account.hidden ? " · hidden" : ""}
          {!account.includeInNetWorth ? " · excluded from net worth" : ""}
        </span>
      </div>
      {history.length > 2 ? <Sparkline values={history} tone={account.balance >= 0 ? "--c3" : "--c9"} /> : null}
      <span className="num bold" style={{ width: 120, textAlign: "right" }}>
        <Money value={account.balance} cents={false} />
      </span>
      <ChevronRight size={15} className="faint" />
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
