import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Search } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { merchantRows } from "../lib/select";
import { Card, Empty, Money, TextInput, cx } from "../components/ui";
import { MerchantAvatar } from "./Transactions";

/** How many to draw before the list has to be asked for more. */
const PAGE = 60;

export default function Merchants() {
  const db = useDB();
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [by, setBy] = useState<"count" | "total">("count");

  const rows = useMemo(() => merchantRows(db), [db]);
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
          <div className="search">
            <Search size={14} />
            <TextInput value={q} onChange={setQ} placeholder="Search merchants" />
          </div>
          <div className="spread small muted" style={{ marginTop: 10 }}>
            <span>
              {shown.length.toLocaleString()} merchant{shown.length === 1 ? "" : "s"}
              {q ? ` matching "${q}"` : ""}
            </span>
            <span>{rows.reduce((s, r) => s + r.count, 0).toLocaleString()} transactions in all</span>
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
              title={q ? `Nothing matching "${q}"` : "No merchants yet"}
              body={q ? undefined : "They appear as soon as there are transactions to draw them from."}
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
