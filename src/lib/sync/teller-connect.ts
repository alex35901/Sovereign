/**
 * Teller Connect, loaded on demand.
 *
 * The same shape as Plaid Link and for the same reason: the bank credentials
 * are entered inside Teller's own dialog and never touch this app. What comes
 * back is an access token for that one login, which goes into the document
 * beside the Plaid ones.
 *
 * Unlike Link there is no token to mint first. Teller Connect opens on the
 * application id alone, and the certificate that proves this app is that
 * application is only ever used server-side, when the token is spent.
 */

const SCRIPT_SRC = "https://cdn.teller.io/connect/connect.js";

export interface TellerEnrollment {
  accessToken: string;
  enrollment: {
    id: string;
    institution?: { name?: string | null; id?: string | null } | null;
  };
}

interface ConnectHandle { open: () => void; destroy?: () => void }

interface TellerGlobal {
  setup: (opts: {
    applicationId: string;
    environment?: string;
    products?: string[];
    enrollmentId?: string;
    onSuccess: (enrollment: TellerEnrollment) => void;
    onExit?: () => void;
    onFailure?: (failure: { type?: string; code?: string; message?: string }) => void;
  }) => ConnectHandle;
}

declare global {
  interface Window { TellerConnect?: TellerGlobal }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.TellerConnect) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;
      reject(new Error("Couldn't load Teller Connect. Check the connection and try again."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/** Thrown when Connect stopped on an error rather than on a closed dialog. */
export class TellerConnectError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "TellerConnectError";
  }
}

export interface OpenOptions {
  applicationId: string;
  environment?: string;
  /**
   * The enrollment to sign into again, rather than adding a new one.
   *
   * The whole point of naming it: without this the dialog mints a second
   * enrollment for the same bank, and both of them count against the hundred
   * the free tier allows while only one of them is being read.
   */
  enrollmentId?: string;
}

/** Resolves with an enrollment, or null if the person closed the dialog. */
export async function openTellerConnect(opts: OpenOptions): Promise<TellerEnrollment | null> {
  await loadScript();
  const teller = window.TellerConnect;
  if (!teller) throw new Error("Teller Connect failed to initialise.");

  return new Promise((resolve, reject) => {
    let done = false;
    const handle = teller.setup({
      applicationId: opts.applicationId,
      ...(opts.environment ? { environment: opts.environment } : {}),
      // Balances and transactions. Teller has no investments product, which is
      // why a brokerage stays on Plaid.
      products: ["balance", "transactions"],
      ...(opts.enrollmentId ? { enrollmentId: opts.enrollmentId } : {}),
      onSuccess: (enrollment) => {
        done = true;
        resolve(enrollment);
        handle.destroy?.();
      },
      onFailure: (failure) => {
        done = true;
        reject(new TellerConnectError(
          failure.code ?? failure.type ?? "",
          failure.message || "Teller Connect could not finish.",
        ));
        handle.destroy?.();
      },
      onExit: () => {
        // A dialog closed on purpose is not a failure, and onExit fires after
        // a failure too, so whichever arrived first stands.
        if (!done) resolve(null);
        handle.destroy?.();
      },
    });
    handle.open();
  });
}
