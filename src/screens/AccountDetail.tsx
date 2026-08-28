import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, lastMonths, monthLabel, monthEnd, today } from "../lib/date";
import { ACCOUNT_TYPE_LABEL, balanceAt } from "../lib/select";
import { canValue } from "../lib/property";
import { AreaChart } from "../components/charts";
import { Btn, Card, CardHead, Empty, Money, MoneyInput, Tile } from "../components/ui";
import { CategoryTag, RangePicker, rangeMonths } from "../components/pickers";
import type { RangeKey } from "../components/pickers";
import { MerchantAvatar } from "./Transactions";
import { AccountModal } from "./Accounts";
import { PropertyValueCard } from "./PropertyValueCard";
import { TransactionModal } from "./TransactionModal";
import type { Transaction } from "../types";

export default function AccountDetail() {
  const { id = "" } = useParams();
  const db = useDB();
  const { actions } = useStore();
  const nav = useNavigate();
  const [range, setRange] = useState<RangeKey>("6m");
  const [editing, setEditing] = useState(false);
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  const [newBalance, setNewBalance] = useState<number | null>(null);

  const account = db.accounts.find((a) => a.id === id);
  const txns = useMemo(
    () => db.transactions.filter((t) => t.accountId === id).slice(0, 60),
    [db.transactions, id],
  );
  const series = useMemo(() => {
    if (!account) return [];
    return lastMonths(rangeMonths(range) + 1).map((m) => ({
      label: monthLabel(m, true),
      value: balanceAt(account, monthEnd(m) > today() ? today() : monthEnd(m)),
    }));
  }, [account, range]);

  if (!account) {
    return (
      <>
        <TopBar title="Account" />
        <div className="page"><Card><Empty title="Account not found" action={<Link to="/accounts"><Btn>Back to accounts</Btn></Link>} /></Card></div>
      </>
    );
  }

  const monthTx = db.transactions.filter((t) => t.accountId === id && t.date >= monthEnd(lastMonths(1)[0]).slice(0, 8) + "01");
  const inflow = monthTx.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const outflow = monthTx.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);

  return (
    <>
      <TopBar
        title={account.name}
        actions={<Btn onClick={() => setEditing(true)}><Pencil size={14} /> Edit</Btn>}
      />
      <div className="page stack">
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => nav("/accounts")}>
          <ArrowLeft size={14} /> All accounts
        </button>

        <div className="grid g4">
          <Tile label="Current balance" value={<Money value={account.balance} cents={false} />}
            sub={<span className="muted">{account.institution} · {ACCOUNT_TYPE_LABEL[account.type]}</span>} />
          <Tile label="This month in" value={<Money value={inflow} cents={false} />} tone="pos" />
          <Tile label="This month out" value={<Money value={outflow} cents={false} />} tone="neg" />
          <Card>
            <div className="col" style={{ gap: 6 }}>
              <span className="tile-label">Update balance</span>
              <div className="row" style={{ gap: 6 }}>
                <MoneyInput value={newBalance ?? account.balance} onChange={setNewBalance} />
                <Btn
                  size="sm" variant="primary" disabled={newBalance === null || newBalance === account.balance}
                  onClick={() => { if (newBalance !== null) { actions.setAccountBalance(account.id, newBalance); setNewBalance(null); } }}
                >
                  Save
                </Btn>
              </div>
              <span className="tiny faint">
                {account.lastSyncedAt ? `Synced ${dateLabel(account.lastSyncedAt.slice(0, 10))}` : "Manual account — snapshots build the net-worth chart."}
              </span>
            </div>
          </Card>
        </div>

        {canValue(account.type) ? <PropertyValueCard account={account} /> : null}

        <Card>
          <CardHead title="Balance history" right={<RangePicker value={range} onChange={setRange} />} />
          <AreaChart points={series} height={220} tone="--c2" zeroBase />
        </Card>

        <Card pad={false}>
          <CardHead
            flush title="Transactions" sub={`${db.transactions.filter((t) => t.accountId === id).length} total`}
            right={<Link to={`/transactions?account=${account.id}`} className="link small">Open in Transactions</Link>}
          />
          {txns.map((t) => (
            <div key={t.id} className="list-row click" onClick={() => setEditTxn(t)}>
              <MerchantAvatar name={t.merchant} size={28} />
              <div className="grow col" style={{ gap: 0 }}>
                <span className="truncate" style={{ fontWeight: 500 }}>{t.merchant}</span>
                <span className="tiny faint">{dateLabel(t.date, { year: true })}</span>
              </div>
              <CategoryTag categoryId={t.categoryId} />
              <span className="num bold" style={{ width: 100, textAlign: "right" }}>
                <Money value={t.amount} colored={t.amount > 0} />
              </span>
            </div>
          ))}
          {!txns.length ? <Empty title="No transactions on this account" /> : null}
        </Card>
      </div>
      {editing ? <AccountModal account={account} onClose={() => setEditing(false)} /> : null}
      {editTxn ? <TransactionModal txn={editTxn} onClose={() => setEditTxn(null)} /> : null}
    </>
  );
}
