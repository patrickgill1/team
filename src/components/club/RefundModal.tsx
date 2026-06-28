// @ts-nocheck
import React, { useState } from 'react';
import type { Registration } from '../../types';
import { Sheet, Button, FormField, fieldInputClass } from '../ui';

// Refund modal. Defaults the amount to "remaining refundable" (original
// total minus any prior refunds) and lets the admin tweak for partial.
// Calls the worker's /stripe/registration-refund which talks to Stripe
// + writes the refund entry back to the Registration. Reason captured
// for the activity log; the dropdown maps to Stripe's enumerated set
// (duplicate / fraudulent / requested_by_customer) plus a free-text
// detail that lives in our own activity payload.

interface Props {
  registration: Registration;
  actorUid: string;
  actorName: string;
  onClose: () => void;
  onRefunded: (refundId: string, amountCents: number) => void;
}

const STRIPE_REASONS: Array<{ value: 'requested_by_customer' | 'duplicate' | 'fraudulent'; label: string }> = [
  { value: 'requested_by_customer', label: 'Family requested' },
  { value: 'duplicate', label: 'Duplicate charge' },
  { value: 'fraudulent', label: 'Fraudulent' },
];

const RefundModal: React.FC<Props> = ({ registration, actorUid, actorName, onClose, onRefunded }) => {
  // Compute remaining refundable from prior refunds.
  const originalCents = (registration.amountPaidCents ?? registration.registrationFeeCents ?? 0)
    + (registration.stripeSurchargeCents || 0);
  const priorRefunds = registration.refunds || [];
  const alreadyRefunded = priorRefunds
    .filter(r => r.status !== 'failed' && r.status !== 'canceled')
    .reduce((sum, r) => sum + (r.amountCents || 0), 0);
  const remainingCents = Math.max(0, originalCents - alreadyRefunded);

  const [amountDollars, setAmountDollars] = useState((remainingCents / 100).toFixed(2));
  const [reason, setReason] = useState<'requested_by_customer' | 'duplicate' | 'fraudulent'>('requested_by_customer');
  const [detail, setDetail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const requestedCents = Math.round(Number(amountDollars) * 100);
  const validAmount = requestedCents > 0 && requestedCents <= remainingCents;
  const isFull = validAmount && requestedCents === remainingCents;
  const needsConfirm = isFull;
  const canSubmit = validAmount && !sending && (!needsConfirm || confirmText.trim().toUpperCase() === 'REFUND');

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSending(true);
    setError(null);
    try {
      const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
      const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET;
      if (!NOTIFY_URL || !NOTIFY_SECRET) { setError('Worker not configured.'); return; }
      const body: any = {
        registrationId: registration.id,
        amountCents: requestedCents,
        reason: detail.trim() ? `${reason}: ${detail.trim()}` : reason,
        actorUid,
        actorName,
      };
      const r = await fetch(`${NOTIFY_URL}/stripe/registration-refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${NOTIFY_SECRET}` },
        body: JSON.stringify(body),
      });
      const data: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data?.error === 'no-payment-intent' ? 'No online payment on file for this registration. Refund manually if needed.'
          : data?.error === 'club-not-stripe-ready' ? 'Club payments setup not complete. Refund manually.'
          : data?.error === 'fully-refunded' ? 'Already fully refunded.'
          : data?.error || 'Refund failed.';
        setError(msg);
        return;
      }
      onRefunded(data.refundId, data.amountCents);
    } catch (err: any) {
      setError(err?.message || 'Network error.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      open={true}
      onClose={onClose}
      kicker="Issue refund"
      title={`${registration.player.firstName} ${registration.player.lastName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={handleSubmit} disabled={!canSubmit} loading={sending}>
            Refund ${(requestedCents / 100).toFixed(2)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-line-default/[0.04] ring-1 ring-line-default/10 p-3 text-sm space-y-1">
          <div className="flex items-center justify-between"><span className="text-ink-primary/55">Original total</span><span className="font-bold text-ink-primary">${(originalCents / 100).toFixed(2)}</span></div>
          {alreadyRefunded > 0 && (
            <div className="flex items-center justify-between"><span className="text-ink-primary/55">Already refunded</span><span className="font-bold text-rose-300">-${(alreadyRefunded / 100).toFixed(2)}</span></div>
          )}
          <div className="flex items-center justify-between pt-1 border-t border-line-default/10"><span className="font-bold text-ink-primary">Remaining refundable</span><span className="font-black text-ink-primary tabular-nums">${(remainingCents / 100).toFixed(2)}</span></div>
        </div>

        <FormField
          label="Refund amount (USD)"
          error={!validAmount && requestedCents > remainingCents ? "Can't exceed remaining refundable." : null}
        >
          <div className="flex items-center gap-1">
            <span className="text-ink-primary/55 text-sm">$</span>
            <input
              type="number"
              step="0.01"
              min={0}
              max={remainingCents / 100}
              value={amountDollars}
              onChange={(e) => setAmountDollars(e.target.value)}
              className={`flex-1 ${fieldInputClass}`}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAmountDollars((remainingCents / 100).toFixed(2))}
            >
              Max
            </Button>
          </div>
        </FormField>

        <FormField label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value as any)} className={fieldInputClass}>
            {STRIPE_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </FormField>

        <FormField
          label="Detail"
          optional
          hint="Logged on the activity timeline. Not sent to the family."
        >
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Moved out of state mid-season"
            className={fieldInputClass}
          />
        </FormField>

        {needsConfirm && (
          <div className="rounded-lg bg-amber-500/10 ring-1 ring-amber-400/30 p-3">
            <p className="text-[11px] text-amber-200 font-bold mb-2">Full refund — type REFUND to confirm.</p>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="REFUND"
              className={`${fieldInputClass} uppercase tracking-wider font-bold`}
            />
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-rose-950/30 ring-1 ring-rose-700/40 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        )}
      </div>
    </Sheet>
  );
};

export default RefundModal;
