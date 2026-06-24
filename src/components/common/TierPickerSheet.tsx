// @ts-nocheck
import React from 'react';
import { createPortal } from 'react-dom';
import { openWebSignup, isAppleDevice } from '../../utils/subscriptionApi';

// Bottom-sheet that lets a coach pick Coach vs Club track BEFORE
// the system browser opens for /signup. Patrick: "i subscribed as
// a coach, because there was still no option to pick a club
// subscription from app..." — every in-app subscribe CTA used to
// hardcode tier='annual'.
//
// Apple-safe: still names goalkickr.com explicitly + opens externally.

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
  if (!open || typeof document === 'undefined') return null;

  const goto = (tier: 'annual' | 'club') => {
    if (onPick) {
      onPick(tier);
    } else {
      openWebSignup({ email, uid, tier, intent });
    }
    onClose();
  };

  // Founder is hidden on iOS per Apple anti-steering (the marketing
  // page handles the founder counter + signup itself if a user
  // navigates there directly — we just don't surface it in-app).
  const showFounder = !isAppleDevice();

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-charcoal-900 ring-1 ring-white/10 rounded-2xl p-5 sm:p-6 w-full max-w-md space-y-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div>
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400 mb-1.5">
            Pick a plan
          </p>
          <h3 className="text-bone text-xl font-bold leading-tight">
            What are you running?
          </h3>
          <p className="text-charcoal-300 text-sm mt-2">
            Tap one. Safari opens to goalkickr.com to finish checkout.
          </p>
        </div>

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
          <p className="text-charcoal-500 text-[11px] text-center pt-1">
            Founder Rate ($5/mo lifetime) is available on the web for the first 50 coaches.
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full px-4 py-2.5 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition mt-2"
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
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
        ? 'bg-gradient-to-br from-crimson-950/30 to-charcoal-900 ring-2 ring-crimson-500/40 hover:ring-crimson-500/60'
        : 'bg-charcoal-950 ring-1 ring-white/10 hover:ring-white/30'
    }`}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className={`text-[10px] font-extrabold tracking-widest uppercase mb-1 ${highlight ? 'text-crimson-400' : 'text-bone/60'}`}>
          {kicker}
        </p>
        <p className="text-bone font-bold text-base leading-tight">{title}</p>
        <p className="text-charcoal-300 text-xs mt-1 leading-snug">{note}</p>
      </div>
      <div className="shrink-0 text-bone text-sm font-black tabular-nums">{price}</div>
    </div>
  </button>
);

export default TierPickerSheet;
