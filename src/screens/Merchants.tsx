import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Filter, Search, X } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { merchantRows } from "../lib/select";
import { Btn, Card, Empty, Field, Money, Popover, SelectInput, TextInput, cx } from "../components/ui";
import { MerchantAvatar } from "./Transactions";

/** How many to draw before the list has to be asked for more. */
const PAGE = 60;

export default function Merchants() {
  const db = useDB();
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [by, setBy] = useState<"count" | "total">("count");
  const [scope, setScope] = useState<"spending" | "all">("spending");
  const [groupId, setGroupId] = useState("");

  const rows = useMemo(
    () => merchantRows(db, { scope, groupId: groupId || undefined }),
    [db, scope, groupId],
  );
  const groups = useMemo(
    () => db.groups.filter((g) => g.kind === "expense").sort((a, b) => a.order - b.order),
    [db.groups],
  );
  const narrowed = (scope === "all" ? 1 : 0) + (groupId ? 1 : 0);
  const shown = useMemo(() => {
    const needle = q.toLowerCase().trim();
    const matched = needle ? rows.filter((r) => r.key.includes(needle)) : rows;
    // Sorted by count in the selector already; spending is a second question
    // and re-sorts a copy rather than a second pass over the transactions.
    return by === "count" ? matched : [...matched].sort((a, b) => a.total - b.total);
  }, [rows, q, by]);

  return (
    <>
      <TopBar
        title="Merchants"
        actions={
          <div className="seg">
            <button className={cx(by === "count" && "on")} onClick={() => setBy("count")}>Most often</button>
            <button className={cx(by === "total" && "on")} onClick={() => setBy("total")}>Most spent</button>
          </div>
        }
      />
      <div className="page stack">
        <Card>
          <div className="row filter-bar" style={{ gap: 8 }}>
            <div className="search grow" style={{ minWidth: 0 }}>
              <Search size={14} />
              <TextInput value={q} onChange={setQ} placeholder="Search merchants" />
            </div>
            <Popover
              align="right" width={290} className="filter-panel"
              trigger={(open) => (
                <button
                  className={cx("btn btn-icon filter-toggle", narrowed > 0 && "on")}
                  onClick={open} title="Filters" aria-label="Filters"
                >
                  <Filter size={16} />
                  {narrowed ? <span className="filter-count">{narrowed}</span> : null}
                </button>
              )}
            >
              {(close) => (
                <div className="col" style={{ gap: 12 }}>
                  <div className="spread">
                    <span style={{ fontWeight: 600 }}>Filters</span>
                    {narrowed ? (
                      <Btn size="sm" variant="ghost" onClick={() => { setScope("spending"); setGroupId(""); close(); }}>
                        <X size={13} /> Clear all
                      </Btn>
                    ) : null}
                  </div>
                  <Field
                    label="Count"
                    hint="Transfers, card payments and income are not decisions made at a merchant"
                  >
                    <SelectInput
                      value={scope} onChange={(v) => setScope(v as "spending" | "all")}
                      options={[
                        { value: "spending", label: "Spending only" },
                        { value: "all", label: "Every transaction" },
                      ]}
                    />
                  </Field>
                  <Field label="Category group">
                    <SelectInput
                      value={groupId} onChange={setGroupId} placeholder="All groups"
                      options={groups.map((g) => ({ value: g.id, label: g.name }))}
                    />
                  </Field>
                </div>
              )}
            </Popover>
          </div>
          <div className="spread small muted" style={{ marginTop: 10 }}>
            <span>
              {shown.length.toLocaleString()} merchant{shown.length === 1 ? "" : "s"}
              {q ? ` matching "${q}"` : ""}
            </span>
            {/* Says what is being counted, because a list that quietly leaves
                the mortgage out should say that it has. */}
            <span>
              {rows.reduce((s, r) => s + r.count, 0).toLocaleString()}
              {scope === "spending" ? " purchases" : " transactions"}
              {groupId ? ` in ${groups.find((g) => g.id === groupId)?.name ?? "that group"}` : ""}
            </span>
          </div>
        </Card>

        <Card pad={false}>
          {shown.slice(0, limit).map((r) => (
            <Link key={r.key} to={`/merchants/${encodeURIComponent(r.name)}`} className="list-row click">
              <MerchantAvatar name={r.name} size={34} />
              <div className="grow col" style={{ gap: 1, minWidth: 0 }}>
                <span className="truncate" style={{ fontWeight: 500 }}>{r.name}</span>
                <span className="tiny faint">
                  {r.count.toLocaleString()} transaction{r.count === 1 ? "" : "s"}
                </span>
              </div>
              <span className="num bold merchant-total">
                <Money value={r.total} cents={false} colored={r.total > 0} />
              </span>
              <ChevronRight size={15} className="faint" />
            </Link>
          ))}
          {!shown.length ? (
            <Empty
              title={q ? `Nothing matching "${q}"` : "No spending yet"}
              body={
                q ? undefined
                  : "Only money spent at a merchant is counted — transfers, card payments and income are left out. Change that under the filter."
              }
            />
          ) : null}
          {shown.length > limit ? (
            <div style={{ padding: 12 }}>
              <button className="btn view-all" onClick={() => setLimit((n) => n + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit)} more
              </button>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
