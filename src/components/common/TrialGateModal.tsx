// @ts-nocheck
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../hooks/useAuth';
import TierPickerSheet from './TierPickerSheet';

// Friendly bottom-sheet shown when a coach without an active sub
// tries to do something gated (create event, send announcement, add
// player, upload media, etc.).
//
// Apple-safe: never names a price in the headline; the actual
// pricing + payment happens on goalkickr.com via TierPickerSheet.
// We just explain why the action is gated and offer a Start Trial
// button that opens Safari.

interface Props {
  open: boolean;
  onClose: () => void;
  /** Verb shown in the headline: "send messages", "add players",
   *  "create events", etc. Falls back to a generic prompt if absent. */
  action?: string;
  /** From useTrialGate().reason. Controls the body copy. */
  reason?: 'none' | 'no-sub' | 'past-due' | 'canceled' | 'expired';
}

const TrialGateModal: React.FC<Props> = ({ open, onClose, action, reason = 'no-sub' }) => {
  const { currentUser, userData } = useAuth();
  const [tierSheet, setTierSheet] = useState(false);

  if (!open || typeof document === 'undefined') return null;

  const verb = action || 'do this';
  const headline =
    reason === 'past-due' ? 'Your last payment failed'
    : reason === 'canceled' ? 'Your subscription was canceled'
    : reason === 'expired' ? 'Your trial has ended'
    : 'Start your free trial';
  const body =
    reason === 'past-due'
      ? `Update your card at goalkickr.com to keep using GoalKickr to ${verb}.`
      : reason === 'canceled'
      ? `Resubscribe at goalkickr.com to ${verb} again. Your team data is still here.`
      : reason === 'expired'
      ? `Your free trial ended. Subscribe at goalkickr.com to ${verb}.`
      : `Coaches need an active GoalKickr subscription to ${verb}. Start a 7-day free trial — your team data stays put either way.`;

  const handleStart = () => {
    setTierSheet(true);
  };

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
            Coach plan needed
          </p>
          <h3 className="text-bone text-xl font-bold leading-tight">{headline}</h3>
          <p className="text-charcoal-300 text-sm mt-2 leading-snug">{body}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={handleStart}
            className="px-4 py-2.5 rounded-md font-bold text-sm bg-crimson-600 hover:bg-crimson-500 text-white shadow-lg shadow-crimson-900/40 transition"
          >
            {reason === 'past-due' ? 'Update card' : reason === 'canceled' ? 'Resubscribe' : 'Start free trial'}
          </button>
        </div>
        <TierPickerSheet
          open={tierSheet}
          onClose={() => { setTierSheet(false); onClose(); }}
          email={currentUser?.email || (userData as any)?.email || undefined}
          uid={currentUser?.uid}
          intent={reason === 'no-sub' ? 'subscribe' : 'upgrade'}
        />
      </div>
    </div>,
    document.body,
  );
};

export default TrialGateModal;
