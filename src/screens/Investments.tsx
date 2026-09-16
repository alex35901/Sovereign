import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Link } from "react-router-dom";
import type { AssetClass, Holding, ISODate } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel, today } from "../lib/date";
import { fmtPct } from "../lib/money";
import { ASSET_CLASS_LABEL, accountOptions, balanceAt, earliestHistoryDate, holdingCost, holdingValue, portfolioSummary, trendTone } from "../lib/select";
import { Donut } from "../components/charts";
import { BalanceChart, ScopeBar } from "../components/BalanceChart";
import { Btn, Card, CardHead, Empty, Field, Modal, Money, MoneyInput, Segmented, SelectInput, TextInput, cx } from "../components/ui";
import { MAX_TICKERS } from "../lib/prices";
import { isSymbol } from "../lib/symbol";
import type { GroupBy } from "../lib/holdings";
import { GROUPINGS, groupHoldings, groupReturn, holdingTickers, periodReturn } from "../lib/holdings";
import { MIX_AS_OF, lookThrough } from "../lib/funds";
import type { PriceHistory } from "../lib/benchmarks";
import { BENCHMARKS, benchmarkByTicker, emptyHistory, fetchHistories, historyFloor, mergeCloses, needsFetch, nextTone, rebase, returnSeries } from "../lib/benchmarks";
import { loadHistory, saveHistory } from "../lib/benchmark-store";
import type { RangeKey } from "../lib/range";
import { rangeStart, sampleDates, sampleLabel, spanDays } from "../lib/range";
import { SPANS } from "../components/BalanceChart";

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
   * Accounts whose positions are this app's to edit.
   *
   * Plaid sends holdings, and a sync replaces every holding on an account it
   * reports for — so a position edited on one of those accounts quietly
   * reverts the next morning, and an Edit button there is a promise the app
   * cannot keep. SimpleFIN sends none at all, and an account entered by hand
   * has nobody else to speak for it, so both keep theirs.
   */
  const ownHoldings = useMemo(
    () => p.invAccounts.filter((a) => a.syncSource !== "plaid"),
    [p.invAccounts],
  );

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

  const [groupBy, setGroupBy] = useState<GroupBy>("account");

  /**
   * Every symbol the page needs closes for: the lines a reader has chosen,
   * and every position in the table, because each row now says what it did
   * over the period. Asked for together so the fetch below can batch them.
   */
  const wanted = useMemo(() => {
    const out = new Set(holdingTickers(db, MAX_TICKERS));
    for (const t of picked) out.add(t);
    return [...out];
  }, [db, picked]);

  const market = useHistories(wanted, db.settings.tiingoApiKey ?? "");

  const groups = useMemo(
    () => groupHoldings(p.invAccounts, p.holdings, groupBy),
    [p.invAccounts, p.holdings, groupBy],
  );
  const periodLabel = SPANS.find((x) => x.value === range)?.period ?? range;
  const accountOf = useMemo(() => new Map(p.invAccounts.map((a) => [a.id, a])), [p.invAccounts]);

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
        primary={ownHoldings.length
          ? <Btn variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> <span className="btn-label">Holding</span></Btn>
          : undefined}
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

        <div className="row wrap hold-controls">
          <h2 className="grow">Holdings</h2>
          <SelectInput
            value={groupBy} onChange={(v) => setGroupBy(v as GroupBy)} options={GROUPINGS}
          />
        </div>

        {groups.map((g) => {
          const rows = g.rows;
          const a = g.account;
          const moved = groupReturn(rows, market.data, span.start, span.end);
          return (
            <Card key={g.key} pad={false}>
              <CardHead
                flush title={g.label}
                // Said out loud, or a card with no way to edit anything on it
                // looks broken rather than looked after.
                sub={a?.syncSource === "plaid" ? `${g.sub} · positions come from the sync` : g.sub}
                right={
                  <span className="row" style={{ gap: 12 }}>
                    {moved === null ? null : (
                      <span className={cx("small num", moved < 0 ? "neg" : "pos")}>
                        {moved < 0 ? "-" : "+"}{fmtPct(Math.abs(moved) * 100)}
                      </span>
                    )}
                    <span className="num bold"><Money value={rows.length || !a ? g.value : a.balance} cents={false} /></span>
                  </span>
                }
              />
              {rows.length ? (
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl tbl-holdings">
                    <thead>
                      <tr>
                        <th className="hold-pick" />
                        <th className="hold-name">Holding</th>
                        <th>Shares</th>
                        <th>Price</th>
                        <th>Cost basis</th>
                        <th>Value</th>
                        <th>Gain</th>
                        {/* Named for the period the chart is showing, and it
                            moves with it — the whole table answers the same
                            question the range pills just asked. */}
                        <th>Past {periodLabel}</th>
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
                        const moved = periodReturn(market.data[sym], span.start, span.end);
                        // Asked of the row's own account rather than the
                        // group's: a group cut by asset class holds rows from
                        // several accounts, and only some of them may be the
                        // provider's to speak for.
                        const synced = accountOf.get(h.accountId)?.syncSource === "plaid";
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
                            <td className="hold-name">
                              <div className="col" style={{ gap: 0 }}>
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
                            <td className={cx("num", moved !== null && moved < 0 ? "neg" : moved !== null ? "pos" : "faint")}>
                              {moved === null ? "-" : `${moved < 0 ? "-" : "+"}${fmtPct(Math.abs(moved) * 100)}`}
                            </td>
                            <td>
                              {synced ? null : <Btn size="sm" variant="ghost" onClick={() => setEditing(h)}>Edit</Btn>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : a ? (
                <div style={{ padding: 16 }}>
                  <span className="small faint">
                    No positions recorded. The account balance of <Money value={a.balance} cents={false} /> still counts toward net worth.
                  </span>
                </div>
              ) : null}
            </Card>
          );
        })}

        {!p.invAccounts.length ? (
          <Card>
            <Empty title="No investment accounts" body="Add a brokerage or retirement account first, then record its holdings here." />
          </Card>
        ) : null}

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

    // Symbols wanting the same window travel together. Most do: either they
    // are all new, or they all need the same few days on the end.
    const byWindow = new Map<string, { from: ISODate; to: ISODate; tickers: string[] }>();
    for (const t of fresh) {
      const want = needsFetch(cached[t], historyFloor(), today());
      if (!want) { busy.current.delete(t); continue; }
      const key = `${want.from}|${want.to}`;
      const bucket = byWindow.get(key) ?? { ...want, tickers: [] };
      bucket.tickers.push(t);
      byWindow.set(key, bucket);
    }

    let failed = false;
    for (const { from, to, tickers: batch } of byWindow.values()) {
      try {
        const rows = await fetchHistories(apiKey, batch, from, to);
        const at = new Date().toISOString();
        const merged: Record<string, PriceHistory> = {};
        for (const t of batch) {
          const next = mergeCloses(cached[t].dates.length ? cached[t] : emptyHistory(t), rows[t] ?? [], at);
          // Stamped even when the provider had nothing new, or a quiet market
          // puts the page into a request loop.
          saveHistory(next);
          if (!next.dates.length) failed = true;
          merged[t] = next;
        }
        setData((cur) => ({ ...cur, ...merged }));
      } catch {
        failed = true;
      } finally {
        for (const t of batch) busy.current.delete(t);
      }
    }
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
/**
 * What the portfolio is made of, with the funds opened up.
 *
 * Four tickers is four slices and answers nothing, because three of them are
 * funds and a fund is a portfolio of its own. Looked through by default, since
 * the true split is the answer to the question anybody is asking of a pie
 * chart, with the recorded view a click away for anyone who wants to see the
 * tickers as they hold them.
 *
 * The coverage line under it is not an apology, it is the reading: a chart
 * built half from published weights and half from whatever somebody tagged a
 * position is worth knowing about before anybody rebalances off it.
 */
function Allocation({ p }: { p: ReturnType<typeof portfolioSummary> }) {
  const [through, setThrough] = useState(true);
  const opened = useMemo(() => lookThrough(p.holdings), [p.holdings]);

  if (!p.byClass.length) {
    return (
      <div className="alloc-panel">
        <Empty title="No holdings recorded yet" body="Add positions to see how the portfolio is split." />
      </div>
    );
  }

  const slices = through
    ? opened.slices.map((c) => ({
        label: ASSET_CLASS_LABEL[c.key] ?? c.key,
        value: c.value,
        tone: CLASS_TONES[c.key] ?? "--c10",
      }))
    : p.byClass.map((c) => ({ label: c.label, value: c.value, tone: CLASS_TONES[c.key] ?? "--c10" }));

  const total = opened.seen + opened.faceValue;
  const pctSeen = total > 0 ? (opened.seen / total) * 100 : 0;

  return (
    <div className="alloc-panel">
      <div className="alloc-switch">
        <Segmented
          value={through ? "through" : "recorded"}
          options={[
            { value: "through", label: "What it holds" },
            { value: "recorded", label: "As recorded" },
          ]}
          onChange={(v) => setThrough(v === "through")}
        />
      </div>
      <Donut
        size={190}
        slices={slices}
        center={<div className="col" style={{ gap: 0 }}>
          <span className="tiny muted">Holdings</span>
          <Money value={p.value} cents={false} className="bold" style={{ fontSize: 18 }} />
        </div>}
      />
      {through ? (
        <div className="alloc-note">
          <span className="tiny faint">
            {opened.seen === 0
              ? "None of these are funds this app has published weights for, so every position counts as it was recorded."
              : opened.faceValue === 0
                ? `Every position opened up, using allocations published as of ${MIX_AS_OF}.`
                : `${Math.round(pctSeen)}% opened up using allocations published as of ${MIX_AS_OF}. The rest counts as recorded: ${opened.unknown.slice(0, 4).map((u) => u.ticker).join(", ")}${opened.unknown.length > 4 ? ` and ${opened.unknown.length - 4} more` : ""}.`}
          </span>
        </div>
      ) : null}
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

const CLASS_OPTIONS = Object.entries(ASSET_CLASS_LABEL).map(([value, label]) => ({ value: value as AssetClass, label }));

function HoldingModal({ holding, onClose, onDelete }: { holding?: Holding; onClose: () => void; onDelete?: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  // Same rule as the page: an account whose positions the sync owns is not
  // one a holding can be filed under, because the next pull would drop it.
  const invAccounts = db.accounts.filter(
    (a) => ["investment", "retirement", "crypto"].includes(a.type) && a.syncSource !== "plaid",
  );
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
