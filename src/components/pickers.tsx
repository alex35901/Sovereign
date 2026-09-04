import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { Category } from "../types";
import { useDB } from "../store";
import { addMonths, monthLabel } from "../lib/date";
import { Popover } from "./ui";
import type { RangeKey } from "../lib/range";
import { RANGES } from "../lib/range";

/** Searchable category menu, grouped the way the budget screen groups them. */
export function CategoryPicker({ value, onChange, trigger, clearLabel, note, only }: {
  value: string;
  onChange: (id: string) => void;
  trigger?: (cat: Category | undefined, open: () => void) => React.ReactNode;
  /** Offers a row that picks nothing, for a filter. Absent on a transaction's
   *  own category, where "no category" is Uncategorized rather than empty. */
  clearLabel?: string;
  /**
   * Something to show at the end of each row — what is left in it, when the
   * choice depends on that. Picking where to move money from is guesswork
   * without it: the figures are the whole reason one category is the answer.
   */
  note?: (c: Category) => React.ReactNode;
  /** Narrows what is offered, so a choice that cannot work is not on the list. */
  only?: (c: Category) => boolean;
}) {
  const db = useDB();
  const [q, setQ] = useState("");
  const current = db.categories.find((c) => c.id === value);

  const grouped = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return [...db.groups]
      .sort((a, b) => a.order - b.order)
      .map((g) => ({
        group: g,
        cats: db.categories
          .filter((c) => c.groupId === g.id && !c.archived && (!only || only(c))
            && (!needle || c.name.toLowerCase().includes(needle)))
          .sort((a, b) => a.order - b.order),
      }))
      .filter((x) => x.cats.length);
  }, [db.groups, db.categories, q, only]);

  return (
    <Popover
      width={264}
      trigger={(open) =>
        trigger ? trigger(current, open) : (
          <button className="btn btn-sm" onClick={open} style={{ maxWidth: 200 }}>
            <span>{current?.icon ?? "❓"}</span>
            <span className="truncate">{current?.name ?? "Uncategorized"}</span>
          </button>
        )}
    >
      {(close) => (
        <>
          <div className="search" style={{ margin: "2px 2px 6px" }}>
            <Search size={13} />
            <input className="input" autoFocus placeholder="Search categories" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {clearLabel ? (
            <button onClick={() => { onChange(""); setQ(""); close(); }}>
              <span className="grow truncate">{clearLabel}</span>
              {!value ? <span className="tiny" style={{ color: "var(--accent)" }}>✓</span> : null}
            </button>
          ) : null}
          {grouped.map(({ group, cats }) => (
            <div key={group.id}>
              <div className="tiny faint" style={{ padding: "6px 9px 3px", textTransform: "uppercase", letterSpacing: ".06em" }}>
                {group.name}
              </div>
              {cats.map((c) => (
                <button key={c.id} onClick={() => { onChange(c.id); setQ(""); close(); }}>
                  <span>{c.icon}</span>
                  <span className="grow truncate">{c.name}</span>
                  {note ? note(c) : null}
                  {c.id === value ? <span className="tiny" style={{ color: "var(--accent)" }}>✓</span> : null}
                </button>
              ))}
            </div>
          ))}
          {!grouped.length ? <div className="tiny faint" style={{ padding: 10 }}>No matches</div> : null}
        </>
      )}
    </Popover>
  );
}

export function CategoryTag({ categoryId, onClick }: { categoryId: string; onClick?: () => void }) {
  const db = useDB();
  const cat = db.categories.find((c) => c.id === categoryId);
  return (
    <span
      className="chip" onClick={onClick}
      style={{
        cursor: onClick ? "pointer" : "default",
        background: cat ? `color-mix(in srgb, var(${cat.color}) 15%, transparent)` : undefined,
        borderColor: "transparent",
        color: cat ? `var(${cat.color})` : undefined,
        fontWeight: 500,
      }}
    >
      <span>{cat?.icon ?? "❓"}</span>
      <span className="truncate" style={{ maxWidth: 130 }}>{cat?.name ?? "Uncategorized"}</span>
    </span>
  );
}

export function MonthNav({ month, onChange, max }: { month: string; onChange: (m: string) => void; max?: string }) {
  const canForward = !max || month < max;
  return (
    <div className="row" style={{ gap: 2 }}>
      <button className="btn btn-ghost btn-icon" onClick={() => onChange(addMonths(month, -1))} aria-label="Previous month">
        <ChevronLeft size={17} />
      </button>
      <span className="bold nowrap" style={{ minWidth: 132, textAlign: "center" }}>{monthLabel(month)}</span>
      <button
        className="btn btn-ghost btn-icon" disabled={!canForward}
        onClick={() => canForward && onChange(addMonths(month, 1))} aria-label="Next month"
      >
        <ChevronRight size={17} />
      </button>
    </div>
  );
}

export function RangePicker({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <select className="select" style={{ width: "auto", minWidth: 140 }} value={value} onChange={(e) => onChange(e.target.value as RangeKey)}>
      {RANGES.map((r) => (
        <option key={r.value} value={r.value}>{r.label}</option>
      ))}
    </select>
  );
}

export function AccountPicker({ value, onChange, allowAll }: {
  value: string; onChange: (id: string) => void; allowAll?: boolean;
}) {
  const db = useDB();
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAll ? <option value="">All accounts</option> : null}
      {db.accounts.filter((a) => !a.hidden).map((a) => (
        <option key={a.id} value={a.id}>{a.name}</option>
      ))}
    </select>
  );
}
