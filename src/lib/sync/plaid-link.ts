/**
 * Plaid Link, loaded on demand.
 *
 * Link is a hosted flow: the bank credentials are entered inside Plaid's own
 * iframe and never touch this app, which is the entire point of it. All that
 * comes back is a short-lived public token, exchanged server-side.
 */
import { describeLinkFailure } from "./link-error.js";
import type { LinkFailure } from "./link-error.js";

const SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface LinkHandler {
  open: () => void;
  exit: () => void;
  destroy: () => void;
}
interface LinkError {
  display_message?: string | null;
  error_message?: string | null;
  error_code?: string | null;
}
/** What Link attaches to an event: the same trouble, reported earlier. */
interface LinkEventMeta {
  error_code?: string | null;
  error_message?: string | null;
  view_name?: string | null;
  institution_name?: string | null;
  request_id?: string | null;
  link_session_id?: string | null;
}
interface LinkExitMeta {
  institution?: { name?: string | null } | null;
  request_id?: string | null;
  link_session_id?: string | null;
  status?: string | null;
}
interface PlaidGlobal {
  create: (opts: {
    token: string;
    onSuccess: (publicToken: string) => void;
    onEvent?: (name: string, meta: LinkEventMeta) => void;
    onExit: (err: LinkError | null, meta?: LinkExitMeta) => void;
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

/** Thrown when Link stopped on an error, carrying what Plaid said about it. */
export class PlaidLinkError extends Error {
  constructor(public detail: LinkFailure) {
    super(describeLinkFailure(detail));
    this.name = "PlaidLinkError";
  }
}

/** Resolves with a public token, or null if the person closed the dialog. */
export async function openPlaidLink(token: string): Promise<string | null> {
  await loadScript();
  const plaid = window.Plaid;
  if (!plaid) throw new Error("Plaid Link failed to initialise.");

  return new Promise((resolve, reject) => {
    /**
     * The last thing that went wrong inside the dialog.
     *
     * Kept because the exit callback's own error is null when somebody presses
     * Exit, which is exactly what anybody does when a screen says "Something
     * went wrong". Without this the whole event is lost.
     */
    let last: LinkFailure | null = null;

    const handler = plaid.create({
      token,
      onEvent: (name, meta) => {
        if (name !== "ERROR" && !meta?.error_code) return;
        last = {
          message: meta?.error_message ?? undefined,
          code: meta?.error_code ?? undefined,
          institution: meta?.institution_name ?? undefined,
          view: meta?.view_name ?? undefined,
          requestId: meta?.request_id ?? undefined,
          sessionId: meta?.link_session_id ?? undefined,
        };
      },
      onSuccess: (publicToken) => {
        resolve(publicToken);
        handler.destroy();
      },
      onExit: (err, meta) => {
        const detail: LinkFailure = {
          message: err?.display_message ?? err?.error_message ?? last?.message,
          code: err?.error_code ?? last?.code,
          institution: meta?.institution?.name ?? last?.institution,
          view: last?.view,
          requestId: meta?.request_id ?? last?.requestId,
          sessionId: meta?.link_session_id ?? last?.sessionId,
        };
        // A dialog closed on purpose with nothing wrong is not a failure. One
        // closed after a screen that said something went wrong is, even though
        // pressing Exit looks identical from here.
        if (detail.code || detail.message) reject(new PlaidLinkError(detail));
        else resolve(null);
        handler.destroy();
      },
    });
    handler.open();
  });
}
