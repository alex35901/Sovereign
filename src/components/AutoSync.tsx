import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { DEFAULT_CADENCE, syncDue, syncSimplefin } from "../lib/sync";
import { pricesDue, refreshPrices } from "../lib/prices";

/** How often to look at the clock. The cadence decides whether anything happens. */
const CHECK_MS = 5 * 60_000;
/** After a failed pull, wait this long before trying again. */
const BACKOFF_MS = 30 * 60_000;

/**
 * Runs the scheduled SimpleFIN pull, and the price refresh that rides with it.
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

      const cadence = cur.settings.syncCadence ?? DEFAULT_CADENCE;
      const bankDue = Boolean(cur.settings.simplefinAccessUrl)
        && syncDue(cadence, cur.settings.lastSyncAt, now, sessionStart.current);
      // Prices keep their own clock. Someone whose investment accounts come
      // from Plaid has no SimpleFIN connection at all, and their holdings
      // should still be priced.
      const priceDue = cur.settings.priceAutoRefresh !== false
        && Boolean(cur.settings.tiingoApiKey?.trim())
        && pricesDue(cur.settings.lastPricesAt, now);
      if (!bankDue && !priceDue) return;

      running.current = true;
      try {
        if (bankDue) {
          const { summary, changed } = await syncSimplefin(cur, act.current.apply);
          // Silence when nothing arrived: a toast on every app open, saying
          // nothing happened, is worse than no toast at all.
          if (changed) act.current.notify(summary);
        }
      } catch {
        // The Settings card is where a broken connection gets explained. Here,
        // just stop hammering a provider that isn't answering.
        holdUntil.current = Date.now() + BACKOFF_MS;
      }

      try {
        // Its own try: a revoked price token must not put the bank sync into
        // backoff, and a bridge that is down must not cost the day's prices.
        // `cur` supplies the ticker list only — the write itself goes through
        // apply(), so it composes with whatever the pull just added.
        if (priceDue) await refreshPrices(cur, act.current.apply);
      } catch {
        // Prices are the quietest thing in the app; a failed one stays quiet.
        // Settings and the Investments card both explain it on demand.
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
