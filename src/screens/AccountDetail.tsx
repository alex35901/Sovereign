import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Download, MoreHorizontal, Pencil, Settings2, Upload, Wallet } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, today } from "../lib/date";
import { balanceAt, trendTone } from "../lib/select";
import { canValue } from "../lib/property";
import { balanceHistoryToCSV, toCSV } from "../lib/csv";
import { download } from "../lib/storage";
import { BalanceChart } from "../components/BalanceChart";
import { Btn, Card, CardHead, Empty, Modal, Money, Popover } from "../components/ui";
import { CategoryTag } from "../components/pickers";
import type { RangeKey } from "../lib/range";
import { rangeStart, sampleDates, sampleLabel, spanDays } from "../lib/range";
import { MerchantAvatar } from "./Transactions";
import { AccountModal } from "./Accounts";
import { PropertyValueCard } from "./PropertyValueCard";
import { VehicleValueCard } from "./VehicleValueCard";
import { BalanceImportModal } from "./BalanceImportModal";
import { BalancePointsCard } from "./BalancePointsCard";
import { AccountControls } from "./AccountControls";
import { TransactionModal } from "./TransactionModal";
import type { Transaction } from "../types";

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "account";

/** How many of the newest transactions the page shows before sending you on. */
const RECENT = 12;

export default function AccountDetail() {
  const { id = "" } = useParams();
  const db = useDB();
  const [range, setRange] = useState<RangeKey>("6m");
  const [editing, setEditing] = useState(false);
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  const [importing, setImporting] = useState(false);
  // Two panels that used to be cards halfway down the page. They are still the
  // same panels; they are just no longer between you and the transactions.
  const [points, setPoints] = useState(false);
  const [settings, setSettings] = useState(false);

  const account = db.accounts.find((a) => a.id === id);
  const mine = useMemo(
    () => db.transactions.filter((t) => t.accountId === id),
    [db.transactions, id],
  );

  const chart = useMemo(() => {
    if (!account) return { series: [] as number[], points: [] as { label: string; value: number; sub: string }[] };
    // Never plot before the account has any data — it would read as a run of
    // zero balances rather than as an account that did not exist yet.
    const earliest = account.history[0]?.date;
    const from = rangeStart(range, earliest);
    const start = earliest && earliest > from ? earliest : from;
    const end = today();
    const days = spanDays(start, end);
    const dates = sampleDates(start, end);
    return {
      series: dates.map((d) => balanceAt(account, d)),
      points: dates.map((d) => ({
        label: sampleLabel(d, days),
        value: balanceAt(account, d),
        sub: dateLabel(d, { year: true }),
      })),
    };
  }, [account, range]);

  if (!account) {
    return (
      <>
        <TopBar title="Account" back={{ to: "/accounts", label: "All accounts" }} />
        <div className="page"><Card><Empty title="Account not found" action={<Link to="/accounts"><Btn>Back to accounts</Btn></Link>} /></Card></div>
      </>
    );
  }

  return (
    <>
      <TopBar
        title={`${account.name}${account.mask ? ` (…${account.mask})` : ""}`}
        back={{ to: "/accounts", label: "All accounts" }}
        actions={
          /* Everything that is not the balance and its history lives behind
             the one button, so the page is a chart and a list of what happened
             — which is all anyone opens an account to see. */
          <Popover
            align="right" width={264}
            trigger={(open) => (
              <Btn onClick={open} title="More"><MoreHorizontal size={15} /></Btn>
            )}
          >
            {(close) => (
              <>
                <button onClick={() => { setEditing(true); close(); }}>
                  <Pencil size={14} /> Edit account details
                </button>
                <button onClick={() => { setPoints(true); close(); }}>
                  <Wallet size={14} /> Edit balance history
                </button>
                <button onClick={() => { setSettings(true); close(); }}>
                  <Settings2 size={14} /> Visibility and actions
                </button>
                <button onClick={() => { setImporting(true); close(); }}>
                  <Upload size={14} /> Import balance history
                </button>
                <button
                  onClick={() => {
                    download(`${slug(account.name)}-transactions.csv`, toCSV(db, mine), "text/csv");
                    close();
                  }}
                >
                  <Download size={14} /> Download transactions
                </button>
                <button
                  disabled={!account.history.length}
                  onClick={() => {
                    download(`${slug(account.name)}-balance-history.csv`, balanceHistoryToCSV(account), "text/csv");
                    close();
                  }}
                >
                  <Download size={14} /> Download balance history
                </button>
              </>
            )}
          </Popover>
        }
      />
      <div className="page stack">
        <Card pad={false} className="nw-card">
          <BalanceChart
            label="Current balance"
            total={account.balance} series={chart.series} points={chart.points}
            tone={trendTone(chart.series)} range={range} onRange={setRange}
          />
        </Card>

        {canValue(account.type) ? <PropertyValueCard account={account} /> : null}
        {account.type === "vehicle" ? <VehicleValueCard account={account} /> : null}

        <Card pad={false}>
          <CardHead flush title="Recent transactions" sub={`${mine.length} on this account`} />
          {mine.slice(0, RECENT).map((t) => (
            <div key={t.id} className="list-row click" onClick={() => setEditTxn(t)}>
              <MerchantAvatar name={t.merchant} size={28} />
              <div className="grow col" style={{ gap: 0 }}>
                <span className="truncate" style={{ fontWeight: 500 }}>{t.merchant}</span>
                <span className="tiny faint">{dateLabel(t.date, { year: true })}</span>
              </div>
              <span className="acct-txn-cat"><CategoryTag categoryId={t.categoryId} /></span>
              <span className="num bold" style={{ width: 100, textAlign: "right" }}>
                <Money value={t.amount} colored={t.amount > 0} />
              </span>
            </div>
          ))}
          {mine.length ? (
            <div style={{ padding: 12 }}>
              <Link to={`/transactions?account=${account.id}`} className="btn view-all">
                View all transactions
              </Link>
            </div>
          ) : (
            <Empty title="No transactions on this account" />
          )}
        </Card>
      </div>

      {editing ? <AccountModal account={account} onClose={() => setEditing(false)} /> : null}
      {importing ? <BalanceImportModal account={account} onClose={() => setImporting(false)} /> : null}
      {editTxn ? <TransactionModal txn={editTxn} onClose={() => setEditTxn(null)} /> : null}
      {points ? (
        <Modal wide flush title="Edit balance history" onClose={() => setPoints(false)}>
          <BalancePointsCard account={account} heading={false} />
        </Modal>
      ) : null}
      {settings ? (
        <Modal wide flush title={account.name} onClose={() => setSettings(false)}>
          <AccountControls account={account} />
        </Modal>
      ) : null}
    </>
  );
}
