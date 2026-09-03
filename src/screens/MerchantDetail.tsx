import { useCallback, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { dateLabel } from "../lib/date";
import { toCSV } from "../lib/csv";
import { download } from "../lib/storage";
import {
  merchantAccounts, merchantActivity, merchantCategories, merchantIndex, merchantKey, merchantLifetime,
} from "../lib/select";
import { Btn, Card, CardHead, Empty, Money } from "../components/ui";
import { MerchantAvatar, merchantTone } from "./Transactions";
import type { Period } from "./Drilldown";
import { Drilldown, Line, SummaryCard } from "./Drilldown";

/**
 * One merchant, broken all the way down.
 *
 * The same page as a category's, sharing everything but what sits beside the
 * list. A merchant has no budget to report against, so in its place is the
 * question a merchant actually raises: where did this money get filed? One
 * category for most shops, and for Amazon a list worth reading.
 *
 * A merchant is a string on a transaction rather than a record with an id, so
 * the name is the URL. Matching ignores case and surrounding space — "WHOLE
 * FOODS " off a statement and "Whole Foods" typed by hand are one shop — and
 * the title shows whichever spelling is most common.
 */
export default function MerchantDetail() {
  const { name = "" } = useParams();
  const db = useDB();
  const nav = useNavigate();

  const index = useMemo(() => merchantIndex(db), [db.transactions]);
  const known = index.get(merchantKey(name));
  const display = known?.name ?? name;

  const lifetime = useMemo(() => merchantLifetime(db, name), [db, name]);

  const load = useCallback(
    (from: string, to: string) => merchantActivity(db, display, from, to),
    [db, display],
  );

  if (!known) {
    return (
      <>
        <TopBar title="Merchant" />
        <div className="page">
          <Empty
            title={`Nothing from ${name || "that merchant"}`}
            body="No transaction carries this name. It may have been renamed, or spelled differently."
            action={<Btn variant="primary" onClick={() => nav("/transactions")}>All transactions</Btn>}
          />
        </div>
      </>
    );
  }

  const exportCSV = (period: Period) => {
    const slug = display.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "merchant";
    download(`${slug}-${period.key}.csv`, toCSV(db, period.entries.map((e) => e.txn)));
  };

  return (
    <Drilldown
      title={display}
      actions={(period) => (
        <Btn onClick={() => exportCSV(period)} disabled={!period.entries.length}>
          <Download size={14} /> <span className="btn-label">Export</span>
        </Btn>
      )}
      tone={merchantTone(display)}
      earliest={lifetime.first}
      load={load}
      nothingEver="Nothing from this merchant is visible in reports."
      crumb={
        <>
          <Link to="/transactions" className="row tiny faint" style={{ gap: 5 }}>
            <ArrowLeft size={13} /> Transactions
          </Link>
          <MerchantAvatar name={display} size={20} />
          {lifetime.first ? (
            <span className="tiny faint">
              · {lifetime.count.toLocaleString()} transaction{lifetime.count === 1 ? "" : "s"} since{" "}
              {dateLabel(lifetime.first, { year: true })}, <Money value={lifetime.total} /> all told
            </span>
          ) : null}
        </>
      }
      aside={(period) => (
        <>
          <WhereItGoesCard period={period} />
          <SummaryCard period={period} />
        </>
      )}
    />
  );
}

/**
 * Where this merchant's money goes.
 *
 * The merchant page's answer to the category page's budget. Categories are
 * counted through the splits, so a shop divided between two shows up under
 * both — and accounts alongside them, because a subscription still renewing on
 * a card you meant to stop using is exactly what this page should surface.
 * Both collapse to a single line for the ordinary shop that is neither.
 */
function WhereItGoesCard({ period }: { period: Period }) {
  const db = useDB();
  const categories = useMemo(() => merchantCategories(period.entries), [period.entries]);
  const accounts = useMemo(() => merchantAccounts(period.entries), [period.entries]);

  return (
    <Card>
      <CardHead title="Where it goes" sub={period.title} />
      {period.entries.length ? (
        <div className="col" style={{ gap: 9 }}>
          <div className="tiny faint">
            {categories.length === 1 ? "Category" : `${categories.length} categories`}
          </div>
          {categories.map((c) => {
            const cat = db.categories.find((x) => x.id === c.categoryId);
            return (
              <Line
                key={c.categoryId}
                label={
                  <Link to={`/categories/${c.categoryId}`} className="row cat-open" style={{ gap: 6, minWidth: 0 }}>
                    <span>{cat?.icon ?? "❓"}</span>
                    <span className="truncate">{cat?.name ?? "Uncategorized"}</span>
                    {c.count > 1 ? <span className="tiny faint nowrap">×{c.count}</span> : null}
                  </Link>
                }
                value={c.total}
                signed
              />
            );
          })}

          <div className="divider" style={{ margin: "3px 0" }} />
          <div className="tiny faint">
            {accounts.length === 1 ? "Charged to" : `Charged to ${accounts.length} accounts`}
          </div>
          {accounts.map((a) => {
            const account = db.accounts.find((x) => x.id === a.accountId);
            return (
              <Line
                key={a.accountId}
                label={
                  <Link to={`/accounts/${a.accountId}`} className="row cat-open" style={{ gap: 6, minWidth: 0 }}>
                    <span className="truncate">{account?.name ?? "Unknown account"}</span>
                    {a.count > 1 ? <span className="tiny faint nowrap">×{a.count}</span> : null}
                  </Link>
                }
                value={a.total}
                signed
              />
            );
          })}
        </div>
      ) : (
        <div className="small faint">Nothing in {period.title}.</div>
      )}
    </Card>
  );
}
