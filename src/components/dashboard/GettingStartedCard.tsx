// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useSubscription } from '../../hooks/useSubscription';
import { isCoachOfTeam, isClubAdmin as isClubAdminUser } from '../../utils/helpers';
import { useViewMode } from '../../contexts/ViewModeContext';
import TierPickerSheet from '../common/TierPickerSheet';
import { openWebSignup } from '../../utils/subscriptionApi';

// Getting Started checklist for new coaches. Patrick: "the guide was
// cool until you got into the dashboard... they need to be able to
// do something and then have them start the trial."
//
// Lives at the top of the dashboard for the FIRST WEEK or until all
// items are done. Each item is a tappable next-step. The trial CTA
// is the last item — earned by doing the rest, not just dangled.
//
// Hidden when:
//   - User is a parent (the in-the-pool screen handles them)
//   - All four items are complete
//   - User explicitly dismisses (localStorage flag, 30-day cooldown)

interface Props {
  players: any[];   // from Dashboard's player state
  events: any[];    // from Dashboard's event state
  /** True while Dashboard's initial player/event load is in flight.
   *  Suppresses the card so a coach with 15 players doesn't see the
   *  "Schedule your first event" empty state flash for a moment
   *  before the events query resolves. */
  dataLoading?: boolean;
}

// Dismiss is keyed per team — dismissing on one team doesn't hide
// the card on another team (Patrick: testing on a brand-new team
// and the card was already hidden from a prior dismiss). Cooldown
// is also short — 24h — so an accidental tap doesn't lock the
// checklist away for a month. The card always self-hides when all
// 3 steps are actually done.
const DISMISS_KEY_PREFIX = 'gk_dashboard_getstarted_dismissed_at__';
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24 hours

type GuideRole = 'coach' | 'parent' | 'admin';

interface SetupStep {
  key: string;
  label: string;
  done: boolean;
  cta: string;
  onClick: () => void;
}

const GettingStartedCard: React.FC<Props> = ({ players, events, dataLoading }) => {
  const navigate = useNavigate();
  const { currentUser, userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { viewMode } = useViewMode();
  const { isActive, loading: subLoading } = useSubscription();
  const [dismissed, setDismissed] = useState(false);
  const [tierSheet, setTierSheet] = useState(false);

  // Per-team dismiss key + auto-clear on fresh teams. Patrick: "it
  // let me click out of the guide, and now i can't get it back."
  // Resetting when the team has zero players AND zero events means
  // a brand-new team always re-surfaces the checklist regardless
  // of what the coach dismissed on another team.
  useEffect(() => {
    if (!selectedTeamId) { setDismissed(false); return; }
    const key = DISMISS_KEY_PREFIX + selectedTeamId;
    const isFreshTeam = (players?.length || 0) === 0 && (events?.length || 0) === 0;
    try {
      if (isFreshTeam) {
        window.localStorage.removeItem(key);
        setDismissed(false);
        return;
      }
      const at = Number(window.localStorage.getItem(key) || 0);
      if (at && Date.now() - at < DISMISS_COOLDOWN_MS) setDismissed(true);
      else setDismissed(false);
    } catch { /* ignore */ }
  }, [selectedTeamId, players?.length, events?.length]);

  if (!userData) return null;
  if (!selectedTeamId) return null;
  if (dismissed) return null;
  // Suppress the card while Dashboard is still fetching players +
  // events. Without this guard a coach with 15 players sees the
  // "Schedule your first event" empty state flash for a moment
  // because the events array is `[]` during the load.
  if (dataLoading) return null;

  const userIsCoach = isCoachOfTeam(userData, selectedTeam);
  const userIsClubAdmin = isClubAdminUser(userData as any);
  const guideRole: GuideRole = viewMode === 'admin' && userIsClubAdmin
    ? 'admin'
    : viewMode === 'coach' && userIsCoach
      ? 'coach'
      : 'parent';

  // Wait for the subscription doc before rendering coach/admin billing
  // steps. Parent mode has no billing step, so it can paint right away.
  if ((guideRole === 'coach' || guideRole === 'admin') && subLoading) return null;

  // Steps
  const hasPlayers = (players?.length || 0) > 0;
  const hasEvent = (events?.length || 0) > 0;
  const hasInvitedParents = (players || []).some((p: any) =>
    (p.parentEmails?.length || 0) > 0 || (p.parentIds?.length || 0) > 0
  );
  const hasSubscriptionAccess = isActive
    || (userData as any)?.subscriptionActive === true
    || (userData as any)?.coverageSource === 'club'
    || (userData as any)?.isClubAdmin === true;

  const linkedPlayers = (players || []).filter((p: any) =>
    (Array.isArray(p.parentIds) && p.parentIds.includes((userData as any).uid)) ||
    p.parentId === (userData as any).uid
  );
  const nextEvent = events?.[0] || null;
  const parentRsvpDone = !!nextEvent && linkedPlayers.length > 0 && linkedPlayers.every((p: any) => {
    const playerRsvp = (nextEvent as any).playerRsvps?.[p.id]?.status;
    const adultRsvp = (nextEvent as any).rsvps?.[(userData as any).uid]?.status;
    return !!(playerRsvp || adultRsvp);
  });

  // Open the tier picker sheet. The sheet hands off to openWebSignup
  // with the user's choice (Coach annual vs Club). Used to be a
  // direct openWebSignup call hardcoded to Coach annual — meaning
  // a coach running a multi-team club had no way to pick Club from
  // inside the app.
  const handleStartTrial = () => setTierSheet(true);

  const handleDismiss = () => {
    if (!selectedTeamId) return;
    const key = DISMISS_KEY_PREFIX + selectedTeamId;
    try { window.localStorage.setItem(key, String(Date.now())); } catch { /* ignore */ }
    setDismissed(true);
  };

  const rosterReady = hasPlayers && hasInvitedParents;
  const roleCopy: Record<GuideRole, { eyebrow: string; empty: string; almost: string }> = {
    coach: {
      eyebrow: 'Coach launch guide',
      empty: "Let's get your team ready.",
      almost: 'One more step and you can run the week from here.',
    },
    parent: {
      eyebrow: 'Parent quick start',
      empty: "Let's make this useful on day one.",
      almost: 'One more tap and game week is covered.',
    },
    admin: {
      eyebrow: 'Club launch guide',
      empty: "Let's make the club hub operational.",
      almost: 'One more setup item for the club.',
    },
  };

  // Order matters: each role gets the next task that makes their
  // first week successful, not a generic product tour.
  const steps: SetupStep[] = guideRole === 'coach'
    ? [
        {
          key: 'roster',
          label: rosterReady
            ? `${players.length} on the squad, parents in.`
            : hasPlayers
              ? 'Bring the rest of the parents in'
              : 'Build your squad, bring parents in',
          done: rosterReady,
          cta: hasPlayers ? 'Bring more in' : 'Build squad',
          onClick: () => navigate('/people/add'),
        },
        {
          key: 'event',
          label: hasEvent ? 'Practice or game on the calendar' : 'Schedule your first practice',
          done: hasEvent,
          cta: 'Add event',
          onClick: () => navigate('/calendar'),
        },
        {
          key: 'subscription',
          label: hasSubscriptionAccess ? 'Subscription active' : 'Start your 7-day free trial',
          done: hasSubscriptionAccess,
          cta: 'Start trial',
          onClick: handleStartTrial,
        },
      ]
    : guideRole === 'admin'
      ? [
          {
            key: 'club',
            label: 'Open the club command center',
            done: true,
            cta: 'Open club',
            onClick: () => navigate('/club'),
          },
          {
            key: 'roster',
            label: hasPlayers ? 'Roster data is flowing' : 'Add teams, players, or imported registrations',
            done: hasPlayers,
            cta: 'People',
            onClick: () => navigate('/people'),
          },
          {
            key: 'season',
            label: hasEvent ? 'A season event is scheduled' : 'Set the first season event',
            done: hasEvent,
            cta: 'Calendar',
            onClick: () => navigate('/calendar'),
          },
          {
            key: 'subscription',
            label: hasSubscriptionAccess ? 'Club billing is covered' : 'Pick the club plan',
            done: hasSubscriptionAccess,
            cta: 'Plans',
            onClick: handleStartTrial,
          },
        ]
      : [
          {
            key: 'player',
            label: linkedPlayers.length > 0
              ? `${linkedPlayers[0].name?.split(' ')[0] || 'Your player'} is connected`
              : 'Connect your player to this team',
            done: linkedPlayers.length > 0,
            cta: linkedPlayers.length > 0 ? 'View player' : 'Join team',
            onClick: () => linkedPlayers[0]?.id ? navigate(`/player/${linkedPlayers[0].id}`) : navigate('/join'),
          },
          {
            key: 'calendar',
            label: hasEvent ? 'You can see the next team event' : 'Check the team schedule',
            done: hasEvent,
            cta: 'Schedule',
            onClick: () => navigate('/calendar'),
          },
          {
            key: 'rsvp',
            label: parentRsvpDone ? 'RSVP sent for the next event' : 'RSVP so the coach can plan',
            done: parentRsvpDone,
            cta: 'RSVP',
            onClick: () => navigate('/calendar'),
          },
        ];

  const allDone = steps.every((s) => s.done);
  if (allDone) return null;

  const completedCount = steps.filter(s => s.done).length;
  const isLast = (idx: number) => steps.slice(idx + 1).every(s => s.done);
  const firstUndoneIdx = steps.findIndex(s => !s.done);

  return (
    <div className="relative rounded-2xl bg-gradient-to-br from-surface-elevated via-surface-elevated to-brand-primary-deep/30 ring-1 ring-brand-primary/30 p-4 sm:p-5 overflow-hidden shadow-xl">
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full text-ink-primary/50 hover:text-ink-primary hover:bg-line-default/5 flex items-center justify-center transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>

      <div className="flex items-start justify-between gap-3 mb-4 pr-8">
        <div>
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-0.5">
            {roleCopy[guideRole].eyebrow}
          </p>
          <p className="text-ink-primary font-bold leading-tight">
            {completedCount === 0
              ? roleCopy[guideRole].empty
              : completedCount === steps.length - 1
                ? roleCopy[guideRole].almost
                : `${completedCount} of ${steps.length} done.`}
          </p>
        </div>
        <div className="shrink-0 text-ink-primary/70 text-sm font-extrabold tabular-nums leading-none pt-1 mr-2">
          {completedCount}<span className="text-ink-primary/40 mx-0.5">/</span>{steps.length}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-line-default/5 overflow-hidden mb-5">
        <div
          className="h-full rounded-full bg-brand-primary transition-all"
          style={{ width: `${(completedCount / steps.length) * 100}%` }}
        />
      </div>

      <ul className="space-y-2">
        {steps.map((s, i) => {
          const isNext = i === firstUndoneIdx;
          const isTrial = s.key === 'subscription' && guideRole === 'coach';
          return (
            <li
              key={s.key}
              className={`rounded-lg px-3 py-2.5 transition ${
                s.done
                  ? 'bg-emerald-500/5 ring-1 ring-emerald-500/15'
                  : isNext
                    ? 'bg-surface-base ring-1 ring-brand-primary/30'
                    : 'bg-surface-base/60 ring-1 ring-line-default/5'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ring-1 ${
                  s.done
                    ? 'bg-emerald-500/20 ring-emerald-400/40 text-emerald-300'
                    : 'bg-line-default/5 ring-line-default/15 text-ink-primary/40'
                }`}>
                  {s.done ? (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                  ) : (
                    <span className="text-[10px] font-extrabold">{i + 1}</span>
                  )}
                </span>
                <span className={`flex-1 text-sm font-bold leading-tight ${s.done ? 'text-ink-primary/55 line-through decoration-emerald-400/40' : isNext ? 'text-ink-primary' : 'text-ink-primary/70'}`}>
                  {s.label}
                </span>
                {!s.done && (
                  // Fixed-width CTA so all four step rows line up cleanly
                  // regardless of how long the button label is. Patrick:
                  // "can we make buttons all the same size regardless of font?"
                  <button
                    type="button"
                    onClick={s.onClick}
                    className={`shrink-0 w-[120px] px-3 py-1.5 rounded-md font-bold text-xs transition text-center ${
                      isNext
                        ? 'bg-brand-primary hover:bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40 ring-1 ring-brand-primary-soft/20'
                        : 'bg-surface-input ring-1 ring-line-default/10 hover:ring-line-default/25 text-ink-primary'
                    }`}
                  >
                    {s.cta}
                  </button>
                )}
              </div>

              {/* Trial step — show pricing tiers inline so coaches
                  know what they're about to start. Patrick: "we
                  should list the prices and plans so people know
                  what they are getting into. we can add the
                  founder's too." All three tiers; Founder included
                  because in-app display of prices is allowed under
                  Apple rules — only the actual payment trigger has
                  to be out-of-app (which it is — opens Safari). */}
              {isTrial && !s.done && (
                <>
                  <p className="mt-3 pt-3 border-t border-line-default/5 text-ink-primary/55 text-[11px]">
                    After your free week, pick what fits:
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <PricingTier
                      name="Founder"
                      price="$5"
                      period="/mo"
                      note="First 50"
                      highlight
                      onClick={() => openWebSignup({
                        email: currentUser?.email || userData?.email || undefined,
                        uid: currentUser?.uid,
                        tier: 'founder',
                        intent: 'subscribe',
                      })}
                    />
                    <PricingTier
                      name="Annual"
                      price="$99"
                      period="/yr"
                      note="Save 17%"
                      onClick={() => openWebSignup({
                        email: currentUser?.email || userData?.email || undefined,
                        uid: currentUser?.uid,
                        tier: 'annual',
                        intent: 'subscribe',
                      })}
                    />
                    <PricingTier
                      name="Monthly"
                      price="$10"
                      period="/mo"
                      note="Most flex"
                      onClick={() => openWebSignup({
                        email: currentUser?.email || userData?.email || undefined,
                        uid: currentUser?.uid,
                        tier: 'monthly',
                        intent: 'subscribe',
                      })}
                    />
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <TierPickerSheet
        open={tierSheet}
        onClose={() => setTierSheet(false)}
        email={currentUser?.email || userData?.email || undefined}
        uid={currentUser?.uid}
        intent="subscribe"
      />
    </div>
  );
};

const PricingTier: React.FC<{
  name: string;
  price: string;
  period: string;
  note?: string;
  highlight?: boolean;
  onClick?: () => void;
}> = ({ name, price, period, note, highlight, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`rounded-md px-2 py-2 text-center ring-1 transition active:scale-[0.98] ${
      highlight
        ? 'bg-amber-500/5 ring-amber-500/20 hover:bg-amber-500/10 hover:ring-amber-500/40'
        : 'bg-surface-elevated ring-line-default/5 hover:bg-surface-input hover:ring-line-default/15'
    }`}
  >
    <p className={`text-[9px] font-extrabold tracking-widest uppercase ${
      highlight ? 'text-amber-300' : 'text-ink-primary/60'
    }`}>
      {name}
    </p>
    <p className="text-ink-primary font-black text-base leading-none mt-1 tabular-nums">
      {price}<span className="text-ink-primary/50 text-[10px] font-bold">{period}</span>
    </p>
    {note && (
      <p className="text-ink-primary/40 text-[9px] mt-0.5 font-bold">{note}</p>
    )}
  </button>
);

export default GettingStartedCard;
