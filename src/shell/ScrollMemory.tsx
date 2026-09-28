import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * A screen you have already read comes back where you left it.
 *
 * The window is the scroll container for the whole app, so this used to be a
 * plain scroll to the top on every change of path: opening a category from
 * halfway down a transaction list otherwise left the drill-down at that same
 * offset, landing you in the middle of a chart you had not seen the top of.
 *
 * Starting at the top is right for a screen you have not read. It is wrong for
 * one you have: drilling into a category from far down the list and pressing
 * back put you at the top of a list you had spent a minute scrolling. The way
 * back is a fixed destination rather than browser history, on purpose — see
 * TopBar — and that is what makes this the piece that was missing. The arrow
 * still lands somewhere you can aim at; the page it lands on remembers where
 * you were.
 *
 * Keyed on the path alone, not the query. A drill-down keeps which period is
 * selected in the URL, and moving between periods is reading the same page
 * rather than opening a new one.
 */

/**
 * In memory, not in storage.
 *
 * It is worth nothing after the app is closed, it would be one more thing
 * competing for a storage budget a phone has already run out of once, and
 * losing it costs a scroll rather than anything anybody typed.
 */
const spots = new Map<string, number>();

/**
 * How many frames to keep putting a restored screen back where it was.
 *
 * A list that pages as you scroll is short on its first paint, so asking for
 * an offset further down than it currently reaches lands at the bottom and
 * stays there. The rows arrive over the next frame or two and the page grows
 * under it, so the ask is repeated until it sticks or until it is clear the
 * page is never going to be that tall.
 */
const FRAMES = 20;

export function ScrollMemory() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    const want = spots.get(pathname);
    let frame = 0;
    let id = 0;

    if (want === undefined || want <= 0) {
      // Instant, not smooth: this is not a journey anyone asked to watch, and
      // a smooth scroll would race the new screen's own first paint.
      window.scrollTo({ top: 0, behavior: "instant" });
    } else {
      const settle = () => {
        window.scrollTo({ top: want, behavior: "instant" });
        if (Math.abs(window.scrollY - want) > 2 && frame++ < FRAMES) {
          id = requestAnimationFrame(settle);
        }
      };
      settle();
    }

    // On the way out, while this is still the screen on screen: the cleanup
    // runs before the next path's effect, so the offset read here is this
    // page's own rather than the new one's.
    return () => {
      if (id) cancelAnimationFrame(id);
      spots.set(pathname, window.scrollY);
    };
  }, [pathname]);

  return null;
}
