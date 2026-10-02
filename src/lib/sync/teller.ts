import type { TellerEnrollmentRef } from "../../types.js";
import type { SyncPayload } from "./types.js";
import { postJSON } from "../api.js";

/**
 * Teller, through this app's own proxy.
 *
 * Why there is a second provider: Plaid will not open the big banks until the
 * Plaid account asking has been separately approved for each of them, and a
 * household that cannot get that approval has no way through at any price.
 * Teller has no such gate, and its developer tier is free up to a hundred
 * live connections. It is not a replacement for Plaid. It is the way round a
 * bank Plaid will not open, and it holds no investments, so a brokerage still
 * belongs on Plaid.
 */
const PROXY = "/api/teller";

/** What the dialog needs to open, which is not a secret and not a credential. */
export interface TellerSetup {
  applicationId: string;
  environment: "sandbox" | "development" | "production";
  /** Whether the certificate is in place as well as the application id. */
  configured: boolean;
}

export const tellerSetup = (): Promise<TellerSetup> =>
  postJSON<TellerSetup>(PROXY, { action: "setup" });

export interface TellerDiagnosis {
  environment: "sandbox" | "development" | "production";
  envVarSet: boolean;
  appId: { length: number; looksRight: boolean };
  /** The PEM header found, which is how a swapped pair is caught. */
  cert: { length: number; kind: string | null; repaired: boolean };
  key: { length: number; kind: string | null; repaired: boolean };
  probe: { ok: boolean; error: string | null };
}

export const diagnoseTeller = (): Promise<TellerDiagnosis> =>
  postJSON<TellerDiagnosis>(PROXY, { action: "diagnose" });

/** What a login holds, asked without pulling a single transaction. */
export const tellerAccounts = (accessToken: string): Promise<SyncPayload> =>
  postJSON<SyncPayload>(PROXY, { action: "accounts", accessToken });

/** Accounts, balances and transactions from one enrollment since a day. */
export const fetchEnrollment = (item: TellerEnrollmentRef, startDate: string): Promise<SyncPayload> =>
  postJSON<SyncPayload>(PROXY, { action: "sync", accessToken: item.accessToken, startDate });
