import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import type { AssetClass, Holding } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, today } from "../lib/date";
import { fmtPct } from "../lib/money";
import { ASSET_CLASS_LABEL, accountOptions, balanceAt, earliestHistoryDate, holdingCost, holdingValue, portfolioSummary, trendTone } from "../lib/select";
import { Donut } from "../components/charts";
import { BalanceChart, ScopeBar } from "../components/BalanceChart";
import { Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, SelectInput, TextInput, cx } from "../components/ui";
import { priceSummary, refreshPrices, tickersOf } from "../lib/prices";
import { isSymbol } from "../lib/symbol";
import type { PriceHistory } from "../lib/benchmarks";
import { BENCHMARKS, benchmarkByTicker, emptyHistory, fetchHistory, historyFloor, mergeCloses, needsFetch, nextTone, rebase, returnSeries } from "../lib/benchmarks";
import { loadHistory, saveHistory } from "../lib/benchmark-store";
import type { RangeKey } from "../lib/range";
import { rangeStart, sampleDates, sampleLabel, spanDays } from "../lib/range";

const CLASS_TONES: Record<string, string> = {
  us_equity: "--c2", intl_equity: "--c4", bond: "--c12", cash: "--c3",
  crypto: "--c5", real_estate: "--c1", other: "--c10",
};

/**
 * The two questions the top of this screen answers.
 *
 * One control, the same one the accounts screen uses to pick a kind, because
 * "what is it worth over time" and "what is it made of" are two views of one
 * portfolio rather than two cards competing for the same width.
 */
const VIEWS = [
  { key: "value", label: "Portfolio value" },
  { key: "allocation", label: "Allocation" },
];

export default function Investments() {
  const db = useDB();
  const { actions } = useStore();
  const [range, setRange] = useState<RangeKey>("1y");
  const [view, setView] = useState("value");
  const [editing, setEditing] = useState<Holding | null>(null);
  const [adding, setAdding] = useState(false);
  const p = useMemo(() => portfolioSummary(db), [db]);

  /**
   * What else is on the chart, in the order it was put there.
   *
   * Tickers, because a benchmark and a holding are the same question of the
   * same provider once you have one. The colour is decided when a line is
   * added and carried with it, so removing one does not repaint the rest.
   */
  const [picks, setPicks] = useState<{ ticker: string; label: string; tone: string }[]>([]);
  const toggle = useCallback((ticker: string, label: string) => {
    setPicks((cur) => {
      if (cur.some((x) => x.ticker === ticker)) return cur.filter((x) => x.ticker !== ticker);
      // One symbol is one line, however it was reached. A holding of VTI and
      // the US Stocks benchmark are the same series, so they share a colour
      // and a name rather than appearing twice in different clothes.
      const bench = benchmarkByTicker(ticker);
      return [...cur, {
        ticker,
        label: bench?.label ?? label,
        tone: bench?.tone ?? nextTone(cur.map((x) => x.tone)),
      }];
    });
  }, []);
  const picked = useMemo(() => picks.map((x) => x.ticker), [picks]);

  const span = useMemo(() => {
    const earliest = earliestHistoryDate(p.invAccounts);
    const from = rangeStart(range, earliest);
    const start = earliest && earliest > from ? earliest : from;
    return { start, end: today(), dates: sampleDates(start, today()) };
  }, [p.invAccounts, range]);

  const series = useMemo(() => {
    const days = spanDays(span.start, span.end);
    return span.dates.map((d) => ({
      label: sampleLabel(d, days),
      value: p.invAccounts.reduce((sum, a) => sum + balanceAt(a, d), 0),
      sub: dateLabel(d, { year: true }),
    }));
  }, [p.invAccounts, span]);

  const values = useMemo(() => series.map((x) => x.value), [series]);

  const market = useHistories(picked, db.settings.tiingoApiKey ?? "");

  /**
   * Every line rebased to where the period opened.
   *
   * The portfolio's shape does not change — dividing a series by its own first
   * value is a rescale, not a reshape — so the chart looks the same and the
   * others simply join it. What changes is what the axis means, and since this
   * chart carries no axis, nothing on screen has to explain itself.
   */
  const compare = useMemo(() => picks.map((pick) => {
    const h = market.data[pick.ticker];
    // Kept in the list even with nothing behind it. A symbol the provider has
    // never heard of — a private fund, a stable-value option in a 401(k) —
    // otherwise lights its marker and then draws nothing, with no line and no
    // word about why. A run of nulls draws nothing and says "no reading".
    const theirs = h && h.dates.length ? returnSeries(h, span.dates) : span.dates.map(() => null);
    const last = [...theirs].reverse().find((v) => v !== null) ?? null;
    return { values: theirs, tone: pick.tone, label: pick.label, pct: last };
  }), [picks, market.data, span.dates]);

  const shownPoints = useMemo(() => {
    if (!compare.length) return series;
    const pct = rebase(values);
    return series.map((s, i) => ({ ...s, value: pct[i] }));
  }, [series, values, compare]);

  return (
    <>
      <TopBar
        title="Investments"
        primary={<Btn variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> <span className="btn-label">Holding</span></Btn>}
      />
      <div className="page stack">
        {/* The same card the accounts screen leads with: the figure, how it
            moved over the period, and a line you can put a finger on. The four
            tiles that used to sit above it said the same things in worse
            places — the period's change is the line's own subject, and what
            the portfolio holds is the other view of this card. */}
        <Card pad={false} className="nw-card">
          <ScopeBar slices={VIEWS} value={view} onChange={setView} />
          {view === "value" ? (
            <BalanceChart
              total={p.accountsValue} series={values} points={shownPoints}
              tone={trendTone(values)} range={range} onRange={setRange}
              compare={compare.length ? compare : undefined}
              under={<Against picked={picked} onToggle={toggle} state={market.state} />}
            />
          ) : (
            <Allocation p={p} />
          )}
        </Card>

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
                  <table className="tbl tbl-holdings">
                    <thead>
                      <tr>
                        <th className="hold-pick" />
                        <th>Holding</th>
                        <th>Shares</th>
                        <th>Price</th>
                        <th>Cost basis</th>
                        <th>Value</th>
                        <th>Gain</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((h) => {
                        const val = holdingValue(h);
                        const cost = holdingCost(h);
                        const gain = val - cost;
                        const sym = h.ticker.trim().toUpperCase();
                        const on = picks.find((x) => x.ticker === sym);
                        return (
                          <tr key={h.id}>
                            <td className="hold-pick">
                              {/* A position is a price series like any other,
                                  so it goes on the chart the same way a
                                  benchmark does. Only one that carries a
                                  symbol: there is nothing to ask a provider
                                  about a holding typed in by hand. */}
                              {isSymbol(sym) ? (
                                <button
                                  className={cx("hold-dot", on && "on")}
                                  style={on ? { background: `var(${on.tone})`, borderColor: `var(${on.tone})` } : undefined}
                                  aria-pressed={Boolean(on)}
                                  title={on ? `Take ${sym} off the chart` : `Put ${sym} on the chart`}
                                  aria-label={on ? `Take ${sym} off the chart` : `Put ${sym} on the chart`}
                                  onClick={() => toggle(sym, sym)}
                                />
                              ) : null}
                            </td>
                            <td>
                              <div className="col" style={{ gap: 0, alignItems: "center" }}>
                                <span className="bold">{h.ticker}</span>
                                <span className="tiny faint truncate" style={{ maxWidth: 240 }}>{h.name}</span>
                              </div>
                            </td>
                            <td className="num">{h.quantity.toLocaleString("en-US", { maximumFractionDigits: 3 })}</td>
                            <td className="num"><Money value={h.price} /></td>
                            <td className="num muted"><Money value={cost} cents={false} /></td>
                            <td className="num bold"><Money value={val} cents={false} /></td>
                            <td className={cx("num", gain >= 0 ? "pos" : "neg")}>
                              <Money value={gain} cents={false} sign={gain >= 0} />
                              <div className="tiny">{cost ? fmtPct((gain / cost) * 100) : "-"}</div>
                            </td>
                            <td>
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
                    No positions recorded. The account balance of <Money value={a.balance} cents={false} /> still counts toward net worth.
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

type FetchState = "idle" | "loading" | "error" | "nokey";

/**
 * Closing prices for every symbol on the chart, from this browser and the wire.
 *
 * The cache answers first and the chart draws immediately from whatever is
 * already there, however old; the fetch only ever fills in what is missing.
 * That matters because the window moves with the range pills, and a reader
 * flicking between 1M and 5Y should not watch the lines empty themselves.
 */
function useHistories(tickers: readonly string[], apiKey: string) {
  const [data, setData] = useState<Record<string, PriceHistory>>({});
  const [state, setState] = useState<FetchState>("idle");
  // Which symbols are already in flight, so a second render does not spend a
  // second request on an answer that is already on its way.
  const busy = useRef<Set<string>>(new Set());
  const key = tickers.join(",");

  const load = useCallback(async (symbols: string[]) => {
    if (!symbols.length) { setState("idle"); return; }

    const cached: Record<string, PriceHistory> = {};
    for (const t of symbols) cached[t] = loadHistory(t);
    setData((cur) => ({ ...cur, ...cached }));

    const short = symbols.filter((t) => needsFetch(cached[t], historyFloor(), today()));
    if (!short.length) { setState("idle"); return; }
    if (!apiKey.trim()) { setState("nokey"); return; }

    const fresh = short.filter((t) => !busy.current.has(t));
    if (!fresh.length) return;
    for (const t of fresh) busy.current.add(t);
    // Only a symbol with nothing behind it puts the card into a waiting state:
    // one already drawn from cache should not blink while its tail arrives.
    setState(fresh.some((t) => !cached[t].dates.length) ? "loading" : "idle");

    let failed = false;
    await Promise.all(fresh.map(async (t) => {
      const want = needsFetch(cached[t], historyFloor(), today());
      if (!want) return;
      try {
        const rows = await fetchHistory(apiKey, t, want.from, want.to);
        const merged = mergeCloses(cached[t].dates.length ? cached[t] : emptyHistory(t), rows, new Date().toISOString());
        // Stamped even when the provider had nothing new, or a quiet market
        // puts the page into a request loop.
        saveHistory(merged);
        if (!merged.dates.length) failed = true;
        setData((cur) => ({ ...cur, [t]: merged }));
      } catch {
        failed = true;
      } finally {
        busy.current.delete(t);
      }
    }));
    setState(failed ? "error" : "idle");
  }, [apiKey]);

  useEffect(() => {
    void load(key ? key.split(",") : []);
  }, [key, load]);

  return { data, state };
}

/** The market lines on offer, none of them on by default. */
function Against({ picked, onToggle, state }: {
  picked: readonly string[]; onToggle: (ticker: string, label: string) => void; state: FetchState;
}) {
  return (
    <div className="against">
      <div className="against-line">
        {/* Outside the scrolling run, or picking the last of them scrolls the
            word that explains them off the left edge of a phone. */}
        <span className="tiny faint against-label">Compare with</span>
        <div className="against-row">
          {BENCHMARKS.map((b) => {
            const on = picked.includes(b.ticker);
            return (
              <button
                key={b.key} className={cx("against-pill", on && "on")} aria-pressed={on}
                onClick={() => onToggle(b.ticker, b.label)}
              >
                <span className="dot" style={{ background: `var(${b.tone})` }} />
                {b.label}
              </button>
            );
          })}
        </div>
      </div>
      {picked.length && state !== "idle" ? (
        <span className="tiny faint against-note">
          {state === "loading" ? "Fetching closing prices…"
            : state === "nokey" ? <>Add a Tiingo token under <Link to="/settings" className="link">Settings &rarr; Integrations</Link> to compare against the market.</>
            : "Some closing prices could not be fetched. The lines that did arrive are unchanged."}
        </span>
      ) : null}
    </div>
  );
}

/**
 * What the portfolio is made of, as the other half of the card above it.
 *
 * It carries the two figures the tiles used to: what the holdings come to,
 * in the middle of the ring, and what they have made against what was paid
 * for them, underneath. Both are facts about today rather than about a
 * period, which is why they belong on this side of the switch and not beside
 * a chart with a date range on it.
 */
function Allocation({ p }: { p: ReturnType<typeof portfolioSummary> }) {
  if (!p.byClass.length) {
    return (
      <div className="alloc-panel">
        <Empty title="No holdings recorded yet" body="Add positions to see how the portfolio is split." />
      </div>
    );
  }
  return (
    <div className="alloc-panel">
      <Donut
        size={190}
        slices={p.byClass.map((c) => ({ label: c.label, value: c.value, tone: CLASS_TONES[c.key] ?? "--c10" }))}
        center={<div className="col" style={{ gap: 0 }}>
          <span className="tiny muted">Holdings</span>
          <Money value={p.value} cents={false} className="bold" style={{ fontSize: 18 }} />
        </div>}
      />
      <div className="alloc-foot spread small">
        <span className="muted">{p.holdings.length} position{p.holdings.length === 1 ? "" : "s"} across {p.invAccounts.length} account{p.invAccounts.length === 1 ? "" : "s"}</span>
        <span className="row" style={{ gap: 7 }}>
          <span className={p.gain >= 0 ? "pos" : "neg"}>
            {p.gain >= 0 ? "↗" : "↘"} <Money value={p.gain} cents={false} />
            {p.cost ? ` (${fmtPct(p.gainPct)})` : ""}
          </span>
          <span className="faint">against what was paid</span>
        </span>
      </div>
    </div>
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
            {last ? <>, last checked {dateLabel(last.slice(0, 10), { year: true })}</> : ", not checked yet"}.</>
          : <>No holdings carry a ticker yet, so there is nothing to price.</>}
      </span>
      {misses?.length ? (
        <div className="tiny faint" style={{ marginTop: 8 }}>
          No quote for {misses.join(", ")}. Those keep the price entered on the holding.
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
        <SelectInput value={accountId} onChange={setAccountId} options={accountOptions(invAccounts)} />
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
