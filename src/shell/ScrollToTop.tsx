import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * A new screen starts at the top of itself.
 *
 * The window is the scroll container for the whole app, so opening a category
 * from halfway down a transaction list left the drill-down scrolled to that
 * same offset — landing you in the middle of a chart you had not seen the top
 * of, or past the end of a shorter page entirely.
 *
 * Keyed on the path alone, not the query. A drill-down keeps which period is
 * selected in the URL, and moving between periods is reading the same page
 * rather than opening a new one; scrolling to the top on every bar click would
 * yank the list out from under whoever clicked it.
 *
 * Before paint, so the new screen is never briefly drawn at the old offset.
 */
export function ScrollToTop() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    // Instant, not smooth: this is not a journey anyone asked to watch, and a
    // smooth scroll would race the new screen's own first paint.
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [pathname]);
  return null;
}
