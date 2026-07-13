/**
 * Returns the production web origin to embed in shareable links / push
 * notification URLs / outgoing emails.
 *
 * On the Capacitor native shell, `window.location.origin` is a local
 * scheme that a remote recipient can't open. Detect the native shell
 * and hard-pin the canonical web domain instead.
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
 *
 * NATIVE-SHELL DETECTION HISTORY:
 *   - iOS Capacitor serves the WebView from capacitor://localhost.
 *     The `/^https?:/i` regex fails → returns PROD. Fine.
 *   - Android Capacitor with `androidScheme: 'https'` (our
 *     capacitor.config.ts) serves the WebView from https://localhost.
 *     The regex PASSES and returned "https://localhost" verbatim,
 *     shipping "https://localhost/join/<id>" to every recipient of an
 *     invite generated on an Android coach's phone. That silently cost
 *     a team as of 2026-07-13.
 *   - Fix: use Capacitor.isNativePlatform() as the primary signal;
 *     keep the scheme and localhost checks as belt-and-suspenders.
 */
export function getShareOrigin(): string {
  const PROD = 'https://app.goalkickr.com';
  if (typeof window === 'undefined') return PROD;

  // Primary signal: are we running inside the Capacitor native shell
  // (either iOS or Android)? If yes, whatever the WebView's location
  // reports is useless to a remote recipient.
  try {
    if ((window as any).Capacitor?.isNativePlatform?.()) return PROD;
  } catch { /* ignore — fall through to origin checks */ }

  const origin = window.location?.origin || '';
  // Anything that isn't an http(s) origin (capacitor://, file://, etc.)
  // can't be opened by a remote recipient.
  if (!/^https?:/i.test(origin)) return PROD;

  // Belt-and-suspenders for the Android https-scheme case if the
  // Capacitor global is late to attach: `https://localhost` (or with
  // any port other than 3000, our CRA dev server) is never a real
  // shareable origin. Web dev on localhost:3000 stays legal so live
  // testing keeps working.
  const host = window.location?.hostname || '';
  const port = window.location?.port || '';
  if ((host === 'localhost' || host === '127.0.0.1') && port !== '3000') {
    return PROD;
  }

  return origin;
}
