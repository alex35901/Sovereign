import type { Cadence, DB, ID, ISODate, Recurring, Transaction } from "../types.js";
import { addDays, addMonthsDate, today } from "./date.js";

/**
 * What a repeating charge is, in one place.
 *
 * The schedule is worked out in two directions: found in the history by
 * detectRecurring, or written down by hand. Both have to land on the same row,
 * or marking a subscription recurring would leave two of it on the page the
 * moment the detector noticed the same thing. That is what the id does here:
 * it is derived from the merchant, so a hand-written entry and a detected one
 * for the same name are the same entry, and whichever was written by hand
 * wins.
 */

export const CADENCES: { value: Cadence; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semiannual", label: "Twice a year" },
  { value: "yearly", label: "Yearly" },
];

export const KINDS: { value: Recurring["kind"]; label: string }[] = [
  { value: "bill", label: "Bill" },
  { value: "subscription", label: "Subscription" },
  { value: "income", label: "Income" },
];

export const cadenceLabel = (c: Cadence): string =>
  CADENCES.find((x) => x.value === c)?.label ?? c;

/**
 * One step of a cadence, in whichever unit that cadence is actually counted in.
 *
 * Fortnights are days and everything longer is calendar months, deliberately:
 * thirty days is not a month, and a year walked in thirty-day steps has
 * thirteen of them in it.
 */
const STEP_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 0, quarterly: 0, semiannual: 0, yearly: 0 };
const STEP_MONTHS: Record<Cadence, number> = { weekly: 0, biweekly: 0, monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };

export const stepDate = (from: ISODate, cadence: Cadence, n: number): ISODate =>
  STEP_DAYS[cadence] ? addDays(from, STEP_DAYS[cadence] * n) : addMonthsDate(from, STEP_MONTHS[cadence] * n);

/** A weekly item over five years is 260 steps; this is a spin guard, not a limit. */
const CAP = 4000;

/**
 * The first date after `seen` that has not already gone by.
 *
 * Every step is measured from the one date we know rather than from the last
 * one worked out, so a charge on the 31st stays on the 31st instead of
 * clamping to the 28th in February and staying there.
 */
export function nextAfter(seen: ISODate, cadence: Cadence, from: ISODate = today()): ISODate {
  let n = 1;
  while (n < CAP && stepDate(seen, cadence, n) <= from) n++;
  return stepDate(seen, cadence, n);
}

/**
 * The id the detector gives this merchant, so a hand-made row overrides it.
 *
 * Trimmed and lowercased on the way in, the same way merchantKey reads a name
 * everywhere else: a stray space around a name typed by hand would otherwise
 * be a second subscription sitting beside the first.
 */
export const recurringIdFor = (merchant: string): ID =>
  `rec_${merchant.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_")}`;

/** A schedule shaped like this transaction, for a merchant that has none yet. */
export function fromTransaction(t: Transaction, cadence: Cadence = "monthly"): Recurring {
  return {
    id: recurringIdFor(t.merchant),
    merchant: t.merchant,
    categoryId: t.categoryId,
    accountId: t.accountId,
    amount: t.amount,
    cadence,
    nextDate: nextAfter(t.date, cadence),
    kind: t.amount > 0 ? "income" : "bill",
    detected: false,
  };
}

/** What this merchant's schedule is, if it has one, and how it came to exist. */
export interface MerchantSchedule {
  /** The live schedule: hand-written if there is one, otherwise detected. */
  item?: Recurring;
  /** Written down by somebody, as opposed to worked out from the history. */
  manual: boolean;
  /** Said, by hand, not to be recurring at all. */
  dismissed: boolean;
}

/**
 * `list` is the merged schedule from recurringList, passed in rather than
 * computed, because working it out means walking every transaction and the
 * caller usually has it already.
 */
export function scheduleFor(db: DB, merchant: string, list: Recurring[]): MerchantSchedule {
  const id = recurringIdFor(merchant);
  const own = db.recurring.find((r) => r.id === id);
  return { item: list.find((r) => r.id === id), manual: !!own && !own.dismissed, dismissed: !!own?.dismissed };
}
