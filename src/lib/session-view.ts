/**
 * What a screen looked like a moment ago, for as long as the app is open.
 *
 * Filters, the month being read, where a long list was scrolled to: none of it
 * is about the household's money, so none of it belongs in the document or in
 * the cloud. It is not a lasting preference either. Coming back to a list you
 * filtered thirty seconds ago and finding it filtered is helpful; opening the
 * app next week and finding a filter you have forgotten setting is a bug
 * report. So: sessionStorage, which lasts exactly as long as the answer stays
 * useful and goes when the app is closed.
 *
 * Every read and write is guarded. Storage throws in a private window and
 * comes back empty when site data is cleared, and neither is a reason for a
 * screen not to render. A remembered view is a convenience; its absence is the
 * ordinary case.
 */

const KEY = (name: string): string => `sovereign.view.${name}`;

export function recall<T>(name: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(KEY(name));
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function keep(name: string, value: unknown): void {
  try {
    sessionStorage.setItem(KEY(name), JSON.stringify(value));
  } catch { /* full or refused; the screen still works without it */ }
}

export function forget(name: string): void {
  try { sessionStorage.removeItem(KEY(name)); } catch { /* nothing to do */ }
}
