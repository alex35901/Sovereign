import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { DEFAULT_CADENCE, syncDue, syncPlaidDue, syncSimplefin } from "../lib/sync";
import { pricesDue, refreshPrices } from "../lib/prices";

/** How often to look at the clock. The cadence decides whether anything happens. */
const CHECK_MS = 5 * 60_000;
/** After a failed pull, wait this long before trying again. */
const BACKOFF_MS = 30 * 60_000;
/**
 * How long to let a credential settle before acting on it.
 *
 * A pasted key arrives whole, in one change. A typed one arrives a character
 * at a time, and a pull fired on the first character would spend the attempt
 * on a key that is not one yet, and earn half an hour of backoff for it. A
 * short wait tells the two apart without anyone noticing it.
 */
const SETTLE_MS = 2_000;

/**
 * Runs the scheduled bank pulls, and the price refresh that rides with them.
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
  /** The round itself, so a new credential can start one without waiting. */
  const tick = useRef<() => Promise<void>>(async () => {});
  const holdUntil = useRef(0);
  // Its own hold. A Plaid login that has expired must not also stop the
  // SimpleFIN pull, and the other way round.
  const holdPlaid = useRef(0);
  const sessionStart = useRef(Date.now());

  useEffect(() => {
    const round = async () => {
      const cur = latest.current;
      const now = Date.now();
      if (running.current || now < holdUntil.current) return;

      const cadence = cur.settings.syncCadence ?? DEFAULT_CADENCE;
      const bankDue = Boolean(cur.settings.simplefinAccessUrl)
        && syncDue(cadence, cur.settings.lastSyncAt, now, sessionStart.current);
      // Plaid on the same cadence. It used to refresh only when somebody
      // pressed a button in Settings or when the overnight job ran, so a bank
      // connected through Plaid sat still all day while one connected through
      // SimpleFIN kept up. Whether anything is actually due is worked out
      // inside, per item.
      const plaidDue = (cur.settings.plaidItems?.length ?? 0) > 0 && now >= holdPlaid.current;
      // Prices keep their own clock. Someone whose investment accounts come
      // from Plaid has no SimpleFIN connection at all, and their holdings
      // should still be priced.
      const priceDue = true
        && Boolean(cur.settings.tiingoApiKey?.trim())
        && pricesDue(cur.settings.lastPricesAt, now);
      if (!bankDue && !plaidDue && !priceDue) return;

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
        if (plaidDue) {
          const out = await syncPlaidDue(latest.current, act.current.apply, cadence, now, sessionStart.current);
          // Silent unless something arrived, the same as the pull above: this
          // runs unattended and a toast saying nothing happened is worse than
          // no toast at all.
          if (out?.changed) act.current.notify(out.summary);
        }
      } catch {
        holdPlaid.current = Date.now() + BACKOFF_MS;
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

    tick.current = round;
    const id = window.setInterval(() => void round(), CHECK_MS);
    return () => window.clearInterval(id);
  }, []);

  // Pasting a key should do something. It used to do nothing until the next
  // five-minute tick came round, which on a first setup is a long time to sit
  // looking at a screen that has not changed. Declared after the effect above
  // so the round it calls has been handed over by the time this runs.
  const hasBank = Boolean(db.settings.simplefinAccessUrl);
  const hasPrices = Boolean(db.settings.tiingoApiKey?.trim());
  const plaidCount = db.settings.plaidItems?.length ?? 0;
  useEffect(() => {
    const id = window.setTimeout(() => void tick.current(), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [hasBank, hasPrices, plaidCount]);

  return null;
}
