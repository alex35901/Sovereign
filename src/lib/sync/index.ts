/**
 * What the app imports when it means "the sync".
 *
 * There used to be a registry here: an ADAPTERS array and a SyncAdapter
 * interface for providers to be written against. Nothing was ever registered
 * in it. SimpleFIN was its only entry and was retired; Plaid never went
 * through it, and Teller does not either, because the two providers agree
 * about the shape of a payload and almost nothing else, and the interface
 * could only have described the part they agree on. An empty list with a
 * lookup nobody called was a promise the code was not keeping.
 */
export { mergeSync, syncWindowStart, cleanMerchant } from "./merge";
export { syncPlaid, syncPlaidDue, syncPlaidItem } from "./run";
export { syncTeller, syncTellerDue, syncTellerEnrollment } from "./run";
export { CADENCES, DEFAULT_CADENCE, cadenceLabel, nextSyncAt, syncDue, untilLabel } from "./schedule";
export type { SyncCadence } from "./schedule";
export type { SyncPayload } from "./types";
