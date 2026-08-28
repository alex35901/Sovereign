import type { SyncAdapter, SyncPayload } from "./types";
import { guessAccountType } from "./types";
import { toISO } from "../date";

/**
 * SimpleFIN Bridge — $15/yr, up to 25 institutions, refreshed about once a day.
 *
 * The bridge speaks neither CORS nor cross-origin credentials, so both calls go
 * through /api/simplefin, which forwards them server-side. See api/simplefin.ts.
 */
const PROXY = "/api/simplefin";

async function call<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(PROXY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `SimpleFIN request failed (${res.status})`);
  return JSON.parse(text) as T;
}

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
    const raw = await call<{ errors?: string[]; accounts?: BridgeAccount[] }>("accounts", {
      accessUrl,
      startDate: Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000),
    });
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
  },
};
