import type { Quiet } from "../quiet.js";

/**
 * Whose problem is it: the bank's, this connection's, or nobody's.
 *
 * A connection that stops has three quite different causes and, until now,
 * one appearance. The bank can be down for everybody. This one login can have
 * broken while the bank is fine for everyone else. Or everything can be
 * working and the bank simply has nothing new to hand over, which looks
 * identical from the outside and is the one case where the right answer is to
 * do nothing at all.
 *
 * Telling them apart takes two questions, and the app was asking neither.
 * /item/get says how this connection is faring and carries its own last
 * failure beside its last success. /institutions/get_by_id with a status flag
 * says how the institution is faring for every Plaid customer at once, per
 * product, with the moment it last changed. Put side by side they answer the
 * question a person actually has, which is not "what is the error code" but
 * "is this me, and is there anything I can do".
 *
 * The reading lives here, apart from the fetching, because the fetching needs
 * a network and a live bank and the reading needs neither. Everything below
 * is a pure function over what Plaid sent, so the sentence somebody reads at
 * two in the morning can be tested against fifty made-up outages.
 */

export type HealthState = "healthy" | "degraded" | "down" | "unknown";

/** One product at one institution, as Plaid grades it. */
export interface ProductHealth {
  /** What this product is called in the sentence, not in the API. */
  label: string;
  state: HealthState;
  /** When Plaid last moved this grade, ISO 8601. */
  since?: string;
  /** The share of attempts succeeding just now, 0 to 1. */
  success?: number;
}

export interface InstitutionHealth {
  name?: string;
  institutionId?: string;
  /** Only the products this app actually uses. */
  products: ProductHealth[];
  /** Plaid's own incident log for this bank, newest first. */
  incidents: { title: string; start?: string; end?: string }[];
}

/** What Plaid says about this one connection. */
export interface ItemHealth {
  lastSuccess?: string;
  lastFailure?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * The products worth reporting, and what to call them.
 *
 * Sign-ins first: a bank that cannot be signed into is the one failure that
 * makes every other grade beside the point, and it is the one that breaks
 * Link rather than the nightly pull.
 */
const PRODUCTS: { key: string; label: string }[] = [
  { key: "item_logins", label: "Sign-ins" },
  { key: "transactions_updates", label: "Transactions" },
  { key: "balance", label: "Balances" },
  { key: "investments_updates", label: "Investments" },
];

const STATES: Record<string, HealthState> = {
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  DOWN: "down",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Plaid's institution response, read down to what is worth saying.
 *
 * Defensive throughout, and deliberately so: this is the one call in the app
 * whose entire job is to run when something is already wrong, and a reader
 * that throws on a field Plaid stopped sending would take the diagnosis down
 * along with the thing it was meant to diagnose.
 */
export function readInstitutionHealth(raw: unknown): InstitutionHealth {
  const inst = (raw && typeof raw === "object"
    ? ((raw as Record<string, unknown>).institution ?? raw)
    : {}) as Record<string, unknown>;
  const status = (inst.status ?? {}) as Record<string, unknown>;

  const products: ProductHealth[] = [];
  for (const { key, label } of PRODUCTS) {
    const at = status[key];
    if (!at || typeof at !== "object") continue;
    const row = at as Record<string, unknown>;
    const breakdown = (row.breakdown ?? {}) as Record<string, unknown>;
    products.push({
      label,
      state: STATES[String(row.status)] ?? "unknown",
      since: str(row.last_status_change),
      success: num(breakdown.success),
    });
  }

  const rawIncidents = Array.isArray(status.health_incidents) ? status.health_incidents : [];
  const incidents = rawIncidents
    .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === "object")
    .map((i) => ({
      title: str(i.title) ?? "An incident at this bank",
      start: str(i.start_date),
      end: str(i.end_date),
    }));

  return {
    name: str(inst.name),
    institutionId: str(inst.institution_id),
    products,
    incidents,
  };
}

/** Plaid's item response, read down to how this one connection is faring. */
export function readItemHealth(raw: unknown): ItemHealth {
  const top = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const item = ((top.item ?? top) ?? {}) as Record<string, unknown>;
  const status = (item.status ?? {}) as Record<string, unknown>;
  const tx = (status.transactions ?? {}) as Record<string, unknown>;
  // The error can arrive on the item or beside it, depending on which call
  // carried it, and both spellings are worth reading.
  const err = ((item.error ?? top.error) ?? {}) as Record<string, unknown>;
  return {
    lastSuccess: str(tx.last_successful_update),
    lastFailure: str(tx.last_failed_update),
    errorCode: str(err.error_code),
    errorMessage: str(err.error_message) ?? str(err.display_message),
  };
}

/** An incident Plaid has not closed yet. */
const open = (i: { end?: string }): boolean => !i.end;

/** The worst grade any product carries, since one broken product is broken. */
export function worstOf(products: readonly ProductHealth[]): HealthState {
  const order: HealthState[] = ["down", "degraded", "healthy"];
  for (const state of order) if (products.some((p) => p.state === state)) return state;
  return "unknown";
}

export type Blame = "bank" | "connection" | "nobody" | "unknown";

export interface Verdict {
  blame: Blame;
  tone: "pos" | "neg" | "warn" | "muted";
  /** The answer, in one line. */
  headline: string;
  /** Why that is the answer. */
  detail: string;
  /** What to do, or empty when the answer is to do nothing. */
  action: string;
}

/** "3 days ago", for a timestamp that may be anything or nothing. */
function daysSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at > now) return undefined;
  return Math.floor((now - at) / 86_400_000);
}

const ago = (days: number | undefined): string =>
  days === undefined ? ""
    : days === 0 ? " today"
    : days === 1 ? " yesterday"
    : ` ${days} days ago`;

/** A share as a percentage, for a figure Plaid gives between 0 and 1. */
const pct = (v: number): number => Math.round(v * 100);

/**
 * The one sentence that says whose problem this is.
 *
 * Ordered by what a person can act on rather than by severity. A bank that is
 * down outranks everything, because nothing else is worth reading while it is
 * true and nothing anybody does here will change it. A connection that is
 * broken against a healthy bank comes next, because that one is fixable in a
 * minute. The case that used to be invisible comes last and matters most: a
 * healthy bank, a connection Plaid is reaching without trouble, and no new
 * transactions for weeks. That is the bank answering the question and saying
 * nothing, which is not a fault anywhere and cost this household three weeks
 * of assuming the app was broken.
 */
export function verdictOn(
  inst: InstitutionHealth,
  item: ItemHealth,
  opts: { quiet?: Quiet; now?: number } = {},
): Verdict {
  const now = opts.now ?? Date.now();
  const bank = inst.name ?? "this bank";
  const down = inst.products.filter((p) => p.state === "down");
  const degraded = inst.products.filter((p) => p.state === "degraded");
  const live = inst.incidents.filter(open);

  if (down.length) {
    const worst = down[0]!;
    const since = daysSince(worst.since, now);
    return {
      blame: "bank",
      tone: "neg",
      headline: `Not you. Plaid has ${bank} down.`,
      detail: `${down.map((p) => p.label.toLowerCase()).join(" and ")} stopped working for everyone`
        + `${ago(since)}${worst.since ? ` (${worst.since.slice(0, 10)})` : ""}.`
        + (live.length ? ` Plaid has an open incident: ${live[0]!.title}.` : ""),
      action: "",
    };
  }

  if (live.length) {
    return {
      blame: "bank",
      tone: "warn",
      headline: `Not you. Plaid has an open incident at ${bank}.`,
      detail: `${live[0]!.title}${live[0]!.start ? `, since ${live[0]!.start.slice(0, 10)}` : ""}.`,
      action: "",
    };
  }

  if (degraded.length) {
    const worst = degraded[0]!;
    const share = worst.success === undefined ? "" : ` About ${pct(1 - worst.success)}% of attempts are failing.`;
    return {
      blame: "bank",
      tone: "warn",
      headline: `Mostly not you. Plaid has ${bank} degraded.`,
      detail: `${degraded.map((p) => p.label.toLowerCase()).join(" and ")} have been patchy for everyone`
        + `${ago(daysSince(worst.since, now))}.${share}`,
      action: "Worth trying again, but expect it to be unreliable until Plaid clears it.",
    };
  }

  const healthy = inst.products.length > 0 && worstOf(inst.products) === "healthy";

  if (item.errorCode) {
    return {
      blame: "connection",
      tone: "neg",
      headline: healthy
        ? `This connection, not the bank. ${bank} is fine for everyone else.`
        : "This connection has an error.",
      detail: `${item.errorMessage ?? "Plaid gave no message with it."} (${item.errorCode})`,
      action: "Press Reconnect: it signs in again without changing anything here.",
    };
  }

  // Failing quietly. No error is stored against the item, but Plaid's last
  // attempt went worse than its last success, which is the signature of a
  // connection that broke since the last time anything looked at it.
  const success = item.lastSuccess ? Date.parse(item.lastSuccess) : NaN;
  const failure = item.lastFailure ? Date.parse(item.lastFailure) : NaN;
  if (Number.isFinite(failure) && (!Number.isFinite(success) || failure > success)) {
    return {
      blame: "connection",
      tone: "neg",
      headline: "This connection is failing, quietly.",
      detail: `Plaid last got through${ago(daysSince(item.lastSuccess, now))}`
        + ` and has failed every time since, most recently${ago(daysSince(item.lastFailure, now))}.`,
      action: "Press Reconnect: it signs in again without changing anything here.",
    };
  }

  // The case worth having built this for. Everything Plaid can see is
  // working, and the bank is simply not sending anything.
  if (opts.quiet && Number.isFinite(success)) {
    const q = opts.quiet;
    return {
      blame: "nobody",
      tone: "warn",
      headline: `Nothing is broken. ${bank} is sending nothing.`,
      detail: `Plaid reached ${bank} successfully${ago(daysSince(item.lastSuccess, now))}`
        + ` and it returned no new transactions. Nothing has arrived for ${q.days} days,`
        + ` against a usual gap of ${q.usual}.`,
      action: "Check the bank's own site for the missing transactions. If they are there,"
        + " it is worth reconnecting, and worth telling Plaid the reference below.",
    };
  }

  if (healthy && Number.isFinite(success)) {
    return {
      blame: "nobody",
      tone: "pos",
      headline: "Working.",
      detail: `Plaid has ${bank} healthy and last got through${ago(daysSince(item.lastSuccess, now))}.`,
      action: "",
    };
  }

  return {
    blame: "unknown",
    tone: "muted",
    headline: "Plaid did not say enough to tell.",
    detail: inst.products.length
      ? `${bank} is not reporting a status for the products this app uses.`
      : `Plaid returned no status for ${bank}.`,
    action: "",
  };
}
