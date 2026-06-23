// @ts-nocheck

// Client helpers for billing actions. Both paths intentionally open
// in the SYSTEM browser (Safari / Chrome), not inside the Capacitor
// WebView — Apple's policy is unambiguous that any flow which takes
// money for ongoing service must not happen inside our app, and
// shelling out is the cleanest way to stay compliant.
//
// Required env (CRA build-time):
//   REACT_APP_NOTIFY_URL     same worker as notify.ts uses
//   REACT_APP_NOTIFY_SECRET  bearer for /stripe/customer-portal
//   REACT_APP_GOALKICKR_SITE optional; defaults to https://goalkickr.com

const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET;
const SITE_URL = process.env.REACT_APP_GOALKICKR_SITE || 'https://goalkickr.com';

// Open an external URL. Capacitor's WKWebView treats window.open
// with target='_blank' as "send to system browser" when no other
// target is registered — which is exactly what we want for billing.
// Falls back to assigning location.href on pure web for the rare
// case Patrick is running this from a desktop browser.
function openExternal(url: string): void {
  if (!url) return;
  try {
    const isNative = typeof (window as any)?.Capacitor?.isNativePlatform === 'function'
      && (window as any).Capacitor.isNativePlatform();
    if (isNative) {
      window.open(url, '_blank');
      return;
    }
  } catch { /* fall through */ }
  // Web: same-tab navigation so the back button works naturally.
  window.location.assign(url);
}

// ── Stripe Customer Portal ───────────────────────────────────────
//
// Sends customerId to the worker, which mints a Billing Portal
// session and returns the hosted URL. We open that URL externally.
// Returns a friendly error string if anything went wrong; null on
// success.
export async function openCustomerPortal(opts: {
  customerId: string;
  returnUrl?: string;
}): Promise<string | null> {
  const { customerId } = opts;
  if (!customerId) return 'no-customer-id';
  if (!NOTIFY_URL || !NOTIFY_SECRET) return 'billing-not-configured';
  try {
    const res = await fetch(`${NOTIFY_URL.replace(/\/$/, '')}/stripe/customer-portal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${NOTIFY_SECRET}`,
      },
      body: JSON.stringify({
        customerId,
        returnUrl: opts.returnUrl || `${SITE_URL}/account`,
      }),
    });
    const data = await res.json().catch(() => ({} as any));
    if (!res.ok || !data?.url) return data?.error || `portal-error-${res.status}`;
    openExternal(data.url);
    return null;
  } catch (err: any) {
    return String(err?.message || err);
  }
}

// ── Marketing-site signup / upgrade ──────────────────────────────
//
// On iOS we MUST NOT show a payment sheet inside the app — sending
// the user to goalkickr.com/signup is the Apple-compliant flow.
// Also the right path on Android for now since we run the same code
// across both platforms.
//
// Prefill email + uid via query so the marketing form skips Firebase
// signup (the account already exists; we just need Stripe Checkout).
export function openWebSignup(opts: {
  email?: string;
  uid?: string;
  tier?: 'founder' | 'monthly' | 'annual' | 'club' | 'club-pro';
  intent?: 'subscribe' | 'upgrade';
}): void {
  const params = new URLSearchParams();
  // Only forward an email that actually looks like one. Some legacy
  // user docs ended up with placeholder strings ("....", "n/a")
  // stamped in the email field, which would corrupt the marketing
  // form's "Signed in as X" banner and lock the user out of typing
  // a real one. Strip the param entirely in that case so the form
  // shows its email-input fallback instead.
  if (opts.email && /^\S+@\S+\.\S+$/.test(opts.email.trim())) {
    params.set('email', opts.email.trim());
  }
  if (opts.uid) params.set('uid', opts.uid);
  if (opts.tier) params.set('tier', opts.tier);
  if (opts.intent) params.set('intent', opts.intent);
  const qs = params.toString();
  const url = `${SITE_URL}/signup${qs ? `?${qs}` : ''}`;
  openExternal(url);
}

export function isAppleDevice(): boolean {
  try {
    const cap = (window as any)?.Capacitor;
    if (cap?.getPlatform) return cap.getPlatform() === 'ios';
  } catch { /* fall through */ }
  // Fallback: UA sniff for the rare case we're rendering on the web.
  return /iPad|iPhone|iPod/.test(typeof navigator !== 'undefined' ? navigator.userAgent : '');
}
