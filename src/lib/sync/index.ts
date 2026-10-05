/**
 * What the app imports when it means "the sync".
 *
 * There used to be a registry here: an ADAPTERS array and a SyncAdapter
 * interface for providers to be written against. Nothing was ever registered
 * in it. SimpleFIN was its only entry and was retired, and so was Teller, whose
 * API was withdrawn by the company that ran it. Plaid never went through the
 * registry either. An empty list with a lookup nobody called was a promise the
 * code was not keeping, and two retirements since have not needed it.
 */
export { mergeSync, syncWindowStart, cleanMerchant } from "./merge";
export { syncPlaid, syncPlaidDue, syncPlaidItem } from "./run";
export { CADENCES, DEFAULT_CADENCE, cadenceLabel, nextSyncAt, syncDue, untilLabel } from "./schedule";
export type { SyncCadence } from "./schedule";
export type { SyncPayload } from "./types";
