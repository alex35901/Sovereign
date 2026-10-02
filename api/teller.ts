import type { IncomingMessage, ServerResponse } from "node:http";
import { TellerError, fetchEnrollment, pemKind, readPem, tellerCall, tellerCreds, tellerEnv } from "./_teller.js";

/**
 * Server-side proxy for Teller.
 *
 * Teller authenticates the application with a client certificate rather than a
 * header, so the private key is the credential and it can never be anywhere
 * near a browser. The per-enrollment access token is held by the document and
 * passed back in, the same as Plaid's.
 *
 * The one thing that does go out is the application id, which Teller Connect
 * needs in the page to open at all. It is not a secret: it identifies the app
 * in a dialog the person is already looking at, and nothing can be done with
 * it without the certificate.
 *
 * Signature note: Vercel invokes the default export as (req, res). A Web-style
 * handler is called the same way and silently never responds.
 */
export const config = { runtime: "nodejs", maxDuration: 60 };

type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse;

interface SetupBody { action: "setup" }
interface DiagnoseBody { action: "diagnose" }
interface AccountsBody { action: "accounts"; accessToken: string }
interface SyncBody { action: "sync"; accessToken: string; startDate: string }
type Body = SetupBody | DiagnoseBody | AccountsBody | SyncBody;

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  };

  if (req.method !== "POST") return send(405, { error: "POST only" });

  let body: Body;
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Body;
    if (!body || typeof body !== "object") throw new Error("empty body");
  } catch {
    return send(400, { error: "Malformed JSON body" });
  }

  /**
   * What the dialog needs to open, answered before the credentials are
   * demanded.
   *
   * Deliberately the one action that works without a certificate. A household
   * setting this up has the application id before it has anything else, and a
   * card that cannot even say which environment it is pointed at is a card
   * that cannot be set up.
   */
  if (body.action === "setup") {
    const appId = (process.env.TELLER_APP_ID ?? "").trim();
    return send(200, {
      applicationId: appId,
      environment: tellerEnv(),
      configured: Boolean(appId && readPem(process.env.TELLER_CERT ?? "") && readPem(process.env.TELLER_KEY ?? "")),
    });
  }

  /**
   * The shape of the configuration, and what Teller says about it, without
   * ever returning the certificate itself.
   *
   * Lengths and PEM headers only. "TELLER_KEY holds a CERTIFICATE" is the
   * single most likely mistake here, because the two files are downloaded
   * together and look alike, and it is invisible from every other angle.
   */
  if (body.action === "diagnose") {
    const appId = (process.env.TELLER_APP_ID ?? "").trim();
    const rawCert = process.env.TELLER_CERT ?? "";
    const rawKey = process.env.TELLER_KEY ?? "";
    const cert = readPem(rawCert);
    const key = readPem(rawKey);
    const creds = tellerCreds();
    const probe = creds
      // Teller answers /accounts with 401 for a token it does not know and
      // refuses the handshake outright for a certificate it does not know, so
      // a refused token is a certificate that worked.
      ? await tellerCall(creds, "/accounts", "probe_not_a_real_token")
        .then(() => ({ ok: true, error: null }))
        .catch((err: unknown) => {
          if (err instanceof TellerError) {
            if (err.status === 401) return { ok: true, error: null };
            return { ok: false, error: err.code || err.message };
          }
          return { ok: false, error: err instanceof Error ? err.message : "unknown failure" };
        })
      : { ok: false, error: "not configured" };

    return send(200, {
      environment: tellerEnv(),
      envVarSet: Boolean(process.env.TELLER_ENV),
      appId: { length: appId.length, looksRight: /^app_/.test(appId) },
      cert: { length: cert.length, kind: pemKind(cert), repaired: rawCert.includes("\\n") },
      key: { length: key.length, kind: pemKind(key), repaired: rawKey.includes("\\n") },
      probe,
    });
  }

  const creds = tellerCreds();
  if (!creds) {
    return send(503, {
      error: "Teller isn't configured. Add TELLER_APP_ID, TELLER_CERT and TELLER_KEY as environment variables "
        + "in your Vercel project, then redeploy.",
      configured: false,
    });
  }

  try {
    if (body.action === "accounts") {
      if (!body.accessToken) return send(400, { error: "No access token supplied." });
      // No transactions: this is the call that asks what a login holds, which
      // is a different question from what has happened on it.
      const payload = await fetchEnrollment(creds, body.accessToken, new Date().toISOString().slice(0, 10), {
        withTransactions: false,
      });
      return send(200, payload);
    }

    if (body.action === "sync") {
      if (!body.accessToken) return send(400, { error: "No access token supplied." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate ?? "")) {
        return send(400, { error: "A start date of the form YYYY-MM-DD is required." });
      }
      return send(200, await fetchEnrollment(creds, body.accessToken, body.startDate));
    }

    return send(400, { error: "Unknown action" });
  } catch (err) {
    if (err instanceof TellerError) return send(err.status >= 400 && err.status < 600 ? err.status : 502, { error: err.message, code: err.code });
    return send(502, { error: err instanceof Error ? err.message : "Teller could not be reached." });
  }
}
