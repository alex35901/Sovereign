import { useEffect, useRef } from "react";
import { useStore } from "../store";
import {
  CloudError, cloudEnabled, cloudState, deviceName, head, isBlocking, mayPush, pull, push,
  retryDelay, setCloudState, shouldSay,
  stashConflict, subscribeSync,
} from "../lib/cloud";
import { drainQueue } from "../lib/sync/drain";
import { POLL_MIN_MS, pollDelay, saveDelay } from "../lib/sync/schedule";
import type { DB } from "../types";

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
  /** The next poll, and how many rounds in a row have found nothing. */
  const poll = useRef<number | null>(null);
  const quiet = useRef(0);
  /** When the oldest unsent edit was made, so a busy hour still gets saved. */
  const firstEdit = useRef(0);

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
   * Take the stored document, setting aside anything unsent first.
   *
   * The rule when the two disagree is that the server wins, and this is the
   * only place that rule is carried out, so that no path can quietly implement
   * it differently. A local edit that would be lost to it is stashed, never
   * dropped.
   */
  const takeRemote = async (say: (by: string) => string | null): Promise<boolean> => {
    const remote = await pull().catch(() => null);
    if (!remote) return false;
    if (cloudState().dirty) stashConflict(latest.current);
    install(remote.doc);
    setCloudState({ version: remote.version, dirty: false });
    const said = say(remote.updatedBy);
    if (said) act.current.notify(said);
    return true;
  };

  /**
   * Send what this browser is holding.
   *
   * Shared by the debounce after an edit and by the poll, because a push that
   * fails leaves the work marked unsent and something has to try it again. The
   * poll used to say in a comment that it did this, and simply return.
   */
  /**
   * Answers whether the save actually landed.
   *
   * The poll asks, because an attempt is not the same as a result: a browser
   * whose saves are failing was counting every attempt as movement and so kept
   * polling at the lively rate for as long as it stayed broken, which is the
   * one state where asking more often helps nobody.
   */
  const pushNow = async (force = false): Promise<boolean> => {
    if (busy.current || !cloudEnabled()) return false;
    const at = cloudState();
    // A save that has failed is not tried again on the next tick. The whole
    // document goes up each time, and a tab left open on a broken connection
    // used to send half a megabyte every sixty seconds until it was closed.
    if (!force && !mayPush(at)) return false;
    busy.current = true;
    let landed = false;
    try {
      const res = await push(latest.current, at.version);
      // The failure is kept through the success that follows it. An
      // intermittent fault is the one worth being able to see, and clearing
      // the record every time a save works is what hides it.
      setCloudState({
        version: res.version, dirty: false,
        lastError: at.lastError, saidAt: at.saidAt, okAt: Date.now(),
      });
      landed = true;
    } catch (err) {
      if (err instanceof CloudError && err.status === 409) {
        // The save did not land, but the document moved, which is the question
        // the poll is asking.
        if (await takeRemote((by) =>
          `${by} changed this budget first. That copy is now loaded; yours was set aside, see Settings.`)) return true;
      }
      // Everything else stays unsent and waits, longer each time. Said once
      // when it starts failing rather than on every attempt: a toast a minute
      // is not more informative than a toast.
      const failures = (at.failures ?? 0) + 1;
      const blocked = err instanceof CloudError && isBlocking(err.status) ? err.message : undefined;
      const status = err instanceof CloudError ? err.status : 0;
      const reason = err instanceof CloudError ? err.message : "Could not reach the server.";
      const before = cloudState();
      const say = shouldSay(before, reason);
      setCloudState({
        ...before, dirty: true, failures,
        nextTryAt: Date.now() + retryDelay(failures),
        blocked,
        lastError: { status, message: reason, at: Date.now() },
        saidAt: say ? Date.now() : before.saidAt,
      });
      // Named rather than hinted at. The app knows the status and what the
      // server said; a message that withholds both leaves nothing to act on
      // and nothing to tell anybody. Settings carries it too, for after the
      // toast has gone.
      if (say) {
        act.current.notify(blocked
          ? `Not saving to the cloud: ${blocked}`
          : `Could not save to the cloud: ${reason}. It will keep trying.`);
      }
    } finally {
      busy.current = false;
    }
    return landed;
  };

  const drainNow = async (): Promise<boolean> => {
    const at = cloudState();
    const out = await drainQueue(latest.current, at.version).catch(() => null);
    // Nothing opened: an empty queue, or a browser holding no key yet. Either
    // way the poll must not treat it as movement, or a locked tab with rows
    // waiting would reset its own backoff for ever.
    if (!out) return false;
    // The drain pushed what it merged, so this is the stored document too.
    install(out.db);
    setCloudState({ version: out.version, dirty: false });
    if (out.said) act.current.notify(out.said);
    return true;
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
      /**
       * Anything but exact agreement means the stored document is the one to
       * take.
       *
       * Higher is the ordinary case: another device saved. Different without
       * being higher is the one that used to do damage. The rule was "newer
       * than mine, or else adopt the number and keep what I have", so a stored
       * document that had gone backwards — restored from a backup, rolled back
       * after an accident — left this browser holding a stale copy stamped
       * with the server's own version number, and the next edit pushed it
       * straight back over the recovery.
       */
      if (meta.version !== local.version) {
        // Both moved. Keep the shared copy, but don't throw this browser's
        // unsent work away: Settings can hand it back.
        const stale = local.dirty;
        const took = await takeRemote((by) => (stale
          ? `Loaded the copy saved by ${by}. This device's unsent changes were set aside, see Settings.`
          : null));
        if (isCancelled() || !took) return;
      } else if (local.dirty) {
        // This browser has work the server has not got. Through the same door
        // as the debounce, so a failing save backs off here too rather than
        // being retried by every tick of the poll.
        if (!mayPush(local)) return;
        /**
         * This browser's own base version, never the server's.
         *
         * Handing the server back the number it just reported is asking it not
         * to check, and the check is the only thing standing between a device
         * holding an old copy and everybody else's work. It was written this
         * way because in this branch the two are equal anyway — which is true
         * until the moment it is not, and that moment is a race with whatever
         * else is saving.
         */
        const res = await push(latest.current, local.version).catch(async (err: unknown) => {
          if (err instanceof CloudError && err.status === 409) {
            await takeRemote((by) =>
              `${by} changed this budget first. That copy is now loaded; yours was set aside, see Settings.`);
            return null;
          }
          throw err;
        });
        if (res) setCloudState({ version: res.version, dirty: false });
      } else {
        // Already in step. Nothing crosses the wire, which is the common case
        // every single time the app is opened.
        setCloudState({ version: meta.version, dirty: false });
      }

      // Whatever the scheduled job pulled overnight is waiting encrypted in
      // the queue; this is the first moment there is a key to open it with.
      // The version check already said whether there is anything in it.
      if (!isCancelled() && meta.queued > 0) await drainNow();
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

    // Waiting for quiet, but measured from the first unsent edit rather than
    // the last, so a long stretch of steady typing still gets saved.
    if (!firstEdit.current) firstEdit.current = Date.now();
    const delay = saveDelay(firstEdit.current);

    // An edit is also a reason to start asking often again: work is happening,
    // so another device may be about to see it and answer back.
    quiet.current = 0;

    // An edit clears the backoff. Somebody is at the keyboard, which is the
    // one moment worth spending a retry on: whatever was wrong may have been
    // put right, and if it has not been, the wait starts again from a minute.
    if (state.failures || state.nextTryAt || state.blocked) {
      setCloudState({ ...cloudState(), failures: 0, nextTryAt: undefined, blocked: undefined });
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { firstEdit.current = 0; void pushNow(); }, delay);

    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [db]);

  // ── pick up edits made elsewhere, and whatever the schedule pulled in ──

  /**
   * One round: send anything unsent, then take anything new.
   *
   * Says whether it did anything, because the loop below asks less often while
   * the answer keeps being no. A round that could not run at all counts as
   * quiet: a browser that is not connected has nothing to be woken for.
   */
  const syncNow = async (): Promise<boolean> => {
    // Re-checked every time rather than at mount: a refusal part-way through a
    // session has to stop this where it stands.
    if (busy.current || !ready.current || !cloudEnabled()) return false;
    const at = cloudState();
    // Our own unsent work comes first, and gets sent rather than waiting for
    // another edit that may never come. While a failed save is backing off,
    // this falls through to the version check below instead: that costs a few
    // hundred bytes, and a browser that cannot save should still be able to
    // notice that another device has.
    if (at.dirty && mayPush(at)) return pushNow();
    busy.current = true;
    let moved = false;
    try {
      // The version first, on its own. This used to fetch the whole document
      // every minute and throw it away when nothing had changed — half a
      // megabyte a minute, per open tab, which is how a month's database
      // allowance went in two days.
      const meta = await head();
      // Different, rather than newer. A stored document that has gone
      // backwards is one that was restored from a backup or rolled back after
      // an accident, and a poll that only looks forwards sails straight past
      // it: this browser keeps the copy that was rolled back and saves it
      // again at the next edit.
      if (meta.found && meta.version !== at.version) {
        const remote = await pull();
        if (remote && remote.version !== at.version) {
          install(remote.doc);
          setCloudState({ version: remote.version, dirty: false });
          if (remote.updatedBy !== deviceName()) notifyUpdate(act.current.notify, remote.updatedBy);
          moved = true;
        }
      }
      // Only when the version check said there is something to drain. It used
      // to be asked on every round, which doubled the requests a poll makes to
      // be told there was nothing there.
      if (meta.queued > 0 && await drainNow()) moved = true;
    } catch { /* offline, most likely; the next round tries again */ } finally {
      busy.current = false;
    }
    return moved;
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
    // Leaving the tab is the one moment worth not waiting for quiet: the work
    // survives locally either way, but another device picking the budget up
    // next would otherwise be working from a copy that is eight seconds stale.
    /**
     * A timeout that books the next one, rather than a fixed interval.
     *
     * The gap has to be able to grow and an interval cannot change its mind.
     * A hidden tab asks nothing at all and does not count the round as quiet:
     * it has not learned that nothing changed, it simply has not looked.
     */
    let stopped = false;
    let nextAt = 0;

    const book = (delay: number) => {
      if (poll.current) window.clearTimeout(poll.current);
      nextAt = Date.now() + delay;
      poll.current = window.setTimeout(() => void run(), delay);
    };

    const run = async () => {
      if (poll.current) window.clearTimeout(poll.current);
      const hidden = typeof document !== "undefined" && document.hidden;
      if (!hidden) {
        const moved = await syncNow();
        quiet.current = moved ? 0 : quiet.current + 1;
      }
      // A round can be in flight when this unmounts, and booking the next one
      // from inside it would outlive the component that owns it.
      if (stopped) return;
      book(pollDelay(quiet.current));
    };

    /**
     * Somebody is using this tab, so it should not be half an hour behind.
     *
     * The backoff is for a tab nobody is at. Being visible is not the same as
     * being read: a window left in the foreground all afternoon fires no
     * visibility event, and without this it would sit at the half-hour gap
     * while its owner looked straight at it.
     *
     * Clicks and keys rather than movement. A pointer crossing the window on
     * its way somewhere else is not a reason to ask the server anything, and
     * the next poll is still a minute out rather than now, so a burst of
     * typing costs one request at most.
     */
    const stir = () => {
      quiet.current = 0;
      if (nextAt - Date.now() > POLL_MIN_MS) book(POLL_MIN_MS);
    };

    const onVisible = () => {
      if (document.hidden) {
        if (cloudState().dirty) {
          if (timer.current) clearTimeout(timer.current);
          firstEdit.current = 0;
          void pushNow();
        }
        return;
      }
      // Looking at it again is a reason to think the answer may have changed.
      quiet.current = 0;
      void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Captured, so a handler that stops the event getting any further cannot
    // also stop this from noticing that somebody is here.
    document.addEventListener("pointerdown", stir, true);
    document.addEventListener("keydown", stir, true);
    window.addEventListener("focus", stir);
    book(POLL_MIN_MS);

    return () => {
      stopped = true;
      if (poll.current) window.clearTimeout(poll.current);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", stir, true);
      document.removeEventListener("keydown", stir, true);
      window.removeEventListener("focus", stir);
    };
  }, []);

  return null;
}

const notifyUpdate = (notify: (m: string) => void, by: string) =>
  notify(by === "scheduled sync" ? "Updated by the overnight sync." : `Updated from ${by}.`);
