import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCheck, Download, Filter, Search, Tag as TagIcon, Trash2, Upload, X } from "lucide-react";
import type { Transaction } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { dateLabel, monthOf } from "../lib/date";
import { hash } from "../lib/id";
import { toCSV } from "../lib/csv";
import { download } from "../lib/storage";
import { Btn, Card, Empty, Money, Popover, SelectInput, TagPill, TextInput, cx } from "../components/ui";
import { CategoryPicker, CategoryTag } from "../components/pickers";
import { TransactionModal } from "./TransactionModal";
import { ImportModal } from "./ImportModal";

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
  const [month, setMonth] = useState(params.get("month") ?? "");
  const [tagId, setTagId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [importing, setImporting] = useState(false);
  const [limit, setLimit] = useState(120);

  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return db.transactions.filter((t) => {
      if (accountId && t.accountId !== accountId) return false;
      if (categoryId && t.categoryId !== categoryId && !t.splits?.some((s) => s.categoryId === categoryId)) return false;
      if (month && monthOf(t.date) !== month) return false;
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
  }, [db.transactions, q, accountId, categoryId, month, tagId, preset]);

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

  const total = filtered.reduce((s, t) => s + t.amount, 0);
  const allSelected = shown.length > 0 && shown.every((t) => selected.has(t.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const clearFilters = () => {
    setQ(""); setPreset("all"); setAccountId(""); setCategoryId(""); setMonth(""); setTagId("");
    setParams({});
  };
  const filterCount = [accountId, categoryId, month, tagId].filter(Boolean).length + (preset === "all" ? 0 : 1);

  return (
    <>
      <TopBar
        title="Transactions"
        actions={
          <>
            <Btn onClick={() => setImporting(true)}><Upload size={15} /> Import</Btn>
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
              value={accountId} onChange={setAccountId} placeholder="All accounts"
              options={db.accounts.map((a) => ({ value: a.id, label: a.name }))}
            />
            <SelectInput
              value={month} onChange={setMonth} placeholder="All time"
              options={[...new Set(db.transactions.map((t) => monthOf(t.date)))].sort().reverse().slice(0, 36)
                .map((m) => ({ value: m, label: m }))}
            />
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
            <span className="muted">Net <Money value={total} colored className="bold" /></span>
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
            <span className="tiny faint right">Amount</span>
          </div>

          {grouped.map(([date, rows]) => (
            <div key={date}>
              <div className="date-head spread">
                <span>{dateLabel(date, { weekday: true, year: true })}</span>
                <span className="num">
                  <Money value={rows.reduce((s, t) => s + t.amount, 0)} colored />
                </span>
              </div>
              {rows.map((t) => (
                <Row
                  key={t.id} txn={t} selected={selected.has(t.id)}
                  onToggle={() => toggle(t.id)} onEdit={() => setEditing(t)}
                />
              ))}
            </div>
          ))}

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
    </>
  );
}

function Row({ txn, selected, onToggle, onEdit }: {
  txn: Transaction; selected: boolean; onToggle: () => void; onEdit: () => void;
}) {
  const db = useDB();
  const { actions, suggestRule } = useStore();
  const account = db.accounts.find((a) => a.id === txn.accountId);
  const category = db.categories.find((c) => c.id === txn.categoryId);
  const split = (txn.splits?.length ?? 0) > 0;

  return (
    <div className={cx("list-row tx-grid", selected && "sel")} style={selected ? { background: "var(--accent-soft)" } : undefined}>
      <input type="checkbox" className="cb" checked={selected} onChange={onToggle} />
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
        ) : (
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
                <span className="truncate" style={{ maxWidth: 96 }}>{cat?.name ?? "Uncategorized"}</span>
              </span>
            )}
          />
        )}
      </div>
      <div className="right num bold" style={{ cursor: "pointer" }} onClick={onEdit}>
        <Money value={txn.amount} colored={txn.amount > 0} />
      </div>
    </div>
  );
}
