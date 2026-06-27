// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useSubscription } from '../hooks/useSubscription';
import { createPlayerInvite, inviteUrl } from '../utils/invites';
import { openWebSignup } from '../utils/subscriptionApi';
import BulkAddPlayersForm from '../components/people/BulkAddPlayersForm';
import { Share } from '@capacitor/share';
import { Capacitor } from '@capacitor/core';

// First-run wizard for a freshly-signed-up coach. Lands here when
// ProtectedRoute sees a signed-in user with no teamIds. Multi-step,
// state kept in URL query (?step=...) so a refresh keeps progress.
//
// Steps (Coach tier):
//   1. welcome   — set expectations, hand off to step 2
//   2. team      — name, format, age group → createTeam()
//   3. invite    — auto-generate parent invite link, copy/share
//   4. done      — short congrats, dashboard CTA
//
// Steps (Club / Club Pro tier): adds a club step between team and
// invite, where they name the club + optionally Connect Stripe.
//
// Tier is read from the live subscription doc (subscriptions/{uid}).
// If subscription is still propagating from Stripe webhook (rare race
// on first visit), we proceed as if Coach — they can convert later.

const TEAM_FORMATS = [
  { id: '4v4', label: '4v4' },
  { id: '7v7', label: '7v7' },
  { id: '9v9', label: '9v9' },
  { id: '11v11', label: '11v11' },
];

const AGE_GROUPS = [
  'U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14', 'U15', 'U16', 'U17', 'U18', 'Adult',
];

type Step = 'welcome' | 'team' | 'club' | 'roster' | 'event' | 'invite' | 'done';
type Intent = 'team' | 'club';

const Onboarding: React.FC = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { currentUser, userData, refreshUserData } = useAuth();
  const { createTeam, createClub, updateDocument, addPlayer, addEvent } = useFirestore();
  const { subscription, tier } = useSubscription();

  // Intent = what the user declared on the welcome step ("I'm setting
  // up a team" vs "I'm setting up a club"). Distinct from `tier`
  // (which is what they're SUBSCRIBED to — they may not be subscribed
  // yet). Persisted in the URL so a refresh mid-wizard doesn't lose
  // the choice. Also honors ?intent= for deep-links that already know
  // (e.g. a "Start your club" CTA elsewhere in the app).
  const initialIntent = ((params.get('intent') || '') as Intent);
  const subscriptionImpliesClub = tier === 'club' || tier === 'club-pro';
  const intent: Intent = initialIntent === 'club' || initialIntent === 'team'
    ? initialIntent
    : (subscriptionImpliesClub ? 'club' : 'team');
  const setIntent = (i: Intent) => {
    const next = new URLSearchParams(params);
    next.set('intent', i);
    setParams(next, { replace: true });
  };

  const isClubTrack = intent === 'club';
  // Kept for back-compat with the rest of the wizard (renders the
  // Club step + tier-aware copy). Now driven by intent instead of
  // subscription tier.
  const isClubTier = isClubTrack;

  const step = ((params.get('step') || 'welcome') as Step);
  const setStep = (s: Step) => {
    const next = new URLSearchParams(params);
    next.set('step', s);
    setParams(next, { replace: true });
  };

  // Form state — kept across steps so back-navigation doesn't lose
  // typed data. Defaults are friendly: coach's name primes the team
  // name ("Patrick's team") and a club name ("Patrick's club") so
  // they can just hit Continue.
  const firstName = (userData?.name || currentUser?.displayName || '').split(' ')[0] || '';
  const [teamName, setTeamName] = useState(firstName ? `${firstName}'s team` : '');
  const [teamFormat, setTeamFormat] = useState('7v7');
  const [teamAgeGroup, setTeamAgeGroup] = useState('U10');
  const [clubName, setClubName] = useState(firstName ? `${firstName}'s club` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTeamId, setCreatedTeamId] = useState<string | null>(null);
  const [createdClubId, setCreatedClubId] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  // Roster bulk-add result (rendered for end-of-flow confirmation).
  const [rosterResult, setRosterResult] = useState<{ created: number; invitesSent: number } | null>(null);

  // First-event step: defaults to a Practice tomorrow at 6:30 PM,
  // 90 minutes. Coach can edit anything or skip. Saves to events
  // collection with their teamId.
  const tomorrowAt630 = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(18, 30, 0, 0);
    return d;
  }, []);
  const toLocalInput = (d: Date) => {
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tz).toISOString().slice(0, 16);
  };
  const [eventName, setEventName] = useState('Practice');
  const [eventWhen, setEventWhen] = useState(toLocalInput(tomorrowAt630));
  const [eventDurationMins, setEventDurationMins] = useState(90);
  const [eventLocation, setEventLocation] = useState('');
  const [eventCreated, setEventCreated] = useState(false);
  // Skip-with-friction modal on the done step.
  const [showSkipModal, setShowSkipModal] = useState(false);

  // If a coach already has teamIds, they don't belong here — kick
  // them to dashboard. Handles back-navigation after they finished.
  useEffect(() => {
    if (userData?.teamIds && userData.teamIds.length > 0 && step !== 'done') {
      navigate('/dashboard', { replace: true });
    }
  }, [userData?.teamIds, step, navigate]);

  // ─ Team creation ─
  const handleCreateTeam = async () => {
    if (!userData || !teamName.trim()) {
      setError('Add a team name to continue.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const newTeamId = await createTeam({
        name: teamName.trim(),
        coachIds: [userData.uid],
        headCoachId: userData.uid,
        assistantCoachIds: [],
        playerIds: [],
        parentIds: [],
        season: '',
        ageGroup: teamAgeGroup,
        format: teamFormat,
        updatedAt: new Date(),
      });
      if (!newTeamId) throw new Error('Team creation returned no id.');
      setCreatedTeamId(newTeamId);

      // Link team to user. Patrick's existing pattern in
      // TeamManagement.tsx writes the array directly.
      const currentTeamIds = userData.teamIds || (userData.teamId ? [userData.teamId] : []);
      await updateDocument('users', userData.uid, {
        teamIds: [...currentTeamIds, newTeamId],
        // Make this the "selected" team for solo coaches who only
        // ever have one — Dashboard reads teamId for backward compat.
        teamId: userData.teamId || newTeamId,
        role: 'coach',
        coachLevel: 'head_coach',
        updatedAt: new Date(),
      });

      // Solo coach gets an invisible club auto-created and linked.
      // Club tier proceeds to the club step where they name it.
      if (!isClubTier) {
        const autoClubId = await createClub({
          name: teamName.trim(),
          ownerUid: userData.uid,
          initialTeamId: newTeamId,
        });
        if (autoClubId) setCreatedClubId(autoClubId);
      }

      await refreshUserData?.();
      // Coach track: team -> roster -> event -> invite -> done
      // Club track:  team -> club -> roster -> event -> invite -> done
      setStep(isClubTier ? 'club' : 'roster');
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  // ─ Club creation (only on Club / Club Pro tiers) ─
  const handleCreateClub = async () => {
    if (!userData || !clubName.trim() || !createdTeamId) {
      setError('Add a club name to continue.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const newClubId = await createClub({
        name: clubName.trim(),
        ownerUid: userData.uid,
        initialTeamId: createdTeamId,
      });
      if (!newClubId) throw new Error('Club creation returned no id.');
      setCreatedClubId(newClubId);
      // Link team to club so the team admin UI shows it under the club.
      await updateDocument('teams', createdTeamId, {
        clubId: newClubId,
        updatedAt: new Date(),
      });
      setStep('roster');
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  // (Bulk roster handler removed — now lives in
  // src/components/people/BulkAddPlayersForm.tsx so this page and
  // /people/add use the same code path + branded email template.)

  // ─ First event ─
  // Defaults to a Practice tomorrow at 6:30 PM, 90 minutes. A coach
  // who skips here ends onboarding with an empty calendar; one who
  // saves ends with the next practice on the schedule + parents (if
  // bulk-added with emails) receiving an event invite when they
  // accept their join link.
  const handleEventSave = async () => {
    if (!userData || !createdTeamId) {
      setError('No team yet — go back to the previous step.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const start = new Date(eventWhen);
      const end = new Date(start.getTime() + eventDurationMins * 60 * 1000);
      await addEvent({
        title: (eventName || 'Practice').trim(),
        date: start,
        endDate: end,
        location: eventLocation.trim() || '',
        type: eventName.toLowerCase().includes('game') ? 'game' : 'practice',
        teamId: createdTeamId,
        createdBy: userData.uid,
        createdByName: userData.name || '',
      });
      setEventCreated(true);
      setStep('invite');
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const handleEventSkip = () => setStep('invite');

  // ─ Invite link ─
  // Generate ONE invite the first time the invite step is entered.
  // 30-day expiry, unlimited uses — coach can revoke + regenerate
  // later from the team page.
  useEffect(() => {
    if (step !== 'invite') return;
    if (inviteLink) return;
    if (!userData || !createdTeamId) return;
    (async () => {
      try {
        const inv = await createPlayerInvite({
          teamId: createdTeamId,
          playerId: '',  // open invite, no specific player
          createdBy: userData.uid,
          ttlDays: 30,
          maxUses: null,
          note: 'Welcome invite',
        });
        setInviteLink(inviteUrl(inv.id));
      } catch (err: any) {
        setError(`Couldn't generate invite link: ${err?.message || err}`);
      }
    })();
  }, [step, userData, createdTeamId, inviteLink]);

  const handleShare = async () => {
    if (!inviteLink) return;
    const isNative = Capacitor.isNativePlatform();
    try {
      if (isNative) {
        await Share.share({
          title: `Join ${teamName}`,
          text: `Join our team on GoalKickr: ${inviteLink}`,
          url: inviteLink,
        });
      } else if ((navigator as any).share) {
        await (navigator as any).share({
          title: `Join ${teamName}`,
          text: `Join our team on GoalKickr: ${inviteLink}`,
          url: inviteLink,
        });
      } else {
        await navigator.clipboard.writeText(inviteLink);
        setCopyState('copied');
        setTimeout(() => setCopyState('idle'), 2000);
      }
    } catch { /* user cancelled share — ignore */ }
  };

  const handleCopy = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      window.prompt('Copy this link:', inviteLink);
    }
  };

  // ─ Render ─
  return (
    <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-900 to-charcoal-950 text-bone">
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <StepIndicator currentStep={step} isClubTier={isClubTier} />

        {step === 'welcome' && (
          <Card>
            <Kicker>Welcome</Kicker>
            <H>What are you setting up?</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              Pick whichever fits. You can convert from team to club later if it grows.
            </p>

            <div className="mt-5 space-y-3">
              <TrackOption
                selected={intent === 'team'}
                onClick={() => setIntent('team')}
                label="A team"
                blurb="One team I coach. Roster, RSVPs, chat, gameday, development plans."
                pricing="Coach $99/yr or $10/mo · 7-day free trial"
              />
              <TrackOption
                selected={intent === 'club'}
                onClick={() => setIntent('club')}
                label="A club"
                blurb="Multiple teams under one organization. Registrations, dues, club admin, financial reporting."
                pricing="Club $299/yr · waived for clubs running registrations through GoalKickr"
              />
            </div>

            {/* Escape hatch for users who landed here by mistake.
                Patrick 2026-06-26: 'what if I was a parent but
                decided to use a different email? no place for a
                code?' If they have an invite code (parent OR
                coach invited as staff), let them out of the
                team/club setup wizard and into the standard
                invite consume flow. */}
            <div className="mt-5 pt-4 border-t border-white/10 space-y-2">
              <p className="text-bone/55 text-xs">
                Already have an invite code from a coach or club admin?
              </p>
              <InviteCodeRow />
            </div>

            {subscription && (
              <p className="mt-5 text-charcoal-400 text-xs">
                Active subscription: <span className="text-bone font-semibold">{
                  tier === 'founder' ? 'Founder Rate ($5/mo lifetime)'
                  : tier === 'annual' ? 'Coach Annual ($99/yr)'
                  : tier === 'monthly' ? 'Coach Monthly ($10/mo)'
                  : tier === 'club' ? 'Club ($299/yr)'
                  : tier === 'club-pro' ? 'Club Pro ($499/yr)'
                  : 'GoalKickr'
                }</span>
              </p>
            )}

            <PrimaryButton onClick={() => setStep('team')} className="mt-7 w-full">
              Continue
            </PrimaryButton>
          </Card>
        )}

        {step === 'team' && (
          <Card>
            <Kicker>Step 1{isClubTier ? ' of 3' : ' of 2'}</Kicker>
            <H>Name your team.</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              You can edit any of this later from Team Settings.
            </p>
            <Field label="Team name">
              <input
                type="text"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                className="form-input"
                placeholder="e.g. Fire FC U10"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Format">
                <select value={teamFormat} onChange={e => setTeamFormat(e.target.value)} className="form-input">
                  {TEAM_FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </Field>
              <Field label="Age group">
                <select value={teamAgeGroup} onChange={e => setTeamAgeGroup(e.target.value)} className="form-input">
                  {AGE_GROUPS.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
            </div>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <PrimaryButton onClick={handleCreateTeam} disabled={busy || !teamName.trim()} className="mt-6 w-full">
              {busy ? 'Creating team…' : 'Create team'}
            </PrimaryButton>
          </Card>
        )}

        {step === 'club' && isClubTier && (
          <Card>
            <Kicker>Step 2 of 3</Kicker>
            <H>Name your club.</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              The club is the umbrella over all your teams. You can connect Stripe
              later when you&apos;re ready to collect dues.
            </p>
            <Field label="Club name">
              <input
                type="text"
                value={clubName}
                onChange={e => setClubName(e.target.value)}
                className="form-input"
                placeholder="e.g. Fire FC"
              />
            </Field>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <PrimaryButton onClick={handleCreateClub} disabled={busy || !clubName.trim()} className="mt-6 w-full">
              {busy ? 'Creating club…' : 'Create club'}
            </PrimaryButton>
          </Card>
        )}

        {step === 'roster' && createdTeamId && (
          <Card>
            <Kicker>Add your roster</Kicker>
            <H>Who&apos;s on your team?</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              Drop in players + parent emails. Parents get a link to join in their inbox.
              Skip rows you&apos;re not ready for. Add the rest later from the Team page.
            </p>
            <div className="mt-5">
              <BulkAddPlayersForm
                teamId={createdTeamId}
                teamName={teamName}
                primaryLabel="Add players + send parent invites"
                skipLabel="Skip for now"
                onComplete={(r) => {
                  setRosterResult(r);
                  setStep('event');
                }}
                onSkip={() => setStep('event')}
              />
            </div>
          </Card>
        )}

        {step === 'event' && (
          <Card>
            <Kicker>Add your first practice</Kicker>
            <H>Get something on the calendar.</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              We pre-filled tomorrow at 6:30 PM. Edit anything and save, or skip if you&apos;re not ready.
              Parents you just invited will see it the moment they join.
            </p>

            <Field label="What is it?">
              <input
                type="text"
                value={eventName}
                onChange={e => setEventName(e.target.value)}
                className="form-input"
                placeholder="Practice, Game vs ..., etc."
              />
            </Field>
            <Field label="When">
              <input
                type="datetime-local"
                value={eventWhen}
                onChange={e => setEventWhen(e.target.value)}
                className="form-input"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Duration">
                <select
                  value={eventDurationMins}
                  onChange={e => setEventDurationMins(Number(e.target.value))}
                  className="form-input"
                >
                  <option value={60}>1 hour</option>
                  <option value={75}>1 hr 15 min</option>
                  <option value={90}>1 hr 30 min</option>
                  <option value={105}>1 hr 45 min</option>
                  <option value={120}>2 hours</option>
                </select>
              </Field>
              <Field label="Location (optional)">
                <input
                  type="text"
                  value={eventLocation}
                  onChange={e => setEventLocation(e.target.value)}
                  className="form-input"
                  placeholder="Sullivan Park field 5"
                />
              </Field>
            </div>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            <PrimaryButton onClick={handleEventSave} disabled={busy || !eventName.trim()} className="mt-6 w-full">
              {busy ? 'Saving…' : 'Add to schedule'}
            </PrimaryButton>

            <button
              type="button"
              onClick={handleEventSkip}
              className="mt-3 w-full px-5 py-3 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition"
            >
              Skip for now
            </button>
          </Card>
        )}

        {step === 'invite' && (
          <Card>
            <Kicker>Step {isClubTier ? '3 of 3' : '2 of 2'}</Kicker>
            <H>Invite your parents.</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              Share this link with parents. They&apos;ll sign in, add their player, and join your team.
              You can revoke or regenerate it later from the Team page.
            </p>
            {inviteLink ? (
              <>
                <div className="mt-5 rounded-md bg-charcoal-950 ring-1 ring-white/10 px-4 py-3 text-cyan-300 font-mono text-sm break-all">
                  {inviteLink}
                </div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="px-4 py-2.5 rounded-md bg-charcoal-800 ring-1 ring-white/10 hover:ring-white/25 font-bold text-sm transition"
                  >
                    {copyState === 'copied' ? 'Copied!' : 'Copy link'}
                  </button>
                  <button
                    type="button"
                    onClick={handleShare}
                    className="px-4 py-2.5 rounded-md bg-charcoal-800 ring-1 ring-white/10 hover:ring-white/25 font-bold text-sm transition"
                  >
                    Share…
                  </button>
                </div>
              </>
            ) : (
              <div className="mt-5 text-charcoal-400 text-sm">Generating link…</div>
            )}
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <button
              type="button"
              onClick={() => setStep('done')}
              className="mt-6 w-full px-5 py-3 rounded-md font-bold text-sm ring-1 ring-white/15 hover:bg-white/5 transition"
            >
              I&apos;ll do this later
            </button>
            <PrimaryButton onClick={() => setStep('done')} className="mt-3 w-full">
              All set
            </PrimaryButton>
          </Card>
        )}

        {step === 'done' && (
          <Card>
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/10 ring-2 ring-emerald-400/40 mx-auto mb-5">
              <svg className="w-8 h-8 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <Kicker>Almost done</Kicker>
            <H>{isClubTrack ? 'Start your club subscription.' : 'Start your free trial.'}</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              <span className="text-bone font-semibold">{teamName}</span> is set up.
              {isClubTrack
                ? ' Club includes unlimited teams, registrations, dues, and financial reporting. The fee is waived if your club processes $15K+/yr in registrations through GoalKickr.'
                : ' Start your 7-day free trial to unlock everything — chat, RSVPs, gameday, development plans. No charge for 7 days, cancel anytime.'}
            </p>

            {/* Pricing snapshot. Tier shown depends on the track the
                user picked on the welcome step. */}
            <div className="mt-5 rounded-lg bg-charcoal-950/80 ring-1 ring-white/10 px-4 py-3 space-y-1">
              {isClubTrack ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-bone font-bold text-sm">Club</span>
                    <span className="text-bone font-black tabular-nums">
                      $299<span className="text-charcoal-400 text-xs font-bold ml-0.5">/yr</span>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-bone/80 text-sm">Club Pro</span>
                    <span className="text-bone/80 tabular-nums">
                      $499<span className="text-charcoal-400 text-xs ml-0.5">/yr</span>
                    </span>
                  </div>
                  <p className="text-charcoal-400 text-[11px] pt-1">
                    Club fee waived when you process $15K+/yr in registrations through GoalKickr. Cancel anytime from goalkickr.com.
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-bone font-bold text-sm">Coach Annual</span>
                    <span className="text-bone font-black tabular-nums">
                      $99<span className="text-charcoal-400 text-xs font-bold ml-0.5">/yr</span>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-bone/80 text-sm">Coach Monthly</span>
                    <span className="text-bone/80 tabular-nums">
                      $10<span className="text-charcoal-400 text-xs ml-0.5">/mo</span>
                    </span>
                  </div>
                  <p className="text-charcoal-400 text-[11px] pt-1">
                    Both include a 7-day free trial. Cancel anytime from goalkickr.com.
                  </p>
                </>
              )}
            </div>

            <PrimaryButton
              onClick={() => openWebSignup({
                email: currentUser?.email || userData?.email || undefined,
                uid: currentUser?.uid,
                tier: isClubTrack ? 'club' : 'annual',
                intent: 'subscribe',
              })}
              className="mt-5 w-full"
            >
              {isClubTrack ? 'Start Club subscription' : 'Start 7-day free trial'}
            </PrimaryButton>

            <button
              type="button"
              onClick={() => setShowSkipModal(true)}
              className="mt-3 w-full px-5 py-3 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition"
            >
              Skip for now
            </button>

            <p className="text-charcoal-500 text-[11px] text-center mt-3 leading-snug">
              Tapping Start opens goalkickr.com in your browser to complete checkout.
            </p>
          </Card>
        )}
      </div>

      {/* Skip-with-friction modal on the done step. Loss-aversion
          nudge before they bail on the trial. Two paths out: open
          the marketing checkout, or go to dashboard without trial. */}
      {showSkipModal && (
        <div
          className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 animate-fade-in"
          onClick={() => setShowSkipModal(false)}
        >
          <div
            className="bg-charcoal-900 ring-1 ring-white/10 rounded-2xl p-5 sm:p-6 w-full max-w-md space-y-4 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div>
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-amber-400 mb-1.5">
                Wait
              </p>
              <h3 className="text-bone text-lg font-bold leading-tight">
                {isClubTrack ? 'Skip the Club subscription?' : 'Skip your 7-day free trial?'}
              </h3>
              <p className="text-charcoal-300 text-sm mt-2">
                You can still use the app for free, but you&apos;ll miss:
              </p>
              <ul className="mt-3 space-y-2 text-charcoal-200 text-sm">
                {[
                  'Unlimited parent invites and team chat',
                  'Push notifications for events and messages',
                  'Player development plans and Player of the Match',
                  'Game day tracker with live subs and stats',
                ].map(b => (
                  <li key={b} className="flex items-start gap-2">
                    <svg className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowSkipModal(false);
                  navigate('/dashboard', { replace: true });
                }}
                className="px-4 py-2.5 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition"
              >
                Continue without
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowSkipModal(false);
                  openWebSignup({
                    email: currentUser?.email || userData?.email || undefined,
                    uid: currentUser?.uid,
                    tier: isClubTrack ? 'club' : 'annual',
                    intent: 'subscribe',
                  });
                }}
                className="px-4 py-2.5 rounded-md font-bold text-sm bg-brand-primary hover:bg-brand-primary text-white transition"
              >
                {isClubTrack ? 'Subscribe' : 'Try anyway'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .form-input {
          width: 100%;
          background: #0f1116;
          border: 1px solid rgba(255,255,255,0.10);
          color: var(--bone, #f1e9d8);
          padding: 0.6rem 0.75rem;
          border-radius: 0.4rem;
          font-size: 0.95rem;
        }
        .form-input:focus {
          outline: none;
          border-color: rgb(225 29 72 / 0.6);
        }
      `}</style>
    </div>
  );
};

// ── Small, file-local presentational pieces ─────────────────────
const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="bg-charcoal-900/80 backdrop-blur ring-1 ring-white/10 rounded-2xl p-6 sm:p-8 shadow-xl">{children}</div>
);
const Kicker: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-2">{children}</p>
);
const H: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h1 className="text-2xl sm:text-3xl font-black text-bone tracking-tight">{children}</h1>
);
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block mt-5">
    <span className="block text-charcoal-300 text-[11px] font-bold uppercase tracking-widest mb-1.5">{label}</span>
    {children}
  </label>
);
const ErrorBanner: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mt-4 rounded-md bg-brand-primary-deep/40 ring-1 ring-brand-primary/40 px-3 py-2 text-brand-primary-soft text-sm">{children}</div>
);
const TrackOption: React.FC<{
  selected: boolean;
  onClick: () => void;
  label: string;
  blurb: string;
  pricing: string;
}> = ({ selected, onClick, label, blurb, pricing }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full text-left rounded-lg p-4 transition-all ${
      selected
        ? 'bg-gradient-to-br from-brand-primary-deep/40 to-charcoal-900 ring-2 ring-brand-primary shadow-lg shadow-brand-primary-deep/30'
        : 'bg-charcoal-900/60 ring-1 ring-white/10 hover:ring-white/25'
    }`}
  >
    <div className="flex items-start gap-3">
      <span className={`shrink-0 mt-1 w-4 h-4 rounded-full ring-2 ${
        selected ? 'bg-brand-primary ring-brand-primary-soft' : 'bg-transparent ring-white/30'
      }`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-bone font-bold">{label}</p>
        <p className="text-charcoal-300 text-xs mt-1 leading-snug">{blurb}</p>
        <p className="text-charcoal-500 text-[11px] mt-2">{pricing}</p>
      </div>
    </div>
  </button>
);

const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', children, ...rest }) => (
  <button
    type="button"
    className={`px-5 py-3 rounded-md font-bold text-sm bg-brand-primary hover:bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40 ring-1 ring-brand-primary-soft/20 transition disabled:opacity-60 disabled:cursor-wait ${className}`}
    {...rest}
  >
    {children}
  </button>
);
const StepIndicator: React.FC<{ currentStep: Step; isClubTier: boolean }> = ({ currentStep, isClubTier }) => {
  const order: Step[] = isClubTier
    ? ['welcome', 'team', 'club', 'roster', 'event', 'invite', 'done']
    : ['welcome', 'team', 'roster', 'event', 'invite', 'done'];
  const idx = order.indexOf(currentStep);
  return (
    <div className="flex items-center gap-1.5 mb-7">
      {order.map((s, i) => (
        <div
          key={s}
          className={`flex-1 h-1 rounded ${i <= idx ? 'bg-brand-primary' : 'bg-white/10'}`}
        />
      ))}
    </div>
  );
};

// Inline invite-code input. Submitting routes to /join/<code> which
// runs the existing invite-consume flow (validates the code, attaches
// the user to the correct team, sets role appropriately). Lives at
// the bottom of the welcome step so a user who landed here by mistake
// has a way out without picking 'team' or 'club' first.
const InviteCodeRow: React.FC = () => {
  const [code, setCode] = React.useState('');
  const handleGo = () => {
    const c = code.trim();
    if (!c) return;
    window.location.href = `/join/${encodeURIComponent(c)}`;
  };
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Invite code"
        className="flex-1 bg-charcoal-900 border border-white/10 rounded-lg px-3 py-2 text-bone placeholder:text-bone/30 text-sm"
      />
      <button
        type="button"
        onClick={handleGo}
        disabled={!code.trim()}
        className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 text-bone text-xs font-bold whitespace-nowrap"
      >
        Use code
      </button>
    </div>
  );
};

export default Onboarding;
