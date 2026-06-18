import React, { useState } from 'react';
import type { Registration } from '../../types';

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
        const msg = data?.error === 'no-payment-intent' ? 'No Stripe payment on file for this registration. Refund manually if needed.'
          : data?.error === 'club-not-stripe-ready' ? 'Club Stripe Connect setup not complete. Refund manually.'
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
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-black text-charcoal-950">Issue refund</h2>
            <p className="text-[11px] text-slate-500">{registration.player.firstName} {registration.player.lastName}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3 text-sm space-y-1">
            <div className="flex items-center justify-between"><span className="text-slate-500">Original total</span><span className="font-bold">${(originalCents / 100).toFixed(2)}</span></div>
            {alreadyRefunded > 0 && (
              <div className="flex items-center justify-between"><span className="text-slate-500">Already refunded</span><span className="font-bold text-rose-700">-${(alreadyRefunded / 100).toFixed(2)}</span></div>
            )}
            <div className="flex items-center justify-between pt-1 border-t border-slate-200"><span className="font-bold text-slate-700">Remaining refundable</span><span className="font-black tabular-nums">${(remainingCents / 100).toFixed(2)}</span></div>
          </div>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Refund amount (USD)</span>
            <div className="flex items-center gap-1">
              <span className="text-slate-500 text-sm">$</span>
              <input
                type="number"
                step="0.01"
                min={0}
                max={remainingCents / 100}
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-rose-400 text-sm"
              />
              <button
                type="button"
                onClick={() => setAmountDollars((remainingCents / 100).toFixed(2))}
                className="px-2 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-600 hover:text-slate-900"
              >
                Max
              </button>
            </div>
            {!validAmount && requestedCents > remainingCents && (
              <p className="text-[11px] text-rose-700 mt-1">Can't exceed remaining refundable.</p>
            )}
          </label>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Reason</span>
            <select value={reason} onChange={(e) => setReason(e.target.value as any)} className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-rose-400 text-sm">
              {STRIPE_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Detail (optional)</span>
            <input
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Moved out of state mid-season"
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-rose-400 text-sm"
            />
            <p className="text-[10px] text-slate-500 mt-1">Logged on the activity timeline. Not sent to the family.</p>
          </label>

          {needsConfirm && (
            <div className="rounded-lg bg-amber-50 ring-1 ring-amber-300 p-3">
              <p className="text-[11px] text-amber-900 font-bold mb-2">Full refund — type REFUND to confirm.</p>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="REFUND"
                className="w-full px-3 py-2 rounded-lg ring-1 ring-amber-300 focus:ring-2 focus:ring-amber-400 text-sm uppercase tracking-wider font-bold"
              />
            </div>
          )}

          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-sm font-bold"
          >
            {sending ? 'Refunding…' : `Refund $${(requestedCents / 100).toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RefundModal;
