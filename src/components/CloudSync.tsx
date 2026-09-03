import { useEffect, useRef } from "react";
import { useStore } from "../store";
import {
  CloudError, cloudEnabled, cloudState, deviceName, head, pull, push, setCloudState,
  stashConflict, subscribeSync,
} from "../lib/cloud";
import { drainQueue } from "../lib/sync/drain";
import type { DB } from "../types";

/** Local edits settle before a save; a burst of typing makes one request. */
const PUSH_DEBOUNCE_MS = 1500;
/** How often to look for changes made on another device. */
const POLL_MS = 60_000;

/**
 * Keeps this browser and the stored document in step.
 *
 * Renders nothing. The rule when the two disagree is that the server wins,
 * because it is the copy the scheduled sync updates and the copy every other
 * device sees. A local edit that would be lost to that rule is set aside first
 * rather than dropped.
 */
export function CloudSync() {
  const { db, apply, notify, replaceFromCloud } = useStore();

  const latest = useRef(db);
  latest.current = db;
  const act = useRef({ apply, notify, replaceFromCloud });
  act.current = { apply, notify, replaceFromCloud };

  const busy = useRef(false);
  const ready = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The exact document this browser last took from the server.
   *
   * Without it, two tabs left open talk to each other forever. A pull hands the
   * store a freshly parsed object, the save effect watches `db` by identity and
   * cannot tell it apart from a typed edit, so it pushes the same bytes back;
   * the other tab sees a new version and does the same. Nobody has touched
   * anything and half a megabyte crosses the wire each way, every minute.
   *
   * Set from what the store says it installed, which is the same object when
   * the document needed nothing doing to it.
   */
  const fromCloud = useRef<DB | null>(null);

  /**
   * The document as it stood when this mounted.
   *
   * The save effect runs once on mount with it, and that is not an edit. It
   * used to be filtered out by "first contact has not finished yet", which
   * also swallowed anything typed in the second or two while that ran: the
   * edit was never marked unsent, so nothing ever pushed it, and a change
   * arriving from another device overwrote it without even offering it back.
   */
  const atMount = useRef<DB | null>(db);

  const install = (doc: DB) => {
    const installed = act.current.replaceFromCloud(doc);
    // Only the same document the server holds when nothing had to be brought
    // up to date. One that needed migrating is genuinely different now, and
    // that difference is worth saving back — which happens once, because the
    // next device to pull it finds nothing left to migrate.
    fromCloud.current = installed === doc ? installed : null;
  };

  /**
   * Send what this browser is holding.
   *
   * Shared by the debounce after an edit and by the poll, because a push that
   * fails leaves the work marked unsent and something has to try it again. The
   * poll used to say in a comment that it did this, and simply return.
   */
  const pushNow = async () => {
    if (busy.current || !cloudEnabled()) return;
    busy.current = true;
    try {
      const at = cloudState();
      const res = await push(latest.current, at.version);
      setCloudState({ version: res.version, dirty: false });
    } catch (err) {
      if (err instanceof CloudError && err.status === 409) {
        const remote = await pull().catch(() => null);
        if (remote) {
          stashConflict(latest.current);
          install(remote.doc);
          setCloudState({ version: remote.version, dirty: false });
          act.current.notify(`${remote.updatedBy} changed this budget first. That copy is now loaded; yours was set aside — see Settings.`);
        }
      }
      // Anything else stays marked unsent, and the next poll tries again.
    } finally {
      busy.current = false;
    }
  };

  const drainNow = async () => {
    const at = cloudState();
    const out = await drainQueue(latest.current, at.version).catch(() => null);
    if (!out) return;
    // The drain pushed what it merged, so this is the stored document too.
    install(out.db);
    setCloudState({ version: out.version, dirty: false });
    if (out.said) act.current.notify(out.said);
  };

  // ── first contact: reconcile this browser against the stored document ──

  /**
   * Settle this browser against the stored document, once.
   *
   * Asks for the version before the document. Opening the app used to fetch
   * the whole thing on every load just to find out it already had it, which on
   * a phone that gets opened twenty times a day is twenty copies of the budget
   * for no reason.
   */
  const reconcile = async (isCancelled: () => boolean) => {
    busy.current = true;
    try {
      const meta = await head();
      if (isCancelled()) return;

      if (!meta.found) {
        // nothing stored yet — this browser seeds it
        const res = await push(latest.current, 0);
        setCloudState({ version: res.version, dirty: false });
        act.current.notify("Budget saved to the cloud. It'll open on any device now.");
        return;
      }

      const local = cloudState();
      if (meta.version > local.version) {
        const remote = await pull();
        if (isCancelled() || !remote) return;
        if (local.dirty) {
          // Both moved. Keep the newer shared copy, but don't throw this
          // browser's unsent work away — Settings can hand it back.
          stashConflict(latest.current);
          act.current.notify(`Loaded a newer copy saved by ${remote.updatedBy}. This device's unsent changes were set aside — see Settings.`);
        }
        install(remote.doc);
        setCloudState({ version: remote.version, dirty: false });
      } else if (local.dirty || local.version === 0) {
        // this browser is ahead, or has never agreed with the server
        const res = await push(latest.current, meta.version);
        setCloudState({ version: res.version, dirty: false });
      } else {
        // Already in step. Nothing crosses the wire, which is the common case
        // every single time the app is opened.
        setCloudState({ version: meta.version, dirty: false });
      }

      // Whatever the scheduled job pulled overnight is waiting encrypted in
      // the queue; this is the first moment there is a key to open it with.
      if (!isCancelled()) await drainNow();
    } catch (err) {
      if (!isCancelled()) {
        act.current.notify(err instanceof CloudError ? `Cloud sync: ${err.message}` : "Cloud sync failed.");
      }
    } finally {
      busy.current = false;
      ready.current = true;
    }
  };

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    if (cloudEnabled()) void reconcile(isCancelled);

    // A browser that connects from the Settings card was not connected when
    // this mounted, so the loop below stood down and never started: it noticed
    // nothing anyone else did for the rest of the session, and the reload that
    // fixed it was not something anyone knew to do.
    //
    // The card does the reconciling itself when it connects, so there is
    // nothing to repeat here — only the standing down to undo.
    const off = subscribeSync(() => {
      if (!cancelled && cloudEnabled()) ready.current = true;
    });

    return () => { cancelled = true; off(); };
  }, []);

  // ── save local edits ──────────────────────────────────────────────────
  useEffect(() => {
    if (!cloudEnabled()) return;
    // Two documents that are not edits: the one this mounted with, and one
    // that arrived from the server a moment ago. Pushing the second back would
    // only tell the server what it already knows, and tell every other tab
    // there is something new to fetch.
    // Consumed on the way past: the undo stack can hand that very object back
    // later, and by then it really is a change the server has not got.
    if (db === atMount.current) { atMount.current = null; return; }
    if (db === fromCloud.current) return;

    // Marked unsent first and unconditionally, so an edit typed while first
    // contact is still running is not quietly dropped.
    const state = cloudState();
    if (!state.dirty) setCloudState({ ...state, dirty: true });

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void pushNow(); }, PUSH_DEBOUNCE_MS);

    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [db]);

  // ── pick up edits made elsewhere, and whatever the schedule pulled in ──

  /** One round: send anything unsent, then take anything new. */
  const syncNow = async () => {
    // Re-checked every time rather than at mount: a refusal part-way through a
    // session has to stop this where it stands.
    if (busy.current || !ready.current || !cloudEnabled()) return;
    const at = cloudState();
    // Our own unsent work comes first — and gets sent, rather than waiting for
    // another edit that may never come.
    if (at.dirty) { await pushNow(); return; }
    busy.current = true;
    try {
      // The version first, on its own. This used to fetch the whole document
      // every minute and throw it away when nothing had changed — half a
      // megabyte a minute, per open tab, which is how a month's database
      // allowance went in two days.
      const meta = await head();
      if (meta.found && meta.version > at.version) {
        const remote = await pull();
        if (remote && remote.version > at.version) {
          install(remote.doc);
          setCloudState({ version: remote.version, dirty: false });
          if (remote.updatedBy !== deviceName()) notifyUpdate(act.current.notify, remote.updatedBy);
        }
      }
      await drainNow();
    } catch { /* offline, most likely; the next round tries again */ } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    // Set up whether or not this browser is connected yet: connecting happens
    // in Settings, long after this mounts, and a loop that was never started
    // does not start itself. syncNow checks the connection on every round.
    //
    // A tab nobody is looking at does not need to know within a minute — but
    // it does need to know before the next thing typed into it, or that edit
    // is refused as a conflict and set aside in favour of the copy this tab
    // was too idle to have fetched.
    const onVisible = () => { if (!document.hidden) void syncNow(); };
    document.addEventListener("visibilitychange", onVisible);

    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void syncNow();
    }, POLL_MS);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}

const notifyUpdate = (notify: (m: string) => void, by: string) =>
  notify(by === "scheduled sync" ? "Updated by the overnight sync." : `Updated from ${by}.`);
