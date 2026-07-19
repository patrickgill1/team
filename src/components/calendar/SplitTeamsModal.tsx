// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useAuth } from '../../hooks/useAuth';
import type { CalendarEvent, Player } from '../../types';
import { isGuestActive } from '../../types';
import {
  splitTeams,
  averageScore,
  playerScore,
  LEVEL_LABELS,
} from '../../utils/snakeDraft';

// ── Split Teams modal — adult pickup auto-balance ────────────────
//
// Loads the team's roster, filters to the players RSVP'd "going" (if
// any RSVPs exist), runs snake-draft split, and shows the sides
// side-by-side. Reshuffle bumps the seed. Save persists to
// event.teamSplit.
//
// Deliberately simple v1: no drag-drop override, no size picker
// beyond 2/3 teams. Those are follow-ups. See utils/snakeDraft.ts
// for the algorithm.

interface Props {
  event: CalendarEvent;
  onClose: () => void;
  onSave: (split: {
    method: 'snake' | 'random';
    sides: Array<{ label: string; playerIds: string[] }>;
    generatedAt: Date;
    generatedBy: string;
  }) => void;
}

const SplitTeamsModal: React.FC<Props> = ({ event, onClose, onSave }) => {
  const { userData } = useAuth();
  const [roster, setRoster] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [numSides, setNumSides] = useState<2 | 3 | 4 | 5 | 6>(2);
  const [seed, setSeed] = useState(0);
  const [method, setMethod] = useState<'snake' | 'random'>('snake');

  // ── Load the team's roster (adult players on this team) ────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!event.teamId) return;
      setLoading(true);
      try {
        const snap = await getDocs(query(
          collection(db, 'players'),
          where('teamIds', 'array-contains', event.teamId),
        ));
        if (cancelled) return;
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) } as Player))
          .filter(p => (p as any).isActive !== false && isGuestActive(p as any));
        setRoster(list);
      } catch (err) {
        console.error('roster load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [event.teamId]);

  // ── Which roster feeds the split? ──────────────────────────────
  // Prefer the "going" RSVPs (real pickup game reality: only people
  // who confirmed are on the field). Fall back to the whole active
  // roster if no RSVPs exist yet (early planning use case).
  const goingSet = useMemo(() => {
    const playerRsvps = (event as any).playerRsvps || {};
    const going = new Set<string>();
    for (const [pid, status] of Object.entries(playerRsvps)) {
      if (status === 'going') going.add(pid);
    }
    return going;
  }, [event]);

  const eligibleRoster = useMemo(() => {
    if (goingSet.size === 0) return roster;
    return roster.filter(p => goingSet.has(p.id));
  }, [roster, goingSet]);

  const usingRsvpFilter = goingSet.size > 0;

  // ── Run the split. Recomputes on seed/side/method/roster change. ─
  const split = useMemo(() => splitTeams(eligibleRoster, { numSides, seed, method }), [eligibleRoster, numSides, seed, method]);

  const rosterById = useMemo(() => {
    const map = new Map<string, Player>();
    for (const p of eligibleRoster) map.set(p.id, p);
    return map;
  }, [eligibleRoster]);

  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({
        method,
        sides: split.sides,
        generatedAt: new Date(),
        generatedBy: userData?.uid || 'unknown',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl bg-surface-elevated rounded-t-3xl sm:rounded-2xl ring-1 ring-line-default/10 shadow-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-4 sm:px-5 pt-4 pb-3 border-b border-line-default/10">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft mb-0.5">Auto team split</p>
              <h2 className="text-lg font-black text-ink-primary leading-tight">Split teams</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-2 -mr-2 rounded-full text-ink-primary/60 hover:text-ink-primary hover:bg-line-default/10 transition"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <p className="text-[12px] text-ink-primary/55 mt-1">
            {usingRsvpFilter
              ? `Snake-drafting the ${eligibleRoster.length} players marked "going".`
              : `No RSVPs yet — using the full ${eligibleRoster.length}-player roster.`}
          </p>
        </div>

        {/* Controls */}
        <div className="flex-shrink-0 px-4 sm:px-5 py-3 border-b border-line-default/5 flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center bg-surface-base ring-1 ring-line-default/10 rounded-full p-0.5 flex-wrap">
            {([2, 3, 4, 5, 6] as const).map(n => (
              <button
                key={n}
                type="button"
                onClick={() => setNumSides(n)}
                className={`px-2.5 py-1.5 text-[11px] font-black tracking-wider uppercase rounded-full transition ${
                  numSides === n ? 'bg-brand-primary text-brand-primary-fg' : 'text-ink-primary/60 hover:text-ink-primary'
                }`}
              >
                {n}
              </button>
            ))}
            <span className="ml-1 pr-1.5 text-[10px] font-black uppercase tracking-widest text-ink-primary/40">teams</span>
          </div>
          <div className="inline-flex items-center bg-surface-base ring-1 ring-line-default/10 rounded-full p-0.5">
            {(['snake', 'random'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`px-3 py-1.5 text-[11px] font-black tracking-wider uppercase rounded-full transition ${
                  method === m ? 'bg-brand-primary text-white' : 'text-ink-primary/60 hover:text-ink-primary'
                }`}
              >
                {m === 'snake' ? 'Balanced' : 'Random'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSeed(s => s + 1)}
            className="ml-auto px-3 py-1.5 rounded-full bg-line-default/10 hover:bg-line-default/15 ring-1 ring-line-default/10 text-[11px] font-black tracking-wider uppercase text-ink-primary transition"
          >
            Reshuffle
          </button>
        </div>

        {/* Body — teams */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4">
          {loading ? (
            <p className="text-center text-ink-primary/45 text-sm py-8">Loading roster…</p>
          ) : eligibleRoster.length < numSides * 2 ? (
            <p className="text-center text-ink-primary/60 text-sm py-6">
              Need at least {numSides * 2} players to split into {numSides} sides. You have {eligibleRoster.length}.
            </p>
          ) : (
            <div className={`grid gap-3 ${
              numSides === 2 ? 'grid-cols-1 sm:grid-cols-2'
              : numSides === 3 ? 'grid-cols-1 sm:grid-cols-3'
              : numSides === 4 ? 'grid-cols-2 sm:grid-cols-2 lg:grid-cols-4'
              : 'grid-cols-2 sm:grid-cols-3'
            }`}>
              {split.sides.map(side => {
                const avg = averageScore(side.playerIds, eligibleRoster);
                return (
                  <div key={side.label} className="rounded-xl bg-surface-base ring-1 ring-line-default/10 p-3">
                    <div className="flex items-baseline justify-between mb-2">
                      <p className="text-sm font-black text-ink-primary">{side.label}</p>
                      <p className="text-[10px] font-bold tracking-wider uppercase text-ink-primary/45">
                        avg {avg.toFixed(1)} · {side.playerIds.length}
                      </p>
                    </div>
                    <ul className="space-y-1.5">
                      {side.playerIds.map(pid => {
                        const p = rosterById.get(pid);
                        if (!p) return null;
                        const score = playerScore(p);
                        const level = (p as any).highestLevelPlayed as keyof typeof LEVEL_LABELS | undefined;
                        return (
                          <li key={pid} className="flex items-center gap-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/5 px-2 py-1.5">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold text-ink-primary truncate">{(p as any).name || 'Player'}</p>
                              <p className="text-[10px] text-ink-primary/45 truncate">
                                {level ? LEVEL_LABELS[level] : 'Unrated'}
                                {typeof (p as any).skillLevel === 'number' ? ` · ${(p as any).skillLevel}/5` : ''}
                              </p>
                            </div>
                            <span className="text-[10px] font-black tracking-wider text-ink-primary/40 tabular-nums">{score}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-4 sm:px-5 py-3 border-t border-line-default/10 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl text-ink-primary/70 hover:text-ink-primary text-sm font-bold transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={loading || saving || eligibleRoster.length < numSides * 2}
            className="ml-auto px-5 py-2.5 rounded-xl bg-brand-primary text-white text-sm font-black tracking-wider uppercase shadow-lg active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save split'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SplitTeamsModal;
