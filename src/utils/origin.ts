/**
 * Returns the production web origin to embed in shareable links / push
 * notification URLs / outgoing emails.
 *
 * On the Capacitor iOS / Android shell, `window.location.origin` is
 * `capacitor://localhost` — useless when someone else clicks the link.
 * Detect the native shell and hard-pin the canonical web domain instead.
 *
 * On web (CRA dev or Vercel prod), fall through to `window.location.origin`
 * so http://localhost:3000 / https://app.goalkickr.com keep working naturally
 * during development.
 *
 * IMPORTANT: this returns the APP origin (app.goalkickr.com), not the
 * marketing origin (goalkickr.com). The team app lives at
 * app.goalkickr.com; the marketing site has /pricing, /clubs, /about,
 * /signup and nothing else — none of the share paths exist there
 * (/join, /event, /survey, /vote, /wall/p, /media). Patrick caught
 * this 2026-06-27 when a survey share URL went to goalkickr.com and
 * 404'd. The marketing site has a fallback rewrite for these paths
 * to app.goalkickr.com so URLs already in the wild keep resolving,
 * but new shares should go directly to the app to skip the hop.
 *
 * Migrated from firefc.app → goalkickr.com on 2026-06-18 after Google
 * Safe Browsing flagged firefc.app. Legacy firefc.app links 301 to
 * app.goalkickr.com via vercel.json so old texts / emails don't break.
 */
export function getShareOrigin(): string {
  const PROD = 'https://app.goalkickr.com';
  if (typeof window === 'undefined') return PROD;
  const origin = window.location?.origin || '';
  // Anything that isn't an http(s) origin (capacitor://, file://, etc.)
  // can't be opened by a remote recipient — fall back to the canonical
  // app domain.
  if (!/^https?:/i.test(origin)) return PROD;
  return origin;
}
