// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useSubscription } from '../../hooks/useSubscription';
import { isCoach } from '../../utils/helpers';
import TierPickerSheet from '../common/TierPickerSheet';

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

// Dismiss is keyed per team — dismissing on one team doesn't hide
// the card on another team (Patrick: testing on a brand-new team
// and the card was already hidden from a prior dismiss). Cooldown
// is also short — 24h — so an accidental tap doesn't lock the
// checklist away for a month. The card always self-hides when all
// 3 steps are actually done.
const DISMISS_KEY_PREFIX = 'gk_dashboard_getstarted_dismissed_at__';
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24 hours

const GettingStartedCard: React.FC<Props> = ({ players, events }) => {
  const navigate = useNavigate();
  const { currentUser, userData } = useAuth();
  const { selectedTeamId } = useTeam();
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
  if (!isCoach(userData.role)) return null;
  if (!selectedTeamId) return null;
  if (dismissed) return null;
  // Wait for the subscription doc to load before deciding to render.
  // Without this guard, the card flashes the 'Start your 7-day free
  // trial' step for a frame on every cold start (isActive defaults
  // to false while the snapshot is in flight) and disappears once
  // the active-sub state lands. Patrick 2026-06-25: 'I swear I see
  // the 7 day trial come up briefly and then go away.'
  if (subLoading) return null;

  // Steps
  const hasPlayers = (players?.length || 0) > 0;
  const hasEvent = (events?.length || 0) > 0;
  const hasInvitedParents = (players || []).some((p: any) =>
    (p.parentEmails?.length || 0) > 0 || (p.parentIds?.length || 0) > 0
  );
  const hasTrial = isActive;

  const allDone = hasPlayers && hasEvent && hasInvitedParents && hasTrial;
  if (allDone) return null;

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

  // Order matters: each step gates the next as the obvious "do this now."
  //
  // "Add players" and "invite parents" used to be separate steps,
  // but they both routed to /people/add and the bulk form does both
  // in one action — adding a player with a parent email sends the
  // parent's invite immediately. Patrick: "add players and invite
  // players can kinda be combined as it does the same thing, right?"
  // Merged into one step. "Done" is when at least one player has a
  // parent linked (parentIds) or a pending parent email.
  const rosterReady = hasPlayers && hasInvitedParents;
  const steps = [
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
    <div className="relative rounded-2xl bg-gradient-to-br from-charcoal-900 via-charcoal-900 to-brand-primary-deep/30 ring-1 ring-brand-primary/30 p-4 sm:p-5 overflow-hidden shadow-xl">
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full text-bone/50 hover:text-bone hover:bg-white/5 flex items-center justify-center transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>

      <div className="flex items-start justify-between gap-3 mb-4 pr-8">
        <div>
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-0.5">
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
        <div className="shrink-0 text-bone/70 text-sm font-extrabold tabular-nums leading-none pt-1 mr-2">
          {completedCount}<span className="text-bone/40 mx-0.5">/</span>{steps.length}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-5">
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-primary to-amber-400 transition-all"
          style={{ width: `${(completedCount / steps.length) * 100}%` }}
        />
      </div>

      <ul className="space-y-2">
        {steps.map((s, i) => {
          const isNext = i === firstUndoneIdx;
          const isTrial = s.key === 'trial';
          return (
            <li
              key={s.key}
              className={`rounded-lg px-3 py-2.5 transition ${
                s.done
                  ? 'bg-emerald-500/5 ring-1 ring-emerald-500/15'
                  : isNext
                    ? 'bg-charcoal-950 ring-1 ring-brand-primary/30'
                    : 'bg-charcoal-950/60 ring-1 ring-white/5'
              }`}
            >
              <div className="flex items-center gap-3">
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
                  // Fixed-width CTA so all four step rows line up cleanly
                  // regardless of how long the button label is. Patrick:
                  // "can we make buttons all the same size regardless of font?"
                  <button
                    type="button"
                    onClick={s.onClick}
                    className={`shrink-0 w-[120px] px-3 py-1.5 rounded-md font-bold text-xs transition text-center ${
                      isNext
                        ? 'bg-brand-primary hover:bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40 ring-1 ring-brand-primary-soft/20'
                        : 'bg-charcoal-800 ring-1 ring-white/10 hover:ring-white/25 text-bone'
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
                  <p className="mt-3 pt-3 border-t border-white/5 text-bone/55 text-[11px]">
                    After your free week, pick what fits:
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <PricingTier
                      name="Founder"
                      price="$5"
                      period="/mo"
                      note="First 50"
                      highlight
                      onClick={handleStartTrial}
                    />
                    <PricingTier
                      name="Annual"
                      price="$99"
                      period="/yr"
                      note="Save 17%"
                      onClick={handleStartTrial}
                    />
                    <PricingTier
                      name="Monthly"
                      price="$10"
                      period="/mo"
                      note="Most flex"
                      onClick={handleStartTrial}
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
        : 'bg-charcoal-900 ring-white/5 hover:bg-charcoal-800 hover:ring-white/15'
    }`}
  >
    <p className={`text-[9px] font-extrabold tracking-widest uppercase ${
      highlight ? 'text-amber-300' : 'text-bone/60'
    }`}>
      {name}
    </p>
    <p className="text-bone font-black text-base leading-none mt-1 tabular-nums">
      {price}<span className="text-bone/50 text-[10px] font-bold">{period}</span>
    </p>
    {note && (
      <p className="text-bone/40 text-[9px] mt-0.5 font-bold">{note}</p>
    )}
  </button>
);

export default GettingStartedCard;
