// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import type { Season, SeasonLifecycle } from '../types';

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
 * THIS COMMIT scope: Step 1 is fully functional (creates the season
 * doc, writes name + dates + ageGroups). Steps 2-5 render in the
 * timeline as 'Coming next' placeholders so the structure is visible
 * but doesn't pretend to work yet. Each follow-up commit fills in one
 * step end-to-end.
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
  const [ageGroupsInput, setAgeGroupsInput] = useState('');

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
          setAgeGroupsInput(((s as any).ageGroups || []).join(', '));
          // Auto-advance to the next un-completed step so admin lands
          // where the work is.
          setActiveStep(deriveActiveStep(s));
        }
      } catch (err) {
        console.warn('[season-wizard] load failed', err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isNew, seasonIdFromUrl]);

  const isClubAdmin = (userData as any)?.isClubAdmin === true;
  if (!isClubAdmin) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 text-center">
        <p className="text-bone/85 font-semibold mb-1">Admin only</p>
        <p className="text-bone/55 text-sm mb-4">The season wizard is for club admins.</p>
        <Link to="/dashboard" className="text-crimson-300 font-bold text-sm hover:text-crimson-200">← Back to dashboard</Link>
      </div>
    );
  }

  // Save Step 1. If creating, addDoc + redirect to the resume URL.
  // If editing, updateDoc in place.
  const savePlan = async () => {
    if (saving) return;
    if (!name.trim() || !startDate || !endDate) {
      alert('Name, start date, and end date are required.');
      return;
    }
    setSaving(true);
    try {
      const ageGroups = ageGroupsInput
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

      const planPatch: any = {
        name: name.trim(),
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        ageGroups,
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

  const stepIsDone = (key: WizardStepKey): boolean => {
    if (!season) return false;
    if (key === 'plan') {
      return !!(season.name && (season as any).ageGroups?.length);
    }
    // Steps 2-5 not implemented yet; treat as never done.
    return false;
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="mb-5 sm:mb-7">
        <p className="text-[11px] font-extrabold tracking-widest uppercase text-crimson-400">Club admin</p>
        <h1 className="font-display text-2xl sm:text-3xl font-black text-bone mt-1">
          {isNew ? 'New season' : (season?.name || 'Season')}
        </h1>
        <p className="text-sm text-bone/65 mt-1.5">
          Build the season step by step. Each step writes to the same season record; you can leave and come back at any point.
        </p>
      </div>

      {showProgress && !loaded && (
        <div className="h-0.5 bg-crimson-500/15 overflow-hidden rounded-full mb-3">
          <div className="h-full w-1/3 bg-crimson-500 animate-progress-slide" />
        </div>
      )}

      <div className={`transition-opacity duration-300 ease-out ${loaded ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <ol className="space-y-3">
          {STEPS.map((step, i) => {
            const done = stepIsDone(step.key);
            const isActive = activeStep === step.key;
            const isStub = step.key !== 'plan';  // only plan is implemented in this commit
            const blockedByPlan = step.key !== 'plan' && !stepIsDone('plan');
            return (
              <li
                key={step.key}
                className={`rounded-2xl ring-1 transition-colors ${
                  isActive
                    ? 'bg-charcoal-900 ring-crimson-500/40'
                    : done
                      ? 'bg-charcoal-900 ring-emerald-400/25'
                      : 'bg-charcoal-900 ring-white/10'
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
                        ? 'bg-emerald-500 ring-emerald-400 text-charcoal-950'
                        : isActive
                          ? 'bg-crimson-600 ring-crimson-400 text-white'
                          : 'bg-charcoal-950 ring-white/15 text-bone/50'
                    }`}
                  >
                    {done ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                    ) : i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-black text-bone">{step.title}</span>
                      {isStub && (
                        <span className="text-[9px] font-extrabold tracking-widest uppercase px-1.5 py-0.5 rounded bg-bone/5 ring-1 ring-white/10 text-bone/55">Coming next</span>
                      )}
                    </div>
                    <p className="text-[12.5px] text-bone/60 leading-snug mt-0.5">{step.hint}</p>
                  </div>
                </button>

                {isActive && step.key === 'plan' && (
                  <div className="px-4 pb-4 pt-1 border-t border-white/5 space-y-3 animate-fade-in">
                    <div>
                      <label className="block text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1">Season name</label>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Fall 2026 / Spring 2027 / 2027-28 ECNL"
                        className="w-full bg-charcoal-950 ring-1 ring-white/10 rounded-lg px-3 py-2.5 text-sm text-bone placeholder:text-bone/35 focus:outline-none focus:ring-crimson-400/50"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1">Start date</label>
                        <input
                          type="date"
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                          className="w-full bg-charcoal-950 ring-1 ring-white/10 rounded-lg px-3 py-2.5 text-sm text-bone focus:outline-none focus:ring-crimson-400/50"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1">End date</label>
                        <input
                          type="date"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                          className="w-full bg-charcoal-950 ring-1 ring-white/10 rounded-lg px-3 py-2.5 text-sm text-bone focus:outline-none focus:ring-crimson-400/50"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-extrabold tracking-widest uppercase text-bone/55 mb-1">Age groups</label>
                      <input
                        type="text"
                        value={ageGroupsInput}
                        onChange={(e) => setAgeGroupsInput(e.target.value)}
                        placeholder="U8, U10, U12, U14"
                        className="w-full bg-charcoal-950 ring-1 ring-white/10 rounded-lg px-3 py-2.5 text-sm text-bone placeholder:text-bone/35 focus:outline-none focus:ring-crimson-400/50"
                      />
                      <p className="text-[11px] text-bone/45 mt-1">Comma-separated. Each age group gets its own coach assignment + tryout date downstream.</p>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={savePlan}
                        disabled={saving}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-crimson-600 hover:bg-crimson-500 text-white font-bold rounded-md ring-1 ring-crimson-400/30 transition-colors text-sm disabled:opacity-50"
                      >
                        {saving ? 'Saving…' : (done ? 'Save changes' : 'Save and continue')}
                      </button>
                    </div>
                  </div>
                )}

                {isActive && step.key !== 'plan' && (
                  <div className="px-4 pb-4 pt-1 border-t border-white/5 animate-fade-in">
                    <div className="text-[12.5px] text-bone/60 italic">
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
    return d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

function deriveActiveStep(s: Season): WizardStepKey {
  // Resume the wizard at the first un-completed step. Simple heuristic
  // for v1; gets smarter as more steps are wired.
  if (!s.name || !(s as any).ageGroups?.length) return 'plan';
  return 'coaches';
}

export default SeasonWizard;
