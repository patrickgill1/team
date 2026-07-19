import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { CatalogItem, PaymentRecurringInterval, PaymentRequest, Player } from '../../types';
import { workerFetch } from '../../utils/workerFetch';
import { intervalLabel } from '../../utils/paymentIntervals';

/**
 * Coach-side edit modal for an existing payment_request.
 *
 * Ship 1 decision #2 — the rules the modal enforces client-side
 * (mirrored server-side in worker /payments/update so a tampered
 * client can't sneak a change through):
 *   - Kind is never editable (recurring is not a store).
 *   - Amount + feeCoveredBy: LOCKED once ANY payment has landed
 *     (stripe, cash, subscription, guest). Would rebill or
 *     underbill an already-paid family.
 *   - Roster: add-only after payments land. Paid rows lose the
 *     delete button; unpaid rows keep it.
 *   - Title / description / dueDate: always editable.
 *
 * Warm inline warning tells the coach exactly why the fields are
 * locked ("Two families already paid $50 …") so it doesn't read as
 * a bug. Copy voice per feedback_copy_voice.md.
 */

export interface PaymentRequestEditModalProps {
  pr: PaymentRequest;
  onClose: () => void;
}

const PaymentRequestEditModal: React.FC<PaymentRequestEditModalProps> = ({ pr, onClose }) => {
  const [title, setTitle] = useState(pr.title || '');
  const [description, setDescription] = useState(pr.description || '');
  const [feeCoveredBy, setFeeCoveredBy] = useState<'player' | 'coach'>(pr.feeCoveredBy || 'player');
  const [feeDollars, setFeeDollars] = useState(
    pr.kind === 'one_off' && pr.feeCents ? (pr.feeCents / 100).toFixed(2) : ''
  );
  const [intervalDollars, setIntervalDollars] = useState(
    pr.kind === 'recurring' && pr.intervalCents ? (pr.intervalCents / 100).toFixed(2) : ''
  );
  const [intervalPick, setIntervalPick] = useState<PaymentRecurringInterval>(
    (pr.interval as PaymentRecurringInterval) || 'month'
  );
  const [items, setItems] = useState<CatalogItem[]>(pr.items || []);

  const [roster, setRoster] = useState<Player[]>([]);
  const [targetMode, setTargetMode] = useState<'all' | 'specific'>(
    pr.targetPlayerIds === 'all' ? 'all' : 'specific'
  );
  const [pickedIds, setPickedIds] = useState<Set<string>>(
    new Set(pr.targetPlayerIds === 'all' ? [] : (pr.targetPlayerIds || []))
  );

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const stripePaidUids = pr.paidUids || [];
  const cashPaidUids = pr.paidByCoach || [];
  const cashPaidPlayerIds = pr.paidByCoachPlayerIds || [];
  const stripeSubs = pr.stripeSubscriptionIds || {};
  const purchases = (pr.purchases || []).filter(p => !p.refundedAt);
  const guestPaid = pr.guestPaid || [];

  const paidCount =
    stripePaidUids.length +
    cashPaidUids.length +
    cashPaidPlayerIds.length +
    Object.keys(stripeSubs).length +
    purchases.length +
    guestPaid.length;
  const hasAnyPayment = paidCount > 0;

  // Ambient roster load so the picker + add-only lock use fresh
  // player rows (mirrors CoachPaymentCreate).
  useEffect(() => {
    if (!pr.teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const q = query(collection(db, 'players'), where('teamIds', 'array-contains', pr.teamId));
        const snap = await getDocs(q);
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false) as Player[];
        list.sort((a, b) => {
          const ja = a.jerseyNumber ?? 999;
          const jb = b.jerseyNumber ?? 999;
          if (ja !== jb) return ja - jb;
          return (a.name || '').localeCompare(b.name || '');
        });
        if (!cancelled) setRoster(list);
      } catch (e) {
        console.warn('[edit-payment] roster load failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [pr.teamId]);

  // Which player rows count as "already paid" — used to hide the
  // remove control after payments land. Union of:
  //   - kids the coach marked paid (playerId-scoped)
  //   - kids whose parent uid appears in paidUids OR paidByCoach
  //     (parent-scoped rows join back via parentIds)
  const paidPlayerIds = useMemo(() => {
    const out = new Set<string>();
    for (const pid of cashPaidPlayerIds) out.add(pid);
    const paidParentUids = new Set([...stripePaidUids, ...cashPaidUids, ...Object.keys(stripeSubs)]);
    if (paidParentUids.size === 0) return out;
    for (const p of roster) {
      const parents = (p as any).parentIds as string[] | undefined;
      if (parents && parents.some(u => paidParentUids.has(u))) out.add(p.id);
    }
    return out;
  }, [roster, cashPaidPlayerIds, stripePaidUids, cashPaidUids, stripeSubs]);

  const canRemoveTarget = (playerId: string): boolean => !hasAnyPayment || !paidPlayerIds.has(playerId);

  const feeCents = Math.round((Number(feeDollars) || 0) * 100);
  const intervalCents = Math.round((Number(intervalDollars) || 0) * 100);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: any = {
        paymentRequestId: pr.id,
        title: title.trim(),
        description: description.trim(),
      };
      if (!hasAnyPayment) {
        body.feeCoveredBy = feeCoveredBy;
        if (pr.kind === 'one_off') body.feeCents = feeCents;
        if (pr.kind === 'recurring') {
          body.intervalCents = intervalCents;
          body.interval = intervalPick;
        }
        if (pr.kind === 'catalog') {
          body.items = items
            .filter(i => i.name.trim() && i.priceCents > 0)
            .map(i => ({
              id: i.id,
              name: i.name.trim(),
              priceCents: i.priceCents,
              description: i.description,
              maxPerPlayer: i.maxPerPlayer,
              isActive: i.isActive !== false,
            }));
        }
      }
      body.targetPlayerIds =
        targetMode === 'all'
          ? 'all'
          : roster
              .map(p => p.id)
              .filter(id => pickedIds.has(id) || paidPlayerIds.has(id));
      const res = await workerFetch('/payments/update', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setErr(data?.hint || data?.error || 'Could not save.');
        setBusy(false);
        return;
      }
      onClose();
    } catch (e: any) {
      setErr(String(e?.message || e));
      setBusy(false);
    }
  };

  const priceLine = useMemo(() => {
    if (pr.kind === 'one_off') return pr.feeCents ? `$${(pr.feeCents / 100).toFixed(2)}` : '';
    if (pr.kind === 'recurring') return pr.intervalCents ? `$${(pr.intervalCents / 100).toFixed(2)} / ${intervalLabel(pr.interval || 'month')}` : '';
    return '';
  }, [pr]);

  return (
    <div className="fixed inset-0 z-50 bg-ink-primary/60 flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-2xl bg-surface-base rounded-2xl ring-1 ring-line-default/15 my-8">
        <div className="p-4 sm:p-5 border-b border-line-default/10 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">Edit payment</p>
            <h2 className="text-base font-black text-ink-primary mt-0.5 truncate">{pr.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-black uppercase tracking-widest text-ink-primary/50 hover:text-ink-primary transition"
          >
            Close
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          {hasAnyPayment && (
            <div className="rounded-xl bg-brand-primary/10 ring-1 ring-brand-primary/20 p-3">
              <p className="text-[13px] text-ink-primary/80 leading-snug">
                {paidCount === 1
                  ? `One family already paid${priceLine ? ` ${priceLine}` : ''}.`
                  : `${paidCount} families already paid${priceLine ? ` ${priceLine}` : ''}.`}{' '}
                Amount and fee coverage are locked so their receipts still match. You can still update the title, details, and add more players.
              </p>
            </div>
          )}

          <label className="block">
            <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Title</span>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">Details</span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none resize-none"
            />
          </label>

          {pr.kind === 'one_off' && (
            <label className="block">
              <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">
                Amount per player {hasAnyPayment && <span className="text-ink-primary/40">(locked)</span>}
              </span>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-ink-primary/60 font-black">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="1"
                  value={feeDollars}
                  onChange={e => setFeeDollars(e.target.value)}
                  disabled={hasAnyPayment}
                  className="flex-1 px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none disabled:opacity-50"
                />
              </div>
            </label>
          )}

          {pr.kind === 'recurring' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">
                  Amount {hasAnyPayment && <span className="text-ink-primary/40">(locked)</span>}
                </span>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-ink-primary/60 font-black">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="1"
                    value={intervalDollars}
                    onChange={e => setIntervalDollars(e.target.value)}
                    disabled={hasAnyPayment}
                    className="flex-1 px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none disabled:opacity-50"
                  />
                </div>
              </label>
              <label className="block">
                <span className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">
                  Cycle {hasAnyPayment && <span className="text-ink-primary/40">(locked)</span>}
                </span>
                <select
                  value={intervalPick}
                  onChange={e => setIntervalPick(e.target.value as PaymentRecurringInterval)}
                  disabled={hasAnyPayment}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/20 focus:ring-brand-primary/50 text-ink-primary text-sm outline-none disabled:opacity-50"
                >
                  <option value="week">Every week</option>
                  <option value="month">Every month</option>
                  <option value="season">Every season (4 mo)</option>
                  <option value="year">Every year</option>
                </select>
              </label>
            </div>
          )}

          {pr.kind === 'catalog' && (
            <div className="space-y-2">
              <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60">
                Items {hasAnyPayment && <span className="text-ink-primary/40 normal-case tracking-normal">(locked while shoppers have carts through)</span>}
              </p>
              {items.map((item, idx) => (
                <div key={item.id} className="rounded-xl bg-surface-elevated ring-1 ring-line-default/15 p-3 space-y-2">
                  <input
                    type="text"
                    value={item.name}
                    onChange={e => setItems(items.map((it, i) => i === idx ? { ...it, name: e.target.value } : it))}
                    disabled={hasAnyPayment}
                    className="w-full px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/15 text-ink-primary text-sm outline-none disabled:opacity-50"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-ink-primary/60 font-black">$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="1"
                      value={item.priceCents ? (item.priceCents / 100).toString() : ''}
                      onChange={e => setItems(items.map((it, i) => i === idx ? { ...it, priceCents: Math.round((Number(e.target.value) || 0) * 100) } : it))}
                      disabled={hasAnyPayment}
                      className="flex-1 px-3 py-2 rounded-lg bg-surface-base ring-1 ring-line-default/15 text-ink-primary text-sm outline-none disabled:opacity-50"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {(pr.kind === 'one_off' || pr.kind === 'recurring') && (
            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4">
              <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-2">
                Who covers the processing fee? {hasAnyPayment && <span className="text-ink-primary/40 normal-case tracking-normal">(locked)</span>}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={hasAnyPayment}
                  onClick={() => setFeeCoveredBy('player')}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition disabled:opacity-50 ${
                    feeCoveredBy === 'player'
                      ? 'bg-brand-primary text-white'
                      : 'bg-line-default/[0.05] text-ink-primary/60 hover:text-ink-primary'
                  }`}
                >
                  Player
                </button>
                <button
                  type="button"
                  disabled={hasAnyPayment}
                  onClick={() => setFeeCoveredBy('coach')}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition disabled:opacity-50 ${
                    feeCoveredBy === 'coach'
                      ? 'bg-brand-primary text-white'
                      : 'bg-line-default/[0.05] text-ink-primary/60 hover:text-ink-primary'
                  }`}
                >
                  You
                </button>
              </div>
            </div>
          )}

          <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4">
            <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/60 mb-2">Who is this for?</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTargetMode('all')}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition ${
                  targetMode === 'all'
                    ? 'bg-brand-primary text-white'
                    : 'bg-line-default/[0.05] text-ink-primary/60 hover:text-ink-primary'
                }`}
              >
                Everyone
              </button>
              <button
                type="button"
                onClick={() => {
                  setTargetMode('specific');
                  if (pickedIds.size === 0) {
                    setPickedIds(new Set(roster.map(p => p.id)));
                  }
                }}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition ${
                  targetMode === 'specific'
                    ? 'bg-brand-primary text-white'
                    : 'bg-line-default/[0.05] text-ink-primary/60 hover:text-ink-primary'
                }`}
              >
                Pick specific players
              </button>
            </div>

            {targetMode === 'specific' && (
              <div className="mt-3 space-y-2">
                {hasAnyPayment && (
                  <p className="text-[12px] text-ink-primary/60 leading-snug">
                    Paid families stay in for their receipts. Add more players anytime.
                  </p>
                )}
                <ul className="divide-y divide-line-default/10 rounded-xl bg-surface-base ring-1 ring-line-default/15 max-h-72 overflow-y-auto">
                  {roster.map(p => {
                    const checked = pickedIds.has(p.id) || paidPlayerIds.has(p.id);
                    const locked = !canRemoveTarget(p.id);
                    return (
                      <li key={p.id}>
                        <label className={`flex items-center gap-3 p-2 sm:p-3 select-none ${locked ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer hover:bg-line-default/[0.04]'}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={locked}
                            onChange={e => {
                              setPickedIds(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(p.id);
                                else next.delete(p.id);
                                return next;
                              });
                            }}
                            className="w-4 h-4 accent-brand-primary rounded shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-black text-ink-primary truncate">{p.name}</p>
                            {locked && (
                              <p className="text-[11px] text-brand-primary-soft">Already paid</p>
                            )}
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {err && <p className="text-xs text-rose-400">{err}</p>}

          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-lg bg-line-default/[0.06] ring-1 ring-line-default/15 text-ink-primary text-xs font-black uppercase tracking-widest hover:ring-brand-primary/30 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !title.trim()}
              className="flex-1 py-3 rounded-lg bg-brand-primary text-white text-xs font-black uppercase tracking-widest hover:bg-brand-primary/90 transition disabled:opacity-50"
            >
              {busy ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PaymentRequestEditModal;
