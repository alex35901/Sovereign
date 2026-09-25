import { useEffect, useState } from "react";

/**
 * A CSS media query, read from React.
 *
 * Nearly everything in this app that changes with the width changes in CSS,
 * which is where it belongs: a rule about how wide a column is should sit with
 * the widths it is trading against. This is for the other kind — where the
 * same control has to be somewhere different rather than look different, and
 * rendering it twice and hiding one would put two of the same button on the
 * page for anything reading it aloud.
 *
 * Reactive rather than read once: a phone turned on its side crosses this, and
 * so does every run of the layout suite, which resizes one window rather than
 * opening twenty.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => read(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

const read = (query: string): boolean =>
  typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia(query).matches;

/**
 * The width the top bar drops its labels at, as a query.
 *
 * The same number as the breakpoint in index.css, and it has to stay the same
 * number: this decides where a control sits and that decides how much room it
 * has, so a page whose two answers disagree lays out for a screen it is not on.
 */
export const PHONE = "(max-width: 720px)";
