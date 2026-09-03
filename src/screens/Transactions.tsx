import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, CheckCheck, CopyCheck, Download, EyeOff, Filter, Search, Tag as TagIcon, Trash2, Upload, X } from "lucide-react";
import type { DB, Transaction } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { dateLabel, monthLabel } from "../lib/date";
import { hash } from "../lib/id";
import { toCSV } from "../lib/csv";
import { budgetedCategoryIds, budgetedSum } from "../lib/select";
import type { BudgetedSum } from "../lib/select";
import { fmt } from "../lib/money";
import { download } from "../lib/storage";
import { Btn, Card, Empty, Money, Popover, SelectInput, TagPill, TextInput, cx } from "../components/ui";
import { CategoryPicker, CategoryTag } from "../components/pickers";
import type { DateFilter } from "../lib/date-filter";
import { ALL, FILTER_KINDS, PARAM_KEYS, bounds, fromParams, isNarrowed, toParams } from "../lib/date-filter";
import { TransactionModal } from "./TransactionModal";
import { ImportModal } from "./ImportModal";
import { DuplicatesModal } from "./DuplicatesModal";

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

export function MerchantAvatar({ name, size = 32 }: { name: string; size?: number }) {
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

type Preset = "all" | "unreviewed" | "uncategorized" | "income" | "expense" | "hidden";

export default function Transactions() {
  const db = useDB();
  const { actions, suggestRule } = useStore();
  const [params, setParams] = useSearchParams();

  const [q, setQ] = useState("");
  const [preset, setPreset] = useState<Preset>("all");
  const [accountId, setAccountId] = useState(params.get("account") ?? "");
  const [categoryId, setCategoryId] = useState(params.get("category") ?? "");
  const [period, setPeriodState] = useState<DateFilter>(() => fromParams((k) => params.get(k)));
  const [tagId, setTagId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [importing, setImporting] = useState(false);
  const [deduping, setDeduping] = useState(false);
  const [limit, setLimit] = useState(120);

  // Worked out once rather than per transaction: a between-dates filter over
  // several thousand rows should not re-parse its own bounds for each one.
  const span = useMemo(() => bounds(period), [period]);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return db.transactions.filter((t) => {
      if (accountId && t.accountId !== accountId) return false;
      if (categoryId && t.categoryId !== categoryId && !t.splits?.some((s) => s.categoryId === categoryId)) return false;
      if (span && (t.date < span.from || t.date > span.to)) return false;
      if (tagId && !t.tags.includes(tagId)) return false;
      if (preset === "unreviewed" && t.reviewed) return false;
      if (preset === "uncategorized" && t.categoryId !== "c_uncategorized") return false;
      if (preset === "income" && t.amount <= 0) return false;
      if (preset === "expense" && t.amount >= 0) return false;
      if (preset === "hidden" && !t.hideFromReports) return false;
      if (needle) {
        const hay = `${t.merchant} ${t.statement ?? ""} ${t.notes ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [db.transactions, q, accountId, categoryId, span, tagId, preset]);

  const shown = filtered.slice(0, limit);
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

  const clearFilters = () => {
    setQ(""); setPreset("all"); setAccountId(""); setCategoryId(""); setTagId("");
    setPeriodState(ALL);
    setParams({});
  };
  const filterCount = [accountId, categoryId, tagId].filter(Boolean).length
    + (preset === "all" ? 0 : 1) + (isNarrowed(period) ? 1 : 0);

  return (
    <>
      <TopBar
        title="Transactions"
        actions={
          <>
            <Btn onClick={() => setImporting(true)}><Upload size={15} /> Import</Btn>
            <Btn onClick={() => setDeduping(true)} title="Find transactions imported more than once">
              <CopyCheck size={15} /> <span className="btn-label">Duplicates</span>
            </Btn>
            <Btn onClick={() => download("transactions.csv", toCSV(db, filtered), "text/csv")}>
              <Download size={15} /> Export
            </Btn>
          </>
        }
      />
      <div className="page stack">
        <Card>
          <div className="row wrap filter-bar" style={{ gap: 8 }}>
            <div className="search grow" style={{ minWidth: 200 }}>
              <Search size={14} />
              <TextInput value={q} onChange={setQ} placeholder="Search merchants, notes, statements" />
            </div>
            <SelectInput
              value={preset} onChange={(v) => setPreset(v as Preset)}
              options={[
                { value: "all", label: "All" },
                { value: "unreviewed", label: "Needs review" },
                { value: "uncategorized", label: "Uncategorized" },
                { value: "expense", label: "Expenses" },
                { value: "income", label: "Income" },
                { value: "hidden", label: "Hidden" },
              ]}
            />
            <SelectInput
              value={accountId} onChange={pickAccount} placeholder="All accounts"
              options={db.accounts.map((a) => ({ value: a.id, label: a.name }))}
            />
            <CategoryPicker
              value={categoryId} onChange={pickCategory} clearLabel="Any category"
              trigger={(cat, open) => (
                <button className="btn" onClick={open} style={{ maxWidth: 190 }}>
                  <span>{cat ? cat.icon : "🏷"}</span>
                  <span className="truncate">{cat ? cat.name : "Any category"}</span>
                </button>
              )}
            />
            <PeriodFilter db={db} value={period} onChange={setPeriod} />
            {db.tags.length ? (
              <SelectInput
                value={tagId} onChange={setTagId} placeholder="Any tag"
                options={db.tags.map((t) => ({ value: t.id, label: t.name }))}
              />
            ) : null}
            {filterCount ? (
              <Btn variant="ghost" onClick={clearFilters}><X size={14} /> Clear</Btn>
            ) : (
              <span className="row tiny faint" style={{ gap: 4 }}><Filter size={13} /> No filters</span>
            )}
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

        {selected.size ? (
          <Card style={{ position: "sticky", top: 60, zIndex: 20, borderColor: "var(--accent)" }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="bold">{selected.size} selected</span>
              <div className="grow" />
              <CategoryPicker
                value=""
                onChange={(id) => {
                  const picked = db.transactions.filter((t) => selected.has(t.id));
                  actions.updateMany([...selected], { categoryId: id, reviewed: true }, `categorize ${selected.size}`);
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
            </div>
          </Card>
        ) : null}

        <Card pad={false}>
          <div className="list-row tx-grid head">
            <input
              type="checkbox" className="cb" checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(shown.map((t) => t.id)))}
            />
            <span />
            <span className="tiny faint">Merchant</span>
            <span className="tiny faint tx-account">Account</span>
            <span className="tiny faint tx-category">Category</span>
            <span className="tiny faint tx-amount">Amount</span>
          </div>

          {grouped.map(([date, rows]) => {
            const day = budgetedSum(db, rows, budgeted);
            return (
              <div key={date}>
                <div className="date-head tx-grid">
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
                    onToggle={() => toggle(t.id)} onEdit={() => setEditing(t)}
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

          {filtered.length > shown.length ? (
            <div style={{ padding: 14, textAlign: "center" }}>
              <Btn onClick={() => setLimit((l) => l + 200)}>
                Show more ({(filtered.length - shown.length).toLocaleString()} remaining)
              </Btn>
            </div>
          ) : null}
        </Card>
      </div>

      {editing ? <TransactionModal txn={editing} onClose={() => setEditing(null)} /> : null}
      {importing ? <ImportModal onClose={() => setImporting(false)} /> : null}
      {deduping ? <DuplicatesModal onClose={() => setDeduping(false)} /> : null}
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
 * multi-select: omit `onToggle` and the checkbox column stays empty rather than
 * the grid shifting under it, so the two lists line up column for column.
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

  return (
    <div className={cx("list-row tx-grid", selected && "sel")} style={selected ? { background: "var(--accent-soft)" } : undefined}>
      {onToggle ? <input type="checkbox" className="cb" checked={selected} onChange={onToggle} /> : <span />}
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
          {/* Inline rather than pinned like the category's: this column is
              left-aligned, so nothing shifts when it appears. */}
          <Link
            to={`/merchants/${encodeURIComponent(txn.merchant)}`} className="tx-open tx-merchant-open"
            title={`View ${txn.merchant}`} aria-label={`View ${txn.merchant}`}
            onClick={(e) => e.stopPropagation()}
          >
            <ArrowRight size={13} />
          </Link>
          {txn.pending ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>Pending</span> : null}
          {!txn.reviewed ? <span className="dot" style={{ background: "var(--accent)" }} title="Needs review" /> : null}
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
            ) : <span className="tx-sub-account">—</span>}
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
      {account ? (
        <Link
          to={`/accounts/${account.id}`} className="tx-account tx-account-link"
          title={account.name} aria-label={account.name}
        >
          <InstitutionLogo account={account} size={26} round />
        </Link>
      ) : (
        <span className="tiny truncate tx-account">—</span>
      )}
      <div className="row tx-category" style={{ gap: 4, minWidth: 0 }}>
        {split ? (
          <span className="chip" onClick={onEdit} style={{ cursor: "pointer" }}>Split</span>
        ) : (<>
          <CategoryPicker
            value={txn.categoryId}
            onChange={(id) => {
              actions.updateTransaction(txn.id, { categoryId: id, reviewed: true });
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
      <div className="num bold tx-amount" style={{ cursor: "pointer" }} onClick={onEdit}>
        <Money value={amount ?? txn.amount} colored={(amount ?? txn.amount) > 0} />
      </div>
    </div>
  );
}
