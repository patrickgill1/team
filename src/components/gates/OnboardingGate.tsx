// @ts-nocheck
import React, { useState } from 'react';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { Button } from '../ui';

/**
 * Replaces the old 'Waiting for Approval' and 'Almost There' dead-
 * end screens. A new user who doesn't have a player linked and
 * isn't approved gets three concrete next steps instead of a wall:
 *
 *   1. Enter invite code  — paste a code their coach sent
 *   2. Start a team       — they're a coach launching their own
 *   3. Start a club       — they run multiple teams
 *
 * Each path provisions the relevant Firestore docs and patches the
 * user record so they're approved + attached on the spot. The
 * previous lockdown (preventing random people from creating teams
 * in someone else's club) stays intact: these flows always create
 * a NEW team/club where this user is the owner — they cannot drop
 * themselves into an existing one without an invite.
 */

type Mode = 'menu' | 'invite' | 'team' | 'club';

interface Props {
  onSignOut: () => void;
}

const OnboardingGate: React.FC<Props> = ({ onSignOut }) => {
  const { userData, currentUser, refreshUserData } = useAuth();
  const { createTeam, createClub } = useFirestore();
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inviteCode, setInviteCode] = useState('');
  const [teamName, setTeamName] = useState('');
  const [clubName, setClubName] = useState('');
  const [clubFirstTeam, setClubFirstTeam] = useState('');

  const uid = userData?.uid || currentUser?.uid;
  const userEmail = userData?.email || currentUser?.email || '';

  const finishWithRefresh = async () => {
    // Pull the fresh user doc so App's gate re-evaluates and lets us in.
    if (refreshUserData) await refreshUserData();
    window.location.reload();
  };

  const handleInvite = async () => {
    if (!uid || !inviteCode.trim()) return;
    setBusy(true); setError(null);
    try {
      // Reuse the standard invite-consume route. It does the proper
      // team attachment, invite-doc mutation, and parent-link work.
      window.location.href = `/join/${encodeURIComponent(inviteCode.trim())}`;
    } catch (e: any) {
      setError(e?.message || 'Could not apply invite code.');
      setBusy(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!uid || !teamName.trim()) return;
    setBusy(true); setError(null);
    try {
      const teamId = await createTeam({
        name: teamName.trim(),
        coachIds: [uid],
        headCoachId: uid,
        assistantCoachIds: [],
        playerIds: [],
        parentIds: [],
        season: new Date().getFullYear().toString(),
        ageGroup: '',
      } as any);
      // Patrick's data-model intent: every team belongs to a club,
      // even solo coaches get a default one named after the team so
      // 'becoming a club later' is a no-op. The default wrapper
      // gets isDefaultSoloClub: true so the admin portal + billing
      // can distinguish solo-coach accounts from real multi-team
      // clubs (Coach $99/yr vs Club $499/yr Pro tier).
      const clubId = await createClub({
        name: teamName.trim(),
        ownerUid: uid,
        initialTeamId: teamId,
      });
      await updateDoc(doc(db, 'clubs', clubId), { isDefaultSoloClub: true });
      // Stamp the team's clubId so multi-tenant scoping works.
      await updateDoc(doc(db, 'teams', teamId), { clubId });
      // Patch the user as a coach attached to the new team + club.
      await updateDoc(doc(db, 'users', uid), {
        role: 'coach',
        teamId,
        teamIds: arrayUnion(teamId),
        clubIds: arrayUnion(clubId),
        approved: true,
        approvalStatus: 'self-created-team',
      });
      await finishWithRefresh();
    } catch (e: any) {
      console.error('[onboarding] createTeam failed', e);
      setError(e?.message || 'Could not create team. Try again.');
      setBusy(false);
    }
  };

  const handleCreateClub = async () => {
    if (!uid || !clubName.trim() || !clubFirstTeam.trim()) return;
    setBusy(true); setError(null);
    try {
      const teamId = await createTeam({
        name: clubFirstTeam.trim(),
        coachIds: [uid],
        headCoachId: uid,
        assistantCoachIds: [],
        playerIds: [],
        parentIds: [],
        season: new Date().getFullYear().toString(),
        ageGroup: '',
      } as any);
      const clubId = await createClub({
        name: clubName.trim(),
        ownerUid: uid,
        initialTeamId: teamId,
      });
      await updateDoc(doc(db, 'teams', teamId), { clubId });
      await updateDoc(doc(db, 'users', uid), {
        role: 'coach',
        isClubAdmin: false,  // platform-controlled flag; club ownership is via clubs.ownerUid
        teamId,
        teamIds: arrayUnion(teamId),
        clubIds: arrayUnion(clubId),
        approved: true,
        approvalStatus: 'self-created-club',
      });
      await finishWithRefresh();
    } catch (e: any) {
      console.error('[onboarding] createClub failed', e);
      setError(e?.message || 'Could not create club. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-900 to-charcoal-950 flex items-start justify-center px-4 pt-[calc(env(safe-area-inset-top)+4rem)] pb-10">
      <div className="w-full max-w-sm space-y-5">
        {mode === 'menu' && (
          <>
            <div className="text-center">
              <p className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-2">Welcome</p>
              <h1 className="text-3xl font-black text-bone leading-tight">What's next?</h1>
              <p className="text-bone/60 text-sm mt-2">Signed in as <span className="text-bone/80 font-mono text-xs">{userEmail}</span></p>
            </div>
            <ActionCard
              title="Enter invite code"
              hint="Your coach or club admin sent you a link or code."
              onClick={() => setMode('invite')}
            />
            <ActionCard
              title="Start a team"
              hint="You're a coach launching a new team."
              onClick={() => setMode('team')}
            />
            <ActionCard
              title="Start a club"
              hint="You run multiple teams under one organization."
              onClick={() => setMode('club')}
            />
            <button
              type="button"
              onClick={onSignOut}
              className="w-full text-center text-bone/40 hover:text-bone/70 text-sm font-semibold pt-2"
            >
              Sign out
            </button>
          </>
        )}

        {mode === 'invite' && (
          <FormShell title="Enter invite code" back={() => setMode('menu')} error={error}>
            <label className="block">
              <span className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1.5 block">Code</span>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Paste your invite code"
                className="w-full bg-charcoal-900 border border-white/10 rounded-lg px-3 py-3 text-bone placeholder:text-bone/30"
                autoFocus
              />
            </label>
            <Button variant="primary" onClick={handleInvite} disabled={busy || !inviteCode.trim()} fullWidth>
              {busy ? 'Opening...' : 'Continue'}
            </Button>
          </FormShell>
        )}

        {mode === 'team' && (
          <FormShell title="Start a team" back={() => setMode('menu')} error={error}>
            <label className="block">
              <span className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1.5 block">Team name</span>
              <input
                type="text"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="e.g. Eagles U12"
                className="w-full bg-charcoal-900 border border-white/10 rounded-lg px-3 py-3 text-bone placeholder:text-bone/30"
                autoFocus
              />
            </label>
            <p className="text-xs text-bone/55 leading-relaxed">
              You'll be set as head coach. You can fill in age group, season, and roster from Settings later.
            </p>
            <Button variant="primary" onClick={handleCreateTeam} disabled={busy || !teamName.trim()} fullWidth>
              {busy ? 'Creating...' : 'Create team'}
            </Button>
          </FormShell>
        )}

        {mode === 'club' && (
          <FormShell title="Start a club" back={() => setMode('menu')} error={error}>
            <label className="block">
              <span className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1.5 block">Club name</span>
              <input
                type="text"
                value={clubName}
                onChange={(e) => setClubName(e.target.value)}
                placeholder="e.g. Riverside Soccer Club"
                className="w-full bg-charcoal-900 border border-white/10 rounded-lg px-3 py-3 text-bone placeholder:text-bone/30"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1.5 block">First team name</span>
              <input
                type="text"
                value={clubFirstTeam}
                onChange={(e) => setClubFirstTeam(e.target.value)}
                placeholder="e.g. U12 Boys"
                className="w-full bg-charcoal-900 border border-white/10 rounded-lg px-3 py-3 text-bone placeholder:text-bone/30"
              />
            </label>
            <p className="text-xs text-bone/55 leading-relaxed">
              You'll be the club owner and head coach of the first team. Additional teams and admins can be added later.
            </p>
            <Button
              variant="primary"
              onClick={handleCreateClub}
              disabled={busy || !clubName.trim() || !clubFirstTeam.trim()}
              fullWidth
            >
              {busy ? 'Creating...' : 'Create club'}
            </Button>
          </FormShell>
        )}
      </div>
    </div>
  );
};

const ActionCard: React.FC<{ title: string; hint: string; onClick: () => void }> = ({ title, hint, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full text-left bg-charcoal-900 hover:bg-charcoal-900/80 border border-white/10 hover:border-brand-primary/40 rounded-2xl p-4 transition-colors group"
  >
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-bone font-bold text-base leading-tight">{title}</p>
        <p className="text-bone/55 text-xs mt-1 leading-snug">{hint}</p>
      </div>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-5 h-5 text-bone/40 group-hover:text-brand-primary flex-shrink-0">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </div>
  </button>
);

const FormShell: React.FC<{ title: string; back: () => void; error: string | null; children: React.ReactNode }> = ({ title, back, error, children }) => (
  <div className="space-y-4">
    <button
      type="button"
      onClick={back}
      className="flex items-center gap-1.5 text-bone/55 hover:text-bone text-xs font-bold tracking-wide"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      Back
    </button>
    <h2 className="text-2xl font-black text-bone">{title}</h2>
    <div className="space-y-4">{children}</div>
    {error && (
      <p className="text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg p-3">{error}</p>
    )}
  </div>
);

export default OnboardingGate;
