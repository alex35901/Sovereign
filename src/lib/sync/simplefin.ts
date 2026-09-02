import type { SyncAdapter, SyncPayload } from "./types.js";
import { guessAccountType } from "./types.js";
import { toISO } from "../date.js";
import { postJSON } from "../api.js";

/**
 * SimpleFIN Bridge — $15/yr, up to 25 institutions, refreshed about once a day.
 *
 * The bridge speaks neither CORS nor cross-origin credentials, so both calls go
 * through /api/simplefin, which forwards them server-side. See api/simplefin.ts.
 */
const PROXY = "/api/simplefin";

const call = <T,>(action: string, body: Record<string, unknown>): Promise<T> =>
  postJSON<T>(PROXY, { action, ...body });

interface BridgeAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  "balance-date": number;
  org?: { name?: string; domain?: string };
  transactions?: BridgeTxn[];
}
interface BridgeTxn {
  id: string;
  posted: number;
  amount: string;
  description: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
}

const toCents = (v: string): number => Math.round(Number.parseFloat(v) * 100);
const fromUnix = (s: number): string => toISO(new Date(s * 1000));

export const simplefin: SyncAdapter = {
  id: "simplefin",
  label: "SimpleFIN Bridge",
  cost: "$1.50/mo or $15/yr · up to 25 institutions · refreshes daily",
  isConnected: (s) => Boolean(s.simplefinAccessUrl),

  async connect(setupToken: string) {
    const clean = setupToken.trim();
    if (!clean) throw new Error("Paste the setup token from bridge.simplefin.org first.");
    return call<{ accessUrl: string }>("claim", { setupToken: clean });
  },

  async fetch(accessUrl: string, since: string): Promise<SyncPayload> {
    const raw = await call<BridgeResponse>("accounts", {
      accessUrl,
      startDate: startOfDayUnix(since),
    });
    return toPayload(raw);
  },
};

export interface BridgeResponse { errors?: string[]; accounts?: BridgeAccount[] }

/** The bridge's own start-date parameter: midnight UTC on that day, in seconds. */
export const startOfDayUnix = (since: string): number =>
  Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000);

/**
 * Bridge JSON to this app's shape. Pulled out of fetch() so the scheduled job
 * on the server can reuse it — it reaches the bridge directly rather than
 * through the browser proxy, but the data it gets back is identical.
 */
export function toPayload(raw: BridgeResponse): SyncPayload {
  const accounts = (raw.accounts ?? []).map((a) => {
    const balance = toCents(a.balance);
    return {
      syncId: a.id,
      name: a.name,
      institution: a.org?.name ?? a.org?.domain ?? "Unknown",
      balance,
      currency: a.currency ?? "USD",
      type: guessAccountType(`${a.org?.name ?? ""} ${a.name}`, balance),
      balanceDate: fromUnix(a["balance-date"]),
      // SimpleFIN sends no logo, only where the institution lives.
      domain: a.org?.domain,
    };
  });
  const transactions = (raw.accounts ?? []).flatMap((a) =>
    (a.transactions ?? []).map((t) => ({
      syncId: t.id,
      accountSyncId: a.id,
      date: fromUnix(t.posted),
      amount: toCents(t.amount),
      description: t.description ?? t.payee ?? "Unknown",
      payee: t.payee,
      memo: t.memo,
      pending: Boolean(t.pending),
    })),
  );
  return { accounts, transactions, errors: raw.errors ?? [], fetchedAt: new Date().toISOString() };
}
