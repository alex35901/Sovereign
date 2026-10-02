import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { DEFAULT_CADENCE, syncPlaidDue, syncTellerDue } from "../lib/sync";
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
 * Runs the scheduled Plaid pulls, and the price refresh that rides with them.
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
  /** After a failed Plaid pull, when it is allowed to try again. */
  const holdPlaid = useRef(0);
  /** The same for Teller, kept apart: one provider down is not both. */
  const holdTeller = useRef(0);
  const sessionStart = useRef(Date.now());

  useEffect(() => {
    const round = async () => {
      const cur = latest.current;
      const now = Date.now();
      if (running.current) return;

      const cadence = cur.settings.syncCadence ?? DEFAULT_CADENCE;
      // SimpleFIN is deliberately absent. It used to pull here on the strength
      // of an access URL sitting in the document, which meant a bridge nobody
      // had used for months could still refill the app with the accounts it
      // once fed, on a schedule, unattended, over the top of what was there.
      // Removing the credential from the server did not stop it, because this
      // path never read the server's copy. Nothing pulls from that bridge now:
      // not on a timer, not on the overnight job. See api/cron/sync.ts.
      //
      // Plaid on the cadence. Whether anything is actually due is worked out
      // inside, per item.
      const plaidDue = (cur.settings.plaidItems?.length ?? 0) > 0 && now >= holdPlaid.current;
      // Prices keep their own clock, so holdings stay priced on a day when
      // no bank had anything new to send.
      // Teller on the same cadence and its own backoff. One provider refusing
      // must not hold up the other: the whole reason there are two is that one
      // of them will not open a bank the other will.
      const tellerDue = (cur.settings.tellerEnrollments?.length ?? 0) > 0 && now >= holdTeller.current;
      const priceDue = true
        && Boolean(cur.settings.tiingoApiKey?.trim())
        && pricesDue(cur.settings.lastPricesAt, now);
      if (!plaidDue && !tellerDue && !priceDue) return;

      running.current = true;
      try {
        if (plaidDue) {
          const out = await syncPlaidDue(latest.current, act.current.apply, cadence, now, sessionStart.current);
          // Silent unless something arrived: this runs unattended, and a
          // toast on every app open saying nothing happened is worse than no
          // toast at all.
          if (out?.changed) act.current.notify(out.summary);
        }
      } catch {
        holdPlaid.current = Date.now() + BACKOFF_MS;
      }

      try {
        if (tellerDue) {
          const out = await syncTellerDue(latest.current, act.current.apply, cadence, now, sessionStart.current);
          if (out?.changed) act.current.notify(out.summary);
        }
      } catch {
        holdTeller.current = Date.now() + BACKOFF_MS;
      }

      try {
        // Its own try: a revoked price token must not put the bank sync into
        // backoff, and a bank that is down must not cost the day's prices.
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
  const hasPrices = Boolean(db.settings.tiingoApiKey?.trim());
  const plaidCount = db.settings.plaidItems?.length ?? 0;
  useEffect(() => {
    const id = window.setTimeout(() => void tick.current(), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [hasPrices, plaidCount]);

  return null;
}
