// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { isClubAdmin as checkIsClubAdmin } from '../utils/helpers';
import type {
  Season,
  SeasonLifecycle,
  SeasonTryoutDate,
  CoachCommitment,
  CoachCommitmentStatus,
} from '../types';

/**
 * Season Wizard — single guided entry point for an admin starting a new
 * season cycle (or resuming a draft mid-flow). Vertical timeline with
 * five steps, each writing to the same `seasons/{id}` doc:
 *
 *   1. Plan         — name, dates, age groups
 *   2. Coaches      — assign + commitment cycle (sends invites)
 *   3. Tryouts      — dates + locations per age group
 *   4. Registration — attach forms, set window + pricing
 *   5. Marketing    — broadcast tryouts to families + social/Mailchimp
 *
 * Patrick 2026-06-21: 'should all work in a step by step process. like
 * a timeline. as you build the new season out, it will let you attach
 * the necessary forms, tryout dates, email tryout dates to current
 * clubs, then create any marketing opportunities... it needs to be
 * easy, needs to be seamless, and it has to work without people
 * clicking new form and just staring at a text box wondering how it
 * all works.'
 *
 * 2026-10-21 (Patrick audit B2): Steps 2 (Coaches) and 3 (Tryouts)
 * are now functional. Step 4 (Registration) and Step 5 (Marketing)
 * still render as stubs. Lifecycle progression:
 *   plan done        → coach_commit
 *   coaches done     → tryout_prep
 *   tryouts done     → tryout_prep (same bucket; registration step
 *                      flips to registration_open when fired)
 *
 * Per the registrations-test-only memory, no migration is needed for
 * existing season docs — we can require new fields without backfill.
 */

type WizardStepKey = 'plan' | 'coaches' | 'tryouts' | 'registration' | 'marketing';

interface WizardStepDef {
  key: WizardStepKey;
  title: string;
  hint: string;
  lifecycle: SeasonLifecycle;
}

const STEPS: WizardStepDef[] = [
  { key: 'plan',         title: 'Plan',         hint: 'Name the season, set the start and end dates, and pick the age groups you\'re running.', lifecycle: 'draft' },
  { key: 'coaches',      title: 'Coaches',      hint: 'Assign coaches per age group and send commitment invitations. Coaches reply Yes / No / Let\'s talk in one tap.', lifecycle: 'coach_commit' },
  { key: 'tryouts',      title: 'Tryouts',      hint: 'Schedule tryout dates per age group, set locations.', lifecycle: 'tryout_prep' },
  { key: 'registration', title: 'Registration', hint: 'Attach required forms and waivers, set the open/close window, set fees.', lifecycle: 'tryout_prep' },
  { key: 'marketing',    title: 'Marketing',    hint: 'Email tryout dates to current families. Queue social posts and Mailchimp campaigns.', lifecycle: 'tryout_prep' },
];

const SeasonWizard: React.FC = () => {
  const { userData } = useAuth();
  const navigate = useNavigate();
  const { id: seasonIdFromUrl } = useParams<{ id?: string }>();

  // 'new' route → no preloaded season. Anything else → load that season.
  const isNew = !seasonIdFromUrl || seasonIdFromUrl === 'new';
  const [seasonId, setSeasonId] = useState<string | null>(isNew ? null : seasonIdFromUrl || null);
  const [season, setSeason] = useState<Season | null>(null);
  const [loaded, setLoaded] = useState(isNew);
  const [showProgress, setShowProgress] = useState(false);
  const [activeStep, setActiveStep] = useState<WizardStepKey>('plan');
  const [saving, setSaving] = useState(false);

  // Step 1 form state
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedAgeGroups, setSelectedAgeGroups] = useState<string[]>([]);

  // Step 2 — coach commitments. One doc per coach × season in the
  // coach_commitments collection. State:
  //   coachPool: candidate coaches to assign (users with role 'coach'
  //              on any team in this club).
  //   commitments: existing coach_commitments docs for this season,
  //                keyed by proposedAgeGroup for fast per-row lookup.
  const [coachPool, setCoachPool] = useState<Array<{ uid: string; name: string; email?: string }>>([]);
  const [commitments, setCommitments] = useState<CoachCommitment[]>([]);
  const [savingCoach, setSavingCoach] = useState<string | null>(null); // ageGroup being saved

  // Step 3 — tryouts. Stored as season.tryoutDates (array on the
  // season doc, not a subcollection — admin typically picks a handful
  // of dates per age group, not hundreds).
  const [tryouts, setTryouts] = useState<SeasonTryoutDate[]>([]);
  const [savingTryouts, setSavingTryouts] = useState(false);

  // Standard US youth soccer age-group ladder. U6 → U18 is wide
  // enough to cover micro / academy programs at the bottom and high-
  // school-age club at the top. Some clubs add U4 (toddler clinics) or
  // U19/U20 (transition programs); keep the visible set tight and the
  // FREE-text override below for the edges.
  const AGE_GROUP_OPTIONS = ['U6','U7','U8','U9','U10','U11','U12','U13','U14','U15','U16','U17','U18'];

  // Atomic-render gate — same pattern as the rest of the app.
  useEffect(() => {
    if (loaded) { setShowProgress(false); return; }
    const t = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(t);
  }, [loaded]);

  // Load existing season if editing.
  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'seasons', seasonIdFromUrl!));
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data() as any;
          const s: Season = {
            id: snap.id,
            ...data,
            startDate: data.startDate?.toDate?.() || new Date(data.startDate || Date.now()),
            endDate: data.endDate?.toDate?.() || new Date(data.endDate || Date.now()),
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
          };
          setSeason(s);
          setName(s.name || '');
          setStartDate(toISODate(s.startDate));
          setEndDate(toISODate(s.endDate));
          setSelectedAgeGroups(((s as any).ageGroups || []) as string[]);
          // Hydrate tryouts from the season doc (step 3 state).
          const rawTryouts = Array.isArray(data.tryoutDates) ? data.tryoutDates : [];
          setTryouts(rawTryouts.map((t: any) => ({
            id: t.id,
            ageGroup: t.ageGroup,
            date: t.date?.toDate?.() || new Date(t.date),
            durationMinutes: t.durationMinutes,
            location: t.location,
            notes: t.notes,
          })));
          // Load coach_commitments for this season (step 2 state).
          try {
            const cmSnap = await getDocs(query(
              collection(db, 'coach_commitments'),
              where('seasonId', '==', snap.id),
            ));
            if (!cancelled) {
              setCommitments(cmSnap.docs.map((d) => {
                const cd = d.data() as any;
                return {
                  id: d.id,
                  ...cd,
                  invitedAt: cd.invitedAt?.toDate?.() || new Date(cd.invitedAt),
                  respondedAt: cd.respondedAt?.toDate?.() || undefined,
                } as CoachCommitment;
              }));
            }
          } catch (err) {
            console.warn('[season-wizard] load commitments failed', err);
          }
          // Auto-advance to the next un-completed step so admin lands
          // where the work is.
          setActiveStep(deriveActiveStep(s, rawTryouts));
        }
      } catch (err) {
        console.warn('[season-wizard] load failed', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isNew, seasonIdFromUrl]);

  // Use the helper (not the raw flag). The flag is reserved for
  // platform owners; a fresh "Start a club, I'm not a coach" admin
  // has role:'club_admin' but no raw flag, and was being locked out
  // of their own primary CTA. Patrick 2026-10-21 audit (B1).
  const isAdmin = checkIsClubAdmin(userData);
  if (!isAdmin) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 text-center">
        <p className="text-ink-primary/85 font-semibold mb-1">Admin only</p>
        <p className="text-ink-primary/55 text-sm mb-4">The season wizard is for club admins.</p>
        <Link to="/dashboard" className="text-brand-primary-soft font-bold text-sm hover:text-brand-primary-soft">← Back to dashboard</Link>
      </div>
    );
  }

  // Load the pool of coaches available to assign — any user with role
  // 'coach' who is on a team in this club. For a brand-new "I'm not a
  // coach" admin running their first season, this will often be empty;
  // the admin can still invite by email (future enhancement). For MVP
  // we show the pool as a picker and let the admin pick existing team
  // coaches. clubId is sourced from the season doc if present, else
  // from userData.clubId / clubIds[0].
  useEffect(() => {
    if (!userData) return;
    const resolvedClubId = (season as any)?.clubId
      || (userData as any)?.clubId
      || ((userData as any)?.clubIds?.[0]);
    if (!resolvedClubId) return;
    let cancelled = false;
    (async () => {
      try {
        // Find teams in this club → union coachIds → fetch user docs.
        const teamsSnap = await getDocs(query(
          collection(db, 'teams'),
          where('clubId', '==', resolvedClubId),
        ));
        const coachUids = new Set<string>();
        teamsSnap.forEach((t) => {
          const td = t.data() as any;
          (td.coachIds || []).forEach((uid: string) => coachUids.add(uid));
        });
        if (coachUids.size === 0) { if (!cancelled) setCoachPool([]); return; }
        // Fetch user docs in chunks of 30 (Firestore in-query cap).
        const uids = Array.from(coachUids);
        const chunks: string[][] = [];
        for (let i = 0; i < uids.length; i += 30) chunks.push(uids.slice(i, i + 30));
        const { documentId } = await import('firebase/firestore');
        const snaps = await Promise.all(chunks.map((chunk) =>
          getDocs(query(collection(db, 'users'), where(documentId(), 'in', chunk)))
        ));
        const pool: Array<{ uid: string; name: string; email?: string }> = [];
        snaps.forEach((snap) => snap.forEach((u) => {
          const ud = u.data() as any;
          pool.push({ uid: u.id, name: ud.name || ud.displayName || 'Coach', email: ud.email });
        }));
        pool.sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) setCoachPool(pool);
      } catch (err) {
        console.warn('[season-wizard] load coach pool failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [userData, (season as any)?.clubId]);

  // Save Step 1. If creating, addDoc + redirect to the resume URL.
  // If editing, updateDoc in place.
  const savePlan = async () => {
    if (saving) return;
    if (!name.trim() || !startDate || !endDate) {
      alert('Name, start date, and end date are required.');
      return;
    }
    if (selectedAgeGroups.length === 0) {
      alert('Pick at least one age group.');
      return;
    }
    setSaving(true);
    try {
      const planPatch: any = {
        name: name.trim(),
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        ageGroups: selectedAgeGroups,
        lifecycle: season?.lifecycle && season.lifecycle !== 'draft' ? season.lifecycle : 'coach_commit',
        isActive: true,
      };

      if (isNew || !seasonId) {
        const ref = await addDoc(collection(db, 'seasons'), {
          ...planPatch,
          createdAt: serverTimestamp(),
          teamId: '',  // Season is club-scoped now; legacy field left blank.
          clubId: (userData as any)?.clubId || '',
          lifecycleHistory: [{
            fromState: undefined,
            toState: 'coach_commit',
            at: new Date(),
            by: (userData as any)?.uid,
            byName: (userData as any)?.name || 'Admin',
            note: 'Created via season wizard',
          }],
        });
        setSeasonId(ref.id);
        // Replace URL so refresh / share resumes this wizard, not /new.
        navigate(`/admin/seasons/${ref.id}`, { replace: true });
        setActiveStep('coaches');
      } else {
        await updateDoc(doc(db, 'seasons', seasonId), planPatch);
        setActiveStep('coaches');
      }
    } catch (err) {
      console.warn('[season-wizard] save plan failed', err);
      alert('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  // Assign a coach to an age group — creates a coach_commitments doc
  // with status 'invited'. Admin can mark the response manually (Mark
  // committed / Mark declined buttons on the row). Future: fire an
  // email/push via worker so the coach can tap Yes/No/Let's talk from
  // their phone; for MVP the admin updates the doc directly.
  const assignCoach = async (ageGroup: string, coach: { uid: string; name: string }) => {
    if (!seasonId || savingCoach === ageGroup) return;
    setSavingCoach(ageGroup);
    try {
      const existing = commitments.find(c => c.proposedAgeGroup === ageGroup);
      if (existing) {
        // Replace the existing assignment: cancel the prior, create a
        // new one. Keeps the history auditable rather than mutating in
        // place.
        if (existing.coachUid !== coach.uid) {
          await updateDoc(doc(db, 'coach_commitments', existing.id), {
            status: 'cancelled' as CoachCommitmentStatus,
          });
        } else {
          setSavingCoach(null);
          return; // same coach, no-op
        }
      }
      const payload: any = {
        seasonId,
        coachUid: coach.uid,
        coachName: coach.name,
        proposedAgeGroup: ageGroup,
        status: 'invited' as CoachCommitmentStatus,
        invitedAt: serverTimestamp(),
        invitedBy: (userData as any)?.uid,
      };
      const ref = await addDoc(collection(db, 'coach_commitments'), payload);
      const freshRows = commitments.filter(c => !(c.proposedAgeGroup === ageGroup && c.status !== 'declined' && c.status !== 'cancelled'));
      setCommitments([
        ...freshRows,
        { ...payload, id: ref.id, invitedAt: new Date() } as CoachCommitment,
      ]);
    } catch (err) {
      console.warn('[season-wizard] assign coach failed', err);
      alert('Could not assign coach. Try again.');
    } finally {
      setSavingCoach(null);
    }
  };

  const markCoachStatus = async (commitmentId: string, status: CoachCommitmentStatus) => {
    try {
      await updateDoc(doc(db, 'coach_commitments', commitmentId), {
        status,
        respondedAt: serverTimestamp(),
      });
      setCommitments(prev => prev.map(c =>
        c.id === commitmentId ? { ...c, status, respondedAt: new Date() } : c
      ));
    } catch (err) {
      console.warn('[season-wizard] update commitment failed', err);
      alert('Could not update status.');
    }
  };

  // Step 3 — tryouts. The admin adds any number of tryout slots per
  // age group. Saved as season.tryoutDates on the season doc (array).
  // Doesn't yet auto-create a corresponding events/{eventId} — that
  // happens at Step 4 (Registration) or Step 5 (Marketing) depending
  // on when the admin wants invites to fire. For now the slots are
  // just the schedule record.
  const addTryout = (ageGroup: string) => {
    const id = `${ageGroup}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    setTryouts(prev => [...prev, {
      id,
      ageGroup,
      date: new Date(),
      location: '',
    }]);
  };

  const updateTryout = (id: string, patch: Partial<SeasonTryoutDate>) => {
    setTryouts(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  };

  const removeTryout = (id: string) => {
    setTryouts(prev => prev.filter(t => t.id !== id));
  };

  const saveTryouts = async () => {
    if (!seasonId || savingTryouts) return;
    // Validate: every tryout needs a date; location can be blank for
    // "TBD" cases but we warn before save.
    const missingDate = tryouts.find(t => !t.date || isNaN(t.date.getTime()));
    if (missingDate) { alert('One of your tryouts is missing a date.'); return; }
    setSavingTryouts(true);
    try {
      await updateDoc(doc(db, 'seasons', seasonId), {
        tryoutDates: tryouts.map(t => ({
          id: t.id,
          ageGroup: t.ageGroup,
          date: t.date,
          durationMinutes: t.durationMinutes || null,
          location: t.location || null,
          notes: t.notes || null,
        })),
      });
    } catch (err) {
      console.warn('[season-wizard] save tryouts failed', err);
      alert('Could not save tryouts. Try again.');
    } finally {
      setSavingTryouts(false);
    }
  };

  const stepIsDone = (key: WizardStepKey): boolean => {
    if (!season) return false;
    if (key === 'plan') {
      return !!(season.name && (season as any).ageGroups?.length);
    }
    const ageGroups: string[] = ((season as any).ageGroups || []);
    if (key === 'coaches') {
      // Every age group has at least one committed coach assignment.
      if (ageGroups.length === 0) return false;
      return ageGroups.every(ag =>
        commitments.some(c => c.proposedAgeGroup === ag && c.status === 'committed')
      );
    }
    if (key === 'tryouts') {
      // Every age group has at least one scheduled tryout.
      if (ageGroups.length === 0) return false;
      return ageGroups.every(ag => tryouts.some(t => t.ageGroup === ag));
    }
    // Steps 4-5 not implemented yet; treat as never done.
    return false;
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="mb-5 sm:mb-7">
        <p className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary-soft">Club admin</p>
        <h1 className="font-display text-2xl sm:text-3xl font-black text-ink-primary mt-1">
          {isNew ? 'New season' : (season?.name || 'Season')}
        </h1>
        <p className="text-sm text-ink-primary/65 mt-1.5">
          Build the season step by step. Each step writes to the same season record; you can leave and come back at any point.
        </p>
      </div>

      {showProgress && !loaded && (
        <div className="h-0.5 bg-brand-primary/15 overflow-hidden rounded-full mb-3">
          <div className="h-full w-1/3 bg-brand-primary animate-progress-slide" />
        </div>
      )}

      <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <ol className="space-y-3">
          {STEPS.map((step, i) => {
            const done = stepIsDone(step.key);
            const isActive = activeStep === step.key;
            // Plan, coaches, tryouts are implemented. Registration + Marketing still stubs.
            const isStub = step.key === 'registration' || step.key === 'marketing';
            const blockedByPlan = step.key !== 'plan' && !stepIsDone('plan');
            return (
              <li
                key={step.key}
                className={`rounded-2xl ring-1 transition-colors ${
                  isActive
                    ? 'bg-surface-elevated ring-brand-primary/40'
                    : done
                      ? 'bg-surface-elevated ring-emerald-400/25'
                      : 'bg-surface-elevated ring-line-default/10'
                }`}
              >
                <button
                  type="button"
                  onClick={() => !blockedByPlan && setActiveStep(step.key)}
                  disabled={blockedByPlan}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span
                    className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black ring-2 ${
                      done
                        ? 'bg-emerald-500 ring-emerald-400 text-ink-primary'
                        : isActive
                          ? 'bg-brand-primary ring-brand-primary-soft text-white'
                          : 'bg-surface-base ring-line-default/15 text-ink-primary/50'
                    }`}
                  >
                    {done ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                    ) : i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-black text-ink-primary">{step.title}</span>
                      {isStub && (
                        <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-bone/5 ring-1 ring-line-default/10 text-ink-primary/55">Coming next</span>
                      )}
                    </div>
                    <p className="text-[12.5px] text-ink-primary/60 leading-snug mt-0.5">{step.hint}</p>
                  </div>
                </button>

                {isActive && step.key === 'plan' && (
                  <div className="px-4 pb-4 pt-1 border-t border-line-default/5 space-y-3 animate-fade-in">
                    <div>
                      <label className="block text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-1">Season name</label>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Fall 2026 / Spring 2027 / 2027-28 ECNL"
                        className="w-full bg-surface-base ring-1 ring-line-default/10 rounded-lg px-3 py-2.5 text-sm text-ink-primary placeholder:text-ink-primary/35 focus:outline-none focus:ring-brand-primary-soft/50"
                      />
                    </div>
                    {/* Date inputs constrained to a max width so the native
                        Safari/WebKit date picker UI doesn't blow past the
                        wizard card boundary on mobile. Patrick caught the
                        overflow 2026-06-21: 'the date box for the new
                        season goes past the red box.' min-w-0 on the
                        flex children + max-w on the inputs themselves
                        prevents the picker chrome from forcing its
                        intrinsic width. */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="min-w-0">
                        <label className="block text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-1">Start date</label>
                        <input
                          type="date"
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                          className="block w-full max-w-full bg-surface-base ring-1 ring-line-default/10 rounded-lg px-3 py-2.5 text-sm text-ink-primary focus:outline-none focus:ring-brand-primary-soft/50"
                        />
                      </div>
                      <div className="min-w-0">
                        <label className="block text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-1">End date</label>
                        <input
                          type="date"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                          className="block w-full max-w-full bg-surface-base ring-1 ring-line-default/10 rounded-lg px-3 py-2.5 text-sm text-ink-primary focus:outline-none focus:ring-brand-primary-soft/50"
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/55">Age groups</label>
                        <button
                          type="button"
                          onClick={() => {
                            const allSelected = selectedAgeGroups.length === AGE_GROUP_OPTIONS.length;
                            setSelectedAgeGroups(allSelected ? [] : [...AGE_GROUP_OPTIONS]);
                          }}
                          className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft hover:text-brand-primary-soft"
                        >
                          {selectedAgeGroups.length === AGE_GROUP_OPTIONS.length ? 'Clear all' : 'Select all'}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {AGE_GROUP_OPTIONS.map((ag) => {
                          const on = selectedAgeGroups.includes(ag);
                          return (
                            <button
                              key={ag}
                              type="button"
                              onClick={() => setSelectedAgeGroups((prev) =>
                                prev.includes(ag) ? prev.filter((x) => x !== ag) : [...prev, ag]
                              )}
                              className={`text-[12px] font-extrabold tracking-wide px-2.5 py-1 rounded-full transition-colors ring-1 ${
                                on
                                  ? 'bg-brand-primary ring-brand-primary-soft text-white'
                                  : 'bg-surface-base ring-line-default/10 text-ink-primary/65 hover:bg-line-default/5 hover:text-ink-primary'
                              }`}
                            >
                              {ag}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[11px] text-ink-primary/45 mt-2">
                        {selectedAgeGroups.length === 0
                          ? 'Tap to select. Each age group gets its own coach assignment + tryout date downstream.'
                          : `${selectedAgeGroups.length} selected. Each will get its own coach assignment + tryout date downstream.`}
                      </p>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={savePlan}
                        disabled={saving}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-brand-primary hover:bg-brand-primary text-white font-bold rounded-md ring-1 ring-brand-primary-soft/30 transition-colors text-sm disabled:opacity-50"
                      >
                        {saving ? 'Saving…' : (done ? 'Save changes' : 'Save and continue')}
                      </button>
                    </div>
                  </div>
                )}

                {isActive && step.key === 'coaches' && (
                  <div className="px-4 pb-4 pt-1 border-t border-line-default/5 animate-fade-in">
                    {(((season as any)?.ageGroups) || []).length === 0 ? (
                      <p className="text-sm text-ink-primary/55">Finish Step 1 first — pick your age groups.</p>
                    ) : coachPool.length === 0 ? (
                      <div className="text-sm text-ink-primary/70 space-y-2">
                        <p><span className="font-semibold text-ink-primary">No coaches in your club yet.</span></p>
                        <p className="text-ink-primary/55 text-xs leading-relaxed">
                          Add a team with coaches first, then come back. (Email-invite flow for coaches not yet in the club is a future enhancement — for now, assign existing team coaches.)
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {((season as any).ageGroups || []).map((ag: string) => {
                          const current = commitments
                            .filter(c => c.proposedAgeGroup === ag && c.status !== 'cancelled')
                            .sort((a, b) => (b.invitedAt?.getTime?.() || 0) - (a.invitedAt?.getTime?.() || 0))[0];
                          const assigned = current ? coachPool.find(c => c.uid === current.coachUid) : null;
                          const statusTone =
                            current?.status === 'committed' ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30' :
                            current?.status === 'declined' ? 'bg-rose-500/15 text-rose-300 ring-rose-400/30' :
                            current?.status === 'lets_talk' ? 'bg-amber-500/15 text-amber-300 ring-amber-400/30' :
                            'bg-brand-primary/15 text-brand-primary-soft ring-brand-primary-soft/30';
                          const statusLabel =
                            current?.status === 'committed' ? 'Committed' :
                            current?.status === 'declined' ? 'Declined' :
                            current?.status === 'lets_talk' ? "Let's talk" :
                            current?.status === 'invited' ? 'Invited' :
                            'Not assigned';
                          return (
                            <div key={ag} className="rounded-lg bg-surface-base ring-1 ring-line-default/10 p-3">
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <span className="text-sm font-black text-ink-primary">{ag}</span>
                                <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-0.5 rounded ring-1 ${statusTone}`}>{statusLabel}</span>
                              </div>
                              <select
                                value={current?.coachUid || ''}
                                onChange={(e) => {
                                  const uid = e.target.value;
                                  if (!uid) return;
                                  const coach = coachPool.find(c => c.uid === uid);
                                  if (coach) void assignCoach(ag, coach);
                                }}
                                disabled={savingCoach === ag}
                                className="w-full px-3 py-2 rounded-md text-sm ring-1 ring-line-default/10 disabled:opacity-60"
                              >
                                <option value="">Pick a coach…</option>
                                {coachPool.map(c => (
                                  <option key={c.uid} value={c.uid}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>
                                ))}
                              </select>
                              {current && assigned && (
                                <div className="flex items-center gap-1.5 mt-2">
                                  <button
                                    type="button"
                                    onClick={() => markCoachStatus(current.id, 'committed')}
                                    disabled={current.status === 'committed'}
                                    className="text-[11px] font-bold px-2 py-1 rounded bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30 disabled:opacity-40"
                                  >
                                    Mark committed
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => markCoachStatus(current.id, 'declined')}
                                    disabled={current.status === 'declined'}
                                    className="text-[11px] font-bold px-2 py-1 rounded bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/30 disabled:opacity-40"
                                  >
                                    Mark declined
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => markCoachStatus(current.id, 'lets_talk')}
                                    disabled={current.status === 'lets_talk'}
                                    className="text-[11px] font-bold px-2 py-1 rounded bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30 disabled:opacity-40"
                                  >
                                    Let's talk
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <p className="text-[11px] text-ink-primary/45 pt-1">
                          Assign a coach to each age group. Mark the response after the coach confirms. Email-invite dispatch is coming — for now, update manually.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {isActive && step.key === 'tryouts' && (
                  <div className="px-4 pb-4 pt-1 border-t border-line-default/5 animate-fade-in">
                    {(((season as any)?.ageGroups) || []).length === 0 ? (
                      <p className="text-sm text-ink-primary/55">Finish Step 1 first — pick your age groups.</p>
                    ) : (
                      <div className="space-y-3">
                        {((season as any).ageGroups || []).map((ag: string) => {
                          const ageTryouts = tryouts.filter(t => t.ageGroup === ag);
                          return (
                            <div key={ag} className="rounded-lg bg-surface-base ring-1 ring-line-default/10 p-3">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-black text-ink-primary">{ag}</span>
                                <button
                                  type="button"
                                  onClick={() => addTryout(ag)}
                                  className="text-[11px] font-bold px-2 py-1 rounded bg-brand-primary/15 text-brand-primary-soft ring-1 ring-brand-primary-soft/30"
                                >
                                  + Add tryout
                                </button>
                              </div>
                              {ageTryouts.length === 0 ? (
                                <p className="text-xs text-ink-primary/50 italic">No tryouts scheduled yet.</p>
                              ) : (
                                <div className="space-y-2">
                                  {ageTryouts.map(t => (
                                    <div key={t.id} className="rounded ring-1 ring-line-default/10 p-2 space-y-2">
                                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                        <div>
                                          <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-0.5">Date & time</label>
                                          <input
                                            type="datetime-local"
                                            value={toDateTimeLocal(t.date)}
                                            onChange={(e) => updateTryout(t.id, { date: fromDateTimeLocal(e.target.value) })}
                                            className="w-full max-w-full text-xs px-2 py-1.5 rounded ring-1 ring-line-default/10"
                                          />
                                        </div>
                                        <div>
                                          <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-0.5">Location</label>
                                          <input
                                            type="text"
                                            value={t.location || ''}
                                            onChange={(e) => updateTryout(t.id, { location: e.target.value })}
                                            placeholder="West Field"
                                            className="w-full text-xs px-2 py-1.5 rounded ring-1 ring-line-default/10"
                                          />
                                        </div>
                                        <div>
                                          <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55 mb-0.5">Minutes</label>
                                          <input
                                            type="number"
                                            min={15}
                                            max={240}
                                            value={t.durationMinutes || ''}
                                            onChange={(e) => updateTryout(t.id, { durationMinutes: e.target.value ? Number(e.target.value) : undefined })}
                                            placeholder="90"
                                            className="w-full text-xs px-2 py-1.5 rounded ring-1 ring-line-default/10"
                                          />
                                        </div>
                                      </div>
                                      <div className="flex items-start gap-2">
                                        <input
                                          type="text"
                                          value={t.notes || ''}
                                          onChange={(e) => updateTryout(t.id, { notes: e.target.value })}
                                          placeholder="Notes (optional) — e.g. bring both colors"
                                          className="flex-1 text-xs px-2 py-1.5 rounded ring-1 ring-line-default/10"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => removeTryout(t.id)}
                                          className="text-[11px] font-bold px-2 py-1 rounded text-rose-300 hover:bg-rose-500/10"
                                        >
                                          Remove
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <div className="flex gap-2 pt-1">
                          <button
                            type="button"
                            onClick={saveTryouts}
                            disabled={savingTryouts}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-primary hover:bg-brand-primary text-white font-bold rounded-md ring-1 ring-brand-primary-soft/30 transition-colors text-sm disabled:opacity-50"
                          >
                            {savingTryouts ? 'Saving…' : 'Save tryouts'}
                          </button>
                        </div>
                        <p className="text-[11px] text-ink-primary/45">
                          Family-facing tryout invites + event creation on the calendar happen downstream (Marketing step).
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {isActive && isStub && (
                  <div className="px-4 pb-4 pt-1 border-t border-line-default/5 animate-fade-in">
                    <div className="text-[12.5px] text-ink-primary/60 italic">
                      Coming in the next batch. The data model for this step is already defined; the UI is being built next.
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
};

function toISODate(d: Date | undefined | null): string {
  if (!d) return '';
  try {
    // Local date (not UTC) — same reasoning as the EventForm fix:
    // toISOString converts to UTC, which bumps the day for evening
    // local times west of UTC.
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return '';
  }
}

function toDateTimeLocal(d: Date | undefined | null): string {
  if (!d || isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function fromDateTimeLocal(v: string): Date {
  // `datetime-local` returns 'YYYY-MM-DDTHH:MM' interpreted as the
  // user's local timezone. `new Date(v)` does exactly that in all
  // modern browsers.
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date() : d;
}

function deriveActiveStep(s: Season, rawTryouts: any[] = []): WizardStepKey {
  // Resume the wizard at the first un-completed step. Walks the full
  // chain now that Steps 2 and 3 are implemented.
  if (!s.name || !(s as any).ageGroups?.length) return 'plan';
  // We can't tell from the Season doc alone whether all coaches are
  // committed (that lives in coach_commitments). The caller re-sets
  // activeStep after loading commitments; this heuristic just gets
  // the admin close to the right place on first paint.
  const ageGroups: string[] = ((s as any).ageGroups || []);
  if (ageGroups.length > 0) {
    const covered = ageGroups.every(ag => rawTryouts.some((t: any) => t.ageGroup === ag));
    if (!covered) return 'coaches'; // nudge admin to finish upstream first
  }
  return 'tryouts';
}

export default SeasonWizard;
