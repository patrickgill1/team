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

const CATEGORY: Record<Drill['category'], { label: string; color: string; emoji: string }> = {
  warmup:    { label: 'Warm-up',   color: 'bg-amber-100 text-amber-800 border-amber-300',     emoji: '🏃' },
  technical: { label: 'Technical', color: 'bg-fire-100 text-fire-800 border-fire-300',         emoji: '⚽' },
  tactical:  { label: 'Tactical',  color: 'bg-violet-100 text-violet-800 border-violet-300',   emoji: '🧠' },
  scrimmage: { label: 'Scrimmage', color: 'bg-emerald-100 text-emerald-800 border-emerald-300', emoji: '🥅' },
  fitness:   { label: 'Fitness',   color: 'bg-rose-100 text-rose-800 border-rose-300',         emoji: '💪' },
  cooldown:  { label: 'Cool-down', color: 'bg-sky-100 text-sky-800 border-sky-300',            emoji: '🧘' },
};

const DRILL_LIBRARY: Drill[] = [
  { id: 'lib_1', name: 'Dynamic Warm-up',          durationMin: 10, category: 'warmup',    notes: 'Skips, lunges, leg swings, arm circles' },
  { id: 'lib_2', name: 'Rondo (4v1)',              durationMin: 10, category: 'technical', notes: 'Quick passes, one-touch focus' },
  { id: 'lib_3', name: 'Passing Lanes',            durationMin: 12, category: 'technical', notes: 'Triangles, overlaps' },
  { id: 'lib_4', name: '1v1 Defending',            durationMin: 10, category: 'tactical',  notes: 'Approach angle, body shape' },
  { id: 'lib_5', name: 'Possession Game (5v5+1)',  durationMin: 15, category: 'tactical',  notes: 'Switch fields, find the +1' },
  { id: 'lib_6', name: 'Shooting Reps',            durationMin: 12, category: 'technical', notes: 'Both feet, far post' },
  { id: 'lib_7', name: 'Set Pieces',               durationMin: 10, category: 'tactical',  notes: 'Corners + free kicks' },
  { id: 'lib_8', name: 'Small-sided Scrimmage',    durationMin: 20, category: 'scrimmage', notes: '4v4 or 5v5, 2 touches' },
  { id: 'lib_9', name: 'Full Scrimmage',           durationMin: 25, category: 'scrimmage', notes: 'Full numbers if possible' },
  { id: 'lib_10', name: 'Sprint Ladder',           durationMin: 8,  category: 'fitness',   notes: '4 sets of 6 sprints' },
  { id: 'lib_11', name: 'Stretch & Cool-down',     durationMin: 8,  category: 'cooldown',  notes: 'Hamstrings, calves, hips' },
];

const newId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const PracticePlanBuilder: React.FC = () => {
  const { userData } = useAuth();
  const { selectedTeamId, currentTeam } = useTeam();
  const isUserCoach = userData ? isCoach(userData.role) : false;

  const [plans, setPlans] = useState<PracticePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);

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

  if (!isUserCoach) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <div className="text-4xl mb-2">🔒</div>
          <h2 className="font-bold text-amber-900">Coaches only</h2>
          <p className="text-sm text-amber-700 mt-1">The Practice Plan Builder is available to coaches only.</p>
          <Link to="/dashboard" className="inline-block mt-4 px-4 py-2 bg-navy-700 text-white rounded-lg">Back to Dashboard</Link>
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
    <div className="min-h-screen bg-slate-50 print:bg-white">
      {/* Header */}
      <div className="bg-gradient-to-r from-navy-700 via-navy-600 to-fire-700 text-white print:hidden">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">🗒️ Practice Plan Builder</h1>
              <p className="text-white/70 text-sm mt-0.5">{currentTeam?.name || 'Your team'}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => newPlan()} className="px-4 py-2 bg-white/15 hover:bg-white/25 rounded-xl font-semibold text-sm ring-1 ring-white/20">
                + New Plan
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-4 sm:p-6 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-6">
        {/* Sidebar: plan list */}
        <aside className="print:hidden">
          <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200/70 p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-2 mb-2">Your plans</div>
            {loading ? (
              <div className="text-sm text-slate-400 px-2 py-4">Loading…</div>
            ) : plans.length === 0 ? (
              <div className="text-sm text-slate-400 px-2 py-4">No plans yet. Click <b>+ New Plan</b>.</div>
            ) : (
              <ul className="space-y-1">
                {plans.map(p => (
                  <li key={p.id}>
                    <button
                      onClick={() => setActiveId(p.id || null)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm ${activeId === p.id ? 'bg-fire-50 text-navy-800 ring-1 ring-fire-200' : 'hover:bg-slate-50 text-slate-700'}`}
                    >
                      <div className="font-semibold truncate flex items-center gap-1.5">
                        {p.isTemplate && <span title="Template">📌</span>}
                        {p.title}
                      </div>
                      <div className="text-[11px] text-slate-500">{p.drills.length} drill{p.drills.length === 1 ? '' : 's'} · {p.drills.reduce((s, d) => s + (d.durationMin || 0), 0)} min</div>
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
            <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200/70 p-12 text-center">
              <div className="text-5xl mb-3">📋</div>
              <h2 className="font-bold text-navy-900 text-lg">Pick a plan, or create a new one</h2>
              <p className="text-slate-500 text-sm mt-1">Build a timeline of drills, save it as a template, share with your assistants, and print before practice.</p>
              <button onClick={() => newPlan()} className="mt-5 px-5 py-2.5 bg-gradient-to-r from-fire-600 to-navy-600 hover:from-fire-500 hover:to-navy-500 text-white font-semibold rounded-xl shadow-sm">+ Create Plan</button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200/70 p-5 print:shadow-none print:ring-0">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                  <input
                    value={active.title}
                    onChange={e => update(p => ({ ...p, title: e.target.value }))}
                    className="sm:col-span-2 px-3 py-2 rounded-xl border border-slate-300 focus:border-fire-500 focus:ring-2 focus:ring-fire-500/20 text-base font-bold text-navy-900"
                  />
                  <input
                    type="date"
                    value={active.date || ''}
                    onChange={e => update(p => ({ ...p, date: e.target.value }))}
                    className="px-3 py-2 rounded-xl border border-slate-300 focus:border-fire-500 focus:ring-2 focus:ring-fire-500/20 text-sm"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <label className="flex items-center gap-1.5 text-sm">
                    <span className="text-slate-600">Target length</span>
                    <input
                      type="number"
                      min={15} max={180} step={5}
                      value={active.durationMin}
                      onChange={e => update(p => ({ ...p, durationMin: parseInt(e.target.value || '0', 10) }))}
                      className="w-20 px-2 py-1 rounded border border-slate-300 text-sm"
                    /> <span className="text-slate-500 text-sm">min</span>
                  </label>
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${totalMin > active.durationMin ? 'bg-rose-100 text-rose-700' : totalMin === active.durationMin ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                    Filled: {totalMin}/{active.durationMin} min
                  </span>
                  <label className="flex items-center gap-1.5 text-xs ml-auto">
                    <input
                      type="checkbox"
                      checked={!!active.isTemplate}
                      onChange={e => update(p => ({ ...p, isTemplate: e.target.checked }))}
                      className="h-4 w-4 text-fire-600 focus:ring-fire-500/30 border-slate-300 rounded"
                    />
                    <span className="text-slate-600">Save as reusable template</span>
                  </label>
                </div>

                <div className="flex flex-wrap gap-2 print:hidden">
                  <button onClick={() => setShowLibrary(true)} className="px-3 py-1.5 text-sm bg-fire-50 hover:bg-fire-100 text-navy-700 rounded-lg ring-1 ring-fire-200 font-semibold">
                    📚 Add from library
                  </button>
                  <button
                    onClick={() => addDrill({ id: newId(), name: 'New drill', durationMin: 10, category: 'technical' })}
                    className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold"
                  >+ Custom drill</button>
                  <button onClick={() => newPlan(active)} className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold">📄 Duplicate</button>
                  <button onClick={printPlan} className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-semibold">🖨️ Print / PDF</button>
                  <button onClick={() => active.id && removePlan(active.id)} className="ml-auto px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-50 rounded-lg font-semibold">Delete</button>
                </div>
              </div>

              {/* Timeline */}
              <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200/70 p-5 print:shadow-none print:ring-0">
                {active.drills.length === 0 ? (
                  <div className="text-center text-slate-400 py-8 text-sm">No drills yet. Add from the library or build a custom block.</div>
                ) : (
                  <ol className="space-y-3">
                    {active.drills.map((d, idx) => {
                      const startMin = active.drills.slice(0, idx).reduce((s, x) => s + (x.durationMin || 0), 0);
                      const meta = CATEGORY[d.category];
                      return (
                        <li key={d.id} className={`rounded-xl border ${meta.color} p-3 print:break-inside-avoid`}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-[10px] font-mono tabular-nums text-slate-600 bg-white/60 rounded px-1.5 py-0.5">
                              {String(Math.floor(startMin / 60)).padStart(1, '0')}:{String(startMin % 60).padStart(2, '0')}
                            </span>
                            <span className="text-[10px] font-bold uppercase tracking-wider">{meta.emoji} {meta.label}</span>
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
                              className="w-14 bg-white/60 rounded px-2 py-0.5 text-xs text-slate-700"
                            /><span className="text-xs">min</span>
                            <select
                              value={d.category}
                              onChange={e => editDrill(d.id, { category: e.target.value as Drill['category'] })}
                              className="bg-white/60 rounded px-1.5 py-0.5 text-xs print:hidden"
                            >
                              {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                            </select>
                            <div className="flex items-center gap-1 print:hidden">
                              <button onClick={() => moveDrill(idx, -1)} disabled={idx === 0} className="text-xs px-1.5 disabled:opacity-30">↑</button>
                              <button onClick={() => moveDrill(idx, 1)} disabled={idx === active.drills.length - 1} className="text-xs px-1.5 disabled:opacity-30">↓</button>
                              <button onClick={() => removeDrill(d.id)} className="text-xs px-1.5 text-rose-700">✕</button>
                            </div>
                          </div>
                          <textarea
                            value={d.notes || ''}
                            onChange={e => editDrill(d.id, { notes: e.target.value })}
                            placeholder="Notes (setup, key coaching points, equipment…)"
                            rows={2}
                            className="w-full bg-white/40 rounded-lg p-2 text-xs text-slate-700 placeholder-slate-500/70 focus:outline-none focus:bg-white/70"
                          />
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              {/* Plan-level notes */}
              <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200/70 p-5 print:shadow-none print:ring-0">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">General notes</label>
                <textarea
                  value={active.notes || ''}
                  onChange={e => update(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Anything you want assistants/parents to know about this practice."
                  rows={3}
                  className="mt-1.5 w-full px-3 py-2 rounded-xl border border-slate-300 focus:border-fire-500 focus:ring-2 focus:ring-fire-500/20 text-sm"
                />
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Library modal */}
      {showLibrary && active && (
        <div className="fixed inset-0 z-50 bg-navy-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 print:hidden" onClick={() => setShowLibrary(false)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[88vh] overflow-y-auto ring-1 ring-slate-200" onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 bg-gradient-to-r from-navy-700 to-fire-700 px-5 py-3 flex items-center justify-between">
              <h3 className="text-white font-bold">📚 Drill Library</h3>
              <button onClick={() => setShowLibrary(false)} className="text-white/70 hover:text-white text-xl">✕</button>
            </div>
            <div className="p-3 space-y-2">
              {DRILL_LIBRARY.map(d => {
                const meta = CATEGORY[d.category];
                return (
                  <button
                    key={d.id}
                    onClick={() => addDrill(d)}
                    className={`w-full text-left rounded-xl border ${meta.color} p-3 hover:ring-2 hover:ring-fire-300 transition`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider">{meta.emoji} {meta.label}</span>
                      <span className="ml-auto text-[10px] bg-white/60 rounded px-1.5 py-0.5 text-slate-700 font-semibold">{d.durationMin} min</span>
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
