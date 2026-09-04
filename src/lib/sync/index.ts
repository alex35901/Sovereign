import { simplefin } from "./simplefin";
import type { SyncAdapter } from "./types";

/**
 * Providers are registered here. Adding Plaid or Teller later means writing one
 * adapter against SyncAdapter — nothing else in the app needs to change.
 *
 *   SimpleFIN  $15/yr   25 institutions, daily refresh, one pasted token
 *   Plaid      $0       Trial plan: 10 institutions, includes Investments
 *   Teller     $0       100 connections, US only, thin on retirement accounts
 */
export const ADAPTERS: SyncAdapter[] = [simplefin];
export const getAdapter = (id: string): SyncAdapter | undefined => ADAPTERS.find((a) => a.id === id);
export { mergeSync, syncWindowStart, cleanMerchant } from "./merge";
export { syncSimplefin, syncPlaid, syncPlaidItem } from "./run";
export { CADENCES, DEFAULT_CADENCE, cadenceLabel, nextSyncAt, syncDue, untilLabel } from "./schedule";
export type { SyncCadence } from "./schedule";
export type { SyncPayload, SyncAdapter } from "./types";
