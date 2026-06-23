// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { useSubscription } from '../hooks/useSubscription';
import { createPlayerInvite, inviteUrl } from '../utils/invites';
import { openWebSignup } from '../utils/subscriptionApi';
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

type Step = 'welcome' | 'team' | 'club' | 'invite' | 'done';

const Onboarding: React.FC = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { currentUser, userData, refreshUserData } = useAuth();
  const { createTeam, createClub, updateDocument } = useFirestore();
  const { subscription, tier } = useSubscription();

  const isClubTier = tier === 'club' || tier === 'club-pro';
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
      setStep(isClubTier ? 'club' : 'invite');
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
      setStep('invite');
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

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
            <H>You&apos;re in.</H>
            <p className="mt-4 text-charcoal-200 leading-relaxed">
              We&apos;ll get you set up in about a minute. First we&apos;ll create your team,
              {isClubTier && ' then your club,'} then generate a link your parents can use to join.
            </p>
            {subscription && (
              <p className="mt-3 text-charcoal-400 text-xs">
                Subscription: <span className="text-bone font-semibold">{
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
              Let&apos;s go
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
            <H>Start your free trial.</H>
            <p className="mt-3 text-charcoal-300 text-sm">
              <span className="text-bone font-semibold">{teamName}</span> is set up. Start your
              7-day free trial to unlock everything for your team — chat, RSVPs, gameday,
              development plans. No charge for 7 days, cancel anytime.
            </p>

            {/* Pricing snapshot so they know what they're agreeing to
                without leaving the wizard. Founder Rate is hidden on
                iOS per Apple anti-steering (the marketing page itself
                handles the full picker). */}
            <div className="mt-5 rounded-lg bg-charcoal-950/80 ring-1 ring-white/10 px-4 py-3 space-y-1">
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
            </div>

            <PrimaryButton
              onClick={() => openWebSignup({
                email: currentUser?.email || userData?.email || undefined,
                uid: currentUser?.uid,
                tier: 'annual',
                intent: 'subscribe',
              })}
              className="mt-5 w-full"
            >
              Start 7-day free trial
            </PrimaryButton>

            <button
              type="button"
              onClick={() => navigate('/dashboard', { replace: true })}
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
  <p className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400 mb-2">{children}</p>
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
  <div className="mt-4 rounded-md bg-crimson-950/40 ring-1 ring-crimson-700/40 px-3 py-2 text-crimson-100 text-sm">{children}</div>
);
const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className = '', children, ...rest }) => (
  <button
    type="button"
    className={`px-5 py-3 rounded-md font-bold text-sm bg-crimson-600 hover:bg-crimson-500 text-white shadow-lg shadow-crimson-900/40 ring-1 ring-crimson-400/20 transition disabled:opacity-60 disabled:cursor-wait ${className}`}
    {...rest}
  >
    {children}
  </button>
);
const StepIndicator: React.FC<{ currentStep: Step; isClubTier: boolean }> = ({ currentStep, isClubTier }) => {
  const order: Step[] = isClubTier
    ? ['welcome', 'team', 'club', 'invite', 'done']
    : ['welcome', 'team', 'invite', 'done'];
  const idx = order.indexOf(currentStep);
  return (
    <div className="flex items-center gap-2 mb-7">
      {order.map((s, i) => (
        <div
          key={s}
          className={`flex-1 h-1 rounded ${i <= idx ? 'bg-crimson-500' : 'bg-white/10'}`}
        />
      ))}
    </div>
  );
};

export default Onboarding;
