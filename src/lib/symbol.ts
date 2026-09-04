/**
 * Whether a string can be a market symbol.
 *
 * Lives on its own because both sides need the same answer: the browser uses
 * it to decide what is worth asking about, and api/_prices.ts uses it to
 * decide what may be put in an outbound URL path. A ticker is checked rather
 * than merely escaped — nothing that isn't shaped like one gets sent at all.
 */
export const isSymbol = (t: string): boolean => /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(t);
