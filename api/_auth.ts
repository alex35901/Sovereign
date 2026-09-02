import { createHash, timingSafeEqual } from "node:crypto";

/**
 * One passphrase guards the document. Compared as fixed-length digests through
 * timingSafeEqual, so neither the length nor the position of the first wrong
 * character can be read off the response time.
 */

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

export const passphrase = (): string => (process.env.SYNC_PASSPHRASE ?? "").trim();

export function passphraseSet(): boolean {
  return passphrase().length > 0;
}

export function passphraseOk(supplied: string | undefined): boolean {
  const expected = passphrase();
  if (!expected) return false;
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  return timingSafeEqual(digest(supplied), digest(expected));
}

/**
 * The same fixed-length comparison for any other shared secret — CRON_SECRET,
 * for one. A plain `===` on a secret returns as soon as two bytes differ, which
 * is exactly the leak timingSafeEqual exists to close.
 */
export function secretOk(expected: string, supplied: string | undefined): boolean {
  if (!expected) return false;
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  return timingSafeEqual(digest(supplied), digest(expected));
}

/** Reads the passphrase out of `Authorization: Bearer …`. */
export function bearer(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : undefined;
}
