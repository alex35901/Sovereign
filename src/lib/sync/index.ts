import type { SyncAdapter } from "./types";

/**
 * Providers are registered here. Adding one means writing an adapter against
 * SyncAdapter — nothing else in the app needs to change.
 *
 * Empty on purpose. SimpleFIN was the only entry and is retired: an access URL
 * left in a document kept refilling the app with accounts that bridge used to
 * feed, over the top of what was there, so the pull was taken out rather than
 * gated on a credential that a restored backup would bring straight back.
 * Plaid does not go through this list; it has its own paths in run.ts.
 */
export const ADAPTERS: SyncAdapter[] = [];
export const getAdapter = (id: string): SyncAdapter | undefined => ADAPTERS.find((a) => a.id === id);
export { mergeSync, syncWindowStart, cleanMerchant } from "./merge";
export { syncPlaid, syncPlaidDue, syncPlaidItem } from "./run";
export { syncTeller, syncTellerDue, syncTellerEnrollment } from "./run";
export { CADENCES, DEFAULT_CADENCE, cadenceLabel, nextSyncAt, syncDue, untilLabel } from "./schedule";
export type { SyncCadence } from "./schedule";
export type { SyncPayload, SyncAdapter } from "./types";
