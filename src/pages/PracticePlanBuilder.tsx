// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoach } from '../utils/helpers';
import Header from '../components/common/Header';
import AppIcon from '../components/common/AppIcon';

interface Drill {
  id: string;
  name: string;
  durationMin: number;
  category: 'warmup' | 'technical' | 'tactical' | 'scrimmage' | 'fitness' | 'cooldown';
  notes?: string;
  equipment?: string;
}

interface PracticePlan {
  id?: string;
  teamId: string;
  title: string;
  date?: string;          // YYYY-MM-DD
  durationMin: number;    // total target
  drills: Drill[];
  isTemplate: boolean;
  notes?: string;
  createdBy?: string;
  createdByName?: string;
  createdAt?: any;
  updatedAt?: any;
}

// Category descriptors — color stays inside the Fire palette (no
// violet/amber). `icon` is an AppIcon name so we render outlines
// instead of mixed emoji.
const CATEGORY: Record<Drill['category'], { label: string; color: string; icon: any }> = {
  warmup:    { label: 'Warm-up',   color: 'bg-brand-primary/15 text-charcoal-800 border-brand-primary-soft/30',         icon: 'running' },
  technical: { label: 'Technical', color: 'bg-brand-primary/15 text-brand-primary-soft border-brand-primary-soft/30',         icon: 'soccer' },
  tactical:  { label: 'Tactical',  color: 'bg-surface-raised/10 text-charcoal-800 border-charcoal-700/20', icon: 'chart' },
  scrimmage: { label: 'Scrimmage', color: 'bg-emerald-500/15 text-emerald-200 border-emerald-400/30', icon: 'trophy' },
  fitness:   { label: 'Fitness',   color: 'bg-brand-primary/20 text-charcoal-800 border-brand-primary-soft/40',        icon: 'highlight' },
  cooldown:  { label: 'Cool-down', color: 'bg-brand-primary/20 text-brand-primary-soft border-brand-primary-soft/30',        icon: 'check' },
};

// Library drills now load LIVE from the real `drills` collection so
// Practice Plan Builder is fed by the same catalog as the Training
// Ground page. The hardcoded 11-drill DRILL_LIBRARY was retired and
// imported as a one-time seed (see scripts/seed-starter-drills.ts).
//
// Real drills have a richer schema than the builder's local Drill
// shape — adaptRealDrill() maps title → name, durationMinutes →
// durationMin, focus/description → notes, and picks a sensible
// session segment from the real drill's category + useCase.
function pickSegment(realCategory: string | undefined, useCase: string | undefined): Drill['category'] {
  if (useCase === 'solo') return 'fitness';
  switch (realCategory) {
    case 'tactical': return 'tactical';
    case 'physical': return 'fitness';
    case 'mental':   return 'technical';
    case 'technical':
    default:         return 'technical';
  }
}

function adaptRealDrill(d: any): Drill {
  return {
    id: d.id,
    name: d.title || 'Untitled drill',
    durationMin: typeof d.durationMinutes === 'number' && d.durationMinutes > 0 ? d.durationMinutes : 10,
    category: pickSegment(d.category, d.useCase),
    notes: d.focus || d.description || undefined,
  };
}

const newId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const PracticePlanBuilder: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, currentTeam } = useTeam();
  const isUserCoach = userData ? isCoach(userData.role) : false;

  const [plans, setPlans] = useState<PracticePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  // Real drill library, pulled from the `drills` collection so this
  // page and Training Ground share the same source of truth.
  const [libraryDrills, setLibraryDrills] = useState<Drill[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const active = useMemo(() => plans.find(p => p.id === activeId) || null, [plans, activeId]);
  const totalMin = useMemo(() => (active ? active.drills.reduce((s, d) => s + (d.durationMin || 0), 0) : 0), [active]);

  // Load plans
  useEffect(() => {
    if (!selectedTeamId) return;
    setLoading(true);
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'practice_plans'), where('teamId', '==', selectedTeamId)));
        const items = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as PracticePlan[];
        items.sort((a, b) => {
          const at = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0;
          const bt = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0;
          return bt - at;
        });
        setPlans(items);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [selectedTeamId]);

  // Load the real drill library — same source as Training Ground.
  // Filters: this team's drills + any club-shared drills the user
  // has access to. Active only. Sort by most-used first so the
  // workhorses bubble to the top of the library picker.
  useEffect(() => {
    if (!selectedTeamId) return;
    let cancelled = false;
    (async () => {
      setLibraryLoading(true);
      try {
        const snap = await getDocs(query(collection(db, 'drills'), where('teamId', '==', selectedTeamId)));
        if (cancelled) return;
        const adapted = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((d: any) => d.isActive !== false)
          .sort((a: any, b: any) => (b.assignmentCount || 0) - (a.assignmentCount || 0))
          .map(adaptRealDrill);
        setLibraryDrills(adapted);
      } catch (e) {
        console.warn('drill library load failed', e);
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  if (!isUserCoach) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-amber-500/15 border border-amber-400/30 rounded-xl p-6 text-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10 mx-auto mb-2 text-amber-300">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          <h2 className="font-bold text-amber-100">Coaches only</h2>
          <p className="text-sm text-amber-300 mt-1">Training Sessions are coach-side. Parents see what their kid does, not the playbook.</p>
          <Link to="/dashboard" className="inline-block mt-4 px-4 py-2 bg-surface-raised text-white rounded-lg">Back to Team HQ</Link>
        </div>
      </div>
    );
  }

  const newPlan = async (template?: PracticePlan) => {
    if (!selectedTeamId || !userData) return;
    const data: PracticePlan = {
      teamId: selectedTeamId,
      title: template ? `${template.title} (copy)` : 'New Practice Plan',
      durationMin: template?.durationMin || 75,
      drills: template ? template.drills.map(d => ({ ...d, id: newId() })) : [],
      isTemplate: false,
      createdBy: userData.uid,
      createdByName: userData.name || userData.email || 'Coach',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const ref = await addDoc(collection(db, 'practice_plans'), data);
    const created: PracticePlan = { ...data, id: ref.id };
    setPlans(p => [created, ...p]);
    setActiveId(ref.id);
  };

  const persist = async (next: PracticePlan) => {
    if (!next.id) return;
    setPlans(prev => prev.map(p => p.id === next.id ? next : p));
    try {
      await updateDoc(doc(db, 'practice_plans', next.id), { ...next, updatedAt: serverTimestamp() } as any);
    } catch (e) { console.error('save failed', e); }
  };

  const update = (mutator: (p: PracticePlan) => PracticePlan) => {
    if (!active) return;
    persist(mutator(active));
  };

  const removePlan = async (planId: string) => {
    if (!window.confirm('Delete this practice plan?')) return;
    try {
      await deleteDoc(doc(db, 'practice_plans', planId));
      setPlans(prev => prev.filter(p => p.id !== planId));
      if (activeId === planId) setActiveId(null);
    } catch (e) { alert('Failed to delete.'); console.error(e); }
  };

  const addDrill = (drill: Drill) => {
    update(p => ({ ...p, drills: [...p.drills, { ...drill, id: newId() }] }));
    setShowLibrary(false);
  };
  const moveDrill = (idx: number, dir: -1 | 1) => {
    update(p => {
      const drills = [...p.drills];
      const j = idx + dir;
      if (j < 0 || j >= drills.length) return p;
      [drills[idx], drills[j]] = [drills[j], drills[idx]];
      return { ...p, drills };
    });
  };
  const removeDrill = (id: string) => update(p => ({ ...p, drills: p.drills.filter(d => d.id !== id) }));
  const editDrill = (id: string, patch: Partial<Drill>) => update(p => ({ ...p, drills: p.drills.map(d => d.id === id ? { ...d, ...patch } : d) }));

  const printPlan = () => {
    if (!active) return;
    window.print();
  };

  return (
    <div className="min-h-screen bg-surface-base print:bg-surface-elevated">
      <div className="print:hidden">
        <Header title="Training Sessions" subtitle="Drag drills into a timeline, save as a template, print before training." />
      </div>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 flex justify-end print:hidden">
        <button
          onClick={() => newPlan()}
          className="bg-brand-primary hover:bg-brand-primary text-white px-4 py-2 rounded-xl font-semibold text-sm shadow-sm flex items-center gap-2"
        >
          <AppIcon name="plus" className="w-4 h-4" strokeWidth={2.5} />
          <span>New Plan</span>
        </button>
      </div>

      <div className="max-w-6xl mx-auto p-4 sm:p-6 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-6">
        {/* Sidebar: plan list */}
        <aside className="print:hidden">
          <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/10/70 p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-ink-primary/50 px-2 mb-2">Your plans</div>
            {loading ? (
              <div className="text-sm text-ink-primary/40 px-2 py-4">Loading…</div>
            ) : plans.length === 0 ? (
              <div className="text-sm text-ink-primary/40 px-2 py-4">No plans yet. Click <b>+ New Plan</b>.</div>
            ) : (
              <ul className="space-y-1">
                {plans.map(p => (
                  <li key={p.id}>
                    <button
                      onClick={() => setActiveId(p.id || null)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm ${activeId === p.id ? 'bg-brand-primary/15 text-charcoal-800 ring-1 ring-brand-primary-soft' : 'hover:bg-line-default/[0.05] text-ink-primary/85'}`}
                    >
                      <div className="font-semibold truncate flex items-center gap-1.5">
                        {p.isTemplate && (
                          <span className="text-brand-primary-soft shrink-0" title="Reusable template">
                            <AppIcon name="bell" className="w-3.5 h-3.5" />
                          </span>
                        )}
                        {p.title}
                      </div>
                      <div className="text-[11px] text-ink-primary/50">{p.drills.length} drill{p.drills.length === 1 ? '' : 's'} · {p.drills.reduce((s, d) => s + (d.durationMin || 0), 0)} min</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Main: editor */}
        <main>
          {!active ? (
            <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/10 p-12 text-center">
              <div className="mb-3 flex justify-center text-ink-primary/35">
                <AppIcon name="clipboard" className="w-12 h-12" />
              </div>
              <h2 className="font-bold text-ink-primary text-lg">Pick a plan, or create a new one</h2>
              <p className="text-ink-primary/50 text-sm mt-1">Build a timeline of drills, save it as a template, share with your assistants, and print before practice.</p>
              <button onClick={() => newPlan()} className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 bg-brand-primary hover:bg-brand-primary text-white font-semibold rounded-xl shadow-sm">
                <AppIcon name="plus" className="w-4 h-4" strokeWidth={2.5} />
                <span>Create Plan</span>
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/10/70 p-5 print:shadow-none print:ring-0">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                  <input
                    value={active.title}
                    onChange={e => update(p => ({ ...p, title: e.target.value }))}
                    className="sm:col-span-2 px-3 py-2 rounded-xl border border-line-default/15 focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/20 text-base font-bold text-ink-primary/90"
                  />
                  <input
                    type="date"
                    value={active.date || ''}
                    onChange={e => update(p => ({ ...p, date: e.target.value }))}
                    className="px-3 py-2 rounded-xl border border-line-default/15 focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/20 text-sm"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <label className="flex items-center gap-1.5 text-sm">
                    <span className="text-ink-primary/65">Target length</span>
                    <input
                      type="number"
                      min={15} max={180} step={5}
                      value={active.durationMin}
                      onChange={e => update(p => ({ ...p, durationMin: parseInt(e.target.value || '0', 10) }))}
                      className="w-20 px-2 py-1 rounded border border-line-default/15 text-sm"
                    /> <span className="text-ink-primary/50 text-sm">min</span>
                  </label>
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${totalMin > active.durationMin ? 'bg-rose-500/20 text-rose-300' : totalMin === active.durationMin ? 'bg-emerald-500/20 text-emerald-300' : 'bg-surface-base text-ink-primary/65'}`}>
                    Filled: {totalMin}/{active.durationMin} min
                  </span>
                  <label className="flex items-center gap-1.5 text-xs ml-auto">
                    <input
                      type="checkbox"
                      checked={!!active.isTemplate}
                      onChange={e => update(p => ({ ...p, isTemplate: e.target.checked }))}
                      className="h-4 w-4 text-ink-primary/65 focus:ring-brand-primary/30 border-line-default/15 rounded"
                    />
                    <span className="text-ink-primary/65">Save as reusable template</span>
                  </label>
                </div>

                <div className="flex flex-wrap gap-2 print:hidden">
                  <button
                    onClick={() => setShowLibrary(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand-primary/15 hover:bg-brand-primary/20 text-brand-primary-soft rounded-lg ring-1 ring-brand-primary-soft font-semibold"
                  >
                    <AppIcon name="clipboard" className="w-4 h-4" />
                    <span>Add from library</span>
                  </button>
                  <button
                    onClick={() => addDrill({ id: newId(), name: 'New drill', durationMin: 10, category: 'technical' })}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-line-default/[0.08] hover:bg-line-default/[0.1] text-ink-primary/85 rounded-lg font-semibold"
                  >
                    <AppIcon name="plus" className="w-4 h-4" strokeWidth={2.5} />
                    <span>Custom drill</span>
                  </button>
                  <button
                    onClick={() => newPlan(active)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-line-default/[0.08] hover:bg-line-default/[0.1] text-ink-primary/85 rounded-lg font-semibold"
                  >
                    <AppIcon name="edit" className="w-4 h-4" />
                    <span>Duplicate</span>
                  </button>
                  <button
                    onClick={printPlan}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-line-default/[0.08] hover:bg-line-default/[0.1] text-ink-primary/85 rounded-lg font-semibold"
                  >
                    <AppIcon name="news" className="w-4 h-4" />
                    <span>Print / PDF</span>
                  </button>
                  <button
                    onClick={() => active.id && removePlan(active.id)}
                    className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/15 rounded-lg font-semibold"
                  >
                    <AppIcon name="trash" className="w-4 h-4" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>

              {/* Timeline */}
              <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/10/70 p-5 print:shadow-none print:ring-0">
                {active.drills.length === 0 ? (
                  <div className="text-center text-ink-primary/40 py-8 text-sm">Empty session. Pull drills from the library or build one.</div>
                ) : (
                  <ol className="space-y-3">
                    {active.drills.map((d, idx) => {
                      const startMin = active.drills.slice(0, idx).reduce((s, x) => s + (x.durationMin || 0), 0);
                      const meta = CATEGORY[d.category];
                      return (
                        <li key={d.id} className={`rounded-xl border ${meta.color} p-3 print:break-inside-avoid`}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-[10px] font-mono tabular-nums text-ink-primary/65 bg-line-default/60 rounded px-1.5 py-0.5">
                              {String(Math.floor(startMin / 60)).padStart(1, '0')}:{String(startMin % 60).padStart(2, '0')}
                            </span>
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider">
                              <AppIcon name={meta.icon} className="w-3 h-3" />
                              <span>{meta.label}</span>
                            </span>
                            <input
                              value={d.name}
                              onChange={e => editDrill(d.id, { name: e.target.value })}
                              className="flex-1 bg-transparent border-b border-current/30 focus:border-current focus:outline-none font-semibold text-sm py-0.5"
                            />
                            <input
                              type="number"
                              min={1} max={120}
                              value={d.durationMin}
                              onChange={e => editDrill(d.id, { durationMin: parseInt(e.target.value || '0', 10) })}
                              className="w-14 bg-line-default/60 rounded px-2 py-0.5 text-xs text-ink-primary/85"
                            /><span className="text-xs">min</span>
                            <select
                              value={d.category}
                              onChange={e => editDrill(d.id, { category: e.target.value as Drill['category'] })}
                              className="bg-line-default/60 rounded px-1.5 py-0.5 text-xs print:hidden"
                            >
                              {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                            </select>
                            <div className="flex items-center gap-1 print:hidden">
                              <button onClick={() => moveDrill(idx, -1)} disabled={idx === 0} className="text-xs px-1.5 disabled:opacity-30">↑</button>
                              <button onClick={() => moveDrill(idx, 1)} disabled={idx === active.drills.length - 1} className="text-xs px-1.5 disabled:opacity-30">↓</button>
                              <button onClick={() => removeDrill(d.id)} className="text-xs px-1.5 text-rose-300">✕</button>
                            </div>
                          </div>
                          <textarea
                            value={d.notes || ''}
                            onChange={e => editDrill(d.id, { notes: e.target.value })}
                            placeholder="Notes (setup, key coaching points, equipment…)"
                            rows={2}
                            className="w-full bg-line-default/40 rounded-lg p-2 text-xs text-ink-primary/85 placeholder-bone/50/70 focus:outline-none focus:bg-line-default/70"
                          />
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              {/* Plan-level notes */}
              <div className="bg-surface-elevated rounded-2xl shadow-sm ring-1 ring-line-default/10/70 p-5 print:shadow-none print:ring-0">
                <label className="text-[11px] font-bold uppercase tracking-wider text-ink-primary/50">General notes</label>
                <textarea
                  value={active.notes || ''}
                  onChange={e => update(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Anything you want assistants/parents to know about this practice."
                  rows={3}
                  className="mt-1.5 w-full px-3 py-2 rounded-xl border border-line-default/15 focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/20 text-sm"
                />
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Library modal */}
      {showLibrary && active && (
        <div className="fixed inset-0 z-50 bg-surface-base/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 print:hidden" onClick={() => setShowLibrary(false)}>
          <div className="bg-surface-elevated rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[88vh] overflow-y-auto ring-1 ring-line-default/10" onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 bg-gradient-to-r from-surface-input to-surface-elevated px-5 py-3 flex items-center justify-between border-b border-line-default/5">
              <h3 className="text-white font-bold flex items-center gap-2">
                <AppIcon name="clipboard" className="w-5 h-5" />
                <span>Training Ground</span>
              </h3>
              <button onClick={() => setShowLibrary(false)} className="text-white/70 hover:text-white" aria-label="Close">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="p-3 space-y-2">
              {libraryLoading && (
                <div className="text-center text-ink-primary/55 text-sm py-6">Loading drills…</div>
              )}
              {!libraryLoading && libraryDrills.length === 0 && (
                <div className="text-center py-10 px-4">
                  <p className="text-sm font-bold text-ink-primary/85">No drills yet.</p>
                  <p className="text-xs text-ink-primary/55 mt-1">Head to Training Ground to build your library, then come back to drop drills into a session.</p>
                  <Link
                    to="/drills"
                    onClick={() => setShowLibrary(false)}
                    className="inline-block mt-4 px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/90 text-white text-xs font-extrabold tracking-widest uppercase"
                  >
                    Open Training Ground
                  </Link>
                </div>
              )}
              {!libraryLoading && libraryDrills.map(d => {
                const meta = CATEGORY[d.category];
                return (
                  <button
                    key={d.id}
                    onClick={() => addDrill(d)}
                    className={`w-full text-left rounded-xl border ${meta.color} p-3 hover:ring-2 hover:ring-brand-primary-soft transition`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider">{meta.label}</span>
                      <span className="ml-auto text-[10px] bg-line-default/60 rounded px-1.5 py-0.5 text-ink-primary/85 font-semibold">{d.durationMin} min</span>
                    </div>
                    <div className="font-semibold text-sm mt-1">{d.name}</div>
                    {d.notes && <div className="text-xs opacity-80 mt-0.5">{d.notes}</div>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PracticePlanBuilder;
