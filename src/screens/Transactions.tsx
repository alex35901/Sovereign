import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { forget, keep, recall } from "../lib/session-view";
import { ArrowRight, CheckCheck, Download, EyeOff, Filter, ListChecks, Plus, Repeat, Search, Tag as TagIcon, Trash2, Upload, X } from "lucide-react";
import type { DB, Transaction } from "../types";
import { useDB, useStore } from "../store";
import { IconAction, TopBar } from "../shell/TopBar";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { dateLabel, monthLabel } from "../lib/date";
import { hash } from "../lib/id";
import { logoFor } from "../lib/merchant-domain";
import { toCSV } from "../lib/csv";
import { accountOptions, budgetedCategoryIds, budgetedSum, mutedAccountIds, recurringByMerchant } from "../lib/select";
import { cadenceLabel, recurringIdFor } from "../lib/recurring";
import type { BudgetedSum } from "../lib/select";
import { fmt } from "../lib/money";
import { filesIt } from "../lib/categories";
import { download } from "../lib/storage";
import { AmountBound, Btn, Card, Empty, Field, Money, Popover, SelectInput, TagPill, TextInput, cx } from "../components/ui";
import { CategoryPicker, CategoryTag } from "../components/pickers";
import type { DateFilter } from "../lib/date-filter";
import { amountMatches, hasAmountRange, inAmountRange, typedAmount } from "../lib/amount-filter";
import { ALL, FILTER_KINDS, PARAM_KEYS, bounds, fromParams, isNarrowed, toParams } from "../lib/date-filter";
import { TransactionModal } from "./TransactionModal";
import { ImportModal } from "./ImportModal";

/**
 * The mark next to a total that had something taken out of it.
 *
 * Without it the arithmetic on screen does not add up: a day showing a $40
 * lunch and a $2,000 card payment totals $40, and the only honest thing to do
 * is say why. Small and quiet because most days have nothing to say, and the
 * detail is on hover rather than in the column, which is 118px wide.
 */
function ExcludedNote({ sum }: { sum: BudgetedSum }) {
  const named = sum.excludedNames.slice(0, 3).join(", ");
  const rest = sum.excludedNames.length - 3;
  // Both sides of a transfer land on one day and cancel out, so the amount is
  // often zero while a great deal was left out. Count what was skipped, and
  // only quote a figure when there is one worth quoting.
  const amount = sum.excluded ? `${fmt(sum.excluded)} in ` : "";
  const rows = `${sum.excludedCount} ${sum.excludedCount === 1 ? "line" : "lines"}`;
  return (
    <span
      className="faint row excluded-note"
      style={{ flex: "none" }}
      aria-label={`excludes ${rows} in off-budget categories`}
      title={`Not counted: ${amount}${named}${rest > 0 ? ` and ${rest} more` : ""} (${rows}). `
        + "Transfers and categories set to Exclude from budget are left out, so money moved between your own accounts isn't counted as spending."}
    >
      <EyeOff size={11} style={{ flex: "none" }} />
    </span>
  );
}

const TONES = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8", "--c9", "--c10", "--c11", "--c12"];
export const merchantTone = (name: string): string => TONES[Number.parseInt(hash(name.toLowerCase()), 36) % TONES.length];

/**
 * The merchant's mark, with its initial as the floor.
 *
 * A logo only for merchants on the list in lib/merchant-domain.ts, which is
 * why it is a list and not a guess: everything else keeps the letter, and no
 * string off a bank statement is sent anywhere to find out.
 */
export function MerchantAvatar({ name, size = 32 }: { name: string; size?: number }) {
  // Only the brands on the built-in list are ever looked up, so nothing off a
  // statement is sent anywhere to find out what it is - see merchant-domain.ts.
  const src = logoFor(name);
  const [failed, setFailed] = useState(false);

  // A different merchant deserves another go at fetching one.
  useEffect(() => setFailed(false), [src]);

  if (src && !failed) {
    return (
      <span className="avatar institution-logo" style={{ width: size, height: size, borderRadius: size * 0.28 }}>
        <img src={src} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  }

  const tone = merchantTone(name);
  return (
    <span
      className="avatar" style={{
        width: size, height: size, fontSize: size * 0.42, fontWeight: 700,
        background: `color-mix(in srgb, var(${tone}) 18%, transparent)`, color: `var(${tone})`,
        borderRadius: size * 0.28,
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** How many rows to add at a time as the list is scrolled. */
const PAGE = 120;

type Preset = "all" | "unreviewed" | "uncategorized" | "income" | "expense" | "hidden";

/** Where this screen was left, for as long as the app is open. */
const REMEMBERED = "transactions.filters";
interface Kept {
  /** The filters that live in the address bar, as they were written there. */
  search: string;
  /** And the three that do not: the search box, the preset, and the tag. */
  q: string;
  preset: Preset;
  tagId: string;
  /** How far down the list had been paged, so coming back can be that far. */
  limit: number;
}

/**
 * A bound out of the URL: cents, or nothing asked for.
 *
 * Zero is a bound somebody can mean, so this cannot lean on falsiness - "0" in
 * the address bar is "nothing above nought", not "no filter".
 */
const fromParam = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
};

export default function Transactions() {
  const db = useDB();
  const { actions, suggestRule } = useStore();
  const [params, setParams] = useSearchParams();

  /**
   * Where this screen starts: the link that opened it, or the last look at it.
   *
   * A link that carries filters is somebody saying which transactions they
   * want — from a category's Actual figure, from a merchant, from a chart —
   * and it always wins. A bare /transactions, from the sidebar or the way
   * back, is the case this is for: the filters were thrown away every time,
   * so narrowing to one account, opening a row and coming back meant setting
   * it all up again.
   *
   * Worked out once. Later renders read the live params, which is where the
   * filters live from then on.
   */
  const opened = useMemo(() => {
    if (params.toString()) return { from: params, kept: null as Kept | null };
    const kept = recall<Kept | null>(REMEMBERED, null);
    return { from: kept?.search ? new URLSearchParams(kept.search) : params, kept };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const at = opened.from;

  const [q, setQ] = useState(opened.kept?.q ?? "");
  const [preset, setPreset] = useState<Preset>(opened.kept?.preset ?? "all");
  const [accountId, setAccountId] = useState(at.get("account") ?? "");
  const [categoryId, setCategoryId] = useState(at.get("category") ?? "");
  const [period, setPeriodState] = useState<DateFilter>(() => fromParams((k) => at.get(k)));
  const [tagId, setTagId] = useState(opened.kept?.tagId ?? "");
  // Cents, signed, and null for "not asked". Read out of the URL like every
  // other filter, so a narrowed view is still a link.
  const [minAmount, setMinAmount] = useState<number | null>(() => fromParam(at.get("min")));
  const [maxAmount, setMaxAmount] = useState<number | null>(() => fromParam(at.get("max")));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * Whether the list is in multi-select. Off by default: a checkbox on every
   * row of a list you mostly read is 500 empty boxes for the one time a month
   * you want to recategorise a batch.
   */
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  /**
   * How much of the list is rendered.
   *
   * Remembered with the filters because coming back to the right place in a
   * long list needs the list to be that long again: restoring to the top of a
   * single page and leaving the reader to scroll it all back is most of the
   * annoyance this is meant to fix. Capped, so a session that paged a long way
   * down does not make the next visit render thousands of rows before it draws
   * anything.
   */
  const [limit, setLimit] = useState(() => Math.min(opened.kept?.limit ?? PAGE, PAGE * 6));
  const bottom = useRef<HTMLDivElement>(null);

  // Put back into the address bar, so a restored view is still a link and
  // everything below here reads the params rather than knowing about this.
  useEffect(() => {
    if (opened.kept?.search) setParams(new URLSearchParams(opened.kept.search), { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    keep(REMEMBERED, { search: params.toString(), q, preset, tagId, limit });
  }, [params, q, preset, tagId, limit]);

  // Worked out once rather than per transaction: a between-dates filter over
  // several thousand rows should not re-parse its own bounds for each one.
  const span = useMemo(() => bounds(period), [period]);

  // Parsed once rather than per row, and only when the box holds a number.
  const typed = useMemo(() => typedAmount(q), [q]);
  const range = useMemo(() => ({ min: minAmount, max: maxAmount }), [minAmount, maxAmount]);

  /**
   * Accounts told to keep their transactions out of the figures.
   *
   * Every other surface asks this question through counts(), so a muted
   * account is out of cash flow, the budget, the reports, the cards page and
   * net worth. This page built its own filter straight off db.transactions
   * and never asked, which left the one list in the app that still showed
   * them, and left the total at the top of this page disagreeing with the
   * budget about the same month.
   */
  const muted = useMemo(() => mutedAccountIds(db), [db.accounts]);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return db.transactions.filter((t) => {
      if (accountId && t.accountId !== accountId) return false;
      // Out of the ledger as well, with two ways back to them: ask for the
      // account by name, which is what the account's own page links to and
      // where an empty list would be the wrong answer, or ask for what is
      // being kept out, which is what the Hidden preset is.
      if (!accountId && preset !== "hidden" && muted.has(t.accountId)) return false;
      if (categoryId && t.categoryId !== categoryId && !t.splits?.some((s) => s.categoryId === categoryId)) return false;
      if (span && (t.date < span.from || t.date > span.to)) return false;
      if (tagId && !t.tags.includes(tagId)) return false;
      if (preset === "unreviewed" && t.reviewed) return false;
      if (preset === "uncategorized" && t.categoryId !== "c_uncategorized") return false;
      if (preset === "income" && t.amount <= 0) return false;
      if (preset === "expense" && t.amount >= 0) return false;
      if (preset === "hidden" && !t.hideFromReports && !muted.has(t.accountId)) return false;
      if (!inAmountRange(t.amount, range)) return false;
      if (needle) {
        const hay = `${t.merchant} ${t.statement ?? ""} ${t.notes ?? ""}`.toLowerCase();
        // A figure typed into the box is a figure to find, as well as text to
        // look for. Either can match: "3120" is both a merchant that might
        // have it in its name and an amount somebody is hunting for.
        if (!hay.includes(needle) && !(typed && amountMatches(t.amount, typed))) return false;
      }
      return true;
    });
  }, [db.transactions, q, typed, accountId, categoryId, span, tagId, preset, range, muted]);

  const shown = filtered.slice(0, limit);
  const more = filtered.length > shown.length;

  // Narrowing the list starts the window again. Without this, filtering after
  // a long scroll would render every match at once, which is the opposite of
  // what the scrolling was for.
  useEffect(() => { setLimit(PAGE); }, [q, accountId, categoryId, span, tagId, preset]);

  /**
   * Loads the next batch when the end of the list comes into view.
   *
   * The observer is rebuilt whenever `limit` changes, on purpose. An
   * IntersectionObserver reports crossings, not states: once the marker is in
   * view it has already said so, and growing the list underneath it says
   * nothing new — so one observer loads a single batch and then sits there
   * until you scroll again. Rebuilding re-asks the question.
   *
   * rootMargin starts the load 500px early, so on an ordinary scroll the rows
   * are there before the bottom is.
   */
  useEffect(() => {
    const el = bottom.current;
    if (!el || !more || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE); },
      { rootMargin: "500px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more, limit, filtered.length]);
  const grouped = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of shown) {
      const arr = map.get(t.date) ?? [];
      arr.push(t);
      map.set(t.date, arr);
    }
    return [...map.entries()];
  }, [shown]);

  // Transfers and anything marked "Exclude from budget" are left out of every
  // total on this page. A credit card payment is the same money as the
  // groceries bought on the card, so counting both made a day look twice as
  // expensive as it was and a payday look like a wash.
  const budgeted = useMemo(() => budgetedCategoryIds(db), [db.categories, db.groups]);
  const net = useMemo(() => budgetedSum(db, filtered, budgeted), [db, filtered, budgeted]);
  const allSelected = shown.length > 0 && shown.every((t) => selected.has(t.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  /**
   * Keeps the URL in step, so a filtered view is a link and a reload lands
   * where you were.
   *
   * Every filter that is read out of the URL has to be written back to it. The
   * category was read and not written, so a reload quietly dropped it and the
   * count went up with nothing on screen explaining why.
   */
  const patchParams = (patch: Record<string, string>, drop: readonly string[] = []) => {
    const p = new URLSearchParams(params);
    for (const k of drop) p.delete(k);
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  };

  const setPeriod = (next: DateFilter) => {
    setPeriodState(next);
    patchParams(toParams(next), PARAM_KEYS);
  };
  const pickCategory = (id: string) => { setCategoryId(id); patchParams({ category: id }); };
  const pickAccount = (id: string) => { setAccountId(id); patchParams({ account: id }); };

  const setAmount = (which: "min" | "max", cents: number | null) => {
    if (which === "min") setMinAmount(cents); else setMaxAmount(cents);
    patchParams({ [which]: cents === null ? "" : String(cents) });
  };

  const clearFilters = () => {
    setQ(""); setPreset("all"); setAccountId(""); setCategoryId(""); setTagId("");
    setMinAmount(null); setMaxAmount(null);
    setPeriodState(ALL);
    setParams({});
    // Clearing has to mean cleared. Without this the next visit would restore
    // what was just thrown away, which is the opposite of pressing Clear.
    forget(REMEMBERED);
  };
  const filterCount = [accountId, categoryId, tagId].filter(Boolean).length
    + (preset === "all" ? 0 : 1) + (isNarrowed(period) ? 1 : 0)
    + (hasAmountRange(range) ? 1 : 0);

  return (
    <>
      <TopBar
        title="Transactions"
        actions={
          <>
            <IconAction title="Import a CSV" onClick={() => setImporting(true)}>
              <Upload size={16} />
            </IconAction>
            <IconAction
              title="Export what is showing as CSV"
              onClick={() => download("transactions.csv", toCSV(db, filtered), "text/csv")}
            >
              <Download size={16} />
            </IconAction>
          </>
        }
        primary={
          <Btn variant="primary" onClick={() => setAdding(true)}>
            <Plus size={15} /> <span className="btn-label">Transaction</span>
          </Btn>
        }
      />
      <div className="page stack">
        <Card>
          {/* One line: the search, and everything else behind the funnel at the
              end of it. Six controls strung across the top of the page took
              two rows on a laptop and four on a phone, and were mostly set to
              "any" — a permanent cost for an occasional act. */}
          <div className="row filter-bar" style={{ gap: 8 }}>
            <div className="search grow" style={{ minWidth: 0 }}>
              <Search size={14} />
              <TextInput value={q} onChange={setQ} placeholder="Search merchants, notes, statements, or an amount" />
            </div>
            <Popover
              align="right" width={300} className="filter-panel"
              trigger={(open) => (
                <button
                  className={cx("btn btn-icon filter-toggle", filterCount > 0 && "on")}
                  onClick={open} title="Filters" aria-label={`Filters${filterCount ? ` (${filterCount} on)` : ""}`}
                >
                  <Filter size={16} />
                  {/* The count, not a dot: "filtered" is not the useful part —
                      how much of the list is being hidden from you is. */}
                  {filterCount ? <span className="filter-count">{filterCount}</span> : null}
                </button>
              )}
            >
              {(close) => (
                <div className="col" style={{ gap: 12 }}>
                  <div className="spread">
                    <span style={{ fontWeight: 600 }}>Filters</span>
                    {filterCount ? (
                      <Btn size="sm" variant="ghost" onClick={() => { clearFilters(); close(); }}>
                        <X size={13} /> Clear all
                      </Btn>
                    ) : null}
                  </div>

                  <Field label="Show">
                    <SelectInput
                      value={preset} onChange={(v) => setPreset(v as Preset)}
                      options={[
                        { value: "all", label: "Everything" },
                        { value: "unreviewed", label: "Needs review" },
                        { value: "uncategorized", label: "Uncategorized" },
                        { value: "expense", label: "Expenses" },
                        { value: "income", label: "Income" },
                        { value: "hidden", label: "Hidden from reports" },
                      ]}
                    />
                  </Field>

                  <Field label="Account">
                    <SelectInput
                      value={accountId} onChange={pickAccount} placeholder="All accounts"
                      options={accountOptions(db.accounts.filter((a) => !a.hidden))}
                    />
                  </Field>

                  <Field label="Category">
                    <CategoryPicker
                      value={categoryId} onChange={pickCategory} clearLabel="Any category"
                      trigger={(cat, open) => (
                        <button className="btn filter-pick" onClick={open}>
                          <span>{cat ? cat.icon : "🏷"}</span>
                          <span className="truncate grow">{cat ? cat.name : "Any category"}</span>
                        </button>
                      )}
                    />
                  </Field>

                  {/* Signed, exactly as the rows show it, because that is the
                      one convention the whole app uses. Either box on its own
                      is a half-open range, which is what "anything over five
                      hundred" actually asks for. */}
                  <Field label="Amount" hint="As shown, so money going out is negative">
                    <div className="row" style={{ gap: 8 }}>
                      <AmountBound
                        value={minAmount} onChange={(v) => setAmount("min", v)}
                        placeholder="At least"
                      />
                      <AmountBound
                        value={maxAmount} onChange={(v) => setAmount("max", v)}
                        placeholder="At most"
                      />
                    </div>
                  </Field>

                  <Field label="Date">
                    <div className="col" style={{ gap: 8 }}>
                      <PeriodFilter db={db} value={period} onChange={setPeriod} />
                    </div>
                  </Field>

                  {db.tags.length ? (
                    <Field label="Tag">
                      <SelectInput
                        value={tagId} onChange={setTagId} placeholder="Any tag"
                        options={db.tags.map((t) => ({ value: t.id, label: t.name }))}
                      />
                    </Field>
                  ) : null}
                </div>
              )}
            </Popover>
          </div>
          <div className="divider" />
          <div className="spread small">
            <span className="muted">
              {filtered.length.toLocaleString()} transaction{filtered.length === 1 ? "" : "s"}
              {categoryId ? <> in <CategoryTag categoryId={categoryId} /></> : null}
            </span>
            <span className="muted row" style={{ gap: 6 }}>
              Net <Money value={net.total} colored className="bold" />
              {net.excludedCount ? <ExcludedNote sum={net} /> : null}
            </span>
          </div>
        </Card>

        {picking ? (
          <Card style={{ position: "sticky", top: 60, zIndex: 20, borderColor: "var(--accent)" }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="bold">
                {selected.size ? `${selected.size} selected` : "Select transactions"}
              </span>
              <div className="grow" />
              {/* Nothing picked yet, so there is nothing to do to it — the
                  only button that means anything is the way out. */}
              {selected.size ? <>
              <CategoryPicker
                value=""
                onChange={(id) => {
                  const picked = db.transactions.filter((t) => selected.has(t.id));
                  // Reviewed only where a category was really chosen. Sending a
                  // pile back to Uncategorized used to mark the lot as dealt
                  // with, which is the opposite of what it says.
                  actions.updateMany(
                    [...selected],
                    filesIt(id) ? { categoryId: id, reviewed: true } : { categoryId: id },
                    `categorize ${selected.size}`,
                  );
                  setSelected(new Set());
                  // One merchant across the selection is exactly the case a rule
                  // handles; a mixed batch has nothing to match on.
                  const merchants = new Set(picked.map((t) => t.merchant));
                  if (merchants.size === 1) suggestRule({ merchant: [...merchants][0], categoryId: id });
                }}
                trigger={(_, open) => <Btn onClick={open} size="sm">Categorize</Btn>}
              />
              <Popover
                trigger={(open) => <Btn size="sm" onClick={open}><TagIcon size={13} /> Tag</Btn>}
              >
                {(close) => (
                  <>
                    {db.tags.map((t) => (
                      <button key={t.id} onClick={() => {
                        actions.addTagToMany([...selected], t.id);
                        close();
                        setSelected(new Set());
                      }}>
                        <TagPill name={t.name} tone={t.color} />
                      </button>
                    ))}
                    {!db.tags.length ? <div className="tiny faint" style={{ padding: 8 }}>No tags yet</div> : null}
                  </>
                )}
              </Popover>
              <Btn size="sm" onClick={() => { actions.updateMany([...selected], { reviewed: true }, `review ${selected.size}`); setSelected(new Set()); }}>
                <CheckCheck size={13} /> Mark reviewed
              </Btn>
              <Btn size="sm" variant="danger" onClick={() => { actions.deleteTransactions([...selected]); setSelected(new Set()); }}>
                <Trash2 size={13} /> Delete
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Btn>
              </> : null}
              <Btn size="sm" variant="ghost" onClick={() => { setPicking(false); setSelected(new Set()); }}>Done</Btn>
            </div>
          </Card>
        ) : null}

        <Card pad={false}>
          <div className={cx("list-row tx-grid head", !picking && "tx-nopick")}>
            {picking ? (
              <>
                <input
                  type="checkbox" className="cb" checked={allSelected} title="Select all"
                  onChange={() => setSelected(allSelected ? new Set() : new Set(shown.map((t) => t.id)))}
                />
                <span />
              </>
            ) : (
              // With the column gone there is nowhere to stand but the mark's
              // own, which is still the top left of the table.
              <button
                className="tx-pick" onClick={() => setPicking(true)}
                title="Select multiple" aria-label="Select multiple"
              >
                <ListChecks size={14} />
              </button>
            )}
            <span className="tiny faint">Merchant</span>
            <span className="tiny faint tx-category">Category</span>
            <span className="tiny faint tx-account">Account</span>
            <span className="tiny faint tx-amount">Amount</span>
          </div>

          {grouped.map(([date, rows]) => {
            const day = budgetedSum(db, rows, budgeted);
            return (
              <div key={date}>
                <div className={cx("date-head tx-grid", !picking && "tx-nopick")}>
                  <span className="date-head-label">{dateLabel(date, { weekday: true, year: true })}</span>
                  <span className="num tx-amount tx-day-total">
                    {/* A day of nothing but transfers has no budgeted total to
                        show. Zero would read as "these cancelled out". */}
                    {day.total || !day.excludedCount ? <Money value={day.total} colored /> : null}
                    {day.excludedCount ? <ExcludedNote sum={day} /> : null}
                  </span>
                </div>
                {rows.map((t) => (
                  <Row
                    key={t.id} txn={t} selected={selected.has(t.id)}
                    onToggle={picking ? () => toggle(t.id) : undefined} onEdit={() => setEditing(t)}
                  />
                ))}
              </div>
            );
          })}

          {!filtered.length ? (
            <Empty
              title="No transactions match"
              body="Try widening the filters, or import a CSV from your bank."
              action={<Btn variant="primary" onClick={() => setImporting(true)}><Upload size={14} /> Import CSV</Btn>}
            />
          ) : null}

          {/* Both the marker the observer watches and a button, because a
              browser without one still has to be able to reach row 500. */}
          {more ? (
            <div ref={bottom} style={{ padding: 14, textAlign: "center" }}>
              <Btn onClick={() => setLimit((l) => l + PAGE)}>
                Loading more… ({(filtered.length - shown.length).toLocaleString()} to go)
              </Btn>
            </div>
          ) : filtered.length > PAGE ? (
            <div className="tiny faint" style={{ padding: 14, textAlign: "center" }}>
              That is all {filtered.length.toLocaleString()} of them.
            </div>
          ) : null}
        </Card>
      </div>

      {editing ? <TransactionModal txn={editing} onClose={() => setEditing(null)} /> : null}
      {adding ? <TransactionModal onClose={() => setAdding(false)} /> : null}
      {importing ? <ImportModal onClose={() => setImporting(false)} /> : null}
    </>
  );
}

/**
 * All time, a year, a month, or two dates.
 *
 * The kind comes first and the rest follows from it, rather than four controls
 * competing for the same question. Years and months are offered from what the
 * data actually contains — a list of every year since 1970 is not a filter,
 * it is a haystack — and both ends of "between" are optional, because "since
 * March" is a question people have and "March to today" is them working around
 * a form.
 */
function PeriodFilter({ db, value, onChange }: {
  db: DB; value: DateFilter; onChange: (f: DateFilter) => void;
}) {
  const { years, months } = useMemo(() => {
    const y = new Set<string>();
    const m = new Set<string>();
    for (const t of db.transactions) { y.add(t.date.slice(0, 4)); m.add(t.date.slice(0, 7)); }
    return {
      years: [...y].sort().reverse(),
      months: [...m].sort().reverse().slice(0, 60),
    };
  }, [db.transactions]);

  const pick = (kind: DateFilter["kind"]) => {
    if (kind === "year") onChange({ kind: "year", year: value.kind === "year" ? value.year : years[0] ?? "" });
    else if (kind === "month") onChange({ kind: "month", month: value.kind === "month" ? value.month : months[0] ?? "" });
    else if (kind === "between") onChange({ kind: "between", from: "", to: "" });
    else onChange(ALL);
  };

  return (
    <>
      <SelectInput
        value={value.kind} onChange={(v) => pick(v as DateFilter["kind"])}
        options={FILTER_KINDS.map((k) => ({ value: k.value, label: k.label }))}
      />
      {value.kind === "year" ? (
        <SelectInput
          value={value.year} onChange={(year) => onChange({ kind: "year", year })}
          options={years.map((y) => ({ value: y, label: y }))}
        />
      ) : null}
      {value.kind === "month" ? (
        <SelectInput
          value={value.month} onChange={(month) => onChange({ kind: "month", month })}
          options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
        />
      ) : null}
      {value.kind === "between" ? (
        <span className="row wrap" style={{ gap: 6 }}>
          <input
            className="input date-bound" type="date" aria-label="From"
            value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })}
          />
          <span className="tiny faint">to</span>
          <input
            className="input date-bound" type="date" aria-label="To"
            value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })}
          />
        </span>
      ) : null}
    </>
  );
}

/**
 * One transaction, as it appears in a list.
 *
 * Shared with the category drill-down, which wants the same row without the
 * multi-select: omit `onToggle` and the checkbox column goes altogether, so
 * nothing is indented past a gap held open for a control that isn't there. The
 * lists that hold these rows carry `tx-nopick` on their own header and date
 * rows to match.
 *
 * `amount` overrides what is shown, for a list built from splits — a $300
 * purchase split three ways contributes $40 to the category being read, and
 * printing $300 there would make the total underneath look wrong.
 */
export function Row({ txn, selected = false, onToggle, onEdit, amount }: {
  txn: Transaction; selected?: boolean; onToggle?: () => void; onEdit: () => void; amount?: number;
}) {
  const db = useDB();
  const { actions, suggestRule } = useStore();
  const account = db.accounts.find((a) => a.id === txn.accountId);
  const category = db.categories.find((c) => c.id === txn.categoryId);
  const split = (txn.splits?.length ?? 0) > 0;
  // By merchant rather than by row: what repeats is the charge at a merchant,
  // so every transaction there is part of the pattern, including the ones
  // that arrived before anybody said so.
  const repeats = recurringByMerchant(db).get(recurringIdFor(txn.merchant));

  return (
    <div
      className={cx("list-row tx-grid", !onToggle && "tx-nopick", selected && "sel")}
      style={selected ? { background: "var(--accent-soft)" } : undefined}
    >
      {onToggle ? <input type="checkbox" className="cb" checked={selected} onChange={onToggle} /> : null}
      <span className="tx-mark">
        <MerchantAvatar name={txn.merchant} />
        <span
          className="avatar tx-cat-mark" aria-hidden
          style={category ? {
            background: `color-mix(in srgb, var(${category.color}) 16%, transparent)`,
          } : undefined}
        >
          {category?.icon ?? "\u2753"}
        </span>
      </span>
      <div className="col" style={{ gap: 1, cursor: "pointer", minWidth: 0 }} onClick={onEdit}>
        <span className="row" style={{ gap: 6 }}>
          <span className="truncate" style={{ fontWeight: 500 }}>{txn.merchant}</span>
          {/* First of the badges, hard against the name: it is the one that
              says what this charge is rather than what state it is in. */}
          {repeats ? (
            // On a span rather than the icon: an svg gets no tooltip from a
            // title attribute, only from a title child.
            <span className="tx-repeat" title={`Repeats ${cadenceLabel(repeats.cadence).toLowerCase()}`}>
              <Repeat size={12} aria-label="Recurring" />
            </span>
          ) : null}
          {/* What the row says about itself comes first, hard against the name.
              The arrow holds its width while invisible so the line does not
              jump when the pointer arrives, and that reserved space reads as a
              gap — so it is held at the end of the line, past the badges,
              rather than between the name and them. */}
          {txn.pending ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>Pending</span> : null}
          {!txn.reviewed ? <span className="dot" style={{ background: "var(--accent)" }} title="Needs review" /> : null}
          {/* Inline rather than pinned like the category's: this column is
              left-aligned, so nothing shifts when it appears. */}
          <Link
            to={`/merchants/${encodeURIComponent(txn.merchant)}`} className="tx-open tx-merchant-open"
            title={`View ${txn.merchant}`} aria-label={`View ${txn.merchant}`}
            onClick={(e) => e.stopPropagation()}
          >
            <ArrowRight size={13} />
          </Link>
        </span>
        <span className="row tiny faint" style={{ gap: 5, minWidth: 0 }}>
          <span className="truncate">
            {account ? (
              <Link
                to={`/accounts/${account.id}`} className="tx-sub-account"
                onClick={(e) => e.stopPropagation()}
              >
                {account.name}
              </Link>
            ) : <span className="tx-sub-account">-</span>}
            {txn.notes ? `${txn.notes}` : ""}
            {split ? ` · split ${txn.splits!.length} ways` : ""}
            {!txn.notes && !split ? "" : ""}
          </span>
          {txn.tags.map((id) => {
            const tag = db.tags.find((g) => g.id === id);
            return tag ? <TagPill key={id} name={tag.name} tone={tag.color} /> : null;
          })}
        </span>
      </div>
      <div className="row tx-category" style={{ gap: 4, minWidth: 0 }}>
        {split ? (
          <span className="chip" onClick={onEdit} style={{ cursor: "pointer" }}>Split</span>
        ) : (<>
          <CategoryPicker
            value={txn.categoryId}
            onChange={(id) => {
              actions.updateTransaction(
                txn.id,
                filesIt(id) ? { categoryId: id, reviewed: true } : { categoryId: id },
              );
              if (id !== txn.categoryId) suggestRule({ merchant: txn.merchant, categoryId: id });
            }}
            trigger={(cat, open) => (
              <span
                className="chip" onClick={open}
                style={{
                  background: cat ? `color-mix(in srgb, var(${cat.color}) 15%, transparent)` : undefined,
                  borderColor: "transparent", color: cat ? `var(${cat.color})` : undefined, fontWeight: 500,
                }}
              >
                <span>{cat?.icon ?? "❓"}</span>
                <span className="truncate">{cat?.name ?? "Uncategorized"}</span>
              </span>
            )}
          />
          {/* Kept out of the flow so the chip stays on the column's centre
              line whether or not the pointer is over the row. */}
          <Link
            to={`/categories/${txn.categoryId}`} className="tx-open tx-cat-open"
            title={`View ${category?.name ?? "category"}`} aria-label={`View ${category?.name ?? "category"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <ArrowRight size={13} />
          </Link>
        </>)}
      </div>
      {account ? (
        <Link
          to={`/accounts/${account.id}`} className="tx-account tx-account-link"
          title={account.name} aria-label={account.name}
        >
          <InstitutionLogo account={account} size={26} round />
        </Link>
      ) : (
        <span className="tiny truncate tx-account">-</span>
      )}
      {/* Both ways, not just income. The day's subtotal above these rows and
          the net figure at the top of the page have always coloured a negative
          red; leaving the rows that make them up in plain ink was the odd one
          out, and reading down a column for "what went out" meant reading the
          minus signs. */}
      <div className="num bold tx-amount" style={{ cursor: "pointer" }} onClick={onEdit}>
        <Money value={amount ?? txn.amount} colored />
      </div>
    </div>
  );
}
