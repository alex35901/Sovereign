/**
 * Calls one of this app's own serverless functions.
 *
 * Both integrations go through a function rather than the browser: providers
 * send no CORS headers, and credentials must not sit in a page request the
 * provider can see. The failure modes are identical for both, so they share
 * this.
 */
const missingFunction = (path: string) =>
  `The ${path} function isn't running, so the request never reached the provider. ` +
  "`npm run dev` serves the UI only — start the app with `vercel dev`, or use your deployment.";

export async function postJSON<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Could not reach ${path}. Is the app still running?`);
  }

  // A bare 404 means the function isn't mounted — nothing to do with the provider.
  if (res.status === 404) throw new Error(missingFunction(path));

  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch { /* not JSON — fall back to the raw body */ }
    throw new Error(message || `Request failed (${res.status})`);
  }

  // Some static hosts answer unknown paths with the SPA shell instead of a 404.
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(missingFunction(path));
  }
}
