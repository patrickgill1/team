import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { arrayUnion, collection, doc, getDocs, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin } from '../utils/helpers';
import {
  canTransitionSeason,
  inferSeasonLifecycle,
  seasonLifecycleLabel,
  seasonLifecycleTone,
  validSeasonTransitions,
} from '../utils/seasonLifecycle';
import type { Season, SeasonLifecycle } from '../types';

// Club-wide season lifecycle manager. Every season's current state is
// inferred (legacy seasons predate the lifecycle field), and any valid
// next-state transition is one click away. Each transition appends to
// `lifecycleHistory` so the audit trail is visible inline.

const Seasons: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [loading, setLoading] = useState(true);
  const [openHistoryFor, setOpenHistoryFor] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState<string | null>(null);

  const reload = async () => {
    try {
      setLoading(true);
      const snap = await getDocs(query(collection(db, 'seasons'), orderBy('createdAt', 'desc')));
      setSeasons(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Season));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (allowed) void reload(); }, [allowed]);

  const handleTransition = async (s: Season, to: SeasonLifecycle) => {
    const from = inferSeasonLifecycle(s);
    if (!canTransitionSeason(from, to)) return;
    const note = window.prompt(`Move "${s.name}" → ${seasonLifecycleLabel(to)}?\n\nOptional note for the audit log:`);
    if (note === null) return;
    setTransitioning(s.id);
    try {
      const event = {
        fromState: from,
        toState: to,
        at: new Date(),
        by: userData?.uid,
        byName: userData?.name,
        note: note.trim() || undefined,
      };
      const patch: Record<string, any> = {
        lifecycle: to,
        lifecycleHistory: arrayUnion(event),
        updatedAt: serverTimestamp(),
      };
      // Keep legacy boolean flags in sync so older readers don't drift.
      if (to === 'registration_open') {
        patch.registrationOpen = true;
        patch.registrationOpenedAt = serverTimestamp();
      } else if (from === 'registration_open') {
        patch.registrationOpen = false;
      }
      if (to === 'archived') {
        patch.archivedAt = serverTimestamp();
        patch.isActive = false;
      } else if (to === 'in_season') {
        patch.isActive = true;
      } else if (to === 'ended') {
        patch.isActive = false;
      }
      await updateDoc(doc(db, 'seasons', s.id), patch);
      void reload();
    } finally {
      setTransitioning(null);
    }
  };

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center p-8 text-slate-600 text-sm">Club admins only.</div>;
  }

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-6 sm:py-10">
      <div className="max-w-4xl mx-auto space-y-4">
        <div>
          <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-700">← Club</Link>
          <h1 className="text-2xl font-black text-fire-950 mt-1">Seasons</h1>
          <p className="text-sm text-slate-600">
            Move each season through its lifecycle. Every transition is logged for the audit trail.
          </p>
        </div>

        {loading ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-6 text-sm text-slate-500">Loading…</div>
        ) : seasons.length === 0 ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-200 p-8 text-center text-sm text-slate-500">
            No seasons exist yet. Create one from the Team management page.
          </div>
        ) : (
          <ul className="space-y-3">
            {seasons.map(s => {
              const state = inferSeasonLifecycle(s);
              const tone = seasonLifecycleTone(state);
              const validNext = validSeasonTransitions(state);
              const isHistoryOpen = openHistoryFor === s.id;
              const history = (s.lifecycleHistory || []).slice().reverse();
              return (
                <li key={s.id} className="bg-white rounded-2xl ring-1 ring-gray-200 overflow-hidden">
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-black text-fire-950">{s.name}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {fmt(s.startDate)} → {fmt(s.endDate)}
                        </div>
                      </div>
                      <span className={`text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded ring-1 shrink-0 ${tone.bg} ${tone.text} ${tone.ring}`}>
                        {seasonLifecycleLabel(state)}
                      </span>
                    </div>

                    {validNext.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        {validNext.map(next => (
                          <button
                            key={next}
                            type="button"
                            disabled={transitioning === s.id}
                            onClick={() => handleTransition(s, next)}
                            className="text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded bg-cyan-50 hover:bg-cyan-100 text-cyan-800 ring-1 ring-cyan-200 disabled:opacity-50"
                          >
                            → {seasonLifecycleLabel(next)}
                          </button>
                        ))}
                      </div>
                    )}

                    {history.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setOpenHistoryFor(isHistoryOpen ? null : s.id)}
                        className="mt-3 text-[11px] font-bold text-slate-500 hover:text-slate-700"
                      >
                        {isHistoryOpen ? 'Hide history' : `History (${history.length})`}
                      </button>
                    )}
                  </div>

                  {isHistoryOpen && history.length > 0 && (
                    <ul className="border-t border-slate-100 divide-y divide-slate-100">
                      {history.map((e, i) => {
                        const ts = toDate(e.at);
                        return (
                          <li key={i} className="px-4 py-2 text-[11px] flex items-start gap-3">
                            <div className="font-bold text-slate-700 shrink-0 whitespace-nowrap">
                              {e.fromState ? `${seasonLifecycleLabel(e.fromState)} → ` : ''}{seasonLifecycleLabel(e.toState)}
                            </div>
                            <div className="flex-1 min-w-0 text-slate-500">
                              {e.byName || 'System'} · {ts.toLocaleDateString()} {ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                              {e.note && <div className="text-slate-700 italic mt-0.5">"{e.note}"</div>}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

function toDate(v: any): Date {
  if (!v) return new Date();
  if (v instanceof Date) return v;
  if (typeof v?.toDate === 'function') return v.toDate();
  return new Date(v);
}

function fmt(d: any): string {
  const dt = toDate(d);
  return dt.toLocaleDateString();
}

export default Seasons;
