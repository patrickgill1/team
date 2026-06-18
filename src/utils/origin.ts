/**
 * Returns the production web origin to embed in shareable links / push
 * notification URLs / outgoing emails.
 *
 * On the Capacitor iOS / Android shell, `window.location.origin` is
 * `capacitor://localhost` — useless when someone else clicks the link.
 * Detect the native shell and hard-pin the canonical web domain instead.
 *
 * On web (CRA dev or Vercel prod), fall through to `window.location.origin`
 * so http://localhost:3000 / https://goalkickr.com keep working naturally
 * during development.
 *
 * Migrated from firefc.app → goalkickr.com on 2026-06-18 after Google
 * Safe Browsing falsely flagged firefc.app as a 'Dangerous site'. New
 * share links go to goalkickr.com; legacy firefc.app links continue
 * to resolve via the 301 redirect set in vercel.json so existing
 * texts / emails / push notifications don't break.
 */
export function getShareOrigin(): string {
  const PROD = 'https://goalkickr.com';
  if (typeof window === 'undefined') return PROD;
  const origin = window.location?.origin || '';
  // Anything that isn't an http(s) origin (capacitor://, file://, etc.)
  // can't be opened by a remote recipient — fall back to the canonical
  // web domain.
  if (!/^https?:/i.test(origin)) return PROD;
  return origin;
}
