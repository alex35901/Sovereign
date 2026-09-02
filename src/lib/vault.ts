import type { Envelope, Unlocked } from "./crypto.js";
import { unlockExisting, unlockNew } from "./crypto.js";
import { resumeSync } from "./sync-halt.js";

/**
 * Where the key lives between page loads.
 *
 * Not the passphrase — the key derived from it, held in IndexedDB as a
 * non-extractable CryptoKey. The browser will encrypt and decrypt with it, but
 * no script can read the bytes back out, this app's own included. Storing the
 * passphrase instead would put it in reach of anything that can run in the
 * page; storing nothing would mean typing it on every load.
 *
 * It is per-browser, and clearing site data clears it. That is the intended
 * trade: a lost key costs you a re-entry, and there is no copy of it anywhere
 * a server could be made to hand over.
 */

const DB_NAME = "sovereign.vault";
const DB_VERSION = 1;
const STORE = "keys";
const ID = "current";

let current: Unlocked | null = null;

/** The unlocked keys, or null if this browser has not been unlocked yet. */
export const vault = (): Unlocked | null => current;
export const isUnlocked = (): boolean => current !== null;

const idb = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    // Private windows and storage-blocking settings both land here. The app
    // still works; it just asks for the passphrase again next time.
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });

const put = (value: Unlocked | null): Promise<void> =>
  new Promise((resolve) => {
    void idb().then((db) => {
      if (!db) return resolve();
      try {
        const tx = db.transaction(STORE, "readwrite");
        if (value) tx.objectStore(STORE).put(value, ID);
        else tx.objectStore(STORE).delete(ID);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
      } catch { db.close(); resolve(); }
    });
  });

const get = (): Promise<Unlocked | null> =>
  new Promise((resolve) => {
    void idb().then((db) => {
      if (!db) return resolve(null);
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(ID);
        req.onsuccess = () => { db.close(); resolve((req.result as Unlocked | undefined) ?? null); };
        req.onerror = () => { db.close(); resolve(null); };
      } catch { db.close(); resolve(null); }
    });
  });

/** Reads the key back at startup. Safe to call more than once. */
export async function restore(): Promise<Unlocked | null> {
  if (current) return current;
  current = await get();
  return current;
}

/**
 * Turns a passphrase into the keys, and remembers them on this browser.
 *
 * With no envelope this is a first setup: a new salt and a new drop-box
 * keypair. With one, it is an existing document being opened, and a wrong
 * passphrase throws here rather than producing a key that silently decrypts
 * to nothing.
 */
export async function unlock(env: Envelope | null, passphrase: string): Promise<Unlocked> {
  const at = env ? await unlockExisting(env, passphrase) : await unlockNew(passphrase);
  current = at;
  await put(at);
  // There is now a key, so a loop that stood down for the lack of one can run.
  resumeSync();
  return at;
}

/** Forgets the key on this browser. The document is untouched. */
export async function lock(): Promise<void> {
  current = null;
  await put(null);
}
