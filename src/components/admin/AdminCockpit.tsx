// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getCountFromServer, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';

// Admin cockpit strip — renders at the top of the Dashboard when the
// current user is a club admin. Patrick 2026-06-21: 'what about the
// people who are admins for the club, who don't have kids playing, they
// are the ones handling the logistics, the paperwork, making sure the
// teams get activated, people pay and have nothing to do with practices,
// games or player stats? what do they see on their dashboard?'
//
// The cockpit answers ONE question: 'what needs my attention today?'
// Three pending-action chips with counts. Each chip taps to the
// canonical page where that pending work lives. Counts only — no
// detail render at the cockpit level.
//
// Multi-role users (admin + coach + parent — Patrick's own profile)
// see this strip ABOVE the existing dashboard. We never strip the
// coach/parent context from a multi-role user; we add to it.
//
// Visibility gate: caller passes `isClubAdmin` as a prop. Dashboard
// reads userData.isClubAdmin and renders <AdminCockpit/> only when
// true. Component itself doesn't read auth — keeps it dumb and
// testable.

interface Counts {
  pendingRegistrations: number;
  outstandingPayments: number;
  teamsToActivate: number;
}

const ZERO: Counts = { pendingRegistrations: 0, outstandingPayments: 0, teamsToActivate: 0 };

const AdminCockpit: React.FC = () => {
  const [counts, setCounts] = useState<Counts>(ZERO);
  const [loaded, setLoaded] = useState(false);
  const [showProgress, setShowProgress] = useState(false);

  // Atomic-render pattern: silent until counts arrive, slim progress
  // hint after 400ms, then fade in. Per feedback memory
  // 'atomic-render-over-skeletons.md'.
  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Three lightweight count() queries instead of full reads.
        // Each one is a single round-trip; Firestore returns just the
        // count (not the docs), so the cockpit stays cheap even on
        // clubs with thousands of registrations.
        //
        // PENDING REGISTRATIONS: status in the not-yet-converted set.
        // 'in' max 10 values; we have 3.
        const pendingRegsQ = query(
          collection(db, 'registrations'),
          where('status', 'in', ['pending_payment', 'tryout_invited', 'offer_sent'])
        );
        // OUTSTANDING PAYMENTS: a strict subset of pending — only the
        // ones where the family registered + was invoiced but hasn't
        // paid. This is the row admin chases on dues day.
        const outstandingQ = query(
          collection(db, 'registrations'),
          where('status', '==', 'pending_payment')
        );
        // TEAMS TO ACTIVATE: every team still in active rotation
        // (isActive !== false) that doesn't yet have a stamp on
        // funnelProgress.activated. Can't express 'missing nested map
        // field' as a Firestore where() filter, so we fetch the
        // active team docs (small collection — typically < 50 per
        // club) and count un-activated client-side. Trivial cost.
        const activeTeamsQ = query(collection(db, 'teams'), where('isActive', '==', true));

        const [pendingRegs, outstanding, activeTeamsSnap] = await Promise.all([
          getCountFromServer(pendingRegsQ),
          getCountFromServer(outstandingQ),
          getDocs(activeTeamsQ),
        ]);

        if (cancelled) return;
        const teamsToActivate = activeTeamsSnap.docs.filter((d) => {
          const fp = (d.data() as any)?.funnelProgress;
          return !fp?.activated?.completedAt;
        }).length;
        setCounts({
          pendingRegistrations: pendingRegs.data().count,
          outstandingPayments: outstanding.data().count,
          teamsToActivate,
        });
      } catch (err) {
        console.warn('[admin-cockpit] count load failed', err);
        // Failures leave counts at 0. Better than a noisy error banner;
        // the cockpit just shows zero pending work. Console warn for
        // debugging.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const chips: Array<{ count: number; label: string; href: string; emphasize?: boolean }> = [
    { count: counts.pendingRegistrations, label: 'Pending registrations',  href: '/club/registrations' },
    { count: counts.outstandingPayments,  label: 'Outstanding payments',   href: '/club/registrations?filter=unpaid', emphasize: counts.outstandingPayments > 0 },
    { count: counts.teamsToActivate,      label: 'Teams to activate',      href: '/admin/teams', emphasize: counts.teamsToActivate > 0 },
  ];

  return (
    <div className="relative">
      {showProgress && !loaded && (
        <div className="h-0.5 bg-crimson-500/15 overflow-hidden rounded-full mb-2">
          <div className="h-full w-1/3 bg-crimson-500 animate-progress-slide" />
        </div>
      )}
      <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="rounded-2xl bg-gradient-to-br from-charcoal-900 to-charcoal-800/60 ring-1 ring-crimson-500/20 px-3 py-3 sm:px-4 sm:py-3.5 shadow-lg shadow-crimson-950/30">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-crimson-500/15 ring-1 ring-crimson-400/30 text-crimson-300">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </span>
            <span className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-300">Club admin</span>
            <span className="text-[10px] font-bold tracking-wide text-bone/50">what needs your attention</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <Link
                key={chip.label}
                to={chip.href}
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ring-1 transition-colors text-[12px] ${
                  chip.emphasize
                    ? 'bg-crimson-500/15 ring-crimson-400/40 text-crimson-200 hover:bg-crimson-500/25'
                    : 'bg-charcoal-950 ring-white/10 text-bone/85 hover:bg-white/5'
                }`}
              >
                <span className={`tabular-nums font-extrabold ${chip.emphasize ? 'text-crimson-200' : 'text-bone'}`}>
                  {chip.count}
                </span>
                <span className="font-semibold">{chip.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminCockpit;
