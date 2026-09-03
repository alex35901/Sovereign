import type { DB } from "../types";
import type { Envelope } from "./crypto.js";
import { decryptDocument, encryptDocument, isEnvelope } from "./crypto.js";
import { restore, vault } from "./vault.js";
import { haltSync, notifySync, resumeSync, syncHalt } from "./sync-halt.js";

/**
 * Talking to the stored budget document.
 *
 * The passphrase lives in this browser only, never in the document, and is sent
 * as a bearer token. Losing it costs nothing but retyping — the data is in the
 * database, not behind the phrase.
 */

const ENDPOINT = "/api/db";
const PASS_KEY = "sovereign.cloud.pass";
const STATE_KEY = "sovereign.cloud.state.v1";
export const CONFLICT_KEY = "sovereign.db.conflict.v1";

export interface CloudState {
  /** Version of the document this browser last agreed with the server on. */
  version: number;
  /** Local edits made since then that the server hasn't accepted yet. */
  dirty: boolean;
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const cloudState = (): CloudState => read<CloudState>(STATE_KEY, { version: 0, dirty: false });
export const setCloudState = (s: CloudState): void => {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* storage full; next write retries */ }
};

export const passphrase = (): string => {
  try { return localStorage.getItem(PASS_KEY) ?? ""; } catch { return ""; }
};
export const setPassphrase = (p: string): void => {
  try {
    if (p) localStorage.setItem(PASS_KEY, p);
    else localStorage.removeItem(PASS_KEY);
  } catch { /* nothing to do */ }
  // A passphrase entered by hand is the one thing that can clear a halt.
  resumeSync();
  // resumeSync only tells anyone when a halt was actually lifted, and this may
  // have changed nothing but the passphrase — which is the very thing the
  // Encryption card keys off.
  notifySync();
};
export { syncHalt, resumeSync, subscribeSync, syncEpoch } from "./sync-halt.js";

export const cloudEnabled = (): boolean => syncHalt() === null && passphrase().length > 0;

/** A name for the row's "last changed by", so a surprise edit is traceable. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : "a browser";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : "browser";
  return `${browser} on ${os}`;
}

/**
 * The document came back encrypted and this browser has no key for it.
 *
 * Distinct from a refusal: the passphrase that opens the API was right, so
 * there is nothing wrong with the connection — the encryption passphrase is
 * simply not on this device yet.
 */
export class LockedError extends Error {
  constructor(public envelope: Envelope) {
    super("This document is encrypted. Enter its passphrase to read it.");
    this.name = "LockedError";
  }
}

export class CloudError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "CloudError";
  }
}

async function call(init: RequestInit, override?: string, query = ""): Promise<Response> {
  const pass = override ?? passphrase();
  if (!pass) throw new CloudError("No passphrase set on this device.", 0);
  let res: Response;
  try {
    res = await fetch(ENDPOINT + query, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${pass}` },
    });
  } catch {
    throw new CloudError("Couldn't reach the sync service. Check your connection.", 0);
  }
  // Only the stored passphrase can halt the loop. A wrong one typed into the
  // box is being checked on purpose, and stopping sync over it would be odd.
  if (override === undefined && (res.status === 401 || res.status === 429)) {
    haltSync(res.status === 429 ? "locked" : "refused");
  }
  if (res.status === 404) {
    throw new CloudError("The /api/db function isn't running. This needs the deployed app, not `npm run dev`.", 404);
  }
  return res;
}

/**
 * The server's own words where it has any.
 *
 * A platform-level failure answers with an HTML page rather than this app's
 * JSON, and reducing that to a bare status code hides the only clue there is —
 * so the raw body is shown instead.
 */
const messageOf = async (res: Response, fallback: string): Promise<string> => {
  let text = "";
  try {
    text = await res.clone().text();
  } catch {
    return fallback;
  }
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body.error) return body.error;
  } catch { /* not this app's JSON — fall through to the raw body */ }
  const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain ? `${fallback}: ${plain.slice(0, 300)}` : fallback;
};

export interface RemoteDoc {
  found: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string;
  doc: DB;
}

/**
 * The stored document, or null when the database is still empty.
 *
 * What comes back is either an envelope this browser must open or, on an
 * installation that has not been encrypted yet, the document itself.
 */
export async function pull(): Promise<RemoteDoc | null> {
  const res = await call({ method: "GET" });
  if (!res.ok) throw new CloudError(await messageOf(res, `Load failed (${res.status})`), res.status);
  const body = (await res.json()) as RemoteDoc & { doc: DB | Envelope };
  if (!body.found) return null;

  if (isEnvelope(body.doc)) {
    const at = vault() ?? await restore();
    if (!at) {
      // Stand the loop down. This browser cannot read the document and its own
      // copy must not be saved over it — the server refuses that outright, but
      // there is no sense hammering at it once a minute until someone unlocks.
      haltSync("encrypted");
      throw new LockedError(body.doc);
    }
    return { ...body, doc: await decryptDocument(body.doc, at) };
  }
  return body as RemoteDoc;
}

export interface PushResult {
  version: number;
  updatedAt: string;
}

/**
 * Saves, refusing if the server has moved past `baseVersion`. A conflict is
 * surfaced rather than resolved — silently overwriting another device's work is
 * the one outcome worth avoiding.
 */
export async function push(doc: DB, baseVersion: number): Promise<PushResult> {
  // Encrypted whenever this browser holds a key. An installation that has not
  // been set up yet keeps saving in the clear rather than silently locking
  // itself out of a document its other devices could no longer read.
  const at = vault() ?? await restore();
  const payload = at ? await encryptDocument(doc, at) : doc;
  const res = await call({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: payload, baseVersion, device: deviceName() }),
  });
  if (res.status === 409) throw new CloudError(await messageOf(res, "Changed elsewhere."), 409);
  if (!res.ok) throw new CloudError(await messageOf(res, `Save failed (${res.status})`), res.status);
  return (await res.json()) as PushResult;
}

/**
 * What is stored, without opening it.
 *
 * Settings needs to know whether the document is encrypted before it can offer
 * the right thing to do about it, and asking that question must not require the
 * key — the whole point of the locked state is that there isn't one yet.
 *
 * There are two of these. `head` answers the version-and-sealed question with a
 * reply small enough to ask every minute; `peek` answers it and hands back the
 * envelope, which only the unlock screen actually needs.
 */

/**
 * Has it changed, and is it sealed — without moving the document.
 *
 * The whole reason the sync is cheap. A poll that fetched the document to
 * compare a version number moved half a megabyte a minute out of the database
 * per open tab, which exhausted a 5 GB monthly allowance in about two days.
 */
export interface Meta {
  found: boolean;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  sealed: boolean;
}

export async function head(): Promise<Meta> {
  const res = await call({ method: "GET" }, undefined, "?meta=1");
  if (!res.ok) throw new CloudError(await messageOf(res, `Load failed (${res.status})`), res.status);
  const body = (await res.json()) as Partial<Meta> & { found: boolean };
  return {
    found: !!body.found,
    version: Number(body.version ?? 0),
    updatedAt: body.updatedAt ?? null,
    updatedBy: body.updatedBy ?? null,
    sealed: !!body.sealed,
  };
}

export interface Peek {
  found: boolean;
  encrypted: boolean;
  envelope: Envelope | null;
  /** The stored version, so a browser that cannot read the document can still
   *  write over it without racing another device. */
  version: number;
  /** When the stored copy was last written, and by what. Carried because a
   *  passphrase that stopped working is nearly always a document that was
   *  re-sealed, and the date is the only thing that can say so. */
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The same question as `head`, plus the envelope when there is one.
 *
 * Only the Encryption card needs the envelope, and only to unlock with it, so
 * everything else asks `head` and never touches the document.
 */
export async function peek(): Promise<Peek> {
  const res = await call({ method: "GET" });
  if (!res.ok) throw new CloudError(await messageOf(res, `Load failed (${res.status})`), res.status);
  const body = (await res.json()) as {
    found: boolean; doc?: unknown; version?: number; updatedAt?: string; updatedBy?: string;
  };
  if (!body.found) {
    return { found: false, encrypted: false, envelope: null, version: 0, updatedAt: null, updatedBy: null };
  }
  const env = isEnvelope(body.doc) ? body.doc : null;
  return {
    found: true,
    encrypted: env !== null,
    envelope: env,
    version: Number(body.version ?? 0),
    updatedAt: body.updatedAt ?? null,
    updatedBy: body.updatedBy ?? null,
  };
}

/* ── what the scheduled job left behind ───────────────────────────────── */

export interface QueuedPull { id: number; createdAt: string; epk: string; iv: string; ct: string }

/**
 * The overnight pulls waiting to be merged in.
 *
 * While the document is encrypted the scheduled job cannot merge into it, so
 * it queues what it fetched, encrypted to this installation's public key. This
 * is the browser end of that: the only place the queue can actually be read.
 */
export async function queued(): Promise<QueuedPull[]> {
  const res = await call({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "queue" }),
  });
  if (!res.ok) throw new CloudError(await messageOf(res, `Could not read the sync queue (${res.status})`), res.status);
  return ((await res.json()) as { queued: QueuedPull[] }).queued;
}

/** Called only after the merged result has been saved. */
export async function ackQueued(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await call({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "queue_ack", ids }),
  });
}

export interface CloudDiagnosis {
  driver: { ok: boolean; error: string | null };
  variable: string | null;
  host: string | null;
  database: string | null;
  ssl: boolean;
  passphraseSet: boolean;
  /** How many callers are currently shut out for guessing. */
  lockedOut?: number | null;
  /** What the server can see of the encryption setup. Never any value itself. */
  encryption?: {
    documentSealed: boolean | null;
    simplefinUrlSet: boolean;
    cronSecretSet: boolean;
    queued: number;
    queuedOldest: string | null;
  };
  connect: { ok: boolean; error: string | null; code: string | null };
  table: { ok: boolean; error: string | null };
  documents: number | null;
}

/**
 * Asks the function what it can actually see, without any credential coming
 * back. Takes a passphrase directly so the check still runs on a browser that
 * has not managed to connect yet — which is when it is most wanted.
 */
export async function diagnose(override?: string): Promise<CloudDiagnosis> {
  const res = await call({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "diagnose" }),
  }, override);
  if (!res.ok) throw new CloudError(await messageOf(res, `Check failed (${res.status})`), res.status);
  return (await res.json()) as CloudDiagnosis;
}

export interface Probe {
  alive: boolean;
  node?: string;
  region?: string | null;
  envSet?: string[];
  [module: string]: unknown;
}

/**
 * The import-free endpoint. Asked when /api/db fails to answer at all, because
 * a function that dies on load cannot report why — this one has nothing to
 * load, so it can.
 */
export async function probe(override?: string): Promise<Probe> {
  const pass = override ?? passphrase();
  let res: Response;
  try {
    res = await fetch("/api/ping", { headers: pass ? { authorization: `Bearer ${pass}` } : {} });
  } catch {
    throw new CloudError("Couldn't reach the app's functions at all.", 0);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as Probe;
  } catch {
    throw new CloudError(`Even the import-free probe failed (${res.status}). ${text.replace(/<[^>]*>/g, " ").slice(0, 200)}`, res.status);
  }
}

/** Keeps a copy that would otherwise be lost to a conflict. */
export function stashConflict(db: DB): void {
  try {
    localStorage.setItem(CONFLICT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), doc: db }));
  } catch { /* nothing more we can do */ }
}
export function takeConflict(): { savedAt: string; doc: DB } | null {
  return read<{ savedAt: string; doc: DB } | null>(CONFLICT_KEY, null);
}
export function clearConflict(): void {
  try { localStorage.removeItem(CONFLICT_KEY); } catch { /* ignore */ }
}
