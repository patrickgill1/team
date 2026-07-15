import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import type { QuotaCheck } from '../../utils/videoQuota';
import { startVideoCheckout } from '../../utils/subscriptionApi';

// Shown when an upload attempt fails the team's video quota check.
// Pro tier is wired to live Stripe Checkout via the worker; Highlights+
// stays "Coming soon" until that SKU exists in Stripe.

interface Props {
  open: boolean;
  quota: QuotaCheck | null;
  onClose: () => void;
  teamId?: string;
}

const VideoQuotaModal: React.FC<Props> = ({ open, quota, onClose, teamId }) => {
  const { currentUser } = useAuth();
  const [upgrading, setUpgrading] = useState<'addon' | 'pro' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open || !quota) return null;

  const proSkuConfigured = !!process.env.REACT_APP_STRIPE_PRICE_VIDEO_PRO;
  const addonSkuConfigured = !!process.env.REACT_APP_STRIPE_PRICE_VIDEO_ADDON;

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

  const handleUpgrade = async (tier: 'addon' | 'pro') => {
    if (!teamId) {
      setError('Pick a team first.');
      return;
    }
    setError(null);
    setUpgrading(tier);
    const err = await startVideoCheckout({
      tier,
      teamId,
      uid: currentUser?.uid,
      customerEmail: currentUser?.email || undefined,
    });
    setUpgrading(null);
    if (err) {
      setError(err === 'price-not-configured'
        ? 'Upgrades aren\'t available yet. Email patrick.gill@goalkickr.com.'
        : `Couldn\'t open checkout (${err}).`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in" onClick={onClose}>
      <div
        className="bg-surface-elevated w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden animate-sheet-up sm:animate-pop-in"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-5 py-3 flex items-center justify-between">
          <p className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Video storage</p>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/40 hover:text-ink-primary"
          >
            Close
          </button>
        </div>
        <div className="p-5">
          <h2 className="text-lg font-black text-ink-primary leading-tight">{title}</h2>
          {quota.currentLabel && (
            <p className="text-sm text-ink-primary/55 mt-1">{quota.currentLabel}</p>
          )}
          <p className="mt-4 text-sm text-ink-primary/85 leading-relaxed">{explain}</p>

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
              ctaLabel={addonSkuConfigured ? 'Upgrade' : undefined}
              comingSoon={!addonSkuConfigured}
              onCta={addonSkuConfigured ? () => handleUpgrade('addon') : undefined}
              busy={upgrading === 'addon'}
              disabled={!!upgrading}
            />
            <TierRow
              label="Full Game Film"
              price="$29.99/mo per team"
              perks="Unlimited length, up to 100 hours stored"
              active={quota.tier === 'pro'}
              ctaLabel={proSkuConfigured ? 'Upgrade' : undefined}
              comingSoon={!proSkuConfigured}
              onCta={proSkuConfigured ? () => handleUpgrade('pro') : undefined}
              busy={upgrading === 'pro'}
              disabled={!!upgrading}
            />
          </div>

          {error && (
            <p className="mt-4 text-xs text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30 rounded-lg px-3 py-2 leading-relaxed">
              {error}
            </p>
          )}

          <p className="mt-5 text-ink-primary/55 text-xs leading-relaxed">
            Subscriptions are per-team and billed monthly. Manage or cancel anytime from the team settings page.
          </p>

          <button
            type="button"
            onClick={onClose}
            className="w-full mt-5 px-4 py-2.5 rounded-lg bg-surface-input hover:bg-surface-raised ring-1 ring-line-default/10 text-ink-primary text-xs font-extrabold tracking-widest uppercase"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
};

const TierRow: React.FC<{
  label: string;
  price: string;
  perks: string;
  active?: boolean;
  comingSoon?: boolean;
  ctaLabel?: string;
  onCta?: () => void;
  busy?: boolean;
  disabled?: boolean;
}> = ({ label, price, perks, active, comingSoon, ctaLabel, onCta, busy, disabled }) => (
  <div className={`rounded-xl p-3 ring-1 ${active ? 'bg-brand-primary/10 ring-brand-primary/30' : 'bg-surface-base ring-line-default/10'}`}>
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink-primary font-bold text-sm">{label}</span>
      <span className="text-ink-primary/85 text-sm font-bold tabular-nums">{price}</span>
    </div>
    <p className="text-ink-primary/55 text-xs mt-0.5">{perks}</p>
    {active && (
      <p className="text-brand-primary-soft text-[10px] font-extrabold tracking-widest uppercase mt-1.5">Your team is on this tier</p>
    )}
    {comingSoon && !active && (
      <p className="text-ink-primary/40 text-[10px] font-extrabold tracking-widest uppercase mt-1.5">Coming soon</p>
    )}
    {ctaLabel && !active && onCta && (
      <button
        type="button"
        onClick={onCta}
        disabled={!!busy || !!disabled}
        className="mt-2 w-full px-3 py-2 rounded-lg bg-brand-primary text-white text-xs font-extrabold tracking-widest uppercase hover:bg-brand-primary/90 disabled:opacity-50 disabled:cursor-wait"
      >
        {busy ? 'Opening checkout…' : ctaLabel}
      </button>
    )}
  </div>
);

export default VideoQuotaModal;
