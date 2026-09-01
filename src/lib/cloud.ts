import type { DB } from "../types";

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
};
export const cloudEnabled = (): boolean => passphrase().length > 0;

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

export class CloudError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "CloudError";
  }
}

async function call(init: RequestInit): Promise<Response> {
  const pass = passphrase();
  if (!pass) throw new CloudError("No passphrase set on this device.", 0);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${pass}` },
    });
  } catch {
    throw new CloudError("Couldn't reach the sync service. Check your connection.", 0);
  }
  if (res.status === 404) {
    throw new CloudError("The /api/db function isn't running. This needs the deployed app, not `npm run dev`.", 404);
  }
  return res;
}

const messageOf = async (res: Response, fallback: string): Promise<string> => {
  try {
    const body = (await res.clone().json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
};

export interface RemoteDoc {
  found: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string;
  doc: DB;
}

/** The stored document, or null when the database is still empty. */
export async function pull(): Promise<RemoteDoc | null> {
  const res = await call({ method: "GET" });
  if (!res.ok) throw new CloudError(await messageOf(res, `Load failed (${res.status})`), res.status);
  const body = (await res.json()) as RemoteDoc;
  return body.found ? body : null;
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
  const res = await call({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc, baseVersion, device: deviceName() }),
  });
  if (res.status === 409) throw new CloudError(await messageOf(res, "Changed elsewhere."), 409);
  if (!res.ok) throw new CloudError(await messageOf(res, `Save failed (${res.status})`), res.status);
  return (await res.json()) as PushResult;
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
