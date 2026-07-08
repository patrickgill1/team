// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFirestore } from '../hooks/useFirestore';
import { createPlayerInvite, createStaffInvite, inviteUrl } from '../utils/invites';
import { sendEmail } from '../utils/notify';
import { openWebSignup } from '../utils/subscriptionApi';
import BulkAddPlayersForm from '../components/people/BulkAddPlayersForm';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

// Multi-step first-run wizard for a freshly-signed-up coach.
// Patrick's spec (2026-07-08):
//   1. team          – name the team
//   2. kid-gate      – "do you have a kid on this team?"
//   3. add-kid       – if yes, add them
//   4. practice-days – "which days do you practice?"
//   5. preview       – 4-week mini calendar, uncheck dates
//   6. details       – time + location
//   7. confirm       – summary of the schedule
//   8. invite        – bulk player + parent-email rows
//   9. staff         – invite assistant coach / team manager
//  10. notifications – explain then trigger native prompt
//  11. checklist     – recap of what got done
//  12. another       – "add another team?" branch (loops back to team)
//  13. trial         – founder's deal ($5 mo / $50 yr for life) + 7-day free trial
//  14. done          – dashboard handoff
//
// Step lives in URL (?step=…) so a refresh mid-wizard keeps place.

const TEAM_FORMATS = [
  { id: '4v4', label: '4v4' },
  { id: '7v7', label: '7v7' },
  { id: '9v9', label: '9v9' },
  { id: '11v11', label: '11v11' },
];

const AGE_GROUPS = [
  'U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14', 'U15', 'U16', 'U17', 'U18', 'Adult',
];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LABELS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PREVIEW_WEEKS = 4;

type Step =
  | 'team'
  | 'kid-gate'
  | 'add-kid'
  | 'practice-days'
  | 'preview'
  | 'details'
  | 'confirm'
  | 'invite'
  | 'staff'
  | 'notifications'
  | 'checklist'
  | 'another'
  | 'trial'
  | 'done';

const ORDERED_STEPS: Step[] = [
  'team', 'kid-gate', 'add-kid', 'practice-days', 'preview', 'details',
  'confirm', 'invite', 'staff', 'notifications', 'checklist', 'another',
  'trial', 'done',
];

const STEP_TITLES: Record<Step, string> = {
  team: 'Name your team',
  'kid-gate': 'Family',
  'add-kid': 'Add your kid',
  'practice-days': 'Practice days',
  preview: 'Confirm dates',
  details: 'Time & place',
  confirm: 'Schedule',
  invite: 'Invite parents',
  staff: 'Add a coach',
  notifications: 'Notifications',
  checklist: 'Almost done',
  another: 'Another team?',
  trial: 'Founder’s deal',
  done: 'Ready to play',
};

const Onboarding: React.FC = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { currentUser, userData, refreshUserData } = useAuth();
  const { createTeam, createClub, updateDocument, addPlayer, addEvent } = useFirestore();

  const step = ((params.get('step') || 'team') as Step);
  const goStep = (s: Step) => {
    const next = new URLSearchParams(params);
    next.set('step', s);
    setParams(next, { replace: true });
    // Reset internal scroll on any step change so the header is
    // always visible (mobile safari otherwise preserves scroll).
    try { window.scrollTo(0, 0); } catch { /* no-op */ }
  };

  // ─── Form state ──────────────────────────────────────────────
  const firstName = (userData?.name || currentUser?.displayName || '').split(' ')[0] || '';

  // Team
  const [teamName, setTeamName] = useState(firstName ? `${firstName}'s team` : '');
  const [teamFormat, setTeamFormat] = useState('7v7');
  const [teamAgeGroup, setTeamAgeGroup] = useState('');

  // Kid (coach's own child)
  const [hasKid, setHasKid] = useState<boolean | null>(null);
  const [kidName, setKidName] = useState('');
  const [kidJerseyNumber, setKidJerseyNumber] = useState('');
  const [kidPosition, setKidPosition] = useState('');

  // Practice
  const [practiceDays, setPracticeDays] = useState<number[]>([]);   // 0=Sun..6=Sat
  const [practiceHour, setPracticeHour] = useState(18);              // 6pm default
  const [practiceMinute, setPracticeMinute] = useState(0);
  const [practiceDurationMins, setPracticeDurationMins] = useState(90);
  const [practiceLocation, setPracticeLocation] = useState('');
  // Date-level unchecks — key is ISO yyyy-mm-dd, value=true means skip
  const [skippedDates, setSkippedDates] = useState<Record<string, boolean>>({});

  // Staff invites
  const [staffEmails, setStaffEmails] = useState<Array<{ email: string; role: 'assistant_coach' | 'team_manager' }>>([
    { email: '', role: 'assistant_coach' },
  ]);
  const [staffSentCount, setStaffSentCount] = useState(0);
  const [staffBusy, setStaffBusy] = useState(false);

  // Notifications
  const [notifResult, setNotifResult] = useState<'granted' | 'denied' | 'skipped' | null>(null);
  const [notifBusy, setNotifBusy] = useState(false);

  // Roster invites (result from BulkAddPlayersForm)
  const [rosterResult, setRosterResult] = useState<{ created: number; invitesSent: number } | null>(null);

  // Shared
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTeamId, setCreatedTeamId] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  // Bounce out if the user already has a team AND we're past the
  // first setup. Handles refresh after finish. We DON'T bounce on
  // any step here because a mid-flow refresh should stay in-flow.
  useEffect(() => {
    if (step === 'done' && userData?.teamIds && userData.teamIds.length > 0) {
      // fine to be here — done handles the redirect on tap
    }
  }, [step, userData?.teamIds]);

  // ─── Team creation ───────────────────────────────────────────
  // Uses the worker's /teams/create endpoint, same as OnboardingGate.
  // Rules hardening 2026-07-06 (see firestore.rules comment on the
  // users match block) means user-doc writes to teamIds/role/etc are
  // worker-only. Attempting the client-side patch here throws
  // "Missing or insufficient permissions". withDefaultClub:true
  // atomically creates the solo-club wrap.
  const handleCreateTeamAndAdvance = async (nextStep: Step) => {
    if (!userData || !teamName.trim()) {
      setError('Give your team a name to keep going.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { workerFetch } = await import('../utils/workerFetch');
      const res = await workerFetch('/teams/create', {
        method: 'POST',
        body: JSON.stringify({
          name: teamName.trim(),
          season: String(new Date().getFullYear()),
          ageGroup: teamAgeGroup || undefined,
          format: teamFormat || undefined,
          withDefaultClub: true,
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `create-${res.status}`);
      }
      const newTeamId: string | undefined = data.teamId;
      if (!newTeamId) throw new Error('Team creation returned no id.');
      setCreatedTeamId(newTeamId);
      await refreshUserData?.();
      goStep(nextStep);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  // ─── Add the coach's own kid as a player ─────────────────────
  const handleAddKid = async () => {
    if (!userData || !createdTeamId) {
      setError('Missing team. Go back a step.');
      return;
    }
    if (!kidName.trim()) {
      setError('Add your kid’s name.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const jerseyNumber = kidJerseyNumber.trim() ? Number(kidJerseyNumber.trim()) : undefined;
      await addPlayer({
        name: kidName.trim(),
        teamId: createdTeamId,
        jerseyNumber: (typeof jerseyNumber === 'number' && !isNaN(jerseyNumber)) ? jerseyNumber : undefined,
        position: kidPosition.trim() || undefined,
        parentIds: [userData.uid],
        isActive: true,
        createdBy: userData.uid,
        createdAt: new Date(),
      } as any);
      // Also mark the user as a parent of this player (dashboard
      // uses parentIds → player lookup for widgets, streaks, etc).
      await refreshUserData?.();
      goStep('practice-days');
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  // ─── Practice-date generation ────────────────────────────────
  const generatedDates = useMemo(() => {
    if (practiceDays.length === 0) return [] as Date[];
    const nowDate = new Date();
    const out: Date[] = [];
    for (let week = 0; week < PREVIEW_WEEKS; week++) {
      for (const dow of practiceDays) {
        const d = new Date(nowDate);
        // First occurrence of `dow` on/after today, plus week offset
        d.setDate(d.getDate() + ((7 + dow - d.getDay()) % 7) + week * 7);
        d.setHours(practiceHour, practiceMinute, 0, 0);
        // Skip anything already in the past
        if (d.getTime() < nowDate.getTime()) continue;
        out.push(d);
      }
    }
    // Sort chronologically
    out.sort((a, b) => a.getTime() - b.getTime());
    return out;
  }, [practiceDays, practiceHour, practiceMinute]);

  const isoKey = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const activeDates = generatedDates.filter(d => !skippedDates[isoKey(d)]);

  const toggleSkip = (d: Date) => {
    const key = isoKey(d);
    setSkippedDates(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // ─── Write the schedule ──────────────────────────────────────
  const handleSaveSchedule = async () => {
    if (!userData || !createdTeamId) {
      setError('Missing team. Go back a step.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (activeDates.length > 0) {
        const writes = activeDates.map(evDate => {
          const endDate = new Date(evDate.getTime() + practiceDurationMins * 60000);
          return addEvent({
            title: 'Practice',
            type: 'practice',
            date: evDate,
            endDate,
            location: practiceLocation.trim() || '',
            teamId: createdTeamId,
            createdBy: userData.uid,
            createdByName: userData.name || 'Coach',
          } as any);
        });
        await Promise.allSettled(writes);
      }
      goStep('invite');
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  // ─── Generate an open invite link (used on invite step) ──────
  useEffect(() => {
    if (step !== 'invite') return;
    if (inviteLink) return;
    if (!userData || !createdTeamId) return;
    (async () => {
      try {
        const inv = await createPlayerInvite({
          teamId: createdTeamId,
          playerId: '',
          createdBy: userData.uid,
          ttlDays: 30,
          maxUses: null,
          note: 'Welcome invite',
        });
        setInviteLink(inviteUrl(inv.id));
      } catch (err) {
        console.warn('invite link generate failed', err);
      }
    })();
  }, [step, userData, createdTeamId, inviteLink]);

  // ─── Staff invites ───────────────────────────────────────────
  const handleSendStaffInvites = async () => {
    if (!userData || !createdTeamId) return;
    const validRows = staffEmails.filter(r => r.email.trim().includes('@'));
    if (validRows.length === 0) {
      goStep('notifications');
      return;
    }
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
            subject: `${coachFirst} added you as ${roleLabel} on ${teamName}`,
            text: [
              `Hi,`,
              ``,
              `${userData.name || 'The coach'} added you as ${roleLabel} for ${teamName} on GoalKickr.`,
              ``,
              `Tap to claim your spot:`,
              link,
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
      goStep('notifications');
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

  // ─── Notifications ───────────────────────────────────────────
  const handleNotifPrompt = async () => {
    if (!Capacitor.isNativePlatform()) {
      // Web fallback: browser Notification API. Fine for testing;
      // the actual FCM plumbing only wires on native anyway.
      setNotifBusy(true);
      try {
        if ('Notification' in window) {
          const res = await (Notification as any).requestPermission();
          setNotifResult(res === 'granted' ? 'granted' : 'denied');
        } else {
          setNotifResult('skipped');
        }
      } catch {
        setNotifResult('denied');
      } finally {
        setNotifBusy(false);
      }
      return;
    }
    setNotifBusy(true);
    try {
      const perm = await PushNotifications.requestPermissions();
      if (perm.receive === 'granted') {
        setNotifResult('granted');
        try { await PushNotifications.register(); } catch { /* token registration is async elsewhere */ }
      } else {
        setNotifResult('denied');
      }
    } catch (err) {
      console.warn('notif prompt failed', err);
      setNotifResult('denied');
    } finally {
      setNotifBusy(false);
    }
  };

  // ─── Trial handoff ───────────────────────────────────────────
  const handleStartTrial = async () => {
    setBusy(true);
    try {
      await openWebSignup({ tier: 'annual', intent: 'subscribe' });
    } catch (err) {
      console.warn('openWebSignup failed', err);
    } finally {
      setBusy(false);
      // openWebSignup opens the Stripe portal in a browser tab.
      // Advance to done so if they come back to the app they land
      // on the dashboard, not this step.
      goStep('done');
    }
  };

  // ─── Reset for "add another team" ─────────────────────────────
  const startAnotherTeam = () => {
    // Reset team-scoped state so the wizard can re-run cleanly
    setTeamName(firstName ? `${firstName}'s team` : '');
    setTeamFormat('7v7');
    setTeamAgeGroup('');
    setHasKid(null);
    setKidName('');
    setKidJerseyNumber('');
    setKidPosition('');
    setPracticeDays([]);
    setPracticeLocation('');
    setSkippedDates({});
    setStaffEmails([{ email: '', role: 'assistant_coach' }]);
    setStaffSentCount(0);
    setRosterResult(null);
    setCreatedTeamId(null);
    setInviteLink(null);
    goStep('team');
  };

  // ─── Layout shell ────────────────────────────────────────────
  const currentIndex = ORDERED_STEPS.indexOf(step);
  const totalStepsForDots = ORDERED_STEPS.length - 1; // skip 'done'

  return (
    <div
      className="fixed inset-0 overflow-y-auto overflow-x-hidden bg-gradient-to-b from-brand-primary-dim from-0% via-black via-[10%] to-black text-white"
      style={{ paddingTop: 90, paddingBottom: 40 }}
    >
      <div className="relative w-full max-w-lg mx-auto px-4">
        {/* Step indicator dots */}
        <div className="flex items-center justify-center gap-1.5 mb-3">
          {ORDERED_STEPS.slice(0, totalStepsForDots).map((s, i) => (
            <span
              key={s}
              className={`h-1 rounded-full transition-all ${
                i < currentIndex
                  ? 'w-4 bg-brand-primary'
                  : i === currentIndex
                    ? 'w-6 bg-white'
                    : 'w-4 bg-white/15'
              }`}
              aria-hidden
            />
          ))}
        </div>
        {/* Section heading */}
        <p className="text-center text-[11px] font-black tracking-[0.3em] uppercase text-brand-primary-soft mb-2">
          {STEP_TITLES[step]}
        </p>

        {error && (
          <div className="mb-4 rounded-xl bg-red-500/10 ring-1 ring-red-500/30 p-3 text-red-300 text-sm">
            {error}
          </div>
        )}

        {step === 'team' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                What’s your team called?
              </h1>
              <p className="text-white/60 text-sm">
                Team name, format, age group. You can change any of it later.
              </p>
            </div>

            <div className="space-y-4 rounded-2xl bg-white/[0.04] ring-1 ring-white/10 backdrop-blur-md p-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Team name</label>
                <input
                  type="text"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  className="w-full px-4 py-3.5 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-base"
                  placeholder="e.g. Fire FC"
                  autoCapitalize="words"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Format</label>
                <div className="grid grid-cols-4 gap-1.5">
                  {TEAM_FORMATS.map(f => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setTeamFormat(f.id)}
                      className={`py-2.5 rounded-xl text-sm font-bold transition ${
                        teamFormat === f.id
                          ? 'bg-brand-primary text-white ring-1 ring-brand-primary-soft/60'
                          : 'bg-white/5 text-white/70 ring-1 ring-white/10 hover:bg-white/10'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Age group</label>
                <div className="flex flex-wrap gap-1.5">
                  {AGE_GROUPS.map(a => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setTeamAgeGroup(a)}
                      className={`px-3 py-1.5 rounded-full text-xs font-bold transition ${
                        teamAgeGroup === a
                          ? 'bg-brand-primary text-white'
                          : 'bg-white/5 text-white/60 ring-1 ring-white/10'
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleCreateTeamAndAdvance('kid-gate')}
              disabled={busy || !teamName.trim()}
              className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create team'}
            </button>
          </div>
        )}

        {step === 'kid-gate' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Any of your kids on this team?
              </h1>
              <p className="text-white/60 text-sm">
                If yes, we’ll add them now so you see their profile from day one.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => { setHasKid(true); goStep('add-kid'); }}
                className="py-6 rounded-2xl bg-white/[0.06] ring-1 ring-white/15 hover:bg-white/10 transition text-white font-black text-lg"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => { setHasKid(false); goStep('practice-days'); }}
                className="py-6 rounded-2xl bg-white/[0.06] ring-1 ring-white/15 hover:bg-white/10 transition text-white font-black text-lg"
              >
                No
              </button>
            </div>
            <button
              type="button"
              onClick={() => goStep('practice-days')}
              className="w-full py-3 text-white/45 text-xs uppercase tracking-widest font-bold"
            >
              Skip for now
            </button>
          </div>
        )}

        {step === 'add-kid' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Add your kid
              </h1>
              <p className="text-white/60 text-sm">
                Name is required. Jersey number and position are optional.
              </p>
            </div>
            <div className="space-y-4 rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Kid’s name</label>
                <input
                  type="text"
                  value={kidName}
                  onChange={(e) => setKidName(e.target.value)}
                  className="w-full px-4 py-3.5 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-base"
                  placeholder="e.g. Hunter"
                  autoCapitalize="words"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Jersey #</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={kidJerseyNumber}
                    onChange={(e) => setKidJerseyNumber(e.target.value.replace(/[^0-9]/g, ''))}
                    className="w-full px-4 py-3.5 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-base"
                    placeholder="#"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Position</label>
                  <input
                    type="text"
                    value={kidPosition}
                    onChange={(e) => setKidPosition(e.target.value)}
                    className="w-full px-4 py-3.5 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-base"
                    placeholder="e.g. Winger"
                  />
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleAddKid}
              disabled={busy || !kidName.trim()}
              className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add & continue'}
            </button>
            <button
              type="button"
              onClick={() => goStep('practice-days')}
              className="w-full py-3 text-white/45 text-xs uppercase tracking-widest font-bold"
            >
              Skip for now
            </button>
          </div>
        )}

        {step === 'practice-days' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                What days do you hold practice?
              </h1>
              <p className="text-white/60 text-sm">
                Select all that apply. We’ll fill in the next 4 weeks.
              </p>
            </div>
            <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-4">
              <div className="grid grid-cols-7 gap-1.5">
                {DAY_LABELS.map((label, dow) => {
                  const on = practiceDays.includes(dow);
                  return (
                    <button
                      key={dow}
                      type="button"
                      onClick={() => setPracticeDays(prev =>
                        prev.includes(dow)
                          ? prev.filter(d => d !== dow)
                          : [...prev, dow].sort((a, b) => a - b)
                      )}
                      className={`py-4 rounded-xl text-xs font-black tracking-wider uppercase transition ${
                        on
                          ? 'bg-brand-primary text-white'
                          : 'bg-white/5 text-white/60 ring-1 ring-white/10'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              type="button"
              onClick={() => goStep('preview')}
              disabled={practiceDays.length === 0}
              className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition disabled:opacity-50"
            >
              Preview dates
            </button>
            <button
              type="button"
              onClick={() => goStep('invite')}
              className="w-full py-3 text-white/45 text-xs uppercase tracking-widest font-bold"
            >
              Skip and set schedule later
            </button>
          </div>
        )}

        {step === 'preview' && (
          <PreviewStep
            practiceDays={practiceDays}
            generatedDates={generatedDates}
            skippedDates={skippedDates}
            toggleSkip={toggleSkip}
            onBack={() => goStep('practice-days')}
            onNext={() => goStep('details')}
          />
        )}

        {step === 'details' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Time and place
              </h1>
              <p className="text-white/60 text-sm">
                Applied to every practice on your schedule.
              </p>
            </div>
            <div className="space-y-4 rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-5">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Start time</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <select
                      value={practiceHour}
                      onChange={(e) => setPracticeHour(Number(e.target.value))}
                      className="w-full px-3 py-3.5 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-base"
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h} className="text-black">
                          {h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}
                        </option>
                      ))}
                    </select>
                    <select
                      value={practiceMinute}
                      onChange={(e) => setPracticeMinute(Number(e.target.value))}
                      className="w-full px-3 py-3.5 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-base"
                    >
                      {[0, 15, 30, 45].map(m => (
                        <option key={m} value={m} className="text-black">:{String(m).padStart(2, '0')}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Length</label>
                  <select
                    value={practiceDurationMins}
                    onChange={(e) => setPracticeDurationMins(Number(e.target.value))}
                    className="w-full px-3 py-3.5 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-base"
                  >
                    {[45, 60, 75, 90, 105, 120].map(m => (
                      <option key={m} value={m} className="text-black">{m} min</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-white/70 mb-1.5">Location</label>
                <input
                  type="text"
                  value={practiceLocation}
                  onChange={(e) => setPracticeLocation(e.target.value)}
                  className="w-full px-4 py-3.5 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-base"
                  placeholder="Field name or address"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => goStep('confirm')}
              className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition"
            >
              Review schedule
            </button>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Look right?
              </h1>
              <p className="text-white/60 text-sm">
                We’ll drop these on your calendar.
              </p>
            </div>
            <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-5 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/60">Days</span>
                <span className="text-white font-bold">
                  {practiceDays.map(d => DAY_LABELS[d]).join(', ') || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/60">Time</span>
                <span className="text-white font-bold">
                  {practiceHour === 0 ? '12' : practiceHour <= 12 ? practiceHour : practiceHour - 12}
                  :{String(practiceMinute).padStart(2, '0')}
                  {' '}{practiceHour < 12 ? 'AM' : 'PM'} · {practiceDurationMins} min
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/60">Location</span>
                <span className="text-white font-bold text-right max-w-[60%] truncate">
                  {practiceLocation.trim() || 'Not set'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/60">Practices</span>
                <span className="text-white font-bold">{activeDates.length}</span>
              </div>
            </div>
            <div className="space-y-2">
              <button
                type="button"
                onClick={handleSaveSchedule}
                disabled={busy}
                className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition disabled:opacity-50"
              >
                {busy ? 'Saving…' : `Save ${activeDates.length} practices`}
              </button>
              <button
                type="button"
                onClick={() => goStep('preview')}
                className="w-full py-3 text-white/60 text-xs uppercase tracking-widest font-bold"
              >
                Edit dates
              </button>
            </div>
          </div>
        )}

        {step === 'invite' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Invite the team
              </h1>
              <p className="text-white/60 text-sm">
                Add each player with their parent’s email. We’ll send the invite.
              </p>
            </div>
            {createdTeamId && (
              <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-4">
                <BulkAddPlayersForm
                  teamId={createdTeamId}
                  onFinished={(result) => {
                    setRosterResult(result);
                    goStep('staff');
                  }}
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => goStep('staff')}
              className="w-full py-3 text-white/45 text-xs uppercase tracking-widest font-bold"
            >
              Skip for now
            </button>
          </div>
        )}

        {step === 'staff' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Add a coach or manager
              </h1>
              <p className="text-white/60 text-sm">
                They’ll get an invite email and can help you run the team.
              </p>
            </div>
            <div className="space-y-3 rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-4">
              {staffEmails.map((row, i) => (
                <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 items-start">
                  <input
                    type="email"
                    value={row.email}
                    onChange={(e) => updateStaffRow(i, { email: e.target.value })}
                    className="min-w-0 px-3 py-3 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-sm"
                    placeholder="email@example.com"
                    autoComplete="email"
                  />
                  <select
                    value={row.role}
                    onChange={(e) => updateStaffRow(i, { role: e.target.value as any })}
                    className="px-2 py-3 rounded-xl bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/60 text-xs"
                  >
                    <option value="assistant_coach" className="text-black">Coach</option>
                    <option value="team_manager" className="text-black">Manager</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => removeStaffRow(i)}
                    disabled={staffEmails.length <= 1}
                    className="px-2 py-3 rounded-xl bg-white/5 text-white/60 hover:text-white ring-1 ring-white/10 text-sm disabled:opacity-30"
                    aria-label="Remove row"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addStaffRow}
                className="w-full py-2 text-white/60 hover:text-white text-xs uppercase tracking-widest font-bold"
              >
                + Add another
              </button>
            </div>
            <button
              type="button"
              onClick={handleSendStaffInvites}
              disabled={staffBusy}
              className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition disabled:opacity-50"
            >
              {staffBusy ? 'Sending…' : 'Send invites'}
            </button>
            <button
              type="button"
              onClick={() => goStep('notifications')}
              className="w-full py-3 text-white/45 text-xs uppercase tracking-widest font-bold"
            >
              Skip for now
            </button>
          </div>
        )}

        {step === 'notifications' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Stay in the loop
              </h1>
              <p className="text-white/60 text-sm">
                You’ll get a ping when it matters. Not when it doesn’t.
              </p>
            </div>
            <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-5 space-y-3">
              {[
                { title: 'Player of the Match crowns', body: 'When your kid gets one.' },
                { title: 'Games starting soon', body: '1 hour before kickoff.' },
                { title: 'Practice reminders', body: 'On the days you’ve set.' },
                { title: 'Coach announcements', body: 'When a post lands on the Wall.' },
                { title: 'RSVP asks', body: 'Only when we actually need one.' },
              ].map((row) => (
                <div key={row.title} className="flex items-start gap-3">
                  <div className="h-2 w-2 rounded-full bg-brand-primary-soft mt-2 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-white text-sm font-bold">{row.title}</p>
                    <p className="text-white/55 text-xs">{row.body}</p>
                  </div>
                </div>
              ))}
            </div>
            {notifResult === 'granted' && (
              <div className="rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/30 p-3 text-emerald-300 text-sm text-center">
                Notifications on. You’re set.
              </div>
            )}
            {notifResult === 'denied' && (
              <div className="rounded-xl bg-amber-500/10 ring-1 ring-amber-500/30 p-3 text-amber-200 text-sm text-center">
                Skipped. Turn them on later in Settings when you’re ready.
              </div>
            )}
            {notifResult === null && (
              <button
                type="button"
                onClick={handleNotifPrompt}
                disabled={notifBusy}
                className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition disabled:opacity-50"
              >
                {notifBusy ? 'Asking…' : 'Turn on notifications'}
              </button>
            )}
            <button
              type="button"
              onClick={() => goStep('checklist')}
              className="w-full py-3 text-white/60 text-xs uppercase tracking-widest font-bold"
            >
              {notifResult ? 'Continue' : 'Not now'}
            </button>
          </div>
        )}

        {step === 'checklist' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Look at everything you got done.
              </h1>
              <p className="text-white/60 text-sm">
                Nice work.
              </p>
            </div>
            <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-4 space-y-2.5">
              <ChecklistRow done label="Team created" detail={teamName} />
              <ChecklistRow
                done={!!(hasKid && kidName.trim())}
                label={hasKid ? 'Kid added' : 'Kid on team'}
                detail={hasKid && kidName.trim() ? kidName : (hasKid === false ? 'None' : 'Skipped')}
              />
              <ChecklistRow
                done={activeDates.length > 0}
                label="Practice schedule"
                detail={activeDates.length > 0 ? `${activeDates.length} practices` : 'Skipped'}
              />
              <ChecklistRow
                done={!!(rosterResult && rosterResult.created > 0)}
                label="Team roster"
                detail={rosterResult && rosterResult.created > 0 ? `${rosterResult.created} added` : 'Skipped'}
              />
              <ChecklistRow
                done={staffSentCount > 0}
                label="Staff invited"
                detail={staffSentCount > 0 ? `${staffSentCount} sent` : 'Skipped'}
              />
              <ChecklistRow
                done={notifResult === 'granted'}
                label="Notifications on"
                detail={notifResult === 'granted' ? 'On' : notifResult === 'denied' ? 'Off' : 'Skipped'}
              />
            </div>
            <button
              type="button"
              onClick={() => goStep('another')}
              className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition"
            >
              Continue
            </button>
          </div>
        )}

        {step === 'another' && (
          <div className="space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                Coach another team?
              </h1>
              <p className="text-white/60 text-sm">
                Some of us run two. If not, keep moving.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={startAnotherTeam}
                className="py-6 rounded-2xl bg-white/[0.06] ring-1 ring-white/15 hover:bg-white/10 transition text-white font-black text-base"
              >
                Yes, add one
              </button>
              <button
                type="button"
                onClick={() => goStep('trial')}
                className="py-6 rounded-2xl bg-brand-primary text-white font-black text-base shadow-lg"
              >
                No, keep going
              </button>
            </div>
          </div>
        )}

        {step === 'trial' && (
          <div className="space-y-6">
            <div className="text-center">
              <p className="text-[10px] font-black tracking-[0.3em] uppercase text-amber-300 mb-2">Founder’s Deal</p>
              <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
                50% off. Locked in for life.
              </h1>
              <p className="text-white/60 text-sm">
                First 7 days free. Cancel anytime.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-4 space-y-2">
                <p className="text-[10px] font-black tracking-widest uppercase text-white/50">Monthly</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-black text-white">$5</span>
                  <span className="text-xs text-white/50 line-through">$9.99</span>
                </div>
                <p className="text-[11px] text-white/55">per month, for life</p>
              </div>
              <div className="rounded-2xl bg-brand-primary/15 ring-2 ring-brand-primary-soft/40 p-4 space-y-2 relative">
                <span className="absolute -top-2 left-3 px-1.5 py-0.5 rounded bg-amber-400 text-black text-[9px] font-black uppercase tracking-widest">Best value</span>
                <p className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft">Annual</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-black text-white">$50</span>
                  <span className="text-xs text-white/50 line-through">$99.99</span>
                </div>
                <p className="text-[11px] text-white/55">per year, for life</p>
              </div>
            </div>

            <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-4 space-y-2">
              <p className="text-white text-sm font-bold mb-1">Everything included:</p>
              {[
                'Live GameDay tracker',
                'Player of the Match crowns',
                'Practice streaks',
                'Team Wall for parents',
                'Tagged clips and highlights',
                'Full development plans',
              ].map(feature => (
                <div key={feature} className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span className="text-white/80 text-sm">{feature}</span>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={handleStartTrial}
              disabled={busy}
              className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition disabled:opacity-50"
            >
              {busy ? 'Opening…' : 'Start 7-day free trial'}
            </button>
            <button
              type="button"
              onClick={() => goStep('done')}
              className="w-full py-3 text-white/45 text-xs uppercase tracking-widest font-bold"
            >
              Maybe later
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-6 text-center">
            <div className="mx-auto mb-2 h-20 w-20 rounded-full bg-brand-primary/20 ring-1 ring-brand-primary-soft/40 flex items-center justify-center">
              <svg className="w-10 h-10 text-brand-primary-soft" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1 className="text-4xl font-black tracking-tight leading-tight">
              You’re in.
            </h1>
            <p className="text-white/60 text-base px-4">
              {teamName} is ready. Let’s go see it.
            </p>
            <button
              type="button"
              onClick={() => navigate('/dashboard', { replace: true })}
              className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition"
            >
              Take me to my team
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Preview step (mini 4-week calendar) ───────────────────────
const PreviewStep: React.FC<{
  practiceDays: number[];
  generatedDates: Date[];
  skippedDates: Record<string, boolean>;
  toggleSkip: (d: Date) => void;
  onBack: () => void;
  onNext: () => void;
}> = ({ practiceDays, generatedDates, skippedDates, toggleSkip, onBack, onNext }) => {
  const isoKey = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Build a 4-week grid starting at the Sunday of this week.
  const gridDays = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    // Rewind to Sunday of this week
    start.setDate(start.getDate() - start.getDay());
    const days: Date[] = [];
    for (let i = 0; i < PREVIEW_WEEKS * 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    return days;
  }, []);

  const generatedKeys = new Set(generatedDates.map(isoKey));
  const activeCount = generatedDates.filter(d => !skippedDates[isoKey(d)]).length;

  const monthLabel = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' });

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-black tracking-tight leading-tight mb-2">
          Uncheck any that don’t work
        </h1>
        <p className="text-white/60 text-sm">
          {activeCount} practices over the next {PREVIEW_WEEKS} weeks.
        </p>
      </div>
      <div className="rounded-2xl bg-white/[0.04] ring-1 ring-white/10 p-4">
        {/* Day-of-week headers */}
        <div className="grid grid-cols-7 gap-1 mb-2">
          {DAY_LABELS.map(l => (
            <div key={l} className="text-center text-[10px] font-black tracking-widest uppercase text-white/40">{l}</div>
          ))}
        </div>
        {/* Day grid */}
        <div className="grid grid-cols-7 gap-1">
          {gridDays.map(d => {
            const key = isoKey(d);
            const isGenerated = generatedKeys.has(key);
            const isSkipped = !!skippedDates[key];
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const isPast = d.getTime() < today.getTime();
            const isFirstOfMonth = d.getDate() === 1;
            return (
              <button
                key={key}
                type="button"
                disabled={!isGenerated || isPast}
                onClick={() => toggleSkip(d)}
                className={`aspect-square rounded-lg flex flex-col items-center justify-center text-xs font-bold transition relative ${
                  isPast
                    ? 'text-white/20'
                    : isGenerated
                      ? (isSkipped
                          ? 'bg-white/[0.03] text-white/40 line-through ring-1 ring-white/10'
                          : 'bg-brand-primary text-white ring-1 ring-brand-primary-soft/40')
                      : 'text-white/35'
                }`}
              >
                {isFirstOfMonth && (
                  <span className="absolute -top-1 -right-1 px-1 rounded bg-white/10 text-[8px] text-white/60 font-black tracking-wider uppercase">
                    {monthLabel(d)}
                  </span>
                )}
                <span>{d.getDate()}</span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-white/45 text-center mt-3">
          Tap any highlighted date to skip it.
        </p>
      </div>
      <div className="space-y-2">
        <button
          type="button"
          onClick={onNext}
          disabled={activeCount === 0}
          className="w-full py-4 rounded-2xl bg-brand-primary text-white font-black tracking-wider uppercase text-sm shadow-lg active:scale-95 transition disabled:opacity-50"
        >
          Next: time & place
        </button>
        <button
          type="button"
          onClick={onBack}
          className="w-full py-3 text-white/60 text-xs uppercase tracking-widest font-bold"
        >
          Back
        </button>
      </div>
    </div>
  );
};

// ─── Checklist row ─────────────────────────────────────────────
const ChecklistRow: React.FC<{ done: boolean; label: string; detail?: string }> = ({ done, label, detail }) => (
  <div className="flex items-center gap-3">
    <div className={`h-6 w-6 rounded-full flex-shrink-0 flex items-center justify-center ${
      done ? 'bg-emerald-500/20 ring-1 ring-emerald-400/60' : 'bg-white/5 ring-1 ring-white/15'
    }`}>
      {done && (
        <svg className="w-3.5 h-3.5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </div>
    <div className="flex-1 flex items-center justify-between">
      <span className={`text-sm font-bold ${done ? 'text-white' : 'text-white/60'}`}>{label}</span>
      {detail && <span className="text-xs text-white/50 truncate max-w-[50%] text-right">{detail}</span>}
    </div>
  </div>
);

export default Onboarding;
