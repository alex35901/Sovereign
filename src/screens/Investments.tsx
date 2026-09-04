import { useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import type { AssetClass, Holding } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, today } from "../lib/date";
import { fmtPct } from "../lib/money";
import { ASSET_CLASS_LABEL, balanceAt, earliestHistoryDate, holdingCost, holdingValue, portfolioSummary, trendTone } from "../lib/select";
import { AreaChart, Donut } from "../components/charts";
import { Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, SelectInput, TextInput, Tile, cx } from "../components/ui";
import { RangePicker } from "../components/pickers";
import { priceSummary, refreshPrices, tickersOf } from "../lib/prices";
import type { RangeKey } from "../lib/range";
import { rangeStart, sampleDates, sampleLabel, spanDays } from "../lib/range";

const CLASS_TONES: Record<string, string> = {
  us_equity: "--c2", intl_equity: "--c4", bond: "--c12", cash: "--c3",
  crypto: "--c5", real_estate: "--c1", other: "--c10",
};

export default function Investments() {
  const db = useDB();
  const { actions } = useStore();
  const [range, setRange] = useState<RangeKey>("1y");
  const [editing, setEditing] = useState<Holding | null>(null);
  const [adding, setAdding] = useState(false);
  const p = useMemo(() => portfolioSummary(db), [db]);

  const series = useMemo(() => {
    const earliest = earliestHistoryDate(p.invAccounts);
    const from = rangeStart(range, earliest);
    const start = earliest && earliest > from ? earliest : from;
    const end = today();
    const days = spanDays(start, end);
    return sampleDates(start, end).map((d) => ({
      label: sampleLabel(d, days),
      value: p.invAccounts.reduce((sum, a) => sum + balanceAt(a, d), 0),
      sub: dateLabel(d, { year: true }),
    }));
  }, [p.invAccounts, range]);

  const portfolioTone = trendTone(series.map((x) => x.value));

  const start = series[0]?.value ?? 0;
  const growth = p.accountsValue - start;

  return (
    <>
      <TopBar
        title="Investments"
        primary={<Btn variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> <span className="btn-label">Holding</span></Btn>}
      />
      <div className="page stack">
        <div className="grid g4">
          <Tile label="Portfolio value" value={<Money value={p.accountsValue} cents={false} />}
            sub={<span className="muted">{p.invAccounts.length} accounts</span>} />
          <Tile label="Holdings value" value={<Money value={p.value} cents={false} />}
            sub={<span className="muted">{p.holdings.length} positions</span>} />
          <Tile label="Total gain" value={<Money value={p.gain} cents={false} />} tone={p.gain >= 0 ? "pos" : "neg"}
            sub={<span className={p.gain >= 0 ? "pos" : "neg"}>{fmtPct(p.gainPct)} vs cost basis</span>} />
          <Tile label="Change over period" value={<Money value={growth} cents={false} sign={growth >= 0} />}
            tone={growth >= 0 ? "pos" : "neg"} />
        </div>

        <div className="grid g-2-1">
          <Card>
            <CardHead title="Portfolio value" sub="Brokerage plus retirement balances" right={<RangePicker value={range} onChange={setRange} />} />
            {/* Same rule as net worth: green if the period ended above where
                it opened, red if below, and the dashed line says where that
                was. */}
            <AreaChart
              points={series} height={240} startLine
              tone={portfolioTone} negativeTone={portfolioTone}
            />
          </Card>
          <Card>
            <CardHead title="Allocation" sub="By asset class" />
            {p.byClass.length ? (
              <Donut
                size={150}
                slices={p.byClass.map((c) => ({ label: c.label, value: c.value, tone: CLASS_TONES[c.key] ?? "--c10" }))}
                center={<div className="col" style={{ gap: 0 }}>
                  <span className="tiny muted">Holdings</span>
                  <Money value={p.value} cents={false} className="bold" />
                </div>}
              />
            ) : <Empty title="No holdings yet" body="Add positions to see allocation." />}
          </Card>
        </div>

        {p.invAccounts.map((a) => {
          const rows = p.holdings.filter((h) => h.accountId === a.id);
          const value = rows.reduce((s, h) => s + holdingValue(h), 0);
          return (
            <Card key={a.id} pad={false}>
              <CardHead
                flush title={a.name} sub={a.institution}
                right={<span className="num bold"><Money value={rows.length ? value : a.balance} cents={false} /></span>}
              />
              {rows.length ? (
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Holding</th>
                        <th className="right">Shares</th>
                        <th className="right">Price</th>
                        <th className="right">Cost basis</th>
                        <th className="right">Value</th>
                        <th className="right">Gain</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((h) => {
                        const val = holdingValue(h);
                        const cost = holdingCost(h);
                        const gain = val - cost;
                        return (
                          <tr key={h.id}>
                            <td>
                              <div className="col" style={{ gap: 0 }}>
                                <span className="bold">{h.ticker}</span>
                                <span className="tiny faint truncate" style={{ maxWidth: 240 }}>{h.name}</span>
                              </div>
                            </td>
                            <td className="right num">{h.quantity.toLocaleString("en-US", { maximumFractionDigits: 3 })}</td>
                            <td className="right num"><Money value={h.price} /></td>
                            <td className="right num muted"><Money value={cost} cents={false} /></td>
                            <td className="right num bold"><Money value={val} cents={false} /></td>
                            <td className={cx("right num", gain >= 0 ? "pos" : "neg")}>
                              <Money value={gain} cents={false} sign={gain >= 0} />
                              <div className="tiny">{cost ? fmtPct((gain / cost) * 100) : "—"}</div>
                            </td>
                            <td className="right">
                              <Btn size="sm" variant="ghost" onClick={() => setEditing(h)}>Edit</Btn>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ padding: 16 }}>
                  <span className="small faint">
                    No positions recorded — the account balance of <Money value={a.balance} cents={false} /> still counts toward net worth.
                  </span>
                </div>
              )}
            </Card>
          );
        })}

        {!p.invAccounts.length ? (
          <Card>
            <Empty title="No investment accounts" body="Add a brokerage or retirement account first, then record its holdings here." />
          </Card>
        ) : null}

        <PricesCard />
      </div>

      {editing || adding ? (
        <HoldingModal
          holding={editing ?? undefined}
          onClose={() => { setEditing(null); setAdding(false); }}
          onDelete={editing ? () => { actions.deleteHolding(editing.id); setEditing(null); } : undefined}
        />
      ) : null}
    </>
  );
}

/**
 * Where prices come from, and how to get fresh ones.
 *
 * Holdings that Tiingo has no quote for keep whatever price was typed in, so
 * this names them rather than leaving someone to work out why one row is stale.
 */
function PricesCard() {
  const db = useDB();
  const { apply, notify } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [misses, setMisses] = useState<string[] | null>(null);

  const key = db.settings.tiingoApiKey ?? "";
  const tickers = tickersOf(db.holdings);
  const last = db.settings.lastPricesAt;

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await refreshPrices(db, apply, "refresh prices");
      setMisses(outcome.misses);
      notify(priceSummary(outcome));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The price refresh failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!key.trim()) {
    return (
      <Card>
        <CardHead title="Prices" sub="Typed in by hand" />
        <span className="small muted">
          Every price above is whatever was last entered on the holding. Add a free Tiingo token under{" "}
          <Link to="/settings" className="link">Settings &rarr; Integrations</Link> and they refresh
          themselves each morning, alongside the account sync.
        </span>
      </Card>
    );
  }

  return (
    <Card>
      <CardHead
        title="Prices"
        sub="Previous close, from Tiingo"
        right={
          <Btn onClick={() => void refresh()} disabled={busy || !tickers.length}>
            <RefreshCw size={14} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
            {busy ? "Refreshing…" : "Refresh prices"}
          </Btn>
        }
      />
      <span className="small muted">
        {tickers.length
          ? <>{tickers.length} symbol{tickers.length === 1 ? "" : "s"} priced{" "}
            {last ? <>&mdash; last checked {dateLabel(last.slice(0, 10), { year: true })}</> : "— not checked yet"}.</>
          : <>No holdings carry a ticker yet, so there is nothing to price.</>}
      </span>
      {misses?.length ? (
        <div className="tiny faint" style={{ marginTop: 8 }}>
          No quote for {misses.join(", ")} — those keep the price entered on the holding.
        </div>
      ) : null}
      {error ? <div className="small neg" style={{ marginTop: 8 }}>{error}</div> : null}
    </Card>
  );
}

const CLASS_OPTIONS = Object.entries(ASSET_CLASS_LABEL).map(([value, label]) => ({ value: value as AssetClass, label }));

function HoldingModal({ holding, onClose, onDelete }: { holding?: Holding; onClose: () => void; onDelete?: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  const invAccounts = db.accounts.filter((a) => ["investment", "retirement", "crypto"].includes(a.type));
  const [accountId, setAccountId] = useState(holding?.accountId ?? invAccounts[0]?.id ?? "");
  const [ticker, setTicker] = useState(holding?.ticker ?? "");
  const [name, setName] = useState(holding?.name ?? "");
  const [quantity, setQuantity] = useState(String(holding?.quantity ?? ""));
  const [price, setPrice] = useState(holding?.price ?? 0);
  const [costBasis, setCostBasis] = useState(holding?.costBasis ?? 0);
  const [assetClass, setAssetClass] = useState<AssetClass>(holding?.assetClass ?? "us_equity");

  const save = () => {
    const payload = {
      accountId, ticker: ticker.trim().toUpperCase(), name: name.trim() || ticker.trim().toUpperCase(),
      quantity: Number.parseFloat(quantity) || 0, price, costBasis, assetClass,
    };
    if (holding) actions.updateHolding(holding.id, payload);
    else actions.addHolding(payload);
    onClose();
  };

  return (
    <Modal
      title={holding ? "Edit holding" : "Add holding"}
      onClose={onClose}
      footer={
        <>
          {onDelete ? <Btn variant="danger" onClick={() => { onDelete(); onClose(); }}>Delete</Btn> : null}
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={!accountId || !ticker.trim()}>Save</Btn>
        </>
      }
    >
      <Field label="Account">
        <SelectInput value={accountId} onChange={setAccountId} options={invAccounts.map((a) => ({ value: a.id, label: a.name }))} />
      </Field>
      <div className="row" style={{ gap: 12 }}>
        <Field label="Ticker"><TextInput value={ticker} onChange={setTicker} placeholder="VTI" autoFocus /></Field>
        <Field label="Name"><TextInput value={name} onChange={setName} placeholder="Vanguard Total Stock Market ETF" /></Field>
      </div>
      <div className="row" style={{ gap: 12 }}>
        <Field label="Shares"><TextInput value={quantity} onChange={setQuantity} placeholder="118.42" /></Field>
        <Field label="Price per share"><MoneyInput value={price} onChange={setPrice} /></Field>
        <Field label="Cost per share"><MoneyInput value={costBasis} onChange={setCostBasis} /></Field>
      </div>
      <Field label="Asset class">
        <SelectInput value={assetClass} onChange={setAssetClass} options={CLASS_OPTIONS} />
      </Field>
    </Modal>
  );
}
