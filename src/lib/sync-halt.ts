/**
 * Whether auto-sync has stood down, and why.
 *
 * Its own module rather than a corner of cloud.ts because the vault needs to
 * clear it when a key appears, and cloud.ts needs the vault to decrypt — a
 * cycle between the two that ESM would tolerate and a reader would not.
 *
 * The loop polls every minute and used to swallow every error and try again
 * for ever, which was harmless while wrong answers were free. They are not
 * free any more: rotating SYNC_PASSPHRASE leaves every open browser holding
 * the old one, and a minute apart they would spend the household's whole
 * allowance and lock the address out for a day — from the app's own tabs,
 * while nobody was even sitting at them.
 */

export type Halt =
  /** The server refused the passphrase this browser had. */
  | "refused"
  /** Too many wrong answers from this address; the server is timing us out. */
  | "locked"
  /** The document is encrypted and this browser has no key for it. */
  | "encrypted";

let halted: Halt | null = null;

export const syncHalt = (): Halt | null => halted;
export const haltSync = (why: Halt): void => { halted = why; };
export const resumeSync = (): void => { halted = null; };
