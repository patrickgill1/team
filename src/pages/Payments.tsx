import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import Header from '../components/common/Header';
import type { PaymentRequest, Player } from '../types';
import { intervalShort } from '../utils/paymentIntervals';
import { workerFetch } from '../utils/workerFetch';
import { grossUpCents } from '../utils/pricing';

/**
 * Parent Payments — /payments
 *
 * Outstanding + history across every team the family is on. Groups by
 * team, but each row keys off the payment_request directly. Renders
 * atomic (silence -> hint -> fade) per feedback_atomic_render_over_skeletons.
 */

const Payments: React.FC = () => {
  const { userData } = useAuth();
  const [players, setPlayers] = useState<Player[]>([]);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  // Load the parent's kids so we know team scope + how many kids per team.
  useEffect(() => {
    if (!userData?.uid) return;
    const q = query(collection(db, 'players'), where('parentIds', 'array-contains', userData.uid));
    const unsub = onSnapshot(q, (snap) => {
      setPlayers(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Player[]);
    });
    return () => unsub();
  }, [userData?.uid]);

  // Load payment_requests for any of the parent's teams.
  useEffect(() => {
    const teamIds = Array.from(new Set(players.flatMap(p => (p as any).teamIds || []))) as string[];
    if (teamIds.length === 0) { setLoaded(true); return; }
    const unsubs: Array<() => void> = [];
    const bag: Record<string, PaymentRequest> = {};
    // Firestore `in` supports up to 30, but we chunk defensively at 10.
    const chunks: string[][] = [];
    for (let i = 0; i < teamIds.length; i += 10) chunks.push(teamIds.slice(i, i + 10));
    for (const chunk of chunks) {
      const q = query(
        collection(db, 'payment_requests'),
        where('teamId', 'in', chunk),
        orderBy('createdAt', 'desc'),
      );
      const unsub = onSnapshot(q, (snap) => {
        for (const d of snap.docs) {
          const data: any = d.data();
          bag[d.id] = {
            id: d.id,
            ...data,
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || 0),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt || 0),
          } as PaymentRequest;
        }
        setRequests(Object.values(bag));
        setLoaded(true);
      }, () => setLoaded(true));
      unsubs.push(unsub);
    }
    return () => unsubs.forEach(u => u());
  }, [players.map(p => p.id).join(',')]);

  // Compute outstanding rows for each request the parent hasn't paid.
  const rows = useMemo(() => {
    if (!userData?.uid) return { outstanding: [], history: [] };
    const uid = userData.uid;
    const outstanding: Array<{ pr: PaymentRequest; kidsOnRequest: Player[]; paid: boolean; subscribed: boolean }> = [];
    const history: Array<{ pr: PaymentRequest; paidVia: 'card' | 'cash'; }> = [];
    for (const pr of requests) {
      const kidsOnTeam = players.filter(p => ((p as any).teamIds || []).includes(pr.teamId));
      const kidsOnRequest = pr.targetPlayerIds === 'all'
        ? kidsOnTeam
        : kidsOnTeam.filter(p => (pr.targetPlayerIds as string[]).includes(p.id));
      if (kidsOnRequest.length === 0) continue;
      const paidViaStripe = (pr.paidUids || []).includes(uid);
      const paidByCoach = (pr.paidByCoach || []).includes(uid)
        || kidsOnRequest.some(k => (pr.paidByCoachPlayerIds || []).includes(k.id));
      const subscribed = pr.kind === 'recurring' && !!(pr.stripeSubscriptionIds || {})[uid];
      if (pr.status !== 'active' || pr.isActive === false) {
        if (paidViaStripe) history.push({ pr, paidVia: 'card' });
        else if (paidByCoach) history.push({ pr, paidVia: 'cash' });
        continue;
      }
      if (pr.kind === 'catalog') {
        // Catalog rows always show as "shop" until closed. Never in
        // outstanding-vs-paid because a catalog has no fixed obligation.
        outstanding.push({ pr, kidsOnRequest, paid: false, subscribed: false });
        continue;
      }
      if (paidViaStripe || paidByCoach || subscribed) {
        history.push({ pr, paidVia: paidViaStripe ? 'card' : 'cash' });
        continue;
      }
      outstanding.push({ pr, kidsOnRequest, paid: false, subscribed: false });
    }
    return { outstanding, history };
  }, [requests, players, userData?.uid]);

  const goCheckout = async (pr: PaymentRequest, kids: Player[]) => {
    setBusyId(pr.id);
    try {
      const path = pr.kind === 'recurring' ? '/payments/subscription-checkout' : '/payments/checkout';
      const body: any = {
        paymentRequestId: pr.id,
        uid: userData?.uid,
        customerEmail: userData?.email,
      };
      if (pr.kind === 'one_off') body.playerIds = kids.map(k => k.id);
      const res = await workerFetch(path, { method: 'POST', body: JSON.stringify(body) });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        alert(data?.hint || data?.error || 'Could not start checkout.');
        return;
      }
      window.location.href = data.url;
    } catch (err: any) {
      alert(String(err?.message || err));
    } finally { setBusyId(null); }
  };

  return (
    <div className="min-h-screen bg-surface-base">
      <Header title="Payments" subtitle="For your family" />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        {showProgress && !loaded && (
          <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full">
            <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
          </div>
        )}
        <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0'}`}>
          {loaded && rows.outstanding.length === 0 && rows.history.length === 0 && (
            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 text-center">
              <p className="text-ink-primary/85 font-black text-sm">Nothing to pay right now.</p>
              <p className="text-ink-primary/55 text-xs mt-1">Your coaches have not opened any collections. You are all caught up.</p>
            </div>
          )}

          {rows.outstanding.length > 0 && (
            <section>
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-2">Outstanding</p>
              <div className="space-y-2">
                {rows.outstanding.map(row => (
                  <div key={row.pr.id} className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-4 sm:p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-ink-primary">{row.pr.title}</p>
                        {row.pr.description && (
                          <p className="text-[12px] text-ink-primary/60 mt-1 leading-snug">{row.pr.description}</p>
                        )}
                        <p className="text-[11px] text-ink-primary/50 mt-1">
                          Coach {row.pr.createdByName}
                          {row.kidsOnRequest.length > 1 ? ` · ${row.kidsOnRequest.length} kids` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        {row.pr.kind === 'one_off' && row.pr.feeCents != null && (
                          <p className="text-base font-black text-ink-primary tabular-nums">
                            ${(row.pr.feeCoveredBy === 'player'
                              ? grossUpCents(row.pr.feeCents) * row.kidsOnRequest.length
                              : row.pr.feeCents * row.kidsOnRequest.length) / 100}
                          </p>
                        )}
                        {row.pr.kind === 'recurring' && row.pr.intervalCents != null && (
                          <p className="text-base font-black text-ink-primary tabular-nums">
                            ${(row.pr.feeCoveredBy === 'player'
                              ? grossUpCents(row.pr.intervalCents)
                              : row.pr.intervalCents) / 100}
                            <span className="text-[11px] font-semibold text-ink-primary/60">{intervalShort(row.pr.interval || 'month')}</span>
                          </p>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => goCheckout(row.pr, row.kidsOnRequest)}
                      disabled={busyId === row.pr.id}
                      className="mt-3 w-full py-2.5 rounded-lg bg-brand-primary text-white text-sm font-black uppercase tracking-widest hover:bg-brand-primary/90 transition disabled:opacity-50"
                    >
                      {busyId === row.pr.id
                        ? 'Opening...'
                        : row.pr.kind === 'recurring'
                          ? 'Subscribe'
                          : row.pr.kind === 'catalog'
                            ? 'Shop the store'
                            : 'Pay now'}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {rows.history.length > 0 && (
            <section>
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/50 mb-2 mt-4">History</p>
              <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 divide-y divide-line-default/10">
                {rows.history.map(row => (
                  <div key={row.pr.id} className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="text-sm font-black text-ink-primary truncate">{row.pr.title}</p>
                      <p className="text-[11px] text-ink-primary/55">
                        {row.paidVia === 'card' ? 'Paid via card' : `Coach ${row.pr.createdByName} marked you paid`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <p className="text-[11px] text-ink-primary/45 mt-4 text-center">
            Payments run through Stripe. Coaches never see your card details.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Payments;
