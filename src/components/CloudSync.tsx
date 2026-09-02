import { useEffect, useRef } from "react";
import { useStore } from "../store";
import {
  CloudError, cloudEnabled, cloudState, deviceName, pull, push, setCloudState, stashConflict,
} from "../lib/cloud";

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

  // ── first contact: reconcile this browser against the stored document ──
  useEffect(() => {
    if (!cloudEnabled()) return;
    let cancelled = false;

    (async () => {
      busy.current = true;
      try {
        const remote = await pull();
        if (cancelled) return;

        if (!remote) {
          // nothing stored yet — this browser seeds it
          const res = await push(latest.current, 0);
          setCloudState({ version: res.version, dirty: false });
          act.current.notify("Budget saved to the cloud. It'll open on any device now.");
          return;
        }

        const local = cloudState();
        if (remote.version > local.version) {
          if (local.dirty) {
            // Both moved. Keep the newer shared copy, but don't throw this
            // browser's unsent work away — Settings can hand it back.
            stashConflict(latest.current);
            act.current.notify(`Loaded a newer copy saved by ${remote.updatedBy}. This device's unsent changes were set aside — see Settings.`);
          }
          act.current.replaceFromCloud(remote.doc);
          setCloudState({ version: remote.version, dirty: false });
        } else if (local.dirty || local.version === 0) {
          // this browser is ahead, or has never agreed with the server
          const res = await push(latest.current, remote.version);
          setCloudState({ version: res.version, dirty: false });
        } else {
          setCloudState({ version: remote.version, dirty: false });
        }
      } catch (err) {
        if (!cancelled) {
          act.current.notify(err instanceof CloudError ? `Cloud sync: ${err.message}` : "Cloud sync failed.");
        }
      } finally {
        busy.current = false;
        ready.current = true;
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // ── save local edits ──────────────────────────────────────────────────
  useEffect(() => {
    if (!cloudEnabled() || !ready.current) return;
    const state = cloudState();
    if (!state.dirty) setCloudState({ ...state, dirty: true });

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
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
              act.current.replaceFromCloud(remote.doc);
              setCloudState({ version: remote.version, dirty: false });
              act.current.notify(`${remote.updatedBy} changed this budget first. That copy is now loaded; yours was set aside — see Settings.`);
            }
          }
          // Anything else stays dirty and is retried by the next edit or poll.
        } finally {
          busy.current = false;
        }
      })();
    }, PUSH_DEBOUNCE_MS);

    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [db]);

  // ── pick up edits made elsewhere, and whatever the schedule pulled in ──
  useEffect(() => {
    if (!cloudEnabled()) return;
    const id = window.setInterval(() => {
      void (async () => {
        // Re-checked every tick rather than at mount: a refusal part-way
        // through a session has to stop the loop where it stands.
        if (busy.current || !ready.current || !cloudEnabled()) return;
        const at = cloudState();
        if (at.dirty) return; // our own unsent work comes first
        busy.current = true;
        try {
          const remote = await pull();
          if (remote && remote.version > at.version) {
            act.current.replaceFromCloud(remote.doc);
            setCloudState({ version: remote.version, dirty: false });
            if (remote.updatedBy !== deviceName()) notifyUpdate(act.current.notify, remote.updatedBy);
          }
        } catch { /* offline, most likely; the next tick tries again */ } finally {
          busy.current = false;
        }
      })();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  return null;
}

const notifyUpdate = (notify: (m: string) => void, by: string) =>
  notify(by === "scheduled sync" ? "Updated by the overnight sync." : `Updated from ${by}.`);
