// @ts-nocheck
import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import TierPickerSheet from './TierPickerSheet';
import { Sheet, Button } from '../ui';

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

  const ctaLabel =
    reason === 'past-due' ? 'Update card'
    : reason === 'canceled' ? 'Resubscribe'
    : 'Start free trial';

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        kicker="Coach plan needed"
        title={headline}
        subtitle={body}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>Not now</Button>
            <Button variant="primary" onClick={() => setTierSheet(true)}>{ctaLabel}</Button>
          </>
        }
      />
      <TierPickerSheet
        open={tierSheet}
        onClose={() => { setTierSheet(false); onClose(); }}
        email={currentUser?.email || (userData as any)?.email || undefined}
        uid={currentUser?.uid}
        intent={reason === 'no-sub' ? 'subscribe' : 'upgrade'}
      />
    </>
  );
};

export default TrialGateModal;
