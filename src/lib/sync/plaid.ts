import type { AssetClass, PlaidItemRef } from "../../types";
import type { RemoteAccount, RemoteTransaction, SyncPayload } from "./types";
import { postJSON } from "../api";
import { cleanMerchant } from "./merge";

/**
 * Plaid. The Trial plan is free for up to 10 institutions and, unlike SimpleFIN,
 * returns holdings for investment and retirement accounts.
 */
const PROXY = "/api/plaid";

export type PlaidItem = PlaidItemRef;

/* ── Plaid's response shapes, narrowed to what is used ─────────────────── */

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: { current?: number | null; available?: number | null; iso_currency_code?: string | null };
}
interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  merchant_name?: string | null;
  pending?: boolean;
}
interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  cost_basis?: number | null;
  institution_price?: number | null;
  institution_value?: number | null;
}
interface PlaidSecurity {
  security_id: string;
  ticker_symbol?: string | null;
  name?: string | null;
  type?: string | null;
  close_price?: number | null;
}

interface SyncResponse {
  accounts: PlaidAccount[];
  transactions: PlaidTransaction[];
  holdings: PlaidHolding[];
  securities: PlaidSecurity[];
}

/* ── mapping ──────────────────────────────────────────────────────────── */

const cents = (v: number | null | undefined): number => Math.round((v ?? 0) * 100);

/** Plaid's type/subtype pair maps cleanly onto this app's account types. */
export function mapAccountType(type: string, subtype?: string | null): RemoteAccount["type"] {
  const s = (subtype ?? "").toLowerCase();
  if (type === "credit") return "credit";
  if (type === "loan") return s === "mortgage" ? "mortgage" : "loan";
  if (type === "depository") return s === "savings" || s === "money market" || s === "cd" ? "savings" : "checking";
  if (type === "investment") {
    if (/401k|403b|457b|pension|roth|ira|sep|simple|thrift|keogh|profit sharing/.test(s)) return "retirement";
    if (s === "crypto exchange") return "crypto";
    return "investment";
  }
  return "other_asset";
}

/** Liabilities come back positive from Plaid and are stored negative here. */
export const isLiability = (type: string): boolean => type === "credit" || type === "loan";

export function mapAssetClass(securityType?: string | null): AssetClass {
  switch ((securityType ?? "").toLowerCase()) {
    case "equity":
    case "etf":
    case "mutual fund":
      return "us_equity";
    case "fixed income":
      return "bond";
    case "cash":
      return "cash";
    case "cryptocurrency":
      return "crypto";
    default:
      return "other";
  }
}

export interface PlaidDiagnosis {
  environment: "sandbox" | "production";
  envVarSet: boolean;
  clientId: { length: number; trimmed: boolean };
  secret: { length: number; trimmed: boolean };
  probe: { ok: boolean; error: string | null };
}

/** Asks the function what it sees, without any credential leaving the server. */
export const diagnosePlaid = (): Promise<PlaidDiagnosis> => postJSON<PlaidDiagnosis>(PROXY, { action: "diagnose" });

export async function createLinkToken(kind: "bank" | "investment"): Promise<string> {
  const products = kind === "investment" ? ["investments"] : ["transactions"];
  const { linkToken } = await postJSON<{ linkToken: string }>(PROXY, { action: "link_token", products });
  return linkToken;
}

export async function exchangePublicToken(publicToken: string, kind: "bank" | "investment"): Promise<PlaidItem> {
  const res = await postJSON<{ accessToken: string; itemId: string; institution: string }>(PROXY, {
    action: "exchange",
    publicToken,
  });
  return { ...res, kind, addedAt: new Date().toISOString() };
}

export interface RemoteHolding {
  /** the Plaid account this position sits in */
  accountSyncId: string;
  ticker: string;
  name: string;
  quantity: number;
  /** per share, cents */
  costBasis: number;
  /** per share, cents */
  price: number;
  assetClass: AssetClass;
}

export interface PlaidPayload extends SyncPayload {
  holdings: RemoteHolding[];
}

export async function fetchItem(item: PlaidItem, since: string): Promise<PlaidPayload> {
  const raw = await postJSON<SyncResponse>(PROXY, {
    action: "sync",
    accessToken: item.accessToken,
    startDate: since,
    endDate: new Date().toISOString().slice(0, 10),
    withHoldings: item.kind === "investment",
  });

  const today = new Date().toISOString().slice(0, 10);
  const accounts: RemoteAccount[] = (raw.accounts ?? []).map((a) => {
    const magnitude = cents(a.balances.current);
    return {
      syncId: a.account_id,
      name: a.official_name || a.name,
      institution: item.institution,
      balance: isLiability(a.type) ? -Math.abs(magnitude) : magnitude,
      currency: a.balances.iso_currency_code ?? "USD",
      type: mapAccountType(a.type, a.subtype),
      balanceDate: today,
    };
  });

  const transactions: RemoteTransaction[] = (raw.transactions ?? []).map((t) => ({
    syncId: t.transaction_id,
    accountSyncId: t.account_id,
    date: t.date,
    // Plaid reports money leaving an account as positive; this app uses the
    // opposite sign convention throughout
    amount: -cents(t.amount),
    description: t.name,
    payee: t.merchant_name ? cleanMerchant(t.merchant_name) : undefined,
    pending: Boolean(t.pending),
  }));

  const securities = new Map((raw.securities ?? []).map((s) => [s.security_id, s]));
  const holdings: RemoteHolding[] = (raw.holdings ?? []).map((h) => {
    const security = securities.get(h.security_id);
    const price = cents(h.institution_price ?? security?.close_price);
    const totalCost = cents(h.cost_basis);
    return {
      accountSyncId: h.account_id,
      ticker: security?.ticker_symbol || security?.name?.slice(0, 12) || "—",
      name: security?.name || security?.ticker_symbol || "Unknown holding",
      quantity: h.quantity,
      // Plaid's cost_basis is the total for the position; this app stores it per share
      costBasis: h.quantity ? Math.round(totalCost / h.quantity) : 0,
      price,
      assetClass: mapAssetClass(security?.type),
    };
  });

  return {
    accounts,
    transactions,
    errors: [],
    fetchedAt: new Date().toISOString(),
    holdings,
  };
}
