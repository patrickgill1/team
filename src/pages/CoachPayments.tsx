import React, { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoachOfTeam } from '../utils/helpers';
import Header from '../components/common/Header';
import type { PaymentRequest } from '../types';
import { intervalShort } from '../utils/paymentIntervals';
import { useTeamClubStripeStatus } from '../hooks/useTeamClubStripeStatus';
import StripeConnectBanner from '../components/coach/StripeConnectBanner';

/**
 * Coach Payments — /coach/payments
 *
 * Coach-owned view of every payment_request on the selected team.
 * Three payment kinds share this list (one_off / recurring / catalog),
 * discriminated by row-level meta. Tabs split Active vs Archive so a
 * long-running team doesn't drown in old rows.
 *
 * Atomic-render pattern (per feedback_atomic_render_over_skeletons):
 * silence for 400ms → progress hint → fade-in the list. No skeletons.
 */

const CoachPayments: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeam, selectedTeamId } = useTeam();
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [tab, setTab] = useState<'active' | 'archive'>('active');

  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  useEffect(() => {
    if (!selectedTeamId) { setLoaded(true); return; }
    const q = query(
      collection(db, 'payment_requests'),
      where('teamId', '==', selectedTeamId),
      orderBy('createdAt', 'desc'),
    );
    const unsub = onSnapshot(q, (snap) => {
      const rows: PaymentRequest[] = snap.docs.map(d => {
        const data: any = d.data();
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || 0),
          updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt || 0),
        } as PaymentRequest;
      });
      setRequests(rows);
      setLoaded(true);
    }, (err) => {
      console.warn('[coach-payments] snapshot failed', err);
      setLoaded(true);
    });
    return () => unsub();
  }, [selectedTeamId]);

  const coachOnThisTeam = isCoachOfTeam(userData as any, selectedTeam as any);
  const { clubId: stripeClubId, isReady: stripeIsReady, isLoading: stripeStatusLoading } = useTeamClubStripeStatus();

  const filtered = useMemo(() => {
    return requests.filter(r => {
      if (tab === 'active') return r.status === 'active';
      return r.status === 'closed' || r.status === 'archived';
    });
  }, [requests, tab]);

  if (!coachOnThisTeam) {
    return <Navigate to="/coach" replace />;
  }

  return (
    <div className="min-h-screen bg-surface-base">
      <Header
        title="Team Payments"
        subtitle={selectedTeam ? selectedTeam.name : 'No team selected'}
      />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex rounded-full bg-line-default/[0.06] ring-1 ring-line-default/15 p-1">
            <button
              type="button"
              onClick={() => setTab('active')}
              className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest transition ${
                tab === 'active'
                  ? 'bg-brand-primary text-white'
                  : 'text-ink-primary/60 hover:text-ink-primary'
              }`}
            >
              Active
            </button>
            <button
              type="button"
              onClick={() => setTab('archive')}
              className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest transition ${
                tab === 'archive'
                  ? 'bg-brand-primary text-white'
                  : 'text-ink-primary/60 hover:text-ink-primary'
              }`}
            >
              Archive
            </button>
          </div>
          <Link
            to="/coach/payments/new"
            className="px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-black uppercase tracking-widest hover:bg-brand-primary/90 transition"
          >
            New
          </Link>
        </div>

        {showProgress && !loaded && (
          <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full">
            <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
          </div>
        )}

        <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          {/* Empty-state area waits on BOTH the list snapshot and the Stripe
              status resolve. Otherwise the plain "Nothing to collect yet"
              card renders for a tick and then swaps to the Connect banner
              once the club fetch settles — a visible flicker on the Active
              tab. Ref: verifier finding #1 (2026-07-18). */}
          {loaded && !stripeStatusLoading && filtered.length === 0 && tab === 'active' && !stripeIsReady && (
            <StripeConnectBanner clubId={stripeClubId} returnTo="/coach/payments" />
          )}
          {loaded && !stripeStatusLoading && filtered.length === 0 && (tab !== 'active' || stripeIsReady) && (
            <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 p-6 text-center">
              <p className="text-ink-primary/85 font-black text-sm">Nothing to collect yet.</p>
              <p className="text-ink-primary/55 text-xs mt-1">
                {tab === 'active'
                  ? 'Set up your first payment when you are ready.'
                  : 'Closed and archived payments will show up here.'}
              </p>
              {tab === 'active' && (
                <Link
                  to="/coach/payments/new"
                  className="inline-block mt-4 px-4 py-2 rounded-lg bg-brand-primary text-white text-xs font-black uppercase tracking-widest hover:bg-brand-primary/90 transition"
                >
                  Set one up
                </Link>
              )}
            </div>
          )}
          <div className="space-y-2">
            {filtered.map(r => (
              <PaymentRow key={r.id} r={r} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const PaymentRow: React.FC<{ r: PaymentRequest }> = ({ r }) => {
  const summary = useMemo(() => {
    if (r.kind === 'one_off') {
      const paidCount = (r.paidUids?.length || 0)
        + (r.paidByCoach?.length || 0)
        + (r.paidByCoachPlayerIds?.length || 0)
        + (r.guestPaid?.length || 0);
      const targetSize = r.targetPlayerIds === 'all' ? undefined : r.targetPlayerIds.length;
      return {
        badge: 'One-time',
        price: r.feeCents ? `$${(r.feeCents / 100).toFixed(2)}` : '',
        detail: targetSize
          ? `${paidCount} of ${targetSize} paid`
          : `${paidCount} paid`,
      };
    }
    if (r.kind === 'recurring') {
      const active = Object.keys(r.stripeSubscriptionIds || {}).length;
      return {
        badge: 'Recurring',
        price: r.intervalCents ? `$${(r.intervalCents / 100).toFixed(2)}${intervalShort(r.interval || 'month')}` : '',
        detail: `${active} subscriber${active === 1 ? '' : 's'}`,
      };
    }
    // catalog
    const collected = (r.purchases || [])
      .filter(p => !p.refundedAt)
      .reduce((sum, p) => sum + Number(p.chargedCents || 0), 0);
    return {
      badge: 'Team store',
      price: `$${(collected / 100).toFixed(2)} collected`,
      detail: `${(r.items || []).length} item${(r.items || []).length === 1 ? '' : 's'}`,
    };
  }, [r]);

  return (
    <Link
      to={`/coach/payments/${r.id}`}
      className="block rounded-2xl bg-surface-elevated ring-1 ring-line-default/15 hover:ring-brand-primary/30 transition p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">{summary.badge}</span>
            {r.status !== 'active' && (
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/40">{r.status}</span>
            )}
          </div>
          <p className="text-sm font-black text-ink-primary leading-tight">{r.title}</p>
          <p className="text-[11px] text-ink-primary/55 mt-1">{summary.detail}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-black text-ink-primary tabular-nums">{summary.price}</p>
        </div>
      </div>
    </Link>
  );
};

export default CoachPayments;
