import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useDB } from "../store";
import { TopBar } from "../shell/TopBar";
import { longDate, monthLabel } from "../lib/date";
import { fmt0 } from "../lib/money";
import { reviewYears, yearReview } from "../lib/year-review";
import { BarChart, HBars } from "../components/charts";
import { Btn, Card, CardHead, Empty, Money, SelectInput, Tile, cx } from "../components/ui";

/**
 * The year, told back to you.
 *
 * Every figure here can be got at from somewhere else in the app. The point is
 * not the arithmetic, it is that nobody goes and does it. A year is the unit
 * people think in about money, and until it is in one place the question "was
 * this year better than last?" has no answer anybody can hold in their head.
 *
 * Nothing is congratulated and nothing is scolded. A year where spending rose
 * says spending rose. Whether that was the year the roof went or the year
 * nobody was watching is not something the document knows, and a screen that
 * guessed would be wrong about half the time and cheerful about it.
 */

const CATEGORY_TONES = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"];

/** A change against last year, said in words rather than left as a number. */
function Versus({ now, then, invert }: { now: number; then: number | null; invert?: boolean }) {
  if (then === null) return <span className="tiny faint">nothing to compare</span>;
  const delta = now - then;
  if (delta === 0) return <span className="tiny faint">the same as last year</span>;
  const good = invert ? delta < 0 : delta > 0;
  return (
    <span className={cx("tiny", good ? "pos" : "neg")}>
      {fmt0(Math.abs(delta))} {delta > 0 ? "more" : "less"} than last year
    </span>
  );
}

export default function YearReview() {
  const db = useDB();
  const years = useMemo(() => reviewYears(db), [db]);
  const [year, setYear] = useState(() => years[0] ?? new Date().getFullYear());
  const shown = years.includes(year) ? year : years[0] ?? year;
  const r = useMemo(() => yearReview(db, shown), [db, shown]);

  if (!years.length) {
    return (
      <>
        <TopBar title="Year in Review" />
        <div className="page stack">
          <Card>
            <Empty
              title="Nothing to review yet"
              body="Once a few months of transactions are in, this page adds the year up and puts it beside the one before."
            />
          </Card>
        </div>
      </>
    );
  }

  const months = r.months
    .filter((m) => m.month <= r.through.slice(0, 7))
    .map((m) => ({
      label: monthLabel(m.month, true),
      bars: [
        { key: "in", value: m.income, tone: "--pos" },
        { key: "out", value: -m.spending, tone: "--neg" },
      ],
    }));

  return (
    <>
      <TopBar
        title="Year in Review"
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
      <div className="page stack yr-screen">
        <div className="yr-print">
          <div className="est-print-head">
            <h2>{r.complete ? `Your ${shown}` : `${shown} so far`}</h2>
            <span className="small muted">
              {r.complete
                ? `The whole of ${shown}, from your own records.`
                : `${longDate(r.from)} to ${longDate(r.through)}, ${r.days} days in.`}
              {" "}{r.count.toLocaleString()} transactions.
              {r.last ? " Compared against the same stretch of the year before." : ""}
            </span>
          </div>

          <Card pad={false} className="nw-card">
            <div className="fc-head">
              <span className="small muted">{r.totals.saved >= 0 ? "Put away" : "Spent beyond what came in"}</span>
              <span className={cx("nw-total num", r.totals.saved < 0 && "neg")}>{fmt0(Math.abs(r.totals.saved))}</span>
              <span className="small faint">
                {fmt0(r.totals.income)} came in and {fmt0(r.totals.spending)} went out
                {r.totals.rate !== null ? `, which is ${r.totals.rate}% of it kept` : ""}.
                {" "}That is {fmt0(r.perDay)} a day.
              </span>
            </div>
          </Card>

          <div className="grid g4 yr-tiles">
            <Tile
              label="Money in" value={<Money value={r.totals.income} cents={false} />}
              sub={<Versus now={r.totals.income} then={r.last?.income ?? null} />}
            />
            <Tile
              label="Money out" value={<Money value={r.totals.spending} cents={false} />}
              sub={<Versus now={r.totals.spending} then={r.last?.spending ?? null} invert />}
            />
            <Tile
              label="Net worth" value={<Money value={r.netWorth.change} cents={false} sign colored />}
              sub={<span className="tiny faint">{fmt0(r.netWorth.start)} to {fmt0(r.netWorth.end)}</span>}
            />
            <Tile
              label={r.debt.paid >= 0 ? "Debt paid down" : "Debt taken on"}
              value={<Money value={Math.abs(r.debt.paid)} cents={false} />}
              tone={r.debt.paid >= 0 ? "pos" : "neg"}
              sub={<span className="tiny faint">{fmt0(Math.abs(r.debt.start))} owed at the start</span>}
            />
          </div>

          <Card pad={false}>
            <CardHead
              flush title="Month by month"
              sub={r.best && r.worst && r.best.month !== r.worst.month
                ? `${monthLabel(r.best.month)} kept the most, ${fmt0(r.best.net)}. `
                  + `${monthLabel(r.worst.month)} kept the least, ${fmt0(r.worst.net)}.`
                : "What came in and what went out, month by month."}
            />
            <div style={{ padding: "4px 12px 12px" }}>
              <BarChart groups={months} height={220} />
            </div>
          </Card>

          <Card>
            <CardHead
              title="Where it went"
              sub={`The ${r.categories.length} biggest, and what each one did last year.`}
            />
            <HBars
              rows={r.categories.map((c, i) => ({
                label: c.name,
                value: c.total,
                tone: CATEGORY_TONES[i % CATEGORY_TONES.length],
                sub: c.delta === null
                  ? `${c.share}%`
                  : `${c.share}% · ${c.delta === 0 ? "level with" : `${fmt0(Math.abs(c.delta))} ${c.delta > 0 ? "more" : "less"} than`} last year`,
              }))}
            />
          </Card>

          <div className="grid g2">
            <Card pad={false}>
              <CardHead flush title="Who got it" sub="By what was spent, not by how often." />
              {r.merchants.map((m) => (
                <div key={m.name} className="row est-line">
                  <span className="col grow" style={{ gap: 0 }}>
                    <span className="bold">{m.name}</span>
                    <span className="tiny faint">{m.count} time{m.count === 1 ? "" : "s"}</span>
                  </span>
                  <Money value={m.total} cents={false} className="bold" />
                </div>
              ))}
            </Card>

            <Card>
              <CardHead
                title="New this year"
                sub={r.firstTime.length
                  ? `${r.firstTime.length} place${r.firstTime.length === 1 ? "" : "s"} you had never spent before.`
                  : "Nowhere new. Every merchant this year had been here before."}
              />
              <div className="row yr-new">
                {r.firstTime.slice(0, 24).map((n) => <span key={n} className="yr-chip">{n}</span>)}
              </div>
              {r.firstTime.length > 24 ? (
                <span className="tiny faint">and {r.firstTime.length - 24} more</span>
              ) : null}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
