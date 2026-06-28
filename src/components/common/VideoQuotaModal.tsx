import React from 'react';
import type { QuotaCheck } from '../../utils/videoQuota';

// Shown when an upload attempt fails the team's video quota check.
// Phase 1 — purely informational + waitlist CTA. Phase 2 will swap
// the CTA for a Stripe Checkout button.

interface Props {
  open: boolean;
  quota: QuotaCheck | null;
  onClose: () => void;
}

const VideoQuotaModal: React.FC<Props> = ({ open, quota, onClose }) => {
  if (!open || !quota) return null;

  const title = quota.reason === 'duration'
    ? 'This clip is too long for your tier'
    : quota.reason === 'storage'
      ? 'Your team is out of storage'
      : "You've hit your team's free-tier limit";

  const explain = quota.reason === 'duration'
    ? `Clips on the ${quota.tier === 'free' ? 'Free' : 'Highlights+'} tier are capped at 60 seconds. To upload full game film, the team needs Full Game Film ($29.99/mo).`
    : quota.reason === 'storage'
      ? 'Full Game Film tier includes 100 hours of stored video. Delete an old clip from the team to free up space.'
      : `Free teams can store up to 20 short clips. Upgrade to Highlights+ ($10/mo) for unlimited 60-second clips, or Full Game Film ($29.99/mo) for full-length game video and up to 100 hours stored.`;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in" onClick={onClose}>
      <div
        className="bg-charcoal-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden animate-sheet-up sm:animate-pop-in"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-5 py-3 flex items-center justify-between">
          <p className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Video storage</p>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-extrabold tracking-widest uppercase text-bone/40 hover:text-white"
          >
            Close
          </button>
        </div>
        <div className="p-5">
          <h2 className="text-lg font-black text-bone leading-tight">{title}</h2>
          {quota.currentLabel && (
            <p className="text-sm text-bone/55 mt-1">{quota.currentLabel}</p>
          )}
          <p className="mt-4 text-sm text-bone/85 leading-relaxed">{explain}</p>

          <div className="mt-5 space-y-2">
            <TierRow
              label="Free"
              price="$0"
              perks="20 clips, ≤60s each, 720p"
              active={quota.tier === 'free'}
            />
            <TierRow
              label="Highlights+"
              price="$10/mo per team"
              perks="Unlimited 60s clips, 720p"
              active={quota.tier === 'addon'}
              comingSoon
            />
            <TierRow
              label="Full Game Film"
              price="$29.99/mo per team"
              perks="Unlimited length, up to 100 hours stored"
              active={quota.tier === 'pro'}
              comingSoon
            />
          </div>

          <p className="mt-5 text-bone/55 text-xs leading-relaxed">
            Paid tiers ship soon. We're metering usage now to set the free-tier limit fairly. Want early access? Email <a href="mailto:patrick.gill@goalkickr.com" className="text-brand-primary-soft hover:underline">patrick.gill@goalkickr.com</a>.
          </p>

          <button
            type="button"
            onClick={onClose}
            className="w-full mt-5 px-4 py-2.5 rounded-lg bg-charcoal-800 hover:bg-charcoal-700 ring-1 ring-white/10 text-bone text-xs font-extrabold tracking-widest uppercase"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};

const TierRow: React.FC<{ label: string; price: string; perks: string; active?: boolean; comingSoon?: boolean }> = ({ label, price, perks, active, comingSoon }) => (
  <div className={`rounded-xl p-3 ring-1 ${active ? 'bg-brand-primary/10 ring-brand-primary/30' : 'bg-charcoal-950 ring-white/10'}`}>
    <div className="flex items-center justify-between gap-2">
      <span className="text-bone font-bold text-sm">{label}</span>
      <span className="text-bone/85 text-sm font-bold tabular-nums">{price}</span>
    </div>
    <p className="text-bone/55 text-xs mt-0.5">{perks}</p>
    {active && (
      <p className="text-brand-primary-soft text-[10px] font-extrabold tracking-widest uppercase mt-1.5">Your team is on this tier</p>
    )}
    {comingSoon && !active && (
      <p className="text-bone/40 text-[10px] font-extrabold tracking-widest uppercase mt-1.5">Coming soon</p>
    )}
  </div>
);

export default VideoQuotaModal;
