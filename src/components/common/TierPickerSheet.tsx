// @ts-nocheck
import React from 'react';
import { openWebSignup, isAppleDevice } from '../../utils/subscriptionApi';
import { Sheet, Button } from '../ui';

// Bottom-sheet that lets a coach pick Coach vs Club track BEFORE
// the system browser opens for /signup. Apple-safe: still names
// goalkickr.com explicitly + opens externally.

interface Props {
  open: boolean;
  onClose: () => void;
  /** Used to prefill the marketing /signup form. */
  email?: string;
  /** Used to skip the marketing signup form entirely and go to checkout. */
  uid?: string;
  intent?: 'subscribe' | 'upgrade';
  /** Optional callback: when set, the sheet calls this with the
   *  chosen tier INSTEAD of opening the web signup directly. Used
   *  by SubscriptionCard so it can prompt for a missing email
   *  before handing off to Safari. */
  onPick?: (tier: 'annual' | 'club') => void;
}

const TierPickerSheet: React.FC<Props> = ({ open, onClose, email, uid, intent = 'subscribe', onPick }) => {
  const goto = (tier: 'annual' | 'club') => {
    if (onPick) onPick(tier);
    else openWebSignup({ email, uid, tier, intent });
    onClose();
  };

  // Founder is hidden on iOS per Apple anti-steering.
  const showFounder = !isAppleDevice();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      kicker="Pick a plan"
      title="What are you running?"
      subtitle="Tap one. Safari opens to goalkickr.com to finish checkout."
      footer={<Button variant="outline" onClick={onClose} fullWidth>Cancel</Button>}
    >
      <div className="space-y-2.5">
        <TierOption
          onClick={() => goto('annual')}
          kicker="Coach"
          title="One team"
          price="$99/yr or $10/mo"
          note="7-day free trial · Founders' families always free"
          highlight
        />
        <TierOption
          onClick={() => goto('club')}
          kicker="Club"
          title="Multiple teams under one club"
          price="$299/yr"
          note="Waived for clubs running $15K+/yr in registrations through GoalKickr"
        />
      </div>
      {showFounder && (
        <p className="text-charcoal-500 text-[11px] text-center pt-3">
          Founder Rate ($5/mo lifetime) is available on the web for the first 50 coaches.
        </p>
      )}
    </Sheet>
  );
};

const TierOption: React.FC<{
  onClick: () => void;
  kicker: string;
  title: string;
  price: string;
  note: string;
  highlight?: boolean;
}> = ({ onClick, kicker, title, price, note, highlight }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full text-left rounded-xl p-4 transition ${
      highlight
        ? 'bg-gradient-to-br from-brand-primary-deep/30 to-surface-elevated ring-2 ring-brand-primary/40 hover:ring-brand-primary/60'
        : 'bg-surface-base ring-1 ring-line-default/10 hover:ring-line-default/30'
    }`}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className={`text-[10px] font-extrabold tracking-widest uppercase mb-1 ${highlight ? 'text-brand-primary-soft' : 'text-ink-primary/60'}`}>
          {kicker}
        </p>
        <p className="text-ink-primary font-bold text-base leading-tight">{title}</p>
        <p className="text-charcoal-300 text-xs mt-1 leading-snug">{note}</p>
      </div>
      <div className="shrink-0 text-ink-primary text-sm font-black tabular-nums">{price}</div>
    </div>
  </button>
);

export default TierPickerSheet;
