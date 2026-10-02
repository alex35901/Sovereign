import type { LinkFailure } from "./link-error.js";

/**
 * Every Link attempt that ended in an error, kept.
 *
 * Link reports a failure once, into a dialog that then closes and takes it
 * with it. A reconnect could at least write it onto the item it was about, so
 * the row said what the bank had said. A *new* connection has no item to write
 * it on, so the one case where nothing in the app can help, because nothing in
 * the app is connected yet, was also the one case where the app remembered
 * nothing at all. Press it five times over five days and there are five
 * identical toasts and no record that it has been five days.
 *
 * Which matters for two reasons. Plaid's support asks for the session id of
 * the attempt, and a session id that scrolled past in a toast is gone. And the
 * app's own advice depends on it: "the bank is not answering, try again later"
 * is right the first afternoon and wrong by the second week, and the only way
 * to tell those apart is to have counted.
 */

export interface LinkFailureRecord {
  /** What Link said the bank was, when it had got far enough to know. */
  institution?: string;
  code?: string;
  /** The screen it happened on, which is how far through the flow it got. */
  view?: string;
  sessionId?: string;
  requestId?: string;
  at: string;
}

/**
 * How many to keep.
 *
 * The whole document is uploaded on every save, so this is not a log file. It
 * is enough attempts to show a pattern and to hand a support ticket more than
 * one reference.
 */
export const LINK_LOG_MAX = 20;

/** The log with this attempt on the front, newest first. */
export function noteLinkFailure(
  log: readonly LinkFailureRecord[] | undefined,
  f: LinkFailure,
  at: string,
): LinkFailureRecord[] {
  const record: LinkFailureRecord = {
    ...(f.institution ? { institution: f.institution } : {}),
    ...(f.code ? { code: f.code } : {}),
    ...(f.view ? { view: f.view } : {}),
    ...(f.sessionId ? { sessionId: f.sessionId } : {}),
    ...(f.requestId ? { requestId: f.requestId } : {}),
    at,
  };
  return [record, ...(log ?? [])].slice(0, LINK_LOG_MAX);
}

/**
 * The codes that can mean the bank is fine and this Plaid account is not
 * allowed to ask it.
 *
 * Plaid reports an account-level refusal at a big bank the same way it reports
 * that bank having a bad afternoon, because from inside Link they look the
 * same: the handoff to the bank's own website did not come back. The banks
 * most worth connecting are exactly the ones that hand sign-in over that way,
 * and a Plaid account has to be approved for each of them separately.
 *
 * So these codes are not a verdict on the bank. They are a verdict on the
 * attempt, and after enough attempts over enough days they are evidence of
 * something that waiting will not fix.
 */
export const HANDOFF_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
  "INSTITUTION_DOWN",
]);

export interface LinkPattern {
  institution: string;
  code: string;
  /** Attempts recorded with this code at this bank. */
  count: number;
  firstAt: string;
  lastAt: string;
  /** Whole days between the first and the last of them. */
  days: number;
  /** Every reference Plaid's support could ask for, newest first. */
  references: { sessionId?: string; requestId?: string; at: string }[];
}

const DAY_MS = 86_400_000;

/**
 * The repeated failure at one bank, if the log holds one.
 *
 * Grouped by bank and code, because two different failures at one bank is a
 * bank having a bad week and the same failure ten times is not.
 */
export function patternsIn(log: readonly LinkFailureRecord[] | undefined): LinkPattern[] {
  const by = new Map<string, LinkFailureRecord[]>();
  for (const r of log ?? []) {
    if (!r.institution || !r.code) continue;
    const key = `${r.institution}|${r.code}`;
    const held = by.get(key);
    if (held) held.push(r);
    else by.set(key, [r]);
  }
  const out: LinkPattern[] = [];
  for (const rows of by.values()) {
    const sorted = [...rows].sort((a, b) => (a.at < b.at ? 1 : -1));
    const first = sorted[sorted.length - 1]!;
    const last = sorted[0]!;
    out.push({
      institution: last.institution!,
      code: last.code!,
      count: sorted.length,
      firstAt: first.at,
      lastAt: last.at,
      days: Math.floor((Date.parse(last.at) - Date.parse(first.at)) / DAY_MS),
      references: sorted
        .filter((r) => r.sessionId || r.requestId)
        .map((r) => ({
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
          ...(r.requestId ? { requestId: r.requestId } : {}),
          at: r.at,
        })),
    });
  }
  return out.sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1));
}

/**
 * Whether this pattern has outlived the explanation the app has been giving.
 *
 * Three attempts and a day apart. A bank really is down for an afternoon, and
 * two presses a minute apart during that afternoon say nothing; the same
 * refusal on two different days is not weather.
 */
export function outlivedTheOutage(p: LinkPattern): boolean {
  return HANDOFF_CODES.has(p.code) && p.count >= 3 && p.days >= 1;
}

/** The longest-running pattern that has, if there is one. */
export function escalation(log: readonly LinkFailureRecord[] | undefined): LinkPattern | null {
  const worth = patternsIn(log).filter(outlivedTheOutage);
  return worth.sort((a, b) => b.days - a.days || b.count - a.count)[0] ?? null;
}

/**
 * What to say once a bank has refused the same way for days.
 *
 * Deliberately specific, because the generic version of this advice is what
 * has already been given and has already not helped. The thing it names is
 * the one cause of this that a household cannot see from inside the app and
 * cannot wait out: a Plaid account that has not been cleared to reach this
 * particular bank. Plaid's own troubleshooting lists an incomplete OAuth
 * registration as a common cause of exactly this error, and names the big
 * banks that hand sign-in to their own website as the ones it applies to.
 */
export function escalationAdvice(p: LinkPattern): string {
  const span = p.days === 1 ? "since yesterday" : `over ${p.days} days`;
  return `${p.institution} has refused this the same way ${p.count} times ${span}, so it is not the passing outage `
    + `that ${p.code} usually means. The other thing that looks exactly like this from inside the dialog is an `
    + `account-level one: the big banks hand sign-in over to their own website, and Plaid allows that only once `
    + `your own Plaid account has completed its OAuth registration and has full production access. Without both, `
    + `those banks are refused however healthy the bank is. Worth checking the OAuth registration status on `
    + `dashboard.plaid.com, and worth asking Plaid's support whether this client_id is enabled for `
    + `${p.institution} rather than whether the bank is up. The references below are what they will ask for.`;
}
