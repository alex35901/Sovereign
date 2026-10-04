import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import type { Account } from "../types";
import { useDB } from "../store";
import { dateLabel } from "../lib/date";
import { fmt, fmt0 } from "../lib/money";
import type { CapRoom, CardReport, Move, RewardCard } from "../lib/cards";
import { rewardsSummary } from "../lib/cards";
import { InstitutionLogo } from "../components/InstitutionLogo";
import { Btn, Card, CardHead, Empty, Progress, Tile, cx } from "../components/ui";

/**
 * What the wallet has actually paid, and what to do about it.
 *
 * The honest shape of this page is set by one fact: no bank feed carries a
 * rewards balance. Plaid and Teller both answer about accounts, balances and
 * transactions, and neither has a field for the hundred thousand points
 * sitting with an issuer. So nothing here is fetched. What is earned is
 * computed from the household's own purchases against the rates it has
 * entered, which is exact rather than approximate, and the balance - the one
 * figure only the issuer knows - is typed in and dated.
 *
 * And points are not added up. A hundred thousand of one program beside a
 * hundred thousand of another is not two hundred thousand of anything. Only
 * the money they are worth adds, so money is what the headline shows and
 * points stay beside the card that earns them.
 */

/** Points, with the thousands separated, because they run to six figures. */
const POINTS = (n: number): string => n.toLocaleString();

export function RewardsTab({ report, onEdit, onAsk }: {
  /** The page's own report, so both tabs read one walk of the ledger. */
  report: CardReport;
  onEdit: (account: Account) => void;
  onAsk: (question: string) => void;
}) {
  const db = useDB();
  const summary = useMemo(() => rewardsSummary(db, report), [db, report]);
  const byId = useMemo(() => new Map(db.accounts.map((a) => [a.id, a])), [db.accounts]);

  /**
   * The open-ended half of the question, which this page cannot answer.
   *
   * Everything above is arithmetic on what happened. "What else could I be
   * doing" is not arithmetic: it is about transfer partners, portal rates and
   * which program is worth more than its cash value, none of which Sovereign
   * holds. Hopper is told what the wallet is and what it earned, and nothing
   * about where the money went.
   */
  const ask = () => {
    const wallet = summary.cards
      .map((c) => `${c.name} (${c.pointCents === 1 ? "cash back" : `points worth about ${c.pointCents} cents each`}${c.annualFee ? `, ${fmt0(c.annualFee)} a year` : ""})`)
      .join("; ");
    onAsk(
      `I carry these credit cards: ${wallet}. Over the last year they earned about ${fmt0(summary.value)} in rewards. `
      + "What are the best ways to get more out of this particular set of cards? Cover redeeming for more than a cent a point, "
      + "transfer partners where they apply, and any rotating or quarterly bonus worth registering for. "
      + "Say plainly where my own cards simply do not offer something.",
    );
  };

  return (
    <>
      <Card>
        <div className="fc-head">
          <span className="small muted">Your cards paid you, over the last year</span>
          <span className="nw-total num">{fmt0(summary.value)}</span>
          <span className="small faint">
            On {fmt0(summary.spend)} of spending.
            {summary.gap > 0
              ? ` Another ${fmt0(summary.gap)} was there to be had on the cards you already carry.`
              : " Every purchase went to the card that paid most for it."}
          </span>
        </div>
        <div className="grid g3" style={{ padding: "4px 16px 16px" }}>
          <Tile label="Earned" value={fmt0(summary.value)} sub="from your own purchases" />
          <Tile
            label="Waiting with the issuers"
            value={summary.banked.cards ? fmt0(summary.banked.worth) : "Not tracked"}
            sub={summary.banked.cards
              ? `${summary.banked.cards} card${summary.banked.cards === 1 ? "" : "s"} with a balance typed in${summary.banked.stale ? ", one of them a while ago" : ""}`
              : "No feed carries this. Open a card and type in what the issuer says."}
          />
          <Tile
            label="Left on the table" value={fmt0(summary.gap)}
            tone={summary.gap > 0 ? "neg" : undefined}
            sub="by reaching for the wrong card"
          />
        </div>
      </Card>

      <Card pad={false}>
        <CardHead
          flush title="What each card holds"
          sub="Earned is worked out from your own purchases against the rates you entered. The balance is the one figure nothing can fetch, so it is typed in and dated."
        />
        {summary.cards.map((c) => {
          const account = byId.get(c.accountId);
          return (
            <button
              key={c.accountId} className="card-row"
              onClick={() => account && onEdit(account)}
            >
              {account ? <InstitutionLogo account={account} size={30} /> : null}
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="row" style={{ gap: 6 }}>
                  <span className="bold truncate">{c.name}</span>
                  {/* Unconfirmed, not unset: the same rule the cards tab
                      goes by. Saving a draft fills the terms in and leaves
                      the confirmation alone, and a badge that cleared on a
                      draft would promote a guess. */}
                  {c.confirmed ? null : <span className="tag card-unset">not checked</span>}
                </span>
                {/* Left to wrap rather than truncated. A points card's line
                    carries three figures and the unit they are counted in,
                    and the clipped half is the half that explains it. */}
                <span className="tiny faint">
                  {c.pointCents === 1
                    ? `Cash back. ${fmt(c.value)} earned on ${fmt0(c.spend)} of spending.`
                    : `${POINTS(c.points)} points earned on ${fmt0(c.spend)} of spending, worth ${fmt(c.value)} at ${c.pointCents}\u00a2 each.`}
                </span>
                <Balance card={c} />
                {c.caps.map((cap) => <CapLine key={cap.ruleId} cap={cap} />)}
              </span>
              {/* Always what the card earned over the window, never the
                  balance: a column that means one thing on one row and
                  something else on the next is a column nobody can read down.
                  The balance has its own line above, with its own date. */}
              <span className="col" style={{ gap: 1, textAlign: "right" }}>
                <span className="num bold">{fmt0(c.value)}</span>
                <span className="tiny faint">earned</span>
              </span>
            </button>
          );
        })}
      </Card>

      <Card pad={false}>
        <CardHead
          flush title="Ways to get more out of them"
          sub="Worked out from where your money actually went. Biggest first, except for anything with a deadline on it."
          right={<Btn size="sm" onClick={ask}><Sparkles size={13} /> Ask Hopper</Btn>}
        />
        {/* Keyed by position, because one card can raise two of the same
            kind of move: two capped rates with room in both are two cap
            moves on one account, and keying by account would hand them the
            same key. The list is rebuilt whole on every change anyway. */}
        {summary.moves.length ? summary.moves.map((m, i) => (
          <MoveRow key={`${m.kind}-${i}`} move={m} />
        )) : (
          <div style={{ padding: "4px 16px 16px" }}>
            <Empty
              title="Nothing obvious left"
              body="Every purchase went to the card that paid most for it, and no cap or bonus has room in it. Worth asking Hopper about redemptions, which is the half of this Sovereign cannot see."
            />
          </div>
        )}
      </Card>

      <span className="tiny faint" style={{ padding: "0 2px" }}>
        No bank feed carries a rewards balance, so nothing on this page is pulled from your banks. What was
        earned comes from your own purchases and the rates you entered; what is sitting with an issuer is
        whatever you last typed in. Points are never added across cards, because two programs are two
        currencies and only the money they are worth can be put in one total.
      </span>
    </>
  );
}

/** The balance, with its date, because a number typed in March is not news. */
function Balance({ card }: { card: RewardCard }) {
  const b = card.balance;
  if (!b) {
    return (
      <span className="tiny faint">
        No balance typed in. Open this card to add what the issuer says you have.
      </span>
    );
  }
  return (
    <span className={cx("tiny", b.stale ? "neg" : "muted")}>
      {card.pointCents === 1 ? fmt(b.points) : `${POINTS(b.points)} points`} waiting
      {card.pointCents === 1 ? "" : `, worth ${fmt(b.worth)}`}, as of {dateLabel(b.at, { year: true })}
      {b.stale ? ". Worth checking." : ""}
    </span>
  );
}

/** A capped rate, and how much of this quarter is still open. */
function CapLine({ cap }: { cap: CapRoom }) {
  const what = cap.label || `${cap.rate}x`;
  return (
    <span className="col" style={{ gap: 3 }}>
      <span className="tiny faint">
        {what}: {fmt0(cap.used)} of {fmt0(cap.cap)}{cap.period ? ` this ${cap.period}` : ""}
        {cap.left > 0
          ? `, ${fmt0(cap.left)} left${cap.until ? ` until ${dateLabel(cap.until)}` : ""}`
          : ", full"}
      </span>
      <Progress value={cap.used} max={cap.cap} />
    </span>
  );
}

/** What a move is called, for the chip that says what kind of thing it is. */
const KIND: Record<Move["kind"], string> = {
  unset: "terms",
  bonus: "deadline",
  cap: "cap",
  merchant: "shop",
  category: "habit",
  fee: "fee",
  offcard: "off card",
  stale: "check",
};

function MoveRow({ move }: { move: Move }) {
  return (
    <div className={cx("card-row", "move-row")}>
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="bold">{move.title}</span>
          <span className="tag">{KIND[move.kind]}</span>
        </span>
        <span className="tiny faint">{move.detail}</span>
      </span>
      {move.worth > 0 ? (
        <span className="col" style={{ gap: 1, textAlign: "right" }}>
          <span className="num bold pos">{fmt0(move.worth)}</span>
          <span className="tiny faint">a year</span>
        </span>
      ) : null}
    </div>
  );
}
