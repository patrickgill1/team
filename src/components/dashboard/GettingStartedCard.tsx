// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useSubscription } from '../../hooks/useSubscription';
import { openWebSignup } from '../../utils/subscriptionApi';
import { isCoach } from '../../utils/helpers';

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
}

const DISMISS_KEY = 'gk_dashboard_getstarted_dismissed_at';
const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

const GettingStartedCard: React.FC<Props> = ({ players, events }) => {
  const navigate = useNavigate();
  const { currentUser, userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { isActive } = useSubscription();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      const at = Number(window.localStorage.getItem(DISMISS_KEY) || 0);
      if (at && Date.now() - at < DISMISS_COOLDOWN_MS) setDismissed(true);
    } catch { /* ignore */ }
  }, []);

  if (!userData) return null;
  if (!isCoach(userData.role)) return null;
  if (!selectedTeamId) return null;
  if (dismissed) return null;

  // Steps
  const hasPlayers = (players?.length || 0) > 0;
  const hasEvent = (events?.length || 0) > 0;
  const hasInvitedParents = (players || []).some((p: any) =>
    (p.parentEmails?.length || 0) > 0 || (p.parentIds?.length || 0) > 0
  );
  const hasTrial = isActive;

  const allDone = hasPlayers && hasEvent && hasInvitedParents && hasTrial;
  if (allDone) return null;

  const handleStartTrial = () => {
    openWebSignup({
      email: currentUser?.email || userData?.email || undefined,
      uid: currentUser?.uid,
      tier: 'annual',
      intent: 'subscribe',
    });
  };

  const handleDismiss = () => {
    try { window.localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setDismissed(true);
  };

  // Order matters: each step gates the next as the obvious "do this now."
  // Players + Invite both deep-link to /people/add (the focused bulk
  // add-with-emails page), NOT /people (which is the directory of
  // everyone the coach has ever met). The bulk form sends parent
  // invites at the same moment players are created, so "Add players"
  // and "Invite parents" are the same action.
  const steps = [
    {
      key: 'players',
      label: hasPlayers ? `${players.length} ${players.length === 1 ? 'player' : 'players'} on the roster` : 'Add your first players',
      done: hasPlayers,
      cta: 'Add players',
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
      key: 'invite',
      label: hasInvitedParents ? 'Parent invites sent' : 'Invite your parents',
      done: hasInvitedParents,
      cta: 'Invite parents',
      onClick: () => navigate('/people/add'),
    },
    {
      key: 'trial',
      label: hasTrial ? 'Subscription active' : 'Start your 7-day free trial',
      done: hasTrial,
      cta: 'Start trial',
      onClick: handleStartTrial,
    },
  ];

  const completedCount = steps.filter(s => s.done).length;
  const isLast = (idx: number) => steps.slice(idx + 1).every(s => s.done);
  const firstUndoneIdx = steps.findIndex(s => !s.done);

  return (
    <div className="relative rounded-2xl bg-gradient-to-br from-charcoal-900 via-charcoal-900 to-crimson-950/30 ring-1 ring-crimson-700/30 p-4 sm:p-5 overflow-hidden shadow-xl">
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full text-bone/50 hover:text-bone hover:bg-white/5 flex items-center justify-center transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>

      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400 mb-0.5">
            Getting started
          </p>
          <p className="text-bone font-bold leading-tight">
            {completedCount === 0
              ? "Let's set up your team."
              : completedCount === steps.length - 1
                ? 'One more thing to go.'
                : `${completedCount} of ${steps.length} done.`}
          </p>
        </div>
        <div className="shrink-0 text-bone/70 text-sm font-bold tabular-nums">
          {completedCount}/{steps.length}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-4">
        <div
          className="h-full rounded-full bg-gradient-to-r from-crimson-500 to-amber-400 transition-all"
          style={{ width: `${(completedCount / steps.length) * 100}%` }}
        />
      </div>

      <ul className="space-y-2">
        {steps.map((s, i) => {
          const isNext = i === firstUndoneIdx;
          return (
            <li
              key={s.key}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 transition ${
                s.done
                  ? 'bg-emerald-500/5 ring-1 ring-emerald-500/15'
                  : isNext
                    ? 'bg-charcoal-950 ring-1 ring-crimson-500/30'
                    : 'bg-charcoal-950/60 ring-1 ring-white/5'
              }`}
            >
              <span className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ring-1 ${
                s.done
                  ? 'bg-emerald-500/20 ring-emerald-400/40 text-emerald-300'
                  : 'bg-white/5 ring-white/15 text-bone/40'
              }`}>
                {s.done ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                ) : (
                  <span className="text-[10px] font-extrabold">{i + 1}</span>
                )}
              </span>
              <span className={`flex-1 text-sm font-bold leading-tight ${s.done ? 'text-bone/55 line-through decoration-emerald-400/40' : isNext ? 'text-bone' : 'text-bone/70'}`}>
                {s.label}
              </span>
              {!s.done && (
                <button
                  type="button"
                  onClick={s.onClick}
                  className={`shrink-0 px-3 py-1.5 rounded-md font-bold text-xs transition ${
                    isNext
                      ? 'bg-crimson-600 hover:bg-crimson-500 text-white shadow-lg shadow-crimson-900/40 ring-1 ring-crimson-400/20'
                      : 'bg-charcoal-800 ring-1 ring-white/10 hover:ring-white/25 text-bone'
                  }`}
                >
                  {s.cta}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default GettingStartedCard;
