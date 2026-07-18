import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { collection, doc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import type { PaymentRequest, Player } from '../types';
import { intervalShort } from '../utils/paymentIntervals';
import { workerFetch } from '../utils/workerFetch';

/**
 * Coach Payment Detail — /coach/payments/:id
 *
 * Per-player status table for one_off + recurring. Purchase log for
 * catalog. Row-level actions: mark cash-paid, refund (Stripe rows).
 * Header actions: close / archive.
 */

const CoachPaymentDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();
  const [pr, setPr] = useState<PaymentRequest | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  useEffect(() => {
    if (!id) return;
    const unsub = onSnapshot(doc(db, 'payment_requests', id), (snap) => {
      if (snap.exists()) {
        const data: any = snap.data();
        setPr({
          id: snap.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || 0),
          updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt || 0),
        } as PaymentRequest);
      } else {
        setPr(null);
      }
      setLoaded(true);
    }, (err) => {
      console.warn('[coach-payment-detail] snapshot failed', err);
      setLoaded(true);
    });
    return () => unsub();
  }, [id]);

  useEffect(() => {
    if (!selectedTeamId) return;
    (async () => {
      try {
        const q = query(collection(db, 'players'), where('teamIds', 'array-contains', selectedTeamId));
        const snap = await getDocs(q);
        setPlayers(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => p.isActive !== false) as Player[]);
      } catch (err) {
        console.warn('[coach-payment-detail] roster load failed', err);
      }
    })();
  }, [selectedTeamId]);

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);

  const relevantPlayers = useMemo(() => {
    if (!pr) return [];
    if (pr.targetPlayerIds === 'all') return players;
    const targets = new Set(pr.targetPlayerIds);
    return players.filter(p => targets.has(p.id));
  }, [pr, players]);

  if (!coachOnThisTeam) return <Navigate to="/coach" replace />;

  if (!pr && loaded) {
    return (
      <div className="min-h-screen bg-surface-base">
        <Header title="Payment" subtitle="" />
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 text-center">
          <p className="text-ink-primary/70">This payment could not be loaded.</p>
          <Link to="/coach/payments" className="mt-4 inline-block text-brand-primary-soft text-xs font-black uppercase tracking-widest">&larr; Back</Link>
        </div>
      </div>
    );
  }

  const closeRequest = async (archive: boolean) => {
    if (!pr) return;
    if (!confirm(archive ? 'Archive this payment? Parents will stop seeing it.' : 'Close this payment? Live subscriptions keep charging until you cancel each one.')) return;
    setBusyKey('close');
    setErrMsg(null);
    try {
      const res = await workerFetch('/payments/close', {
        method: 'POST',
        body: JSON.stringify({ paymentRequestId: pr.id, archive }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) setErrMsg(data?.hint || data?.error || 'Could not close.');
    } finally { setBusyKey(null); }
  };

  const markCashUid = async (uid: string, paid: boolean) => {
    if (!pr) return;
    setBusyKey(`uid_${uid}`);
    setErrMsg(null);
    try {
      const res = await workerFetch('/payments/mark-paid-cash', {
        method: 'POST',
        body: JSON.stringify({ paymentRequestId: pr.id, uid, paid }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) setErrMsg(data?.hint || data?.error || 'Could not update.');
      else if (data.hint) alert(data.hint);
    } finally { setBusyKey(null); }
  };
  const markCashPlayer = async (playerId: string, paid: boolean) => {
    if (!pr) return;
    setBusyKey(`p_${playerId}`);
    setErrMsg(null);
    try {
      const res = await workerFetch('/payments/mark-paid-cash', {
        method: 'POST',
        body: JSON.stringify({ paymentRequestId: pr.id, playerId, paid }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) setErrMsg(data?.hint || data?.error || 'Could not update.');
      else if (data.hint) alert(data.hint);
    } finally { setBusyKey(null); }
  };
  const cancelSub = async (uid: string) => {
    if (!pr) return;
    if (!confirm('Cancel this subscription at the end of the current period?')) return;
    setBusyKey(`cancel_${uid}`);
    try {
      const res = await workerFetch('/payments/subscription-cancel', {
        method: 'POST',
        body: JSON.stringify({ paymentRequestId: pr.id, uid }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) setErrMsg(data?.error || 'Could not cancel.');
    } finally { setBusyKey(null); }
  };

  return (
    <div className="min-h-screen bg-surface-base">
      <Header
        title={pr?.title || 'Payment'}
        subtitle={selectedTeam ? selectedTeam.name : ''}
      />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        <Link to="/coach/payments" className="text-brand-primary-soft text-xs font-black uppercase tracking-widest hover:text-brand-primary">
          &larr; All payments
        </Link>

        {showProgress && !loaded && (
          <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full">
            <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
          </div>
        )}

        {pr && (
          <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0'}`}>
            {/* Summary card */}
            <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">
                    {pr.kind === 'one_off' ? 'One-time' : pr.kind === 'recurring' ? 'Recurring' : 'Team store'}
                  </p>
                  <h2 className="text-base font-black text-ink-primary leading-tight mt-0.5">{pr.title}</h2>
                  {pr.description && <p className="text-[12px] text-ink-primary/60 mt-1">{pr.description}</p>}
                </div>
                <div className="text-right shrink-0">
                  {pr.kind === 'one_off' && pr.feeCents != null && (
                    <p className="text-lg font-black text-ink-primary tabular-nums">${(pr.feeCents / 100).toFixed(2)}</p>
                  )}
                  {pr.kind === 'recurring' && pr.intervalCents != null && (
                    <p className="text-lg font-black text-ink-primary tabular-nums">
                      ${(pr.intervalCents / 100).toFixed(2)}
                      <span className="text-[11px] font-semibold text-ink-primary/60">{intervalShort(pr.interval || 'month')}</span>
                    </p>
                  )}
                </div>
              </div>
              {pr.status === 'active' ? (
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => closeRequest(false)}
                    disabled={busyKey === 'close'}
                    className="text-[11px] font-black uppercase tracking-widest text-ink-primary/70 hover:text-ink-primary transition"
                  >
                    Close
                  </button>
                  <span className="text-ink-primary/25">|</span>
                  <button
                    type="button"
                    onClick={() => closeRequest(true)}
                    disabled={busyKey === 'close'}
                    className="text-[11px] font-black uppercase tracking-widest text-ink-primary/70 hover:text-ink-primary transition"
                  >
                    Archive
                  </button>
                </div>
              ) : (
                <p className="text-[11px] font-black uppercase tracking-widest text-ink-primary/40 mt-2">{pr.status}</p>
              )}
            </section>

            {errMsg && (
              <p className="text-xs text-rose-400">{errMsg}</p>
            )}

            {/* Roster status table for one_off + recurring */}
            {(pr.kind === 'one_off' || pr.kind === 'recurring') && (
              <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft mb-3">
                  Who has paid
                </p>
                <div className="divide-y divide-line-default/10">
                  {relevantPlayers.length === 0 && (
                    <p className="text-[13px] text-ink-primary/60">No players match this request.</p>
                  )}
                  {relevantPlayers.map(p => {
                    const paidByCoachKids = new Set(pr.paidByCoachPlayerIds || []);
                    const paidByStripe = new Set(pr.paidUids || []);
                    const paidByCoachAdults = new Set(pr.paidByCoach || []);
                    const parents = (p as any).parentIds as string[] | undefined;
                    const paidStripe = (parents || []).some(u => paidByStripe.has(u));
                    const paidCash = paidByCoachKids.has(p.id) || (parents || []).some(u => paidByCoachAdults.has(u));
                    const subActive = pr.kind === 'recurring' && (parents || []).some(u => (pr.stripeSubscriptionIds || {})[u]);
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-ink-primary truncate">{p.name}</p>
                          <p className="text-[11px] text-ink-primary/55">
                            {paidStripe ? 'Paid via card' : paidCash ? 'Marked paid (cash)' : subActive ? 'Subscribed' : 'Unpaid'}
                          </p>
                        </div>
                        <div className="shrink-0 flex items-center gap-2">
                          {(pr.kind === 'one_off') && !paidStripe && !paidCash && (
                            <button
                              type="button"
                              onClick={() => markCashPlayer(p.id, true)}
                              disabled={busyKey === `p_${p.id}`}
                              className="px-3 py-1 rounded-full bg-line-default/[0.06] ring-1 ring-line-default/15 hover:ring-brand-primary/40 text-[11px] font-black uppercase tracking-widest text-ink-primary/70 hover:text-ink-primary transition"
                            >
                              Mark cash
                            </button>
                          )}
                          {(pr.kind === 'one_off') && paidCash && (
                            <button
                              type="button"
                              onClick={() => markCashPlayer(p.id, false)}
                              disabled={busyKey === `p_${p.id}`}
                              className="px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-widest text-ink-primary/50 hover:text-ink-primary transition"
                            >
                              Undo
                            </button>
                          )}
                          {pr.kind === 'recurring' && subActive && (parents || []).map(u =>
                            (pr.stripeSubscriptionIds || {})[u] ? (
                              <button
                                key={u}
                                type="button"
                                onClick={() => cancelSub(u)}
                                disabled={busyKey === `cancel_${u}`}
                                className="px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-widest text-ink-primary/50 hover:text-ink-primary transition"
                              >
                                Cancel
                              </button>
                            ) : null
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Catalog view — items + collected */}
            {pr.kind === 'catalog' && (
              <section className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
                <p className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft mb-3">
                  Store items
                </p>
                <div className="space-y-2">
                  {(pr.items || []).map(item => {
                    const sold = (pr.purchases || []).filter(p => p.itemId === item.id && !p.refundedAt);
                    const soldQty = sold.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
                    const soldCents = sold.reduce((sum, p) => sum + Number(p.chargedCents || 0), 0);
                    return (
                      <div key={item.id} className="flex items-center justify-between gap-3 py-1">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-ink-primary truncate">{item.name}</p>
                          <p className="text-[11px] text-ink-primary/55">${(item.priceCents / 100).toFixed(2)} · {soldQty} sold</p>
                        </div>
                        <p className="text-[13px] font-black text-ink-primary tabular-nums">${(soldCents / 100).toFixed(2)}</p>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CoachPaymentDetail;
