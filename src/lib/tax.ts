import type { Bucket, DB, GroupKind, ID, ISODate, TaxLine, Transaction } from "../types.js";
import { budgetedCategoryIds, bucketIndex, bucketOf, byId, counts, lines, mutedAccountIds } from "./select.js";

/**
 * What a year cost, arranged the way a tax return asks for it.
 *
 * This is a summary to hand an accountant, not a return and not advice. It
 * adds up money the household has already recorded and puts it under the
 * headings the forms use, so January is an afternoon of checking rather than
 * an afternoon of scrolling. Nothing here decides whether a thing is
 * deductible, what anybody owes, or whether itemising beats the standard
 * deduction. A 1099 from the brokerage is still the authority on the
 * brokerage; this is the authority on nothing.
 *
 * Two mechanisms, deliberately kept apart:
 *
 *   - Personal lines come from tagging a category. Charitable giving is
 *     whatever the household calls charitable giving, which no rule can guess.
 *   - Business and rental come from the books an account or a row belongs to,
 *     which the app already tracks. Nothing to tag, because a separate set of
 *     books is already the answer to "is this a business expense".
 *
 * The two never overlap: a tagged line counts personal money only, so a
 * rental's property tax is in the rental's column and not also on Schedule A.
 */

export interface TaxLineInfo {
  id: TaxLine;
  label: string;
  /** Where it tends to land. Named so a summary is useful to a preparer. */
  form: string;
  /** Which way the money moves, so a refund nets out rather than adding. */
  direction: "out" | "in";
  note: string;
}

export const TAX_LINES: TaxLineInfo[] = [
  { id: "charitable", label: "Charitable giving", form: "Schedule A", direction: "out",
    note: "Cash and cheque giving to qualifying charities. Goods given away are valued separately." },
  { id: "mortgage_interest", label: "Mortgage interest", form: "Schedule A", direction: "out",
    note: "Interest only. A whole mortgage payment is mostly principal, which is not deductible." },
  { id: "property_tax", label: "Property tax", form: "Schedule A", direction: "out",
    note: "Counts towards the state and local cap along with income tax paid." },
  { id: "state_local_tax", label: "State and local income tax", form: "Schedule A", direction: "out",
    note: "Withholding shows on a W-2 already. Tag what was paid outside it." },
  { id: "medical", label: "Medical and dental", form: "Schedule A", direction: "out",
    note: "Only the part above a share of income counts, so record everything and let the preparer cut it." },
  { id: "childcare", label: "Child and dependent care", form: "Form 2441", direction: "out",
    note: "The provider's name and tax number are wanted too. Keep them in the notes." },
  { id: "student_loan_interest", label: "Student loan interest", form: "Schedule 1", direction: "out",
    note: "The servicer sends a 1098-E. This is the cross-check." },
  { id: "hsa", label: "HSA contributions", form: "Form 8889", direction: "out",
    note: "Money paid in directly. Payroll contributions are already on the W-2." },
  { id: "retirement", label: "Retirement contributions", form: "Schedule 1", direction: "out",
    note: "IRA and similar, paid from a bank account rather than through payroll." },
  { id: "education", label: "Tuition and education", form: "Form 8863", direction: "out",
    note: "The school sends a 1098-T. Books and fees are often not on it." },
  { id: "estimated_tax", label: "Estimated tax paid", form: "Form 1040-ES", direction: "out",
    note: "Quarterly payments already made, federal and state together." },
  { id: "interest_income", label: "Interest income", form: "1099-INT", direction: "in",
    note: "Bank interest. Reported whether or not a form arrives." },
  { id: "dividend_income", label: "Dividends", form: "1099-DIV", direction: "in",
    note: "Cash dividends landing in an account. Reinvested ones count too." },
];

export const taxLineInfo = (id: TaxLine): TaxLineInfo | undefined => TAX_LINES.find((l) => l.id === id);

/**
 * The cap on state and local tax as a deduction.
 *
 * Reported, never applied: the total stays whole and the cap is shown beside
 * it, because the right number to hand a preparer is what was actually paid.
 */
export const SALT_CAP = 10_000_00;

export interface TaxLineTotal {
  line: TaxLine;
  label: string;
  form: string;
  /** Positive in the natural direction. A refund reduces it. */
  total: number;
  count: number;
  /** The categories that fed it, named, so a surprise can be traced. */
  categories: string[];
}

export interface BookTotal {
  bucket: Bucket;
  label: string;
  form: string;
  income: number;
  expenses: number;
  net: number;
  /** Expense categories, largest first. */
  breakdown: { id: ID; name: string; total: number; count: number }[];
  /** The accounts keeping these books, named. */
  accounts: string[];
  count: number;
}

export interface TaxSummary {
  year: number;
  from: ISODate;
  to: ISODate;
  lines: TaxLineTotal[];
  books: BookTotal[];
  /** State and local tax against the cap, or null if nothing is tagged. */
  salt: { total: number; cap: number; over: number } | null;
  /** True when no category carries a tax line at all, so the screen can say so. */
  untagged: boolean;
  /** Transactions that fed the tagged lines. */
  counted: number;
}

const BOOK_LABEL: Record<Bucket, { label: string; form: string }> = {
  personal: { label: "Personal", form: "Form 1040" },
  business: { label: "Business", form: "Schedule C" },
  rental: { label: "Rental", form: "Schedule E" },
};

/** Years the document has transactions in, most recent first. */
export function taxYears(db: DB): number[] {
  const years = new Set<number>();
  for (const t of db.transactions) years.add(Number(t.date.slice(0, 4)));
  return [...years].filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
}

const inYear = (t: Transaction, year: number): boolean => t.date.slice(0, 4) === String(year);

/**
 * Everything the year has to say about tax.
 *
 * Splits contribute split by split, so a shop run that was half medical and
 * half groceries counts for the medical half only.
 */
export function taxSummary(db: DB, year: number): TaxSummary {
  const muted = mutedAccountIds(db);
  const accounts = bucketIndex(db);
  const cats = byId(db.categories);
  const budgeted = budgetedCategoryIds(db);

  const tagged = new Map<ID, TaxLine>();
  for (const c of db.categories) if (c.taxLine) tagged.set(c.id, c.taxLine);

  const totals = new Map<TaxLine, { total: number; count: number; cats: Set<string> }>();
  const books = new Map<Bucket, {
    income: number; expenses: number; count: number;
    cats: Map<ID, { total: number; count: number }>;
  }>();

  let counted = 0;

  for (const t of db.transactions) {
    if (!inYear(t, year) || !counts(t, muted)) continue;
    const bucket = bucketOf(t, accounts);

    if (bucket === "personal") {
      // Tagged lines are a household matter. A business's giving belongs to
      // the business's return, and counting it here as well would be the same
      // dollar deducted twice.
      let hit = false;
      for (const l of lines(t)) {
        const line = tagged.get(l.categoryId);
        if (!line) continue;
        const info = taxLineInfo(line);
        if (!info) continue;
        const row = totals.get(line) ?? { total: 0, count: 0, cats: new Set<string>() };
        row.total += info.direction === "out" ? -l.amount : l.amount;
        row.count++;
        const name = cats.get(l.categoryId)?.name;
        if (name) row.cats.add(name);
        totals.set(line, row);
        hit = true;
      }
      if (hit) counted++;
      continue;
    }

    // A separate set of books is its own small return. Transfers are left out
    // for the same reason they are everywhere else: moving money between two
    // accounts is not income and it is not an expense.
    const book = books.get(bucket) ?? { income: 0, expenses: 0, count: 0, cats: new Map() };
    let touched = false;
    for (const l of lines(t)) {
      if (!budgeted.has(l.categoryId)) continue;
      touched = true;
      if (l.amount >= 0) { book.income += l.amount; continue; }
      book.expenses += -l.amount;
      const row = book.cats.get(l.categoryId) ?? { total: 0, count: 0 };
      row.total += -l.amount;
      row.count++;
      book.cats.set(l.categoryId, row);
    }
    if (touched) book.count++;
    books.set(bucket, book);
  }

  const outLines: TaxLineTotal[] = TAX_LINES
    .filter((info) => totals.has(info.id))
    .map((info) => {
      const row = totals.get(info.id)!;
      return {
        line: info.id,
        label: info.label,
        form: info.form,
        total: Math.round(row.total),
        count: row.count,
        categories: [...row.cats].sort(),
      };
    });

  const outBooks: BookTotal[] = (["business", "rental"] as Bucket[])
    .filter((b) => books.has(b))
    .map((b) => {
      const book = books.get(b)!;
      return {
        bucket: b,
        label: BOOK_LABEL[b].label,
        form: BOOK_LABEL[b].form,
        income: Math.round(book.income),
        expenses: Math.round(book.expenses),
        net: Math.round(book.income - book.expenses),
        breakdown: [...book.cats.entries()]
          .map(([id, row]) => ({ id, name: cats.get(id)?.name ?? "Uncategorised", total: Math.round(row.total), count: row.count }))
          .sort((x, y) => y.total - x.total),
        accounts: db.accounts.filter((a) => a.bucket === b).map((a) => a.name).sort(),
        count: book.count,
      };
    });

  const saltTotal = outLines
    .filter((l) => l.line === "property_tax" || l.line === "state_local_tax")
    .reduce((n, l) => n + l.total, 0);

  return {
    year,
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    lines: outLines,
    books: outBooks,
    salt: saltTotal > 0 ? { total: saltTotal, cap: SALT_CAP, over: Math.max(0, saltTotal - SALT_CAP) } : null,
    untagged: tagged.size === 0,
    counted,
  };
}

/**
 * Categories that look like they belong on a line, for the ones nobody has
 * tagged yet.
 *
 * Suggestions only, and narrow on purpose. "Mortgage" is not offered for
 * mortgage interest, because a mortgage category is usually the whole payment
 * and most of a payment is principal. Nothing here writes anything; the
 * household still says yes.
 */
const HINTS: { line: TaxLine; test: RegExp; kind?: GroupKind }[] = [
  { line: "charitable", test: /charit|donation|tithe|giving|church|nonprofit/i },
  { line: "mortgage_interest", test: /mortgage interest|home loan interest/i },
  { line: "property_tax", test: /property tax|real estate tax/i },
  { line: "state_local_tax", test: /state tax|local tax|income tax/i, kind: "expense" },
  { line: "medical", test: /medical|dental|dentist|doctor|pharmacy|prescription|optometr|therap/i },
  { line: "childcare", test: /child ?care|daycare|day care|preschool|nanny|babysit/i },
  { line: "student_loan_interest", test: /student loan/i },
  { line: "hsa", test: /\bhsa\b|health savings/i },
  { line: "retirement", test: /\bira\b|roth|retirement contribution/i },
  { line: "education", test: /tuition|college|university|school fees/i },
  { line: "estimated_tax", test: /estimated tax|quarterly tax|1040-?es/i },
  { line: "interest_income", test: /interest income|bank interest/i },
  // A category called plainly "Interest" is interest earned when it sits under
  // income and interest paid when it does not, which the name alone cannot say.
  { line: "interest_income", test: /^interest$/i, kind: "income" },
  { line: "dividend_income", test: /dividend/i },
];

export function suggestLines(db: DB): { categoryId: ID; name: string; line: TaxLine; label: string }[] {
  const kinds = new Map(db.groups.map((g) => [g.id, g.kind]));
  const out: { categoryId: ID; name: string; line: TaxLine; label: string }[] = [];
  for (const c of db.categories) {
    if (c.taxLine || c.archived) continue;
    const kind = kinds.get(c.groupId);
    const hit = HINTS.find((h) => (!h.kind || h.kind === kind) && h.test.test(c.name));
    if (!hit) continue;
    const info = taxLineInfo(hit.line);
    if (!info) continue;
    out.push({ categoryId: c.id, name: c.name, line: hit.line, label: info.label });
  }
  return out;
}
