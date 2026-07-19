import React, { useState } from 'react';

/**
 * Inline "Set up payments" banner rendered on CoachPaymentCreate +
 * CoachPayments when the coach's team club is NOT Stripe-ready.
 *
 * Deep-links straight to the same /stripe/connect/start endpoint that
 * ClubOverview PaymentsTab uses, bypassing the intermediate Club
 * navigation. Works for both:
 *   - An existing club that never connected Stripe
 *   - A standalone coach where the worker auto-created a
 *     personal_{coachUid} shell
 *
 * Guidance, not a hard gate — the coach can still hit "Send it out"
 * and the /payments/create 409 will surface the same banner shape at
 * the bottom of the form.
 */
interface Props {
  clubId: string | undefined;
  headline?: string;
  body?: string;
  ctaLabel?: string;
}

export const StripeConnectBanner: React.FC<Props> = ({
  clubId,
  headline = 'Set up payments to start collecting',
  body = 'Takes about 3 minutes. Families can then pay directly through the app.',
  ctaLabel = 'Set up payments',
}) => {
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const start = async () => {
    if (!clubId || busy) return;
    setBusy(true);
    setLocalErr(null);
    try {
      const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
      if (!NOTIFY_URL) {
        setLocalErr('Payments backend not configured yet. Contact patrick.gill@goalkickr.com.');
        setBusy(false);
        return;
      }
      const url = `${NOTIFY_URL}/stripe/connect/start?clubId=${encodeURIComponent(clubId)}`;
      const r = await fetch(url);
      const data: any = await r.json().catch(() => ({}));
      if (r.ok && data?.url) {
        window.location.assign(data.url);
        return;
      }
      if (data?.error === 'stripe-connect-not-configured') {
        setLocalErr("Payments isn't configured on this environment yet. Contact patrick.gill@goalkickr.com.");
        setBusy(false);
        return;
      }
      setLocalErr(`Could not start setup (${r.status}). ${data?.error || 'Please try again.'}`);
      setBusy(false);
    } catch (err: any) {
      setLocalErr(`Network hiccup. ${err?.message || err}`);
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5 w-10 h-10 rounded-full bg-brand-primary/10 flex items-center justify-center">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-brand-primary"
            aria-hidden
          >
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M2 10h20" />
            <path d="M6 15h4" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-ink-primary leading-tight">{headline}</p>
          <p className="text-[12px] text-ink-primary/70 mt-1 leading-snug">{body}</p>
          <button
            type="button"
            onClick={start}
            disabled={!clubId || busy}
            className="mt-3 px-4 py-2 rounded-lg bg-brand-primary text-white text-xs font-black uppercase tracking-widest hover:bg-brand-primary/90 transition disabled:opacity-50"
          >
            {busy ? 'Opening Stripe...' : ctaLabel}
          </button>
          {localErr && (
            <p className="mt-2 text-[11px] text-rose-500">{localErr}</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default StripeConnectBanner;
