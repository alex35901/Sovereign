/**
 * Plaid Link, loaded on demand.
 *
 * Link is a hosted flow: the bank credentials are entered inside Plaid's own
 * iframe and never touch this app, which is the entire point of it. All that
 * comes back is a short-lived public token, exchanged server-side.
 */
const SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface LinkHandler {
  open: () => void;
  exit: () => void;
  destroy: () => void;
}
interface PlaidGlobal {
  create: (opts: {
    token: string;
    onSuccess: (publicToken: string) => void;
    onExit: (err: { display_message?: string; error_message?: string } | null) => void;
  }) => LinkHandler;
}

declare global {
  interface Window { Plaid?: PlaidGlobal }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load Plaid Link. Check the connection and try again."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/** Resolves with a public token, or null if the person closed the dialog. */
export async function openPlaidLink(token: string): Promise<string | null> {
  await loadScript();
  const plaid = window.Plaid;
  if (!plaid) throw new Error("Plaid Link failed to initialise.");

  return new Promise((resolve, reject) => {
    const handler = plaid.create({
      token,
      onSuccess: (publicToken) => {
        resolve(publicToken);
        handler.destroy();
      },
      onExit: (err) => {
        if (err) reject(new Error(err.display_message || err.error_message || "Plaid Link closed with an error."));
        else resolve(null);
        handler.destroy();
      },
    });
    handler.open();
  });
}
