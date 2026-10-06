import type { Cadence, DB, ID, ISODate, Recurring, Transaction } from "../types.js";
import { addDays, addMonthsDate, parseISO, toISO, today } from "./date.js";

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
  { value: "semimonthly", label: "15th and last day" },
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
const STEP_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, semimonthly: 0, monthly: 0, quarterly: 0, semiannual: 0, yearly: 0 };
const STEP_MONTHS: Record<Cadence, number> = { weekly: 0, biweekly: 0, semimonthly: 0, monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };

export const stepDate = (from: ISODate, cadence: Cadence, n: number): ISODate =>
  cadence === "semimonthly" ? semimonthlyStep(from, n)
    : STEP_DAYS[cadence] ? addDays(from, STEP_DAYS[cadence] * n) : addMonthsDate(from, STEP_MONTHS[cadence] * n);

/**
 * Twice a month, on the 15th and the last day, moved back to the Friday when
 * either lands on a weekend.
 *
 * Not "every 15 days" and not a step from the last date: a payroll on these
 * dates is pinned to the calendar, so the gap is 13 to 18 days and no fixed
 * step could ever stay on it. Each payday is a numbered slot instead (two a
 * month, counted from year zero) and a step is a step in slots. Measuring from
 * slots rather than from the dates themselves is what lets a Friday-the-13th
 * payday still be "the 15th" when the next one is worked out.
 *
 * Back to the Friday, not forward to the Monday, because that is what payroll
 * does: nobody holds wages over a weekend. Bank holidays are not modelled,
 * which costs at most a day's early warning a few times a year.
 */
export function semimonthlySlot(d: ISODate): number {
  const dt = parseISO(d);
  // The 15th can be pulled back as far as the 13th and the last day as far as
  // the 26th (a 28-day February ending on a Sunday). Anything up to the 22nd
  // is nearer the 15th; anything after it is the month's end.
  return (dt.getFullYear() * 12 + dt.getMonth()) * 2 + (dt.getDate() <= 22 ? 0 : 1);
}

export function semimonthlyDate(slot: number): ISODate {
  const month = Math.floor(slot / 2);
  const y = Math.floor(month / 12);
  const m = month - y * 12;
  const dt = slot % 2 === 0 ? new Date(y, m, 15) : new Date(y, m + 1, 0);
  const dow = dt.getDay();
  if (dow === 6) dt.setDate(dt.getDate() - 1);
  else if (dow === 0) dt.setDate(dt.getDate() - 2);
  return toISO(dt);
}

const semimonthlyStep = (from: ISODate, n: number): ISODate => semimonthlyDate(semimonthlySlot(from) + n);

/**
 * Whether a run of dates is the 15th-and-last-day pattern rather than a
 * fortnight that happens to sit near it.
 *
 * The gaps alone cannot tell them apart: they are 13 to 18 days, which the
 * detector reads as "every 2 weeks", and a fortnightly projection drifts a day
 * further off the real payday every month. Landing on the exact date, nominal
 * or pulled back to the Friday, is what tells them apart: a true fortnight
 * keeps the same weekday and so walks off the calendar dates within a couple of
 * months. Four in five of them exact, so one payday a bank posted a day late
 * does not lose the pattern, and six dates at least: checked against every
 * weekday fortnight over a decade, a run of four or five can land on the
 * calendar dates by coincidence and a run of six never does. Until then the
 * detector calls it every 2 weeks, which is what it did before this existed.
 */
export function looksSemimonthly(dates: readonly ISODate[]): boolean {
  if (dates.length < 6) return false;
  const exact = dates.filter((d) => {
    const slot = semimonthlySlot(d);
    const dt = parseISO(d);
    const nominal = slot % 2 === 0 ? 15 : new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    return d === semimonthlyDate(slot) || dt.getDate() === nominal;
  }).length;
  // And no slot twice: two charges in one half of a month are something else.
  const slots = new Set(dates.map(semimonthlySlot));
  return slots.size === dates.length && exact / dates.length >= 0.8;
}

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

/**
 * The id for a second, third, fourth schedule at a merchant that has one.
 *
 * Two tenants paying the same rent through the same service are one merchant
 * name and two expectations: the same day, the same amount, and either of them
 * able to stop paying without the other. One row cannot say that, so the
 * merchant's own id keeps the first of them and the rest are numbered off it.
 *
 * Why the first keeps the plain id: that is the id the detector derives, and
 * the whole point of deriving it is that a hand-written schedule and a found
 * one for the same name are the same row. Numbering the others preserves that,
 * because the detector only ever finds one pattern per merchant.
 *
 * The double underscore is safe as a separator rather than merely unlikely:
 * recurringIdFor collapses every run of non-alphanumerics to a single
 * underscore, so no merchant's slug can contain two in a row, whatever it is
 * called.
 */
export function anotherRecurringId(merchant: string, taken: Iterable<ID>): ID {
  const base = recurringIdFor(merchant);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  // Counts rather than searches: a merchant with three schedules whose second
  // was deleted gets __2 back, which is a free id and not the one in use.
  let n = 2;
  while (used.has(`${base}__${n}`) && n < 1000) n++;
  return `${base}__${n}`;
}

/** Which merchant a schedule belongs to, whether or not it is the first there. */
export const recurringMerchantId = (r: Recurring): ID => recurringIdFor(r.merchant);

/**
 * The name to put on a row, which is the merchant unless two of them share it.
 *
 * The label is the only thing separating one tenant's rent from the other's,
 * so it travels with the name everywhere the name is shown rather than being
 * left to each caller to remember.
 */
export const recurringTitle = (r: Recurring): string =>
  r.label?.trim() ? `${r.merchant} \u00b7 ${r.label.trim()}` : r.merchant;

/** Every schedule at one merchant, first to last. */
export const sameMerchant = (list: readonly Recurring[], merchant: string): Recurring[] => {
  const key = recurringIdFor(merchant);
  return list.filter((r) => recurringIdFor(r.merchant) === key);
};

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
  /**
   * Every live schedule at the merchant, the first of them included.
   *
   * A merchant can hold more than one, so "does this repeat" and "what does
   * it repeat as" have one answer and several. Callers that only need the
   * first still read `item`.
   */
  items: Recurring[];
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
  const items = sameMerchant(list, merchant);
  return {
    // The merchant's own id first, which is the one the detector and a
    // hand-written entry share; a merchant whose only schedule is a second one
    // still has a schedule, so fall through to it rather than reporting none.
    item: items.find((r) => r.id === id) ?? items[0],
    items,
    manual: !!own && !own.dismissed,
    dismissed: !!own?.dismissed,
  };
}
