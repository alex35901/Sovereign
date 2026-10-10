import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "./App";
import { StoreProvider } from "./store";
import { openingDone } from "./lib/opening";
import "./index.css";

/**
 * How long the opening hop runs, and how long it takes to fade.
 *
 * The same numbers as the keyframes in index.html, which is the one place they
 * can be written down for the browser and the one place they cannot be read
 * from here. Kept in step by hand, and the cost of them drifting is a frame.
 */
const BOOT_MS = 2000;
const BOOT_FADE_MS = 260;

/**
 * Paths normally, hashes for the single-file preview.
 *
 * The deployment rewrites every path to index.html, so /budget is a page. A
 * preview built as one file has nothing to do the rewriting, and a path would
 * be a 404 on whatever is hosting it, so those builds route in the fragment
 * instead. See scripts/preview.mjs.
 */
const Router = import.meta.env.VITE_HASH_ROUTER ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <StoreProvider>
        <App />
      </StoreProvider>
    </Router>
  </StrictMode>,
);

/**
 * Taking the opening hop away again.
 *
 * Two conditions, and it waits for the later of them. The app has to have
 * painted, or the hop would hand over to a blank page, which is the thing it
 * was covering for. And the hop has to have finished, or on a warm load it
 * would flash a frame of rabbit and vanish, which reads as a glitch rather
 * than as an opening.
 *
 * Two frames, because one only guarantees the work is scheduled: the second
 * runs after the browser has actually drawn what React handed it.
 */
const boot = document.getElementById("boot");
if (boot) {
  const started = (window as { __bootAt?: number }).__bootAt ?? Date.now();
  const still = (): number => Math.max(0, BOOT_MS - (Date.now() - started));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.setTimeout(() => {
      boot.classList.add("gone");
      // After the fade in the stylesheet above it, so nothing is left in the
      // tree to be read out or to sit over the page.
      window.setTimeout(() => {
        boot.remove();
        // And the screen is the app's now: whatever was waiting for a clear
        // view to play itself in can go. The page sets a timer against this
        // never being reached, so a chart is never held at nothing for ever.
        openingDone();
      }, BOOT_FADE_MS);
    }, still());
  }));
}
