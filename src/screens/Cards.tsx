import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { Plus, Sparkles, Store, Trash2 } from "lucide-react";
import type { Account, CandidateCard, CardRewards, EarnRule, ID } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { addMonthsDate, dateLabel, thisMonth, today } from "../lib/date";
import { rangeStart } from "../lib/range";
import { fmt0 } from "../lib/money";
import { uid } from "../lib/id";
import { merchantIndex } from "../lib/select";
import type { BonusProgress } from "../lib/cards";
import { candidateValue, cardAccounts, cardReport, nextQuarter, quarterLabel, quarterWindow, rewardsOf, DEFAULT_REWARDS } from "../lib/cards";
import { draftRewards, toRules } from "../lib/hopper/rewards";
import type { DealView } from "../lib/hopper/offers";
import { MIN_REWARD, fetchOffers, ratioOf, topBy } from "../lib/hopper/offers";
import { cloudEnabled } from "../lib/cloud";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { CategoryPicker, CategoryTag } from "../components/pickers";
import { SortHead, sortRows, useSort } from "../components/sort";
import { Btn, Card, CardHead, Empty, Field, Modal, MoneyInput, PercentInput, SelectInput, Segmented, Tile, cx } from "../components/ui";
import { MerchantAvatar } from "./Transactions";
import { RewardsTab } from "./CardRewards";

/**
 * Which card to reach for, worked out from what was actually bought.
 *
 * The page is arithmetic, not advice about products. It never says "get this
 * card": it says what the cards already in the wallet would have paid on the
 * year that actually happened, and where the money went to the wrong one. The
 * one input it cannot work out for itself is what each card pays, so that is
 * asked for plainly and marked as unconfirmed until somebody has said yes.
 */

/** A year's saving smaller than this is not worth a line of red. */
const WORTH_SAYING = 100;

/** How many rows a reach-for table shows before it offers the rest. */
const PREVIEW = 24;

/** What the spark beside the daily driver is for, said once. */
const ASK_DRIVER = "Ask Hopper which card pays most on everything";

/** The columns of the two reach-for tables, by what they hold. */
type CatField = "name" | "spend" | "best" | "earned" | "gap";

/**
 * One line of a reach-for table, whatever the first column happens to be.
 *
 * The categories and the shops ask the same question of the same routing and
 * differ only in what they are cut by, so they are one table drawn twice
 * rather than two tables that have to be kept agreeing by hand.
 */
interface ReachRow {
  key: string;
  /** What the first column draws. */
  label: ReactNode;
  /** How that column sorts, which a drawn node cannot answer for itself. */
  name: string;
  spend: number;
  earned: number;
  gap: number;
  bestAccountId?: ID;
}

/**
 * The two halves of the question a wallet raises.
 *
 * Which card to reach for next is a question about the future and is answered
 * by comparing cards against each other. What the cards have already paid, and
 * what is sitting unspent, is a question about the past and is answered one
 * card at a time. They want different tables, so they get different tabs.
 */
const TABS = [
  { value: "cards", label: "Cards" },
  { value: "rewards", label: "Rewards" },
] as const;

type Tab = (typeof TABS)[number]["value"];

/**
 * The two ways a list of sign-up offers is worth reading.
 *
 * Per dollar finds the card worth opening for an ordinary year of spending.
 * Biggest bonus finds the one worth stretching for, which is usually a card
 * whose spend requirement keeps it out of the other list entirely.
 */
const VIEWS = [
  { value: "ratio", label: "Best per $1" },
  { value: "reward", label: "Biggest bonus" },
] as const;

/**
 * What a rotating card usually caps its bonus quarter at.
 *
 * A starting figure for the button below, not a fact about anybody's card:
 * it sits in an editable box the moment the rate is added, and the cards that
 * work this way have settled on the same number for years. Wrong by a lot is
 * better than blank here, because a blank cap means no cap, which would have
 * the page promising five percent on everything.
 */
const ROTATING_CAP = 1_500_00;

const PERIODS = [
  { value: "month", label: "a month" },
  { value: "quarter", label: "a quarter" },
  { value: "year", label: "a year" },
  { value: "", label: "ever" },
] as const;

export default function Cards() {
  const db = useDB();
  const { actions } = useStore();
  const nav = useNavigate();
  const cards = useMemo(() => cardAccounts(db), [db]);
  const [editing, setEditing] = useState<Account | null>(null);
  const [weighing, setWeighing] = useState<CandidateCard | "new" | null>(null);
  const [tab, setTab] = useState<Tab>("cards");
  const to = today();
  const from = rangeStart("1y");
  const report = useMemo(() => cardReport(db, from, to), [db, from, to]);
  const catName = useMemo(
    () => new Map(db.categories.map((c) => [c.id, c.name])),
    [db.categories],
  );

  /**
   * Hand the question to Hopper rather than answer it here.
   *
   * This page is arithmetic on cards the household already holds, and it has
   * no list of products to look anything up in. What a card on the market
   * pays is a question for the model, on its own screen, where the answer
   * arrives with Hopper's usual caveats attached instead of sitting in a
   * table of figures the app worked out itself.
   */
  const askHopper = (question: string) => {
    nav(`/hopper?ask=${encodeURIComponent(question)}`);
  };

  if (!cards.length) {
    return (
      <>
        <TopBar title="Cards" />
        <div className="page stack">
          <Card>
            <Empty
              title="No cards"
              body="Add a credit card account and this works out which of them to reach for, from what you actually bought."
            />
          </Card>
        </div>
      </>
    );
  }

  const unconfirmed = cards.filter((a) => !a.rewards?.confirmedAt);
  const byId = new Map(cards.map((a) => [a.id, a]));

  const catRows: ReachRow[] = report.categories
    .filter((c) => c.spend > 0)
    .map((c) => ({
      key: c.categoryId,
      label: <CategoryTag categoryId={c.categoryId} />,
      name: catName.get(c.categoryId) ?? "Uncategorized",
      spend: c.spend, earned: c.earned, gap: c.gap, bestAccountId: c.bestAccountId,
    }));

  const shopRows: ReachRow[] = report.merchants
    .filter((m) => m.spend > 0)
    .map((m) => ({
      key: m.key,
      // Where every other merchant in the app goes, by the spelling that page
      // uses: a row that names a shop should lead to the shop.
      label: (
        <Link
          to={`/merchants/${encodeURIComponent(m.name)}`}
          className="row cat-open" style={{ gap: 7, minWidth: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <MerchantAvatar name={m.name} size={20} />
          <span className="tiny truncate">{m.name}</span>
        </Link>
      ),
      name: m.name,
      spend: m.spend, earned: m.earned, gap: m.gap, bestAccountId: m.bestAccountId,
    }));

  return (
    <>
      <TopBar title="Cards" />
      <div className="page stack">
        <Segmented value={tab} options={TABS.map((t) => ({ ...t }))} onChange={setTab} spread />

        {tab === "rewards" ? (
          <RewardsTab report={report} onEdit={setEditing} onAsk={askHopper} />
        ) : (
          <>
            <Card>
              <div className="fc-head">
                <span className="small muted">Put on the right card, the last year would have paid</span>
                <span className="nw-total num">{fmt0(report.totals.best)}</span>
                <span className="small faint">
                  You earned {fmt0(report.totals.earned)} on {fmt0(report.totals.spend)} of spending.
                  {report.totals.gap > 0
                    ? ` ${fmt0(report.totals.gap)} of it went to the wrong card.`
                    : " Nothing went to the wrong card."}
                </span>
              </div>
              <div className="grid g3" style={{ padding: "4px 16px 16px" }}>
                <Tile label="Earned" value={fmt0(report.totals.earned)} sub="on the cards you used" />
                <Tile
                  label="Left on the table" value={fmt0(report.totals.gap)}
                  tone={report.totals.gap > 0 ? "neg" : undefined}
                  sub="by reaching for the wrong one"
                />
                <Tile
                  label="Daily driver" value={report.driver ? report.driver.name : "None"}
                  sub={report.driver ? `${report.driver.rate}% on anything with no bonus` : "No card has terms yet"}
                  action={
                    <button
                      type="button"
                      className="ask-spark"
                      title={ASK_DRIVER}
                      aria-label={ASK_DRIVER}
                      onClick={() => askHopper(
                        report.driver
                          ? `Which credit cards pay the most on everything, with no categories to track and no rotating bonuses? The best flat rate in my wallet is ${report.driver.rate}% on anything with no bonus, from my ${report.driver.name}. Name a few that beat it, say what each one pays and what it costs a year, and say plainly if nothing beats what I already carry.`
                          : "Which credit cards pay the most on everything, with no categories to track and no rotating bonuses? Name a few, and say what each one pays and what it costs a year.",
                      )}
                    >
                      <Sparkles size={13} />
                    </button>
                  }
                />
              </div>
            </Card>

            {unconfirmed.length ? (
              <Card>
                <CardHead
                  title="Nobody has checked these yet"
                  sub={`${unconfirmed.map((a) => a.name).join(", ")} ${unconfirmed.length === 1 ? "is" : "are"} earning at the default 1% on everything. Every figure above is only as right as what each card is said to pay.`}
                />
              </Card>
            ) : null}

            <Card pad={false}>
              <CardHead flush title="Your wallet" sub="What each one pays, and what it paid." />
              {report.cards.map((c) => {
                const account = byId.get(c.accountId);
                const r = account ? rewardsOf(account) : DEFAULT_REWARDS;
                return (
                  <button key={c.accountId} className="card-row" onClick={() => account && setEditing(account)}>
                    {account ? <InstitutionLogo account={account} size={30} /> : null}
                    <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                      <span className="row" style={{ gap: 6 }}>
                        <span className="bold truncate">{c.name}</span>
                        {/* Driven by whether a person has confirmed the terms,
                            not by whether the document holds any. Saving a draft
                            fills the second in and leaves the first alone, and a
                            badge that cleared on a draft would disagree with the
                            warning above it. */}
                        {c.confirmedAt ? null : <span className="tag card-unset">not checked</span>}
                      </span>
                      <span className="tiny faint truncate">
                        {c.base}% on everything{r.rules.length ? `, ${r.rules.length} bonus rate${r.rules.length === 1 ? "" : "s"}` : ""}
                        {c.annualFee ? ` · ${fmt0(c.annualFee)} a year` : ""}
                      </span>
                      {c.annualFee > 0 ? (
                        <span className={cx("tiny", c.earned >= c.annualFee ? "pos" : "neg")}>
                          {c.earned >= c.annualFee
                            ? `Clears its fee, with ${fmt0(c.earned - c.annualFee)} over`
                            : `${fmt0(c.annualFee - c.earned)} short of its fee`}
                        </span>
                      ) : null}
                      {/* The counterweight. A card earning two percent while
                          charging twenty-two is a losing card, and a rewards page
                          that never says so is lying by omission. */}
                      {c.interest > 0 ? (
                        <span className="tiny neg">
                          Charged {fmt0(c.interest)} of interest, against {fmt0(c.earned)} earned
                          {c.interest > c.earned ? ". This card cost more than it paid." : "."}
                        </span>
                      ) : null}
                      {c.bonus ? <BonusLine b={c.bonus} /> : null}
                    </span>
                    <span className="col" style={{ gap: 1, textAlign: "right" }}>
                      <span className="num bold">{fmt0(c.earned)}</span>
                      <span className="tiny faint">on {fmt0(c.spend)}</span>
                    </span>
                  </button>
                );
              })}
            </Card>

            <Offers />

            <ReachTable
              title="Where to put each purchase"
              sub="The last year, biggest miss first, or click a heading to reorder it. The best card is the one to reach for at the till, given what the caps had already taken."
              head="Category"
              rows={catRows}
              byId={byId}
              onAsk={(r) => askHopper(
                `Which credit cards would be good for my ${r.name} spending? Look at what I spent on ${r.name} over the last year and what my cards earn on it now, then name a few worth considering and say what each one pays.`,
              )}
              askTitle={(r) => `Ask Hopper which cards suit ${r.name}`}
              noun="categories"
            />

            {/* The same question asked of shops rather than of kinds of spending.
                Cards are not sold by category: one that pays five percent at a
                single chain is a slice of "Shopping" in the table above, sitting
                beside forty other shops, and the whole line here. */}
            <ReachTable
              title="Where to put each shop"
              sub="The last year at each place you paid, biggest first. Every shop a card touched is here, not only the ones above: a card aimed at one chain is invisible in a table of categories and obvious in this one."
              head="Merchant"
              rows={shopRows}
              byId={byId}
              onAsk={(r) => askHopper(
                `Which credit cards would be good for my spending at ${r.name}? Look at what I spent there over the last year and what my cards earn on it now, then say whether any card aimed at ${r.name} is worth it, and what it pays.`,
              )}
              askTitle={(r) => `Ask Hopper which cards suit ${r.name}`}
              empty="Nothing has gone on a card yet."
              noun="shops"
            />

            <Card pad={false}>
              <CardHead
                flush title="Cards you are weighing up"
                sub="Type the rates off an offer and see what it would have been worth against the year you actually had."
                right={<Btn size="sm" onClick={() => setWeighing("new")}><Plus size={13} /> Add</Btn>}
              />
              {(db.candidates ?? []).length ? (db.candidates ?? []).map((c) => (
                <Candidate key={c.id} card={c} from={from} to={to} onEdit={() => setWeighing(c)} />
              )) : (
                <div style={{ padding: "4px 16px 16px" }}>
                  <span className="small faint">
                    Nothing yet. Sovereign holds no list of card products, so the rates come off the offer in front of you
                    and the answer comes off your own spending.
                  </span>
                </div>
              )}
            </Card>

            <span className="tiny faint" style={{ padding: "0 2px" }}>
              Worked out from your own purchases over the last year, and from what you have said each card pays.
              Sovereign itself holds no list of card products. The spark beside a row asks Hopper, who answers
              from what he was trained on rather than from any live offer, so check the terms of anything he names.
            </span>
          </>
        )}
      </div>
      {editing ? (
        <RewardsModal
          name={editing.name} rewards={rewardsOf(editing)} nameLocked
          onSave={(_n, rewards) => actions.updateAccount(editing.id, { rewards })}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {weighing ? (
        <RewardsModal
          name={weighing === "new" ? "" : weighing.name}
          rewards={weighing === "new" ? DEFAULT_REWARDS : weighing.rewards}
          onSave={(name, rewards) => (weighing === "new"
            ? actions.addCandidate(name || "A card", rewards)
            : actions.updateCandidate(weighing.id, { name, rewards }))}
          onDelete={weighing === "new" ? undefined : () => actions.deleteCandidate(weighing.id)}
          onClose={() => setWeighing(null)}
        />
      ) : null}
    </>
  );
}

/**
 * One reach-for table: what was spent, where it should have gone, and what
 * reaching for the wrong card cost.
 *
 * Drawn twice on this page, by category and by shop. Each copy holds its own
 * sort, so ordering the shops does not quietly reorder the categories above
 * them, and both read the same routing: the caps a purchase spends are spent
 * once, however the answer is later cut up.
 */
function ReachTable({ title, sub, head, rows, byId, onAsk, askTitle, empty, noun = "rows" }: {
  title: string;
  sub: string;
  /** What to call the first column. */
  head: string;
  rows: ReachRow[];
  byId: Map<ID, Account>;
  onAsk: (row: ReachRow) => void;
  askTitle: (row: ReachRow) => string;
  /** Said instead of an empty table, when there is nothing to show. */
  empty?: string;
  /** What the rows are, for the button that shows the rest of them. */
  noun?: string;
}) {
  const { sort, toggle: onSort } = useSort<CatField>();
  const [all, setAll] = useState(false);
  const ranked = sortRows(rows, sort, (r, key) => {
    if (key === "spend") return r.spend;
    if (key === "earned") return r.earned;
    if (key === "gap") return r.gap;
    if (key === "name") return r.name;
    // Only the rows worth moving name a card. The rest say "stay put", which
    // is not a card name, so they gather at the bottom either way.
    return r.gap >= WORTH_SAYING && r.bestAccountId
      ? byId.get(r.bestAccountId)?.name ?? "a card"
      : null;
  });
  /**
   * Cut after the sort rather than before it.
   *
   * A year has a few dozen categories and several hundred shops, so the
   * second table has to open out, and once a button is saying how many are
   * hidden the preview has to mean "the top so many by whatever this is
   * sorted on". Slicing first would leave a click on Missed reordering the
   * biggest spenders among themselves while the real misses stayed out of
   * sight behind a button saying how many there were.
   */
  const shown = all ? ranked : ranked.slice(0, PREVIEW);

  return (
    <Card pad={false}>
      <CardHead flush title={title} sub={sub} />
      {shown.length ? (
        <>
          <div className="card-cat head">
            <span className="tiny faint"><SortHead field="name" sort={sort} onSort={onSort}>{head}</SortHead></span>
            <span className="tiny faint card-cat-spend"><SortHead field="spend" sort={sort} onSort={onSort}>Spent</SortHead></span>
            <span className="tiny faint card-cat-best"><SortHead field="best" sort={sort} onSort={onSort}>Reach for</SortHead></span>
            <span className="tiny faint card-cat-earned"><SortHead field="earned" sort={sort} onSort={onSort}>Earned</SortHead></span>
            <span className="tiny faint card-cat-gap"><SortHead field="gap" sort={sort} onSort={onSort}>Missed</SortHead></span>
            <span />
          </div>
          {shown.map((r) => {
            // A saving that rounds to nothing is nothing. Printing "+$0" in
            // red against every line of a wallet that is already right turns
            // the one column worth reading into noise.
            const worth = r.gap >= WORTH_SAYING;
            return (
              <div key={r.key} className="card-cat">
                <span className="card-cat-name">{r.label}</span>
                <span className="num tiny faint card-cat-spend">{fmt0(r.spend)}</span>
                <span className="card-cat-best">
                  {/* Only when there is something to change. With nothing in
                      it, naming a card reads as "switch to this" against a
                      saving of nothing. */}
                  {worth && r.bestAccountId
                    ? <span className="tiny truncate">{byId.get(r.bestAccountId)?.name ?? "a card"}</span>
                    : <span className="tiny faint">stay put</span>}
                </span>
                <span className="num tiny faint card-cat-earned">{fmt0(r.earned)}</span>
                <span className={cx("num tiny card-cat-gap", worth && "neg")}>
                  {worth ? `+${fmt0(r.gap)}` : "-"}
                </span>
                <button
                  type="button"
                  className="ask-spark"
                  title={askTitle(r)}
                  aria-label={askTitle(r)}
                  onClick={() => onAsk(r)}
                >
                  <Sparkles size={13} />
                </button>
              </div>
            );
          })}
          {ranked.length > PREVIEW ? (
            <button className="btn view-all" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${ranked.length.toLocaleString()} ${noun}`}
            </button>
          ) : null}
        </>
      ) : (
        <div style={{ padding: "4px 16px 16px" }}>
          <span className="small faint">{empty ?? "Nothing to show yet."}</span>
        </div>
      )}
    </Card>
  );
}

/** The columns of the offers table. */
type DealField = "card" | "spend" | "reward" | "ratio";

/**
 * This month's sign-up offers, asked for once a month.
 *
 * The only thing on this page that is not arithmetic on the household's own
 * year, and it is labelled as such: a recollection with a date on it. Nothing
 * about them is sent to get it, because "what is on offer" has no answer that
 * depends on their money.
 *
 * "Monthly" means the first time the page is opened in a new month, which is
 * the only schedule an app with no server that can read its own data can keep.
 * Said plainly on the card rather than dressed up as a cron.
 */
function Offers() {
  const db = useDB();
  const { actions } = useStore();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const asked = useRef(false);
  const { sort, toggle: onSort, setSort } = useSort<DealField>({ key: "ratio", dir: "desc" });
  const [view, setView] = useState<DealView>("ratio");

  const held = db.cardOffers;
  const month = thisMonth();
  const stale = !held || held.month !== month;

  const run = useCallback(async () => {
    setBusy(true);
    setFailed(null);
    try {
      const { deals, note } = await fetchOffers();
      actions.rememberCardOffers(deals, note);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Hopper could not be reached.");
    } finally {
      setBusy(false);
    }
  }, [actions]);

  // Once a month, and once per visit however many times this re-renders. A
  // failure does not stamp the month, so the next visit tries again rather
  // than the card sitting empty until February.
  useEffect(() => {
    if (!stale || asked.current || !cloudEnabled()) return;
    asked.current = true;
    void run();
  }, [stale, run]);

  /**
   * Which question is being asked, before anything is sorted.
   *
   * Not a sort: the two rankings pick different cards, and the biggest bonus
   * is usually on a card whose ratio keeps it out of the top five. So the
   * choice cuts the list first and the column headings order what is left.
   */
  const shown = topBy(held?.deals ?? [], view);
  const rows = sortRows(shown, sort, (d, key) => {
    if (key === "spend") return d.spend;
    if (key === "reward") return d.reward;
    if (key === "ratio") return ratioOf(d);
    return d.card;
  });

  return (
    <Card pad={false}>
      <CardHead
        flush title="Worth opening this month"
        sub={view === "ratio"
          ? `The best of what Hopper remembers being on offer, by what the bonus pays against what it takes to earn it. Nothing beneath ${fmt0(MIN_REWARD)} of reward, because a small enough bonus makes a ratio that means nothing.`
          : "The biggest bonuses Hopper remembers, whatever they take to earn. A big bonus usually comes with a big spend requirement, which is why these are not the same cards as the best per dollar, so read the spend column before the reward one."}
        right={
          <Btn size="sm" onClick={() => void run()} disabled={busy}>
            <Sparkles size={13} /> {busy ? "Asking" : "Refresh"}
          </Btn>
        }
      />
      {(held?.deals.length ?? 0) > 0 ? (
        <div style={{ padding: "0 16px 12px" }}>
          {/* The heading changes with it, because "best" means two different
              things here and a table that silently swapped which cards were
              in it would be the page lying quietly. */}
          <Segmented
            value={view}
            options={VIEWS.map((v) => ({ ...v }))}
            onChange={(v) => { setView(v); setSort({ key: v, dir: "desc" }); }}
            spread
          />
        </div>
      ) : null}
      {rows.length ? (
        <>
          <div className="deal-row head">
            <span className="tiny faint"><SortHead field="card" sort={sort} onSort={onSort}>Card</SortHead></span>
            <span className="tiny faint deal-num"><SortHead field="spend" sort={sort} onSort={onSort}>Spend</SortHead></span>
            <span className="tiny faint deal-num"><SortHead field="reward" sort={sort} onSort={onSort}>Reward</SortHead></span>
            <span className="tiny faint deal-num"><SortHead field="ratio" sort={sort} onSort={onSort}>Per $1</SortHead></span>
          </div>
          {rows.map((d) => (
            <div key={d.card} className="deal-row">
              <span className="col" style={{ gap: 1, minWidth: 0 }}>
                <span className="truncate" style={{ fontWeight: 500 }}>{d.card}</span>
                {d.note || d.months ? (
                  <span className="tiny faint truncate">
                    {[d.note, d.months ? `within ${d.months} months` : ""].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </span>
              <span className="num tiny faint deal-num">{fmt0(d.spend)}</span>
              <span className="num tiny deal-num">{fmt0(d.reward)}</span>
              {/* Cents back per dollar spent, which is the ratio said in a
                  unit somebody can picture. 0.1 is ten cents on the dollar. */}
              <span className="num tiny bold deal-num">{ratioOf(d).toFixed(2)}</span>
            </div>
          ))}
        </>
      ) : (
        <div style={{ padding: "4px 16px 16px" }}>
          <span className="small faint">
            {busy ? "Asking Hopper what is on offer."
              : failed ? "Nothing to show, because the question could not be asked."
              : cloudEnabled() ? "Hopper had nothing it was confident enough to list."
              : "Hopper needs this browser connected. Connect under Settings, Sync across devices."}
          </span>
        </div>
      )}
      <div className="col" style={{ gap: 3, padding: "10px 16px 14px" }}>
        {failed ? <span className="tiny neg">{failed}</span> : null}
        {held ? (
          <span className="tiny faint">
            {held.note ? `${held.note} ` : ""}
            Asked {dateLabel(held.at.slice(0, 10), { year: true })}. These are what Hopper was trained on
            rather than live offers, so check the terms with the issuer before applying.
          </span>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * A shop to attach a rate to.
 *
 * A list the household has actually paid, offered rather than imposed: a card
 * being weighed up can name a chain nobody here has been to yet, and a picker
 * that only offered known shops could not express the one thing store cards
 * are for. So it is a text box with its own suggestions behind it.
 */
function MerchantAdd({ onAdd }: { onAdd: (name: string) => void }) {
  const db = useDB();
  const [text, setText] = useState("");
  const listId = useId();
  // The spellings the rest of the app shows, commonest first, so picking one
  // writes the same name the shop table and the merchant page use.
  const known = useMemo(
    () => [...merchantIndex(db).values()].sort((a, b) => b.count - a.count).slice(0, 400),
    [db],
  );
  const add = () => {
    const name = text.trim();
    if (!name) return;
    onAdd(name);
    setText("");
  };
  return (
    <span className="row" style={{ gap: 6, minWidth: 0 }}>
      <input
        className="input" list={listId} value={text} placeholder="Shop"
        aria-label="Shop this rate applies at"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        style={{ minWidth: 0 }}
      />
      <datalist id={listId}>
        {known.map((m) => <option key={m.name} value={m.name} />)}
      </datalist>
      <Btn size="sm" onClick={add} disabled={!text.trim()}><Plus size={12} /> Shop</Btn>
    </span>
  );
}

/**
 * What one card pays, said plainly enough to be checked against the card.
 *
 * The same form for a card in the wallet and one being weighed up, because
 * they hold the same thing. The only difference is whose name it is: a card
 * you hold is named by its account, and one you are considering is named by
 * whoever typed it in.
 */
function RewardsModal({ name: startName, rewards: start, nameLocked, onSave, onDelete, onClose }: {
  name: string;
  rewards: CardRewards;
  nameLocked?: boolean;
  onSave: (name: string, rewards: CardRewards) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const db = useDB();
  const [name, setName] = useState(startName);
  const [pointCents, setPointCents] = useState(start.pointCents);
  const [base, setBase] = useState(start.base);
  const [annualFee, setFee] = useState(start.annualFee ?? 0);
  const [balance, setBalance] = useState(start.balance?.points ?? 0);
  const [rules, setRules] = useState<EarnRule[]>(start.rules);
  const [requirement, setRequirement] = useState(start.bonus?.requirement ?? 0);
  const [bonusFrom, setBonusFrom] = useState(start.bonus?.from ?? today());
  const [bonusBy, setBonusBy] = useState(start.bonus?.by ?? addMonthsDate(today(), 3));
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * A first draft, for checking.
   *
   * It fills the form in and nothing else. Confirming is still a separate
   * press, so a rate the model half-remembers cannot present itself as one
   * somebody has read off their own card.
   */
  const askHopper = async () => {
    setAsking(true);
    setFailed(null);
    try {
      const draft = await draftRewards(name, db.categories);
      setBase(draft.base);
      setPointCents(draft.pointCents);
      setFee(Math.round(draft.annualFee * 100));
      setRules(toRules(draft, db.categories));
      setNote(draft.note || "Check every line against your own card before confirming.");
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Hopper could not be reached.");
    } finally {
      setAsking(false);
    }
  };

  const patch = (id: ID, p: Partial<EarnRule>) =>
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));

  /**
   * The quarter to offer next.
   *
   * The one after the latest window already written down, or the one we are in
   * if there are none. Four presses lay out a year, in order, without anybody
   * having to work out which quarter they are up to.
   */
  const nextWindow = useMemo(() => {
    const latest = rules.map((r) => r.to).filter((d): d is string => !!d).sort().pop();
    return latest ? nextQuarter(latest) : quarterWindow(today());
  }, [rules]);

  const save = (confirmed: boolean) => {
    onSave(name.trim() || startName, {
      pointCents, base, annualFee: annualFee || undefined,
      // A rate that claims nothing is not a rate. It used to have to name a
      // category; a store rate names only a shop, and dropping those on save
      // would have let somebody type one in and watch it vanish.
      rules: rules.filter((r) => r.categoryIds.length || (r.merchants ?? []).length),
      bonus: requirement > 0 ? { requirement, from: bonusFrom, by: bonusBy } : undefined,
      // Dated the day it was typed, and only re-dated when the figure itself
      // moves: opening this dialog to change a rate must not make a balance
      // from March look like one from today.
      balance: balance > 0
        ? {
          points: balance,
          at: balance === (start.balance?.points ?? 0) ? start.balance?.at ?? today() : today(),
        }
        : undefined,
      // Stamped only when a person says the terms are right. Saving a draft
      // keeps whatever the last confirmation was, so a half-finished edit
      // cannot quietly promote a guess.
      confirmedAt: confirmed ? new Date().toISOString() : start.confirmedAt,
    });
    onClose();
  };

  return (
    <Modal
      title={nameLocked ? startName : "A card to weigh up"}
      onClose={onClose}
      footer={
        <>
          {onDelete ? <Btn variant="danger" onClick={() => { onDelete(); onClose(); }}>Remove</Btn> : null}
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn onClick={() => save(false)}>Save</Btn>
          <Btn variant="primary" onClick={() => save(true)}>Save and confirm</Btn>
        </>
      }
    >
      <div className="card-ask">
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span className="small bold">Ask Hopper for a first draft</span>
          <span className="tiny faint">
            It is told the card's name and your category names, nothing else. What comes back is a
            draft to check, not an answer: Hopper does not know your card and will sometimes be wrong.
          </span>
        </div>
        <Btn size="sm" onClick={() => void askHopper()} disabled={asking}>
          <Sparkles size={13} /> {asking ? "Asking" : "Draft"}
        </Btn>
      </div>
      {note ? <span className="tiny" style={{ color: "var(--accent)" }}>{note}</span> : null}
      {failed ? <span className="tiny neg">{failed}</span> : null}

      {nameLocked ? null : (
        <Field label="Card" hint="Whatever the offer calls it">
          <input className="input" value={name} placeholder="Amex Gold" onChange={(e) => setName(e.target.value)} />
        </Field>
      )}

      <div className="row" style={{ gap: 12 }}>
        <Field label="On everything" hint="Per dollar, in whatever this card counts in">
          <PercentInput value={base} onChange={setBase} suffix="" />
        </Field>
        <Field label="A point is worth" hint="Leave at 1 for a cash-back card">
          <PercentInput value={pointCents} onChange={setPointCents} suffix="¢" />
        </Field>
      </div>
      <Field label="Annual fee"><MoneyInput value={annualFee} onChange={setFee} /></Field>

      {/* Only for a card actually held. A card being weighed up has no
          balance to hold, and nothing can fetch this one: no bank feed
          carries a rewards balance, so it is read off the statement and
          typed in. Dated, so the rewards tab can say how old it is instead
          of presenting last spring's figure as today's. */}
      {nameLocked ? (
        <Field
          label={pointCents === 1 ? "Cash back waiting" : "Points waiting"}
          hint={balanceHint(start.balance?.at, pointCents)}
        >
          {pointCents === 1
            ? <MoneyInput value={balance} onChange={setBalance} />
            : (
              <input
                className="input" type="number" min={0} step={1} inputMode="numeric"
                value={balance || ""} placeholder="0"
                onChange={(e) => setBalance(Math.max(0, Math.round(Number(e.target.value) || 0)))}
              />
            )}
        </Field>
      ) : null}

      <div className="col" style={{ gap: 10 }}>
        <div className="spread">
          <span className="small muted">Bonus rates</span>
          <span className="row" style={{ gap: 6 }}>
            {/* Named for the quarter it will add, so pressing it four times
                walks the year without anybody working out which one is next.
                A rotating card is the case this exists for: the rate and the
                cap are the same every quarter and only the categories change,
                so the dates are the part worth filling in for somebody. */}
            <Btn
              size="sm"
              title={`A 5% rate running ${nextWindow.from} to ${nextWindow.to}`}
              onClick={() => setRules((prev) => [...prev, {
                id: uid("er"), rate: 5, categoryIds: [],
                from: nextWindow.from, to: nextWindow.to,
                cap: ROTATING_CAP, period: "quarter",
              }])}
            >
              <Plus size={13} /> {quarterLabel(nextWindow.from)}
            </Btn>
            <Btn
              size="sm"
              onClick={() => setRules((prev) => [...prev, { id: uid("er"), rate: 3, categoryIds: [] }])}
            >
              <Plus size={13} /> Add
            </Btn>
          </span>
        </div>
        {rules.length ? rules.map((r) => (
          <div key={r.id} className="card-rule">
            <div className="row" style={{ gap: 8 }}>
              <span className="card-rule-rate"><PercentInput value={r.rate} onChange={(rate) => patch(r.id, { rate })} suffix="" /></span>
              <span className="tiny faint">on</span>
              <span className="grow">
                <CategoryPicker
                  value=""
                  clearLabel="Pick a category"
                  onChange={(id) => id && !r.categoryIds.includes(id)
                    && patch(r.id, { categoryIds: [...r.categoryIds, id] })}
                  trigger={(_c, open) => (
                    <button className="btn btn-sm" onClick={open}><Plus size={12} /> Category</button>
                  )}
                />
              </span>
              <button
                className="btn btn-ghost btn-icon" aria-label="Remove this rate"
                onClick={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <MerchantAdd
              onAdd={(name) => {
                const have = r.merchants ?? [];
                if (!have.some((m) => m.toLowerCase() === name.toLowerCase())) {
                  patch(r.id, { merchants: [...have, name] });
                }
              }}
            />
            {r.categoryIds.length || (r.merchants ?? []).length ? (
              <div className="row wrap" style={{ gap: 5 }}>
                {r.categoryIds.map((id) => (
                  <CategoryTag
                    key={id} categoryId={id}
                    onClick={() => patch(r.id, { categoryIds: r.categoryIds.filter((x) => x !== id) })}
                  />
                ))}
                {(r.merchants ?? []).map((name) => (
                  <span
                    key={name} className="chip card-rule-shop" title={`${name}: click to remove`}
                    onClick={() => patch(r.id, {
                      merchants: (r.merchants ?? []).filter((x) => x !== name),
                    })}
                  >
                    <Store size={11} />
                    <span className="truncate" style={{ maxWidth: 130 }}>{name}</span>
                  </span>
                ))}
              </div>
            ) : (
              <span className="tiny faint">
                Pick a category or a shop, or this rate does nothing. A purchase earns it if it matches either.
              </span>
            )}
            <div className="row" style={{ gap: 8 }}>
              <span className="tiny faint">up to</span>
              <span className="card-rule-cap">
                <MoneyInput value={r.cap ?? 0} onChange={(cap) => patch(r.id, { cap: cap || undefined })} />
              </span>
              <span className="card-rule-period">
                <SelectInput
                  value={r.period ?? ""}
                  onChange={(period) => patch(r.id, { period: (period || undefined) as EarnRule["period"] })}
                  options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
                />
              </span>
              <span className="tiny faint">{r.cap ? "" : "no cap"}</span>
            </div>
            {/* Only shown once a rule has one. Most rates are permanent, and
                two date boxes on every one of them would be asking a question
                about a card that does not rotate. */}
            {r.from || r.to ? (
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="tiny faint">running</span>
                <input
                  className="input card-rule-date" type="date" value={r.from ?? ""}
                  onChange={(e) => patch(r.id, { from: e.target.value || undefined })}
                />
                <span className="tiny faint">to</span>
                <input
                  className="input card-rule-date" type="date" value={r.to ?? ""}
                  onChange={(e) => patch(r.id, { to: e.target.value || undefined })}
                />
                <button
                  className="btn btn-ghost btn-sm" title="Make this rate permanent"
                  onClick={() => patch(r.id, { from: undefined, to: undefined })}
                >
                  Always
                </button>
              </div>
            ) : (
              <button
                className="btn btn-ghost btn-sm card-rule-dates"
                onClick={() => patch(r.id, nextWindow)}
              >
                Only for a while
              </button>
            )}
          </div>
        )) : <span className="tiny faint">Nothing beyond the base rate yet.</span>}
      </div>

      <div className="col" style={{ gap: 10 }}>
        <span className="small muted">Sign-up bonus</span>
        <Field label="Spend to earn it" hint="Leave at zero if there is none, or it has been paid">
          <MoneyInput value={requirement} onChange={setRequirement} />
        </Field>
        {requirement > 0 ? (
          <div className="row" style={{ gap: 12 }}>
            <Field label="From">
              <input className="input" type="date" value={bonusFrom} onChange={(e) => setBonusFrom(e.target.value)} />
            </Field>
            <Field label="By">
              <input className="input" type="date" value={bonusBy} onChange={(e) => setBonusBy(e.target.value)} />
            </Field>
          </div>
        ) : null}
      </div>

      <span className="tiny faint">
        {start.confirmedAt
          ? `Last confirmed ${new Date(start.confirmedAt).toLocaleDateString()}.`
          : "Nobody has confirmed these against the card yet."}
      </span>
    </Modal>
  );
}

/** What to say under the balance field, which depends on whether one is held. */
function balanceHint(at: string | undefined, pointCents: number): string {
  const what = pointCents === 1 ? "What the issuer says is there to redeem" : "What the issuer says your balance is";
  return at
    ? `${what}. Last entered ${dateLabel(at, { year: true })}; today's date is stamped on when the figure changes.`
    : `${what}. Nothing can fetch this, so it is read off the statement and typed in.`;
}

/** How far along a sign-up bonus is, in one line. */
function BonusLine({ b }: { b: BonusProgress }) {
  if (b.met) return <span className="tiny pos">Bonus earned: {fmt0(b.requirement)} spent.</span>;
  if (b.missed) {
    return (
      <span className="tiny faint">
        Bonus window closed with {fmt0(b.spent)} of {fmt0(b.requirement)} spent.
      </span>
    );
  }
  return (
    <span className={cx("tiny", b.daysLeft <= 30 ? "neg" : "muted")}>
      {fmt0(b.left)} still to spend for the bonus, {b.daysLeft} day{b.daysLeft === 1 ? "" : "s"} left.
    </span>
  );
}

/**
 * One card nobody holds, measured against the year that happened.
 *
 * The whole point of the page in one row: not "this card is good", but "on
 * what you actually bought, this would have paid this much more than the
 * cards you already carry, and its fee is this".
 */
function Candidate({ card, from, to, onEdit }: {
  card: CandidateCard; from: string; to: string; onEdit: () => void;
}) {
  const db = useDB();
  const v = useMemo(() => candidateValue(db, from, to, card.rewards), [db, from, to, card.rewards]);
  return (
    <button className="card-row" onClick={onEdit}>
      <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="bold truncate">{card.name}</span>
        <span className="tiny faint truncate">
          {v.gain > 0
            ? `${fmt0(v.gain)} more than your wallet earned, on ${fmt0(v.onIt)} of spending it would take`
            : "Nothing you buy would go on it: your wallet already pays as well or better"}
          {v.fee > 0 ? ` · ${fmt0(v.fee)} fee` : " · no fee"}
        </span>
      </span>
      <span className="col" style={{ gap: 1, textAlign: "right" }}>
        <span className={cx("num bold", v.net > 0 ? "pos" : "neg")}>
          {v.net > 0 ? `+${fmt0(v.net)}` : fmt0(v.net)}
        </span>
        <span className="tiny faint">a year, after the fee</span>
      </span>
    </button>
  );
}
