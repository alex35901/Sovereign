import type { DB } from "../types.js";

/**
 * End-to-end encryption for the stored document.
 *
 * Everything here runs in the browser. The server holds an envelope it cannot
 * open: Neon sees ciphertext, Vercel sees ciphertext, and so does anyone who
 * reaches either of them. The passphrase that opens it is never sent anywhere
 * and is not the same secret as the one that opens the API — two separate
 * barriers, so breaking one still leaves the other.
 *
 * AES-256-GCM throughout, from Web Crypto rather than a library: it is the
 * platform's own implementation, it authenticates as well as encrypts (a
 * tampered document fails to open rather than opening wrong), and there is no
 * dependency to keep patched.
 *
 * The one thing encryption cannot do is make a short passphrase safe. Guessing
 * against the server is rate-limited; guessing against a stolen envelope is
 * not, and never can be. That is what the iteration count below is for, and
 * why a long passphrase matters more here than it did before.
 */

/**
 * `JsonWebKey` is a DOM type name. This module is compiled
 * twice — once for the browser and once for the serverless functions, which
 * are deliberately built without the DOM library so nothing in api/ can reach
 * for `document` and typecheck. Declared here, the same source satisfies both.
 */
type Jwk = { kty?: string; crv?: string; x?: string; y?: string; d?: string; [k: string]: unknown };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * OWASP's current floor for PBKDF2-HMAC-SHA256. Recorded inside each envelope
 * rather than assumed, so raising it later still opens documents written now.
 */
export const ITERATIONS = 600_000;
const KEY_BITS = 256;
/** 96 bits, the size AES-GCM is defined for. Fresh for every single encryption. */
const IV_BYTES = 12;
const SALT_BYTES = 16;

export const toB64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s);
};

export const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n));
export const newSalt = (): Uint8Array<ArrayBuffer> => randomBytes(SALT_BYTES);

/**
 * Passphrase to key.
 *
 * Non-extractable on purpose: the browser can encrypt and decrypt with the
 * result, but no script — this app's own included — can read the key material
 * back out. That is what makes it safe to keep the key rather than the
 * passphrase between page loads.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number = ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw", encoder.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface Sealed { iv: string; ct: string }

export async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv }, key, encoder.encode(plaintext),
  );
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** Throws if the passphrase is wrong or a byte has been changed in transit. */
export async function unseal(key: CryptoKey, sealed: Sealed): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(sealed.iv) }, key, fromB64(sealed.ct),
  );
  return decoder.decode(plain);
}

/* ── the document envelope ─────────────────────────────────────────────── */

export interface Envelope {
  v: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: "AES-256-GCM";
  iv: string;
  ct: string;
  /**
   * The public half of a keypair the scheduled job encrypts to. Public by
   * definition, so it sits in the clear beside the ciphertext.
   */
  pub: string;
  /** The private half, itself encrypted with the passphrase-derived key. */
  wrappedPriv: Sealed;
}

/** Whether what came back from the server is an envelope or a bare document. */
export function isEnvelope(doc: unknown): doc is Envelope {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as Partial<Envelope>;
  return d.v === 1 && typeof d.ct === "string" && typeof d.iv === "string" && !!d.kdf;
}

/* ── the drop box ──────────────────────────────────────────────────────── */

/**
 * A keypair so the scheduled job can hand work back.
 *
 * The job runs on Vercel with no way to read the document, but it still has to
 * deliver what it pulled overnight. It encrypts to this public key; only a
 * browser holding the passphrase can open the result. P-256 rather than
 * X25519: every browser and Node have had it for years.
 */
export const KEY_ALGO = { name: "ECDH", namedCurve: "P-256" } as const;

export async function newKeypair(): Promise<{ pub: string; priv: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(KEY_ALGO, true, ["deriveBits"]);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { pub: toB64(raw), priv: pair.privateKey };
}

const exportPriv = async (priv: CryptoKey): Promise<string> =>
  JSON.stringify(await crypto.subtle.exportKey("jwk", priv));

const importPriv = (jwk: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("jwk", JSON.parse(jwk) as Jwk, KEY_ALGO, true, ["deriveBits"]);

/**
 * The shared AES key both sides of the drop box arrive at.
 *
 * One side has a private key and the other's public key; the other side has
 * the reverse. Neither transmits the secret, and an onlooker holding both
 * public keys cannot compute it.
 */
async function sharedKey(priv: CryptoKey, pubRaw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey("raw", pubRaw, KEY_ALGO, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, KEY_BITS);
  // Run through HKDF rather than used raw: the x-coordinate of a curve point is
  // not uniformly distributed, which is not what a block cipher wants as a key.
  const hkdf = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("sovereign/dropbox/v1") },
    hkdf,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface DropBox { epk: string; iv: string; ct: string }

/**
 * Encrypts to a public key, for a sender with no key of its own.
 *
 * A throwaway keypair is made for this one message and its private half is
 * dropped on the spot. That is what lets the scheduled job write something it
 * can never read back — including moments later, having been compromised.
 */
export async function sealTo(pubB64: string, plaintext: string): Promise<DropBox> {
  const ephemeral = await crypto.subtle.generateKey(KEY_ALGO, true, ["deriveBits"]);
  const key = await sharedKey(ephemeral.privateKey, fromB64(pubB64));
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv }, key, encoder.encode(plaintext),
  );
  const epk = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
  return { epk: toB64(epk), iv: toB64(iv), ct: toB64(ct) };
}

export async function openFrom(priv: CryptoKey, box: DropBox): Promise<string> {
  const key = await sharedKey(priv, fromB64(box.epk));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct),
  );
  return decoder.decode(plain);
}

/* ── what the rest of the app calls ────────────────────────────────────── */

export interface Unlocked {
  key: CryptoKey;
  /** Kept so a re-encrypt reuses the same salt and the same drop-box keypair. */
  kdf: Envelope["kdf"];
  pub: string;
  priv: CryptoKey;
  /**
   * The private key already sealed, carried rather than recomputed. Saving is
   * then one encryption instead of two, and the stored bytes stay identical
   * across saves, which makes a changed keypair obvious rather than routine.
   */
  wrappedPriv: Sealed;
}

/** A brand new encrypted identity: fresh salt, fresh drop-box keypair. */
export async function unlockNew(passphrase: string): Promise<Unlocked> {
  const kdf = {
    name: "PBKDF2" as const, hash: "SHA-256" as const,
    iterations: ITERATIONS, salt: toB64(newSalt()),
  };
  const key = await deriveKey(passphrase, fromB64(kdf.salt), kdf.iterations);
  const { pub, priv } = await newKeypair();
  return { key, kdf, pub, priv, wrappedPriv: await seal(key, await exportPriv(priv)) };
}

/**
 * The one failure that really does mean the passphrase was wrong.
 *
 * Everything else that can go wrong while opening a document — a key the
 * browser will not import, storage it will not write to, a server that will
 * not answer — used to be reported as a bad passphrase too, which sent people
 * to look for a typo in something that was correct all along.
 */
export class WrongPassphrase extends Error {
  constructor() {
    super("That passphrase doesn't open this document.");
    this.name = "WrongPassphrase";
  }
}

/**
 * Opens an envelope, or throws if the passphrase is wrong.
 *
 * There is deliberately no way to tell a wrong passphrase from a corrupted
 * document: GCM's tag check fails identically for both, and inventing a
 * distinction would mean storing something that confirms a correct guess.
 * Anything after that check is a different kind of problem and says so.
 */
export async function unlockExisting(env: Envelope, passphrase: string): Promise<Unlocked> {
  const key = await deriveKey(passphrase, fromB64(env.kdf.salt), env.kdf.iterations);
  let privJwk: string;
  try {
    privJwk = await unseal(key, env.wrappedPriv);
  } catch {
    throw new WrongPassphrase();
  }
  // Past here the passphrase is known to be right: it just decrypted something
  // only it could. A failure now is the browser's, and blaming the passphrase
  // for it would be a lie the person cannot check.
  const priv = await importPriv(privJwk);
  return { key, kdf: env.kdf, pub: env.pub, priv, wrappedPriv: env.wrappedPriv };
}

export async function encryptDocument(doc: DB, at: Unlocked): Promise<Envelope> {
  const body = await seal(at.key, JSON.stringify(doc));
  return {
    v: 1,
    kdf: at.kdf,
    cipher: "AES-256-GCM",
    iv: body.iv,
    ct: body.ct,
    pub: at.pub,
    wrappedPriv: at.wrappedPriv,
  };
}

export async function decryptDocument(env: Envelope, at: Unlocked): Promise<DB> {
  return JSON.parse(await unseal(at.key, { iv: env.iv, ct: env.ct })) as DB;
}
