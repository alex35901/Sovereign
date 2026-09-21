/**
 * What Plaid Link said when it stopped without handing anything back.
 *
 * Link reports trouble twice and differently. An ERROR event fires the moment
 * something goes wrong, carrying the code and the screen it happened on; the
 * exit callback fires later, when the dialog closes, and its error is null if
 * the person pressed Exit rather than being thrown out. So a bank that failed
 * with "Something went wrong" and was then dismissed arrived here as nothing
 * at all, and the app said nothing, and there was no way to find out what had
 * happened short of asking Plaid.
 *
 * Kept apart from the dialog itself so the wording can be tested without a
 * browser.
 */

export interface LinkFailure {
  /** Plaid's own message, when it gave one. */
  message?: string;
  code?: string;
  institution?: string;
  /** The screen it happened on, which is how far through the flow it got. */
  view?: string;
  requestId?: string;
  sessionId?: string;
}

/**
 * Plaid's reference for this attempt.
 *
 * Worth printing even when the cause is clear: it is the one thing Plaid's
 * support asks for, and it cannot be recovered after the dialog has closed.
 */
export function linkReference(f: LinkFailure): string {
  const parts = [
    f.sessionId ? `session ${f.sessionId}` : "",
    f.requestId ? `request ${f.requestId}` : "",
  ].filter(Boolean);
  return parts.length ? `Plaid's reference: ${parts.join(", ")}.` : "";
}

/** The codes worth explaining rather than repeating. */
const SAID: Record<string, string> = {
  INTERNAL_SERVER_ERROR:
    "Plaid hit an error at its own end rather than anything to do with this app or the details entered. "
    + "Banks that hand sign-in over to their own website fail this way when that handoff is down, and it is "
    + "usually over within the hour.",
  INSTITUTION_NOT_RESPONDING:
    "The bank is not answering Plaid at the moment. Nothing here is wrong and nothing needs changing; try again later.",
  INSTITUTION_DOWN:
    "Plaid has this bank marked as down. Try again later.",
  INSTITUTION_NOT_AVAILABLE:
    "Plaid cannot reach this bank at the moment. Try again later.",
  INSTITUTION_NO_LONGER_SUPPORTED:
    "Plaid no longer supports this bank. Its accounts have to be kept by hand or imported from a file.",
  INVALID_CREDENTIALS:
    "The bank rejected that username or password.",
  INVALID_MFA:
    "The bank rejected that security code.",
  ITEM_LOCKED:
    "The bank has locked this login after too many attempts. Sign in on the bank's own site to unlock it, then try again.",
  USER_SETUP_REQUIRED:
    "The bank needs something done on its own site before it will share this account.",
  INVALID_LINK_TOKEN:
    "The dialog's token had expired by the time it was used. Press the button again.",
  NO_ACCOUNTS:
    "That login has no accounts Plaid can share.",
};

/**
 * One line to show when Link stops without a public token.
 *
 * Says whose fault it is wherever that is knowable, because "Something went
 * wrong" leaves somebody checking their own password against a bank that is
 * simply down.
 */
export function describeLinkFailure(f: LinkFailure): string {
  const at = f.institution ? ` with ${f.institution}` : "";
  const said = f.code ? SAID[f.code] : undefined;
  const body = said ?? f.message ?? "Plaid gave no reason for it.";
  // The code as well as the explanation: it is what Plaid's own status page
  // and support are indexed by, and the explanation is this app's gloss on it.
  const code = f.code ? ` (${f.code})` : "";
  return [`Plaid Link could not finish${at}. ${body}${code}`, linkReference(f)]
    .filter(Boolean)
    .join(" ");
}
