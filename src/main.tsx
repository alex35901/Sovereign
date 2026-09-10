import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "./App";
import { StoreProvider } from "./store";
import "./index.css";

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
