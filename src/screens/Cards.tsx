import { useMemo, useState } from "react";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import type { Account, CardRewards, EarnRule, ID } from "../types";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { today } from "../lib/date";
import { rangeStart } from "../lib/range";
import { fmt0 } from "../lib/money";
import { uid } from "../lib/id";
import { cardAccounts, cardReport, rewardsOf, DEFAULT_REWARDS } from "../lib/cards";
import { draftRewards, toRules } from "../lib/hopper/rewards";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { CategoryPicker, CategoryTag } from "../components/pickers";
import { Btn, Card, CardHead, Empty, Field, Modal, MoneyInput, PercentInput, SelectInput, Tile, cx } from "../components/ui";

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

const PERIODS = [
  { value: "month", label: "a month" },
  { value: "quarter", label: "a quarter" },
  { value: "year", label: "a year" },
  { value: "", label: "ever" },
] as const;

export default function Cards() {
  const db = useDB();
  const cards = useMemo(() => cardAccounts(db), [db]);
  const [editing, setEditing] = useState<Account | null>(null);
  const to = today();
  const from = rangeStart("1y");
  const report = useMemo(() => cardReport(db, from, to), [db, from, to]);

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

  return (
    <>
      <TopBar title="Cards" />
      <div className="page stack">
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
                </span>
                <span className="col" style={{ gap: 1, textAlign: "right" }}>
                  <span className="num bold">{fmt0(c.earned)}</span>
                  <span className="tiny faint">on {fmt0(c.spend)}</span>
                </span>
              </button>
            );
          })}
        </Card>

        <Card pad={false}>
          <CardHead
            flush title="Where to put each purchase"
            sub="The last year, biggest miss first. The best card is the one to reach for at the till, given what the caps had already taken."
          />
          <div className="card-cat head">
            <span className="tiny faint">Category</span>
            <span className="tiny faint card-cat-spend">Spent</span>
            <span className="tiny faint">Reach for</span>
            <span className="tiny faint card-cat-earned">Earned</span>
            <span className="tiny faint card-cat-gap">Missed</span>
          </div>
          {report.categories.filter((c) => c.spend > 0).slice(0, 24).map((c) => {
            // A saving that rounds to nothing is nothing. Printing "+$0" in
            // red against every line of a wallet that is already right turns
            // the one column worth reading into noise.
            const worth = c.gap >= WORTH_SAYING;
            return (
              <div key={c.categoryId} className="card-cat">
                <span className="card-cat-name"><CategoryTag categoryId={c.categoryId} /></span>
                <span className="num tiny faint card-cat-spend">{fmt0(c.spend)}</span>
                <span className="card-cat-best">
                  {/* Only when there is something to change. With nothing in
                      it, naming a card reads as "switch to this" against a
                      saving of nothing. */}
                  {worth && c.bestAccountId
                    ? <span className="tiny truncate">{byId.get(c.bestAccountId)?.name ?? "a card"}</span>
                    : <span className="tiny faint">stay put</span>}
                </span>
                <span className="num tiny faint card-cat-earned">{fmt0(c.earned)}</span>
                <span className={cx("num tiny card-cat-gap", worth && "neg")}>
                  {worth ? `+${fmt0(c.gap)}` : "-"}
                </span>
              </div>
            );
          })}
        </Card>

        {report.offCard.spend > 0 ? (
          <Card>
            <CardHead
              title="Paid another way"
              sub={`${fmt0(report.offCard.spend)} of last year never went near a card. Most of what lands here cannot: a mortgage, a tax bill, the water rates. Where it can, it would be worth about ${fmt0(report.offCard.could)} a year.`}
            />
          </Card>
        ) : null}

        <span className="tiny faint" style={{ padding: "0 2px" }}>
          Worked out from your own purchases over the last year, and from what you have said each card pays.
          Sovereign holds no list of card products and never recommends one.
        </span>
      </div>
      {editing ? <RewardsModal account={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

/** What one card pays, said plainly enough to be checked against the card. */
function RewardsModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  const start = rewardsOf(account);
  const [pointCents, setPointCents] = useState(start.pointCents);
  const [base, setBase] = useState(start.base);
  const [annualFee, setFee] = useState(start.annualFee ?? 0);
  const [rules, setRules] = useState<EarnRule[]>(start.rules);
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
      const draft = await draftRewards(account.name, db.categories);
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

  const save = (confirmed: boolean) => {
    const next: CardRewards = {
      pointCents, base, annualFee: annualFee || undefined,
      rules: rules.filter((r) => r.categoryIds.length),
      // Stamped only when a person says the terms are right. Saving a draft
      // keeps whatever the last confirmation was, so a half-finished edit
      // cannot quietly promote a guess.
      confirmedAt: confirmed ? new Date().toISOString() : start.confirmedAt,
    };
    actions.updateAccount(account.id, { rewards: next });
    onClose();
  };

  return (
    <Modal
      title={account.name}
      onClose={onClose}
      footer={
        <>
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

      <div className="row" style={{ gap: 12 }}>
        <Field label="On everything" hint="Per dollar, in whatever this card counts in">
          <PercentInput value={base} onChange={setBase} suffix="" />
        </Field>
        <Field label="A point is worth" hint="Leave at 1 for a cash-back card">
          <PercentInput value={pointCents} onChange={setPointCents} suffix="¢" />
        </Field>
      </div>
      <Field label="Annual fee"><MoneyInput value={annualFee} onChange={setFee} /></Field>

      <div className="col" style={{ gap: 10 }}>
        <div className="spread">
          <span className="small muted">Bonus rates</span>
          <Btn
            size="sm"
            onClick={() => setRules((prev) => [...prev, { id: uid("er"), rate: 3, categoryIds: [] }])}
          >
            <Plus size={13} /> Add
          </Btn>
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
            {r.categoryIds.length ? (
              <div className="row wrap" style={{ gap: 5 }}>
                {r.categoryIds.map((id) => (
                  <CategoryTag
                    key={id} categoryId={id}
                    onClick={() => patch(r.id, { categoryIds: r.categoryIds.filter((x) => x !== id) })}
                  />
                ))}
              </div>
            ) : <span className="tiny faint">Pick at least one category, or this rate does nothing.</span>}
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
          </div>
        )) : <span className="tiny faint">Nothing beyond the base rate yet.</span>}
      </div>

      <span className="tiny faint">
        {start.confirmedAt
          ? `Last confirmed ${new Date(start.confirmedAt).toLocaleDateString()}.`
          : "Nobody has confirmed these against the card yet."}
      </span>
    </Modal>
  );
}
