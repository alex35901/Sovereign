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

/**
 * Who to tell when any of this changes.
 *
 * The halt and the stored passphrase are module state, not React state, so a
 * screen showing them has no way to know they moved. The Settings screen used
 * to poll every three seconds for the halt and never noticed the passphrase at
 * all — which is how a browser could be holding a passphrase while the card
 * beside it still said to go and enter one.
 */
let epoch = 0;
const listeners = new Set<() => void>();

export const syncEpoch = (): number => epoch;
export const subscribeSync = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
/** Say that something about the sync's state has moved. */
export const notifySync = (): void => {
  epoch++;
  for (const fn of [...listeners]) fn();
};

export const syncHalt = (): Halt | null => halted;
export const haltSync = (why: Halt): void => { halted = why; notifySync(); };
export const resumeSync = (): void => { halted = null; notifySync(); };
