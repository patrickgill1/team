import React, { useEffect, useMemo, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { logActivity } from '../../utils/activityLog';
import type { Installment, Registration } from '../../types';

// Splits a Registration into N installments with auto-distributed
// amounts + due dates. Admin can override any row before saving. Once
// saved, the Payments tab shows per-installment payment links and
// Mark Paid / Waive actions, and the Stripe checkout for each pulls
// just that installment's amount.

interface Props {
  registration: Registration;
  actorUid: string;
  actorName: string;
  onClose: () => void;
  onSaved: () => void;
}

const MIN_INSTALLMENTS = 2;
const MAX_INSTALLMENTS = 12;

interface Draft {
  id: string;
  amountDollars: string;
  label: string;
  dueDate: string; // yyyy-mm-dd
}

const SplitInvoiceModal: React.FC<Props> = ({ registration, actorUid, actorName, onClose, onSaved }) => {
  const totalCents = (registration.amountPaidCents ?? registration.registrationFeeCents ?? 0)
    + (registration.stripeSurchargeCents || 0);
  const existing = registration.installments || [];

  const [count, setCount] = useState<number>(existing.length || 2);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-fill drafts when count changes or on first open. Preserves
  // edits to surviving rows; appends fresh defaults for new ones.
  useEffect(() => {
    setDrafts(prev => {
      const next: Draft[] = [];
      const perCents = Math.floor(totalCents / count);
      const remainder = totalCents - perCents * count;
      const today = new Date();
      const monthOffset = (i: number) => {
        const d = new Date(today);
        d.setMonth(d.getMonth() + i);
        return d.toISOString().slice(0, 10);
      };
      for (let i = 0; i < count; i++) {
        const existingRow = prev[i];
        // Distribute remainder cents into the FIRST installment so
        // totals always reconcile exactly.
        const defaultCents = perCents + (i === 0 ? remainder : 0);
        next.push({
          id: existingRow?.id || `inst_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          amountDollars: existingRow?.amountDollars ?? (defaultCents / 100).toFixed(2),
          label: existingRow?.label ?? (count === 2 ? (i === 0 ? 'Deposit' : 'Balance') : `Installment ${i + 1}`),
          dueDate: existingRow?.dueDate ?? monthOffset(i),
        });
      }
      return next;
    });
  }, [count, totalCents]);

  // Seed from existing installments on first mount.
  useEffect(() => {
    if (existing.length > 0) {
      setDrafts(existing.map(i => ({
        id: i.id,
        amountDollars: ((i.amountCents || 0) / 100).toFixed(2),
        label: i.label || '',
        dueDate: i.dueDate ? toDateInput(i.dueDate) : '',
      })));
      setCount(existing.length);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateDraft = (i: number, patch: Partial<Draft>) => {
    setDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, ...patch } : d));
  };

  const computedTotal = useMemo(
    () => drafts.reduce((sum, d) => sum + Math.round(Number(d.amountDollars || 0) * 100), 0),
    [drafts],
  );
  const reconciles = computedTotal === totalCents;
  const validLabels = drafts.every(d => d.label.trim());
  const canSave = reconciles && validLabels && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const next: Installment[] = drafts.map((d, idx) => {
        // Preserve status from any existing installment with the same id.
        const old = existing.find(e => e.id === d.id);
        return {
          id: d.id,
          amountCents: Math.round(Number(d.amountDollars) * 100),
          label: d.label.trim() || `Installment ${idx + 1}`,
          dueDate: d.dueDate ? new Date(d.dueDate) : undefined,
          status: old?.status || 'pending',
          paidAt: old?.paidAt,
          stripeCheckoutSessionId: old?.stripeCheckoutSessionId,
          stripePaymentIntentId: old?.stripePaymentIntentId,
          waivedAt: old?.waivedAt,
          waivedBy: old?.waivedBy,
          waivedByName: old?.waivedByName,
          waivedReason: old?.waivedReason,
        };
      });
      await updateDoc(doc(db, 'registrations', registration.id), {
        installments: next,
        updatedAt: serverTimestamp(),
      });
      await logActivity({
        clubId: registration.clubId,
        kind: 'installments_split',
        registrationId: registration.id,
        seasonId: registration.seasonId,
        actorUid,
        actorName,
        payload: {
          count: next.length,
          totalCents,
          labels: next.map(i => i.label),
        },
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const anyLocked = existing.some(i => i.status === 'paid' || i.status === 'waived');

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-black text-fire-950">{existing.length ? 'Edit payment plan' : 'Split into installments'}</h2>
            <p className="text-[11px] text-slate-500">
              {registration.player.firstName} {registration.player.lastName} · total ${(totalCents / 100).toFixed(2)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {anyLocked && (
            <div className="rounded-lg bg-amber-50 ring-1 ring-amber-300 px-3 py-2 text-[11px] text-amber-900">
              Some installments are already paid or waived. Editing here will overwrite the schedule — paid/waived state is preserved by row id, but be careful adjusting amounts on collected installments.
            </div>
          )}

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Number of installments</span>
            <input
              type="number"
              min={MIN_INSTALLMENTS}
              max={MAX_INSTALLMENTS}
              value={count}
              onChange={(e) => {
                const n = Math.max(MIN_INSTALLMENTS, Math.min(MAX_INSTALLMENTS, Number(e.target.value) || MIN_INSTALLMENTS));
                setCount(n);
              }}
              className="w-24 px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-cyan-400 text-sm"
            />
          </label>

          <div className="space-y-2">
            {drafts.map((d, i) => (
              <div key={d.id} className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3 grid grid-cols-3 gap-2">
                <input
                  value={d.label}
                  onChange={(e) => updateDraft(i, { label: e.target.value })}
                  placeholder={`Installment ${i + 1}`}
                  className="col-span-3 sm:col-span-1 px-2.5 py-1.5 rounded-md ring-1 ring-slate-200 text-sm font-bold"
                />
                <div className="flex items-center gap-1 sm:col-span-1">
                  <span className="text-xs text-slate-500">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={d.amountDollars}
                    onChange={(e) => updateDraft(i, { amountDollars: e.target.value })}
                    className="w-full px-2.5 py-1.5 rounded-md ring-1 ring-slate-200 text-sm"
                  />
                </div>
                <input
                  type="date"
                  value={d.dueDate}
                  onChange={(e) => updateDraft(i, { dueDate: e.target.value })}
                  className="sm:col-span-1 px-2.5 py-1.5 rounded-md ring-1 ring-slate-200 text-sm"
                />
              </div>
            ))}
          </div>

          <div className={`rounded-xl p-3 text-sm flex items-center justify-between ${reconciles ? 'bg-emerald-50 ring-1 ring-emerald-200 text-emerald-800' : 'bg-rose-50 ring-1 ring-rose-300 text-rose-700'}`}>
            <span className="text-[11px] font-extrabold uppercase tracking-widest">Sum vs. registration total</span>
            <span className="font-black tabular-nums">
              ${(computedTotal / 100).toFixed(2)} / ${(totalCents / 100).toFixed(2)}
              {!reconciles && <span className="ml-2 text-[11px]">(off by ${Math.abs(computedTotal - totalCents) / 100})</span>}
            </span>
          </div>

          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="button" disabled={!canSave} onClick={handleSave} className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : existing.length ? 'Update plan' : 'Create plan'}
          </button>
        </div>
      </div>
    </div>
  );
};

function toDateInput(v: any): string {
  if (!v) return '';
  const d = v instanceof Date ? v : (v?.toDate?.() || new Date(v));
  if (isNaN(d.getTime?.())) return '';
  return d.toISOString().slice(0, 10);
}

export default SplitInvoiceModal;
