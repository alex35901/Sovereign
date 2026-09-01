import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { DEFAULT_CADENCE, syncDue, syncSimplefin } from "../lib/sync";

/** How often to look at the clock. The cadence decides whether anything happens. */
const CHECK_MS = 5 * 60_000;
/** After a failed pull, wait this long before trying again. */
const BACKOFF_MS = 30 * 60_000;

/**
 * Runs the scheduled SimpleFIN pull.
 *
 * Renders nothing. Mounted once at the root so the schedule is kept wherever
 * you are in the app, not only on the Settings screen.
 */
export function AutoSync() {
  const { db, apply, notify } = useStore();

  // Read through refs: the effect must not tear down and restart on every
  // change to the database, or the interval would never survive a sync.
  const latest = useRef(db);
  latest.current = db;
  const act = useRef({ apply, notify });
  act.current = { apply, notify };

  const running = useRef(false);
  const holdUntil = useRef(0);
  const sessionStart = useRef(Date.now());

  useEffect(() => {
    const tick = async () => {
      const cur = latest.current;
      const now = Date.now();
      if (running.current || now < holdUntil.current) return;
      if (!cur.settings.simplefinAccessUrl) return;
      const cadence = cur.settings.syncCadence ?? DEFAULT_CADENCE;
      if (!syncDue(cadence, cur.settings.lastSyncAt, now, sessionStart.current)) return;

      running.current = true;
      try {
        const { summary, changed } = await syncSimplefin(cur, act.current.apply);
        // Silence when nothing arrived: a toast on every app open, saying
        // nothing happened, is worse than no toast at all.
        if (changed) act.current.notify(summary);
      } catch {
        // The Settings card is where a broken connection gets explained. Here,
        // just stop hammering a provider that isn't answering.
        holdUntil.current = Date.now() + BACKOFF_MS;
      } finally {
        running.current = false;
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), CHECK_MS);
    return () => window.clearInterval(id);
  }, []);

  return null;
}
