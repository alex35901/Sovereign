import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { longDate, today } from "../lib/date";
import { fmt0 } from "../lib/money";
import type { TaxLine } from "../types";
import { SALT_CAP, TAX_LINES, suggestLines, taxSummary, taxYears } from "../lib/tax";
import { Btn, Card, CardHead, Money, SelectInput, cx } from "../components/ui";

/**
 * The year, arranged the way a tax return asks for it.
 *
 * A summary to hand an accountant, not a return and not advice. Nothing here
 * decides what is deductible or what anybody owes; it adds up money already
 * recorded and puts it under the headings the forms use, so January is an
 * afternoon of checking rather than an afternoon of scrolling.
 *
 * Two mechanisms, and they are separate on purpose. The personal lines come
 * from tagging a category, because charitable giving is whatever the household
 * calls charitable giving and no rule can guess that. Business and rental come
 * from the books an account already keeps, because a separate set of books is
 * already the answer to "is this a business expense".
 */

const NONE = "__none__";

/** Enough of the list to act on without turning the card into a scroll. */
const FIRST_FEW = 8;

export default function Tax() {
  const db = useDB();
  const { actions } = useStore();

  const years = useMemo(() => taxYears(db), [db]);
  const [year, setYear] = useState(() => years[0] ?? new Date().getFullYear());
  const [all, setAll] = useState(false);
  const shown = years.includes(year) ? year : years[0] ?? year;

  const summary = useMemo(() => taxSummary(db, shown), [db, shown]);
  const suggested = useMemo(() => suggestLines(db), [db]);

  const info = useMemo(() => new Map(TAX_LINES.map((l) => [l.id, l])), []);
  const deductible = summary.lines
    .filter((l) => info.get(l.line)?.direction === "out" && l.line !== "estimated_tax")
    .reduce((n, l) => n + l.total, 0);
  const paid = summary.lines.find((l) => l.line === "estimated_tax")?.total ?? 0;
  const earned = summary.lines
    .filter((l) => info.get(l.line)?.direction === "in")
    .reduce((n, l) => n + l.total, 0);

  const lineOptions = [
    { value: NONE as TaxLine | typeof NONE, label: "Not a tax line" },
    ...TAX_LINES.map((l) => ({ value: l.id as TaxLine | typeof NONE, label: `${l.label} (${l.form})` })),
  ];
  const setLine = (categoryId: string, value: string) =>
    actions.updateCategory(categoryId, { taxLine: value === NONE ? undefined : (value as TaxLine) });

  const tagged = db.categories
    .filter((c) => c.taxLine && !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const untaggedCats = db.categories
    .filter((c) => !c.taxLine && !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <TopBar
        title="Tax"
        actions={years.length > 1 ? (
          <SelectInput
            value={String(shown)}
            onChange={(v) => setYear(Number(v))}
            options={years.map((y) => ({ value: String(y), label: String(y) }))}
            style={{ width: 96 }}
          />
        ) : undefined}
        primary={
          <Btn variant="primary" onClick={() => window.print()}>
            <Printer size={15} /> <span className="btn-label">Print</span>
          </Btn>
        }
      />
      <div className="page stack tax-screen">
        <div className="tax-print">
          <div className="est-print-head">
            <h2>{shown} tax summary</h2>
            <span className="small muted">
              Prepared from Sovereign on {longDate(today())}. It adds up what was recorded, under the headings
              the forms use. It is not a return, it is not advice, and it does not decide what is deductible.
              The forms your bank and brokerage send are still the authority on what they say.
            </span>
          </div>

          <Card pad={false} className="nw-card tax-head">
            <div className="fc-head">
              <span className="small muted">Recorded against deductible lines</span>
              <span className="nw-total num">{fmt0(deductible)}</span>
              <span className="small faint">
                {summary.lines.length
                  ? `Across ${summary.lines.length} line${summary.lines.length === 1 ? "" : "s"} `
                    + `and ${summary.counted} transaction${summary.counted === 1 ? "" : "s"}.`
                    + (paid ? ` ${fmt0(paid)} of estimated tax paid separately.` : "")
                    + (earned ? ` ${fmt0(earned)} of interest and dividends to report.` : "")
                  : "Nothing is tagged for this year yet."}
              </span>
            </div>
          </Card>

          <Card pad={false} className="est-section">
            <CardHead
              flush title="On a personal return"
              sub="Household money only. Anything in a business or rental set of books is below, so no dollar is counted twice."
              right={summary.lines.length ? <span className="num bold"><Money value={deductible} cents={false} /></span> : undefined}
            />
            {summary.lines.length ? summary.lines.map((l) => (
              <div key={l.line} className="row est-line">
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="bold">{l.label}</span>
                  <span className="tiny faint">
                    {l.form} · {l.count} transaction{l.count === 1 ? "" : "s"} · {l.categories.join(", ")}
                  </span>
                  <span className="tiny muted">{info.get(l.line)?.note}</span>
                </span>
                <Money value={l.total} cents={false} className="bold" />
              </div>
            )) : (
              <div style={{ padding: "12px 16px" }}>
                <span className="small faint">
                  {summary.untagged
                    ? "No category has been put on a tax line yet. Do that below and this fills itself in."
                    : "Nothing landed on a tagged line this year."}
                </span>
              </div>
            )}
            {summary.salt ? (
              <div className="row est-line">
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="bold">State and local tax together</span>
                  <span className="tiny muted">
                    {summary.salt.over > 0
                      ? `Above the ${fmt0(SALT_CAP)} cap by ${fmt0(summary.salt.over)}. `
                        + "The whole figure is shown because what was paid is what a preparer asks for."
                      : `Under the ${fmt0(SALT_CAP)} cap.`}
                  </span>
                </span>
                <Money value={summary.salt.total} cents={false} className="bold" />
              </div>
            ) : null}
          </Card>

          {summary.books.map((b) => (
            <Card key={b.bucket} pad={false} className="est-section">
              <CardHead
                flush title={`${b.label} books`}
                sub={`${b.form} · ${b.accounts.length ? b.accounts.join(", ") : "tagged transactions only"} · `
                  + `${b.count} transaction${b.count === 1 ? "" : "s"}. Transfers between your own accounts are left out.`}
                right={<span className={cx("num bold", b.net >= 0 ? "pos" : "neg")}><Money value={b.net} cents={false} /></span>}
              />
              <div className="row est-line">
                <span className="col grow" style={{ gap: 0 }}><span className="bold">Money in</span></span>
                <Money value={b.income} cents={false} className="bold" />
              </div>
              {b.breakdown.map((r) => (
                <div key={r.id} className="row est-line tax-sub">
                  <span className="col grow" style={{ gap: 0 }}>
                    <span>{r.name}</span>
                    <span className="tiny faint">{r.count} transaction{r.count === 1 ? "" : "s"}</span>
                  </span>
                  <Money value={-r.total} cents={false} />
                </div>
              ))}
              <div className="row est-line">
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="bold">{b.net >= 0 ? "Profit" : "Loss"}</span>
                  <span className="tiny faint">Money in less what went out</span>
                </span>
                <Money value={b.net} cents={false} className="bold" colored />
              </div>
            </Card>
          ))}
        </div>

        {/* Everything below decides what the summary says, and none of it
            belongs on the printed page. */}
        {suggested.length ? (
          <Card pad={false}>
            <CardHead
              flush title="These look like tax lines"
              sub="Guessed from the name, so check each one. Nothing is tagged until you say so."
            />
            {suggested.map((s) => (
              <div key={s.categoryId} className="row est-line">
                <span className="col grow" style={{ gap: 0 }}>
                  <span className="bold">{s.name}</span>
                  <span className="tiny faint">Looks like {s.label}</span>
                </span>
                <Btn onClick={() => setLine(s.categoryId, s.line)}>Tag it</Btn>
              </div>
            ))}
          </Card>
        ) : null}

        <Card pad={false}>
          <CardHead
            flush title="Which categories go where"
            sub="A category on a tax line has its year totalled above. Everything else is left alone."
          />
          {tagged.length ? tagged.map((c) => (
            <div key={c.id} className="row est-line">
              <span className="col grow" style={{ gap: 0 }}>
                <span className="bold">{c.name}</span>
                <span className="tiny faint">{info.get(c.taxLine!)?.form}</span>
              </span>
              <SelectInput
                value={c.taxLine ?? NONE}
                onChange={(v) => setLine(c.id, v)}
                options={lineOptions}
                style={{ maxWidth: 260 }}
              />
            </div>
          )) : (
            <div style={{ padding: "12px 16px" }}>
              <span className="small faint">
                Nothing is on a tax line yet. Charitable giving and property tax are the two most households start with.
              </span>
            </div>
          )}
          <CardHead
            flush title="Everything else"
            sub={`${untaggedCats.length} categor${untaggedCats.length === 1 ? "y" : "ies"}, none of them on a tax line.`}
            right={untaggedCats.length > FIRST_FEW
              ? <Btn onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${untaggedCats.length}`}</Btn>
              : undefined}
          />
          {(all ? untaggedCats : untaggedCats.slice(0, FIRST_FEW)).map((c) => (
            <div key={c.id} className="row est-line tax-sub">
              <span className="col grow" style={{ gap: 0 }}><span>{c.name}</span></span>
              <SelectInput
                value={NONE}
                onChange={(v) => setLine(c.id, v)}
                options={lineOptions}
                style={{ maxWidth: 260 }}
              />
            </div>
          ))}
        </Card>

        <span className="tiny faint" style={{ padding: "0 2px" }}>
          Business and rental totals come from the books each account keeps, set on the Accounts screen.
          A single row can be moved between books from the transaction itself.
        </span>
      </div>
    </>
  );
}
