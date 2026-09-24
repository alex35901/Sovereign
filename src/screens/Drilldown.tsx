import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { dateLabel } from "../lib/date";
import type { Activity, Entry, EntryStats } from "../lib/select";
import { entriesByPeriod, entryStats } from "../lib/select";
import type { Grain } from "../lib/buckets";
import {
  GRAINS, bucketLabel, bucketOf, bucketSpan, bucketTitle, currentBucket, isGrain, lastBuckets,
} from "../lib/buckets";
import { TopBar } from "../shell/TopBar";
import { BarChart } from "../components/charts";
import { Btn, Card, CardHead, Money, Segmented } from "../components/ui";
import { Row } from "./Transactions";
import { TransactionModal } from "./TransactionModal";
import type { Transaction } from "../types";

/**
 * The shape both drill-downs share: a bar per period across the history, one of
 * them picked, and the transactions of that one below it.
 *
 * A category and a merchant differ in what sits beside the list — a budget on
 * one, the categories the money went to on the other — and in nothing else.
 * That difference is the `aside`; everything above it is here once, so the two
 * pages cannot drift into being subtly different screens.
 */

/**
 * The period value meaning "none of them: show the whole chart".
 *
 * A word in the URL rather than an absent parameter, because absent already
 * means something else here: it means "you have not chosen, so land on the
 * newest period with anything in it". Those are different answers and the
 * difference has to survive a reload and the back button.
 */
export const ALL = "all";

/**
 * Which period the detail describes, or null for all of them.
 *
 * Pulled out of the component because it is the one piece of this with rules
 * rather than layout: an asked-for period that is no longer on the chart, the
 * newest populated one as a default, and the explicit "all".
 */
export function pickedBucket(
  asked: string | null,
  buckets: readonly string[],
  populated: ReadonlySet<string>,
): string | null {
  if (asked === ALL) return null;
  if (asked && buckets.includes(asked)) return asked;
  // The newest with anything in it, not simply the newest. Daily on something
  // you touch once a week means most bars are empty, and landing on an empty
  // Tuesday answers no question anybody had.
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (populated.has(buckets[i]!)) return buckets[i]!;
  }
  return buckets.at(-1) ?? null;
}

/** How much history to draw at each grain, so the bars stay readable. */
const SPAN: Record<Grain, number> = { day: 60, week: 26, month: 24, quarter: 12, year: 8 };

export interface Period {
  /** The period's key, as it appears in the URL. */
  key: string;
  grain: Grain;
  from: string;
  to: string;
  /** Long form, for a heading: "August 2026", "Aug 31 – Sep 6, 2026". */
  title: string;
  entries: Entry[];
  stats: EntryStats;
  /** Left out for being hidden from reports or in a muted account. */
  skipped: number;
}

export function Drilldown({ title, back, actions, crumb, tone, earliest, load, aside, nothingEver }: {
  /** The page's heading, in the bar across the top. */
  title: string;
  /** Where this drill-down sits under, for the arrow beside the heading. */
  back: { to: string; label: string };
  /** The buttons beside it. Given the period, because Export needs to know
   *  which one it is exporting and whether there is anything in it. */
  actions?: (period: Period) => ReactNode;
  /** The line above the chart: where you came from, what this is. */
  crumb: ReactNode;
  /** A palette token. The selected bar wears it; the rest wear it dimmed. */
  tone: string;
  /** The first date worth charting, or null if there is nothing at all. */
  earliest: string | null;
  /** Everything between two dates. Wrap it in useCallback, or the memos below
   *  recompute on every keystroke elsewhere in the app. */
  load: (from: string, to: string) => Activity;
  /** The cards beside the list, which is the only part that differs. */
  aside: (period: Period) => ReactNode;
  /** Shown in place of the chart when the subject has no history. */
  nothingEver: string;
}) {
  const [params, setParams] = useSearchParams();
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  const [limit, setLimit] = useState(120);

  const grainParam = params.get("by") ?? "";
  const grain: Grain = isGrain(grainParam) ? grainParam : "month";

  const buckets = useMemo(() => {
    const now = currentBucket(grain);
    if (!earliest) return [now];
    // Newest SPAN periods, counted back from today: a daily chart of four
    // years is a grey smear, and it has to be the recent end that survives.
    return lastBuckets(earliest, bucketSpan(now, grain).to, grain, SPAN[grain]);
  }, [earliest, grain]);

  const setGrain = (by: Grain) => {
    // The period is dropped, not translated: "Q3" is not a week, and guessing
    // would land somewhere the user did not pick. The default is the newest
    // with anything in it, which is where the eye goes anyway.
    const next = new URLSearchParams(params);
    next.set("by", by);
    // "All of them" still means all of them at any grain, so it survives the
    // change. A particular period does not: "Q3" is not a week.
    if (params.get("at") === ALL) next.set("at", ALL);
    else next.delete("at");
    setLimit(120);
    setParams(next, { replace: true });
  };
  const setSelected = (at: string) => {
    setLimit(120);
    const next = new URLSearchParams(params);
    next.set("by", grain);
    next.set("at", at);
    setParams(next, { replace: true });
  };

  // Every entry across the whole chart, fetched once and split two ways: the
  // bars want all of it, the detail below wants the selected period.
  const wide = useMemo(
    () => load(bucketSpan(buckets[0]!, grain).from, bucketSpan(buckets.at(-1)!, grain).to),
    [load, buckets, grain],
  );

  const totals = useMemo(
    () => entriesByPeriod(wide.entries, buckets, (d: string) => bucketOf(d, grain)),
    [wide.entries, buckets, grain],
  );

  /** Which periods actually contain something, which is not the same question
   *  as which ones total something: both halves of a credit card payment land
   *  in one month and cancel, and a month of them is busy, not empty. */
  const populated = useMemo(() => {
    const out = new Set<string>();
    for (const e of wide.entries) out.add(bucketOf(e.txn.date, grain));
    return out;
  }, [wide.entries, grain]);

  /** Which period the detail below describes, or null for the whole chart. */
  const selected = pickedBucket(params.get("at"), buckets, populated);

  // The whole chart when nothing is picked, which is the same span the bars
  // were drawn over, so what is listed is exactly what is shown above it.
  const span = selected
    ? bucketSpan(selected, grain)
    : { from: bucketSpan(buckets[0]!, grain).from, to: bucketSpan(buckets.at(-1)!, grain).to };

  const period: Period = useMemo(() => {
    // Unfiltered when nothing is picked. The same rows, not a second read of
    // them: the filter below would keep every one anyway.
    const entries = selected
      ? wide.entries.filter((e) => e.txn.date >= span.from && e.txn.date <= span.to)
      : wide.entries;
    return {
      key: selected ?? ALL,
      grain,
      from: span.from,
      to: span.to,
      title: selected
        ? bucketTitle(selected, grain)
        : `${bucketTitle(buckets[0]!, grain)} to ${bucketTitle(buckets.at(-1)!, grain)}`,
      entries,
      stats: entryStats(entries),
      // Already counted over this exact span by the read above, so asking
      // again would be a second pass over every transaction for one number.
      skipped: selected ? load(span.from, span.to).skipped : wide.skipped,
    };
  }, [wide.entries, wide.skipped, span.from, span.to, selected, grain, load, buckets]);

  // The unselected bars are the subject's own colour, dimmed — not a neutral
  // grey, which disappears into the card and makes the chart look like it
  // failed to load. The selected one is the colour at full strength.
  const dim = `color-mix(in srgb, var(${tone}) 38%, var(--surface))`;
  const bars = buckets.map((key) => ({
    label: bucketLabel(key, grain),
    bars: [{
      key: bucketTitle(key, grain),
      // Spending is stored negative and a chart of downward bars reads as
      // losses, not as a grocery bill. Drawn by size, signed in the tooltip.
      value: Math.abs(totals.get(key) ?? 0),
      // All of them at full strength when nothing is picked: the list below is
      // showing all of them, and a chart of dimmed bars would say the opposite.
      tone: selected === null || key === selected ? `var(${tone})` : dim,
    }],
  }));

  const grainWord = GRAINS.find((g) => g.value === grain)!.label.replace(/ly$/, "").toLowerCase();

  return (
    <>
      <TopBar title={title} back={back} actions={actions?.(period)} />

      <div className="page stack">
        <div className="row wrap" style={{ gap: 10 }}>{crumb}</div>

        <Card>
          <CardHead
            title="Over time"
            sub={selected === null
              ? `${bars.length} ${grainWord}${bars.length === 1 ? "" : "s"}, all of them. Click one to look at it`
              : `${bars.length} ${grainWord}${bars.length === 1 ? "" : "s"}, click one to look at it, click it again for all`}
            right={<Segmented value={grain} options={GRAINS} onChange={setGrain} />}
          />
          {earliest ? (
            <BarChart
              groups={bars}
              height={210}
              onClickGroup={(i) => {
                const key = buckets[i];
                // Pressing the one already picked lets it go, rather than
                // picking it again, which does nothing and looks broken. Same
                // gesture as a cross-filter anywhere else: click to narrow,
                // click again to stop narrowing.
                if (key) setSelected(key === selected ? ALL : key);
              }}
            />
          ) : (
            <div className="small faint" style={{ padding: "28px 0", textAlign: "center" }}>{nothingEver}</div>
          )}
        </Card>

        <div className="row wrap period-head" style={{ gap: 10 }}>
          <h2 className="period-title">{period.title}</h2>
          {/* A second way out, because a bar three pixels wide is a hard
              thing to press twice on a phone. */}
          {selected !== null ? (
            <Btn size="sm" onClick={() => setSelected(ALL)}>Show all {grainWord}s</Btn>
          ) : null}
        </div>

        <div className="grid g-2-1">
          <Card pad={false}>
            <CardHead
              flush title="Transactions"
              right={<span className="tiny faint">{period.stats.count.toLocaleString()}</span>}
            />
            {period.entries.length ? (
              <>
                <div className="list-row tx-grid head tx-nopick">
                  <span />
                  <span className="tiny faint">Merchant</span>
                  <span className="tiny faint tx-account">Account</span>
                  <span className="tiny faint tx-category">Category</span>
                  <span className="tiny faint tx-amount">Amount</span>
                </div>
                {period.entries.slice(0, limit).map((e) => (
                  <div key={e.txn.id}>
                    <div className="date-head tx-grid tx-nopick">
                      <span className="date-head-label">{dateLabel(e.txn.date, { weekday: true, year: true })}</span>
                      <span className="num tx-amount"><Money value={e.amount} colored /></span>
                    </div>
                    <Row txn={e.txn} onEdit={() => setEditTxn(e.txn)} amount={e.partial ? e.amount : undefined} />
                  </div>
                ))}
              </>
            ) : (
              <div className="empty">
                <h3>Nothing in {period.title}</h3>
                <div className="small">Pick another bar above.</div>
              </div>
            )}
            {period.entries.length > limit ? (
              <div style={{ padding: 12, textAlign: "center" }}>
                <Btn onClick={() => setLimit((n) => n + 240)}>
                  Show more ({(period.entries.length - limit).toLocaleString()} remaining)
                </Btn>
              </div>
            ) : null}
            {period.skipped ? (
              <div className="tiny faint" style={{ padding: "10px 16px", borderTop: "1px solid var(--line-soft)" }}>
                {period.skipped} more {period.skipped === 1 ? "is" : "are"} hidden from reports, or in an account set to
                hide its transactions. They are left out of everything on this page, the same as on the Budget screen.
              </div>
            ) : null}
          </Card>

          <div className="stack">{aside(period)}</div>
        </div>
      </div>

      {editTxn ? <TransactionModal txn={editTxn} onClose={() => setEditTxn(null)} /> : null}
    </>
  );
}

/** A label and a figure, the shape every card beside the list is built from. */
export function Line({ label, value, plain, faint, signed }: {
  label: ReactNode; value?: number; plain?: string; faint?: boolean; signed?: boolean;
}) {
  return (
    <div className="spread">
      <span className={`small ${faint ? "faint" : "muted"}`}>{label}</span>
      <span className="num">
        {plain !== undefined ? plain : <Money value={value ?? 0} colored={signed} />}
      </span>
    </div>
  );
}

/** The Summary card, which is the same question whatever the subject is. */
export function SummaryCard({ period }: { period: Period }) {
  return (
    <Card>
      <CardHead title="Summary" sub={period.title} />
      <div className="col" style={{ gap: 9 }}>
        <Line label="Transactions" plain={period.stats.count.toLocaleString()} />
        <Line label="Average" value={period.stats.average} signed />
        <Line label="Largest" value={period.stats.largest} signed />
        <div className="divider" style={{ margin: "3px 0" }} />
        <div className="spread">
          <span className="small muted">Total</span>
          <span className="num bold"><Money value={period.stats.total} colored /></span>
        </div>
      </div>
    </Card>
  );
}
