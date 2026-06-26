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

  const chips: Array<{ count?: number; label: string; href: string; emphasize?: boolean; cta?: boolean }> = [
    { label: 'Start a season',            href: '/admin/seasons/new', cta: true },
    { count: counts.pendingRegistrations, label: 'Pending registrations',  href: '/club/registrations' },
    { count: counts.outstandingPayments,  label: 'Outstanding payments',   href: '/club/registrations?filter=unpaid', emphasize: counts.outstandingPayments > 0 },
    { count: counts.teamsToActivate,      label: 'Teams to activate',      href: '/admin/teams', emphasize: counts.teamsToActivate > 0 },
  ];

  return (
    <div className="relative">
      {showProgress && !loaded && (
        <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full mb-2">
          <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
        </div>
      )}
      <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="rounded-2xl bg-gradient-to-br from-charcoal-900 to-charcoal-800/60 ring-1 ring-brand-primary/20 px-3 py-3 sm:px-4 sm:py-3.5 shadow-lg shadow-brand-primary-deep/30">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 text-brand-primary-soft">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </span>
            <span className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Club admin</span>
            <span className="text-[10px] font-bold tracking-wide text-bone/50">what needs your attention</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => {
              const cls = chip.cta
                ? 'bg-brand-primary ring-brand-primary-soft/40 text-white hover:bg-brand-primary font-bold'
                : chip.emphasize
                  ? 'bg-brand-primary/15 ring-brand-primary-soft/40 text-brand-primary-soft hover:bg-brand-primary/25'
                  : 'bg-charcoal-950 ring-white/10 text-bone/85 hover:bg-white/5';
              return (
                <Link
                  key={chip.label}
                  to={chip.href}
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ring-1 transition-colors text-[12px] ${cls}`}
                >
                  {chip.cta ? (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  ) : chip.count !== undefined ? (
                    <span className={`tabular-nums font-extrabold ${chip.emphasize ? 'text-brand-primary-soft' : 'text-bone'}`}>
                      {chip.count}
                    </span>
                  ) : null}
                  <span className="font-semibold">{chip.label}</span>
                </Link>
              );
            })}
          </div>

          {/* Quick action tiles — admin's daily-action surface.
              Patrick 2026-06-21: 'maybe we can also put on the main
              page, create survey, create training form, broadcast
              message, etc.' Sits below the count chips so 'what
              needs attention' reads first, 'what can I do now' reads
              second. Each tile is a thin link into the existing
              page/flow — no new modals or routes wired here. */}
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            <Link
              to="/events"
              className="flex flex-col items-center gap-0.5 rounded-lg bg-charcoal-950 ring-1 ring-white/10 hover:ring-brand-primary/30 transition py-2 text-bone/85 hover:text-bone"
            >
              <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <span className="text-[10px] font-bold">Event</span>
            </Link>
            <Link
              to="/club/forms"
              className="flex flex-col items-center gap-0.5 rounded-lg bg-charcoal-950 ring-1 ring-white/10 hover:ring-brand-primary/30 transition py-2 text-bone/85 hover:text-bone"
            >
              <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" />
              </svg>
              <span className="text-[10px] font-bold">Form</span>
            </Link>
            <Link
              to="/surveys"
              className="flex flex-col items-center gap-0.5 rounded-lg bg-charcoal-950 ring-1 ring-white/10 hover:ring-brand-primary/30 transition py-2 text-bone/85 hover:text-bone"
            >
              <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <span className="text-[10px] font-bold">Survey</span>
            </Link>
            <Link
              to="/club?broadcast=open"
              className="flex flex-col items-center gap-0.5 rounded-lg bg-charcoal-950 ring-1 ring-white/10 hover:ring-brand-primary/30 transition py-2 text-bone/85 hover:text-bone"
            >
              <svg className="w-4 h-4 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M3 11h4l5-4v10l-5-4H3z" /><path d="M16 8a4 4 0 0 1 0 8" />
              </svg>
              <span className="text-[10px] font-bold">Broadcast</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminCockpit;
