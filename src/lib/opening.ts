/**
 * Whether the opening is still running, and how to wait for it.
 *
 * The page puts the rabbit up before the app exists and takes it down once the
 * app has painted. Anything that plays once on arrival has to know about that,
 * or it plays to a covered screen: the dashboard's charts drew themselves in
 * and their figures counted up while a rabbit was hopping over the top of
 * them, and what a reader saw when the rabbit left was a finished chart.
 *
 * An attribute on the root for the things CSS can hold by itself, and an event
 * for the things it cannot. Both are set by the page in index.html and cleared
 * by main.tsx, which is the only place that knows when the opening is over.
 */

const ATTR = "data-booting";
const EVENT = "sovereign:opened";

/** Whether the opening is still on screen. */
export const opening = (): boolean =>
  typeof document !== "undefined" && document.documentElement.hasAttribute(ATTR);

/**
 * Run something once the opening is over, or now if it already is.
 *
 * Returns the way to call it off, because what waits here is usually an effect
 * and the thing it was going to start may have been unmounted by then.
 */
export function whenOpened(run: () => void): () => void {
  if (!opening()) {
    run();
    return () => {};
  }
  window.addEventListener(EVENT, run, { once: true });
  return () => window.removeEventListener(EVENT, run);
}

/**
 * The opening is over. Safe to call twice, which matters: the page sets a
 * timer of its own against the app never getting here at all, and a chart held
 * at nothing for ever is a worse failure than an opening cut short.
 */
export function openingDone(): void {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute(ATTR);
  window.dispatchEvent(new Event(EVENT));
}
