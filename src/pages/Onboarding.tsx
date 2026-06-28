// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useSubscription } from '../hooks/useSubscription';
import { createPlayerInvite, createStaffInvite, inviteUrl } from '../utils/invites';
import { sendEmail } from '../utils/notify';
import { openWebSignup } from '../utils/subscriptionApi';
import BulkAddPlayersForm from '../components/people/BulkAddPlayersForm';
import { Share } from '@capacitor/share';
import { Capacitor } from '@capacitor/core';
import { useTheme, type ThemeMode, isThemePickerVisible } from '../contexts/ThemeContext';

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
  const [teamAgeGroup, setTeamAgeGroup] = useState('');
  // Kit colors are free-form strings so clubs can use everything from
  // "Black" to "Red & Gold" to "Royal Blue / White". Left blank by
  // default — the event form hides the swatch label when unset rather
  // than guessing.
  const [homeKitColor, setHomeKitColor] = useState('');
  const [awayKitColor, setAwayKitColor] = useState('');
  const [clubName, setClubName] = useState(firstName ? `${firstName}'s club` : '');
  // Staff invites collected on the parents-invite step. One row per
  // staff member, with role (assistant_coach | team_manager). Emails
  // get an invite link to claim the role once they sign in.
  const [staffEmails, setStaffEmails] = useState<Array<{ email: string; role: 'assistant_coach' | 'team_manager' }>>([
    { email: '', role: 'assistant_coach' },
  ]);
  const [staffSentCount, setStaffSentCount] = useState(0);
  const [staffBusy, setStaffBusy] = useState(false);
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
        homeKitColor: homeKitColor.trim() || undefined,
        awayKitColor: awayKitColor.trim() || undefined,
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

  // ─ Staff invites ─
  // Generate one invite link per email + send a short branded email.
  // Skipped rows with no email are ignored. Failures don't block the
  // ones that succeed — sentCount reflects how many actually landed.
  const handleSendStaffInvites = async () => {
    if (!userData || !createdTeamId) return;
    const validRows = staffEmails.filter(r => r.email.trim().includes('@'));
    if (validRows.length === 0) return;
    setStaffBusy(true);
    setError(null);
    let sent = 0;
    try {
      for (const row of validRows) {
        try {
          const inv = await createStaffInvite({
            teamId: createdTeamId,
            role: row.role,
            createdBy: userData.uid,
            maxUses: 1,
            note: `Invited by ${userData.name || 'the coach'} during onboarding`,
          });
          const link = inviteUrl(inv.id);
          const roleLabel = row.role === 'team_manager' ? 'team manager' : 'assistant coach';
          const coachFirst = (userData.name || '').split(' ')[0] || 'Coach';
          await sendEmail({
            to: row.email.trim(),
            subject: `${coachFirst} added you as ${roleLabel === 'team manager' ? 'team manager' : 'assistant coach'} on ${teamName}`,
            text: [
              `Hi,`,
              ``,
              `${userData.name || 'The coach'} added you as ${roleLabel} for ${teamName} on GoalKickr.`,
              ``,
              `Tap to claim your spot:`,
              link,
              ``,
              `This link is just for you and works once.`,
              ``,
              `App Store: https://apps.apple.com/app/id6770324158`,
              `Google Play: https://play.google.com/store/apps/details?id=com.firefc.team`,
            ].join('\n'),
          });
          sent += 1;
        } catch (rowErr) {
          console.warn('staff invite row failed', rowErr);
        }
      }
      setStaffSentCount(sent);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setStaffBusy(false);
    }
  };

  const updateStaffRow = (i: number, patch: Partial<{ email: string; role: 'assistant_coach' | 'team_manager' }>) => {
    setStaffEmails(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  };
  const addStaffRow = () => setStaffEmails(prev => [...prev, { email: '', role: 'assistant_coach' }]);
  const removeStaffRow = (i: number) => setStaffEmails(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev);

  // ─ Render ─
  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-elevated to-surface-base text-ink-primary">
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
            <div className="mt-5 pt-4 border-t border-line-default/10 space-y-2">
              <p className="text-ink-primary/55 text-xs">
                Already have an invite code from a coach or club admin?
              </p>
              <InviteCodeRow />
            </div>

            {/* Small appearance picker. Defaults to Dark for new users.
                Owner-only via isThemePickerVisible() until the next
                iOS + Android binaries ship with the underlay fixes.
                Sits below the primary CTAs so it reads as a quiet
                flourish, not competing with the team/club decision. */}
            {isThemePickerVisible(userData) && <ThemePickerStrip />}

            {subscription && (
              <p className="mt-5 text-charcoal-400 text-xs">
                Active subscription: <span className="text-ink-primary font-semibold">{
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
            <H>Name your squad.</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              Change any of this later from Team HQ.
            </p>
            <Field label="Team name">
              <input
                type="text"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                className="form-input"
                placeholder="e.g. Eagles U10"
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
                  <option value="">Choose…</option>
                  {AGE_GROUPS.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
            </div>

            {/* Kit colors — free-form so clubs aren't forced into a
                10-option palette ("Royal Blue / White" beats picking
                'Blue'). Optional: parents see "Home" / "Away" on the
                event card when blank, your kit name when set. */}
            <div className="mt-3">
              <p className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-1.5">
                Kit colors <span className="text-ink-primary/40 font-normal normal-case tracking-normal">(optional, shows on event cards)</span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Home kit">
                  <input
                    type="text"
                    value={homeKitColor}
                    onChange={e => setHomeKitColor(e.target.value)}
                    className="form-input"
                    placeholder="e.g. Black"
                  />
                </Field>
                <Field label="Away kit">
                  <input
                    type="text"
                    value={awayKitColor}
                    onChange={e => setAwayKitColor(e.target.value)}
                    className="form-input"
                    placeholder="e.g. White"
                  />
                </Field>
              </div>
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
              The club is the umbrella over all your teams. You can turn on payments
              later when you&apos;re ready to collect dues.
            </p>
            <Field label="Club name">
              <input
                type="text"
                value={clubName}
                onChange={e => setClubName(e.target.value)}
                className="form-input"
                placeholder="e.g. Riverside SC"
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
            <Kicker>Build the squad</Kicker>
            <H>Who&apos;s in?</H>
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
            <Kicker>First session</Kicker>
            <H>Put something on the calendar.</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              We pre-filled tomorrow at 6:30 PM. Tweak and save, or skip for now.
              Parents you just brought in see it the moment they're in.
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
              className="mt-3 w-full px-5 py-3 rounded-md font-bold text-sm ring-1 ring-line-default/15 text-ink-primary hover:bg-line-default/5 transition"
            >
              Skip for now
            </button>
          </Card>
        )}

        {step === 'invite' && (
          <Card>
            <Kicker>Step {isClubTier ? '3 of 3' : '2 of 2'}</Kicker>
            <H>Bring parents in.</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              Send this link to parents. They sign in, claim their player, and they're in.
              Revoke or regenerate it anytime from the Team page.
            </p>
            {inviteLink ? (
              <>
                <div className="mt-5 rounded-md bg-surface-base ring-1 ring-line-default/10 px-4 py-3 text-cyan-300 font-mono text-sm break-all">
                  {inviteLink}
                </div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="px-4 py-2.5 rounded-md bg-surface-input ring-1 ring-line-default/10 hover:ring-line-default/25 font-bold text-sm transition"
                  >
                    {copyState === 'copied' ? 'Copied!' : 'Copy link'}
                  </button>
                  <button
                    type="button"
                    onClick={handleShare}
                    className="px-4 py-2.5 rounded-md bg-surface-input ring-1 ring-line-default/10 hover:ring-line-default/25 font-bold text-sm transition"
                  >
                    Share…
                  </button>
                </div>
              </>
            ) : (
              <div className="mt-5 text-charcoal-400 text-sm">Generating link…</div>
            )}

            {/* Bring in your staff — assistant coaches + team managers
                get one-use email invites that drop them into the right
                role on first sign-in. Skip the whole block by leaving
                emails blank. */}
            <div className="mt-7 pt-6 border-t border-line-default/10">
              <p className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-1">
                Bring in your staff
              </p>
              <p className="text-charcoal-300 text-sm mb-3">
                Assistant coaches and team managers get an email invite that lands them
                in the right role. Skip if you&apos;re the only one running things.
              </p>
              <div className="space-y-2">
                {staffEmails.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                    <input
                      type="email"
                      value={row.email}
                      onChange={e => updateStaffRow(i, { email: e.target.value })}
                      className="form-input"
                      placeholder="coach@example.com"
                      autoComplete="off"
                    />
                    <select
                      value={row.role}
                      onChange={e => updateStaffRow(i, { role: e.target.value as any })}
                      className="form-input"
                    >
                      <option value="assistant_coach">Asst. Coach</option>
                      <option value="team_manager">Team Mgr</option>
                    </select>
                    {staffEmails.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeStaffRow(i)}
                        className="px-2 py-2 text-ink-primary/55 hover:text-rose-300"
                        aria-label="Remove row"
                        title="Remove"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    ) : <span className="w-8" aria-hidden />}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addStaffRow}
                className="mt-2 text-[11px] font-extrabold tracking-widest uppercase text-brand-primary hover:text-brand-primary-dim"
              >
                + Add another
              </button>
              {staffSentCount > 0 && (
                <p className="mt-3 text-emerald-300 text-xs font-semibold">
                  Sent {staffSentCount} invite{staffSentCount === 1 ? '' : 's'}.
                </p>
              )}
              <button
                type="button"
                onClick={handleSendStaffInvites}
                disabled={staffBusy || !staffEmails.some(r => r.email.trim().includes('@'))}
                className="mt-3 w-full px-5 py-2.5 rounded-md bg-surface-input ring-1 ring-line-default/15 hover:ring-line-default/30 font-bold text-sm transition disabled:opacity-50"
              >
                {staffBusy ? 'Sending…' : 'Send staff invites'}
              </button>
            </div>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            <button
              type="button"
              onClick={() => setStep('done')}
              className="mt-6 w-full px-5 py-3 rounded-md font-bold text-sm ring-1 ring-line-default/15 hover:bg-line-default/5 transition"
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
              <span className="text-ink-primary font-semibold">{teamName}</span> is set up.
              {isClubTrack
                ? ' Club includes unlimited teams, registrations, dues, and financial reporting. The fee is waived if your club processes $15K+/yr in registrations through GoalKickr.'
                : ' Start your 7-day free trial to unlock everything — chat, RSVPs, gameday, development plans. No charge for 7 days, cancel anytime.'}
            </p>

            {/* Pricing snapshot. Tier shown depends on the track the
                user picked on the welcome step. */}
            <div className="mt-5 rounded-lg bg-surface-base/80 ring-1 ring-line-default/10 px-4 py-3 space-y-1">
              {isClubTrack ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-ink-primary font-bold text-sm">Club</span>
                    <span className="text-ink-primary font-black tabular-nums">
                      $299<span className="text-charcoal-400 text-xs font-bold ml-0.5">/yr</span>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-ink-primary/80 text-sm">Club Pro</span>
                    <span className="text-ink-primary/80 tabular-nums">
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
                    <span className="text-ink-primary font-bold text-sm">Coach Annual</span>
                    <span className="text-ink-primary font-black tabular-nums">
                      $99<span className="text-charcoal-400 text-xs font-bold ml-0.5">/yr</span>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-ink-primary/80 text-sm">Coach Monthly</span>
                    <span className="text-ink-primary/80 tabular-nums">
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
              className="mt-3 w-full px-5 py-3 rounded-md font-bold text-sm ring-1 ring-line-default/15 text-ink-primary hover:bg-line-default/5 transition"
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
            className="bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl p-5 sm:p-6 w-full max-w-md space-y-4 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div>
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-amber-400 mb-1.5">
                Wait
              </p>
              <h3 className="text-ink-primary text-lg font-bold leading-tight">
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
                className="px-4 py-2.5 rounded-md font-bold text-sm ring-1 ring-line-default/15 text-ink-primary hover:bg-line-default/5 transition"
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
  <div className="bg-surface-elevated/80 backdrop-blur ring-1 ring-line-default/10 rounded-2xl p-6 sm:p-8 shadow-xl">{children}</div>
);
const Kicker: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-2">{children}</p>
);
const H: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h1 className="text-2xl sm:text-3xl font-black text-ink-primary tracking-tight">{children}</h1>
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
        ? 'bg-gradient-to-br from-brand-primary-deep/40 to-surface-elevated ring-2 ring-brand-primary shadow-lg shadow-brand-primary-deep/30'
        : 'bg-surface-elevated/60 ring-1 ring-line-default/10 hover:ring-line-default/25'
    }`}
  >
    <div className="flex items-start gap-3">
      <span className={`shrink-0 mt-1 w-4 h-4 rounded-full ring-2 ${
        selected ? 'bg-brand-primary ring-brand-primary-soft' : 'bg-transparent ring-line-default/30'
      }`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-ink-primary font-bold">{label}</p>
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
          className={`flex-1 h-1 rounded ${i <= idx ? 'bg-brand-primary' : 'bg-line-default/10'}`}
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
// Slim three-up theme picker. Sits under the welcome step as a quiet
// "make GoalKickr feel like home" flourish. New users land on Dark
// by default (see ThemeContext.readStoredMode); tapping here writes
// to localStorage and flips the wizard live so they see the change.
const ThemePickerStrip: React.FC = () => {
  const { mode, setMode } = useTheme();
  const opts: { key: ThemeMode; label: string; hint: string; icon: React.ReactNode }[] = [
    {
      key: 'dark',
      label: 'Dark',
      hint: 'Default',
      icon: (
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ),
    },
    {
      key: 'light',
      label: 'Light',
      hint: 'Bright',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ),
    },
    {
      key: 'system',
      label: 'System',
      hint: 'Match device',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      ),
    },
  ];
  return (
    <div className="mt-5 pt-4 border-t border-line-default/10">
      <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/45 mb-2">
        Make it feel like home
      </p>
      <div className="grid grid-cols-3 gap-2">
        {opts.map(o => {
          const active = mode === o.key;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => setMode(o.key)}
              className={`rounded-xl px-2 py-2.5 text-center transition ring-1 ${
                active
                  ? 'bg-brand-primary/15 ring-brand-primary text-ink-primary'
                  : 'bg-surface-elevated ring-line-default/10 text-ink-primary/65 hover:text-ink-primary hover:ring-line-default/20'
              }`}
            >
              <div className="flex items-center justify-center text-ink-primary/80">{o.icon}</div>
              <div className="text-[12px] font-bold mt-1">{o.label}</div>
              <div className="text-[10px] text-ink-primary/45">{o.hint}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

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
        className="flex-1 bg-surface-elevated border border-line-default/10 rounded-lg px-3 py-2 text-ink-primary placeholder:text-ink-primary/30 text-sm"
      />
      <button
        type="button"
        onClick={handleGo}
        disabled={!code.trim()}
        className="px-3 py-2 rounded-lg bg-line-default/10 hover:bg-line-default/15 disabled:opacity-50 text-ink-primary text-xs font-bold whitespace-nowrap"
      >
        Use code
      </button>
    </div>
  );
};

export default Onboarding;
