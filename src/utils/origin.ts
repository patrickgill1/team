/**
 * Returns the production web origin to embed in shareable links / push
 * notification URLs / outgoing emails.
 *
 * On the Capacitor iOS / Android shell, `window.location.origin` is
 * `capacitor://localhost` — useless when someone else clicks the link.
 * Detect the native shell and hard-pin the canonical web domain instead.
 *
 * On web (CRA dev or Vercel prod), fall through to `window.location.origin`
 * so http://localhost:3000 / https://firefc.app keep working naturally
 * during development.
 */
export function getShareOrigin(): string {
  const PROD = 'https://firefc.app';
  if (typeof window === 'undefined') return PROD;
  const origin = window.location?.origin || '';
  // Anything that isn't an http(s) origin (capacitor://, file://, etc.)
  // can't be opened by a remote recipient — fall back to the canonical
  // web domain.
  if (!/^https?:/i.test(origin)) return PROD;
  return origin;
}
