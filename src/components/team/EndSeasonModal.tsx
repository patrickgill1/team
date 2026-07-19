import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, query, where, writeBatch, serverTimestamp, addDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { Player, Season } from '../../types';
import { isGuestActive } from '../../types';
import { clearActiveSeasonCache, getActiveSeasonForTeam } from '../../utils/seasons';

/**
 * "End Season" — head-coach-only flow.
 *
 * Behavior:
 *   1. Reads current active season + roster for the team.
 *   2. Coach picks which players carry over (defaults to all-checked).
 *   3. Optional: name + dates for the next season (defaults: today through May 15 of next year, or Aug-May for spring).
 *   4. On confirm:
 *      a. Mark current season isActive=false, archivedAt=now.
 *      b. Mark unchecked players isActive=false (their data + profile + clips remain accessible).
 *      c. Create the next season; set isActive=true.
 *      d. For each carried-over player, append a seasonMembership for the new season.
 *
 * Non-destructive: never deletes players, clips, stats, or anything historical.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  teamId: string;
  onComplete?: () => void;
}

const today = new Date();

function defaultNextSeasonName(): string {
  const m = today.getMonth();
  // June-November → next is spring. Otherwise → next fall.
  if (m >= 5 && m <= 10) return `${today.getFullYear() + (m >= 11 ? 1 : 0)} Spring`;
  return `${today.getFullYear()} Fall`;
}

function defaultNextSeasonEnd(): string {
  const m = today.getMonth();
  // If we're between June and November, the next season is spring → ends mid-May
  if (m >= 5 && m <= 10) return new Date(today.getFullYear() + 1, 4, 15).toISOString().slice(0, 10);
  // Fall season → ends mid-December
  return new Date(today.getFullYear(), 11, 15).toISOString().slice(0, 10);
}

const EndSeasonModal: React.FC<Props> = ({ isOpen, onClose, teamId, onComplete }) => {
  const [season, setSeason] = useState<Season | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [keepIds, setKeepIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Next season form fields
  const [createNext, setCreateNext] = useState(true);
  const [nextName, setNextName] = useState(defaultNextSeasonName());
  const [nextStart, setNextStart] = useState(today.toISOString().slice(0, 10));
  const [nextEnd, setNextEnd] = useState(defaultNextSeasonEnd());

  useEffect(() => {
    if (!isOpen || !teamId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const s = await getActiveSeasonForTeam(teamId);
        if (cancelled) return;
        setSeason(s);

        // Team-scoped read. Was pulling every active player in the
        // database then filtering — cross-club PII exposure. Filter
        // by teamIds and drop inactive client-side.
        const snap = await getDocs(query(collection(db, 'players'), where('teamIds', 'array-contains', teamId)));
        const list: Player[] = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => p.isActive !== false && isGuestActive(p));
        if (cancelled) return;
        setPlayers(list);
        setKeepIds(new Set(list.map((p) => p.id))); // default: keep all
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load season state.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, teamId]);

  const toggleKeep = (id: string) => {
    setKeepIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const counts = useMemo(() => ({
    total: players.length,
    keeping: keepIds.size,
    inactiviating: players.length - keepIds.size,
  }), [players, keepIds]);

  const handleConfirm = async () => {
    if (!season) {
      setError('No active season found for this team. Run the Phase 1 migration first.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // 1. Create the new season (if requested) so we have its id before we batch.
      let newSeasonId: string | null = null;
      if (createNext) {
        if (!nextName.trim() || !nextStart || !nextEnd) {
          setError('Next-season name, start and end dates are required.');
          setSubmitting(false);
          return;
        }
        const newRef = await addDoc(collection(db, 'seasons'), {
          teamId,
          name: nextName.trim(),
          startDate: new Date(nextStart),
          endDate: new Date(nextEnd),
          isActive: true,
          createdAt: serverTimestamp(),
        });
        newSeasonId = newRef.id;
      }

      // 2. Batch the rest: archive old season, deactivate dropped players, append memberships to keepers.
      const batch = writeBatch(db);
      batch.update(doc(db, 'seasons', season.id), {
        isActive: false,
        archivedAt: serverTimestamp(),
      });
      players.forEach((p) => {
        if (!keepIds.has(p.id)) {
          batch.update(doc(db, 'players', p.id), { isActive: false });
        } else if (newSeasonId) {
          // Append a seasonMembership for the next season; don't touch existing entries.
          // arrayUnion preserves concurrent additions (e.g. coach editing player, adult self-claim)
          // that a full-array overwrite from stale local state would clobber.
          batch.update(doc(db, 'players', p.id), {
            seasonMemberships: arrayUnion(
              { seasonId: newSeasonId, teamId, jerseyNumber: p.jerseyNumber, position: p.position },
            ),
          });
        }
      });
      await batch.commit();

      // 3. Bust caches so the rest of the app sees the new active season.
      clearActiveSeasonCache(teamId);
      onComplete?.();
      onClose();
    } catch (err: any) {
      console.error('End Season failed', err);
      setError(err?.message || 'Could not end the season. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={submitting ? undefined : onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">End Season</h2>
          <p className="text-sm text-gray-500 mt-1">
            {loading
              ? 'Loading…'
              : season
                ? <>Closing <b>{season.name}</b>. Stats, clips, and awards stay forever — they'll just live in the past-seasons archive.</>
                : <span className="text-rose-600">No active season found. Run the Phase 1 migration script first.</span>}
          </p>
        </div>

        {!loading && season && (
          <div className="p-6 space-y-5">
            {/* Roster carry-over */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-gray-900">Carry over to next season</h3>
                <span className="text-xs font-semibold text-gray-500">
                  {counts.keeping} keeping · {counts.inactiviating} dropping
                </span>
              </div>
              <p className="text-xs text-gray-500 mb-3">
                Unchecked players become inactive — their profile, clips and stats remain readable, they just stop showing in the live roster.
              </p>
              <div className="rounded-xl ring-1 ring-gray-100 max-h-56 overflow-y-auto divide-y divide-gray-100">
                {players.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-gray-500 text-center">No active players on this team.</p>
                ) : (
                  players.map((p) => (
                    <label key={p.id} className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={keepIds.has(p.id)}
                        onChange={() => toggleKeep(p.id)}
                        className="w-4 h-4 rounded border-gray-300 text-brand-primary focus:ring-brand-primary"
                      />
                      <span className="text-sm font-medium text-gray-900 flex-1">
                        {p.jerseyNumber ? `#${p.jerseyNumber} ` : ''}{p.name}
                        {p.position && <span className="text-gray-500 font-normal"> · {p.position}</span>}
                      </span>
                    </label>
                  ))
                )}
              </div>
              <div className="flex gap-2 mt-2 text-xs">
                <button
                  type="button"
                  onClick={() => setKeepIds(new Set(players.map(p => p.id)))}
                  className="text-brand-primary hover:text-brand-primary font-semibold"
                >
                  Select all
                </button>
                <span className="text-gray-300">·</span>
                <button
                  type="button"
                  onClick={() => setKeepIds(new Set())}
                  className="text-rose-600 hover:text-rose-700 font-semibold"
                >
                  Drop all
                </button>
              </div>
            </div>

            {/* Next season */}
            <div>
              <label className="flex items-center gap-2 text-sm font-bold text-gray-900 mb-2">
                <input
                  type="checkbox"
                  checked={createNext}
                  onChange={(e) => setCreateNext(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-brand-primary focus:ring-brand-primary"
                />
                Create the next season now
              </label>
              {createNext && (
                <div className="rounded-xl ring-1 ring-gray-100 p-4 space-y-3 bg-gray-50/50">
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Season name</label>
                    <input
                      type="text"
                      value={nextName}
                      onChange={(e) => setNextName(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Start date</label>
                      <input
                        type="date"
                        value={nextStart}
                        onChange={(e) => setNextStart(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">End date</label>
                      <input
                        type="date"
                        value={nextEnd}
                        onChange={(e) => setNextEnd(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-500">Tryouts in summer means no active season Jun–Aug — leave the dates short and run "End Season" again next cycle.</p>
                </div>
              )}
            </div>

            {error && <p className="text-sm text-rose-600 bg-rose-50 ring-1 ring-rose-100 rounded-xl p-3">{error}</p>}
          </div>
        )}

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2 bg-gray-50">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-semibold text-gray-700 hover:text-gray-900 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting || loading || !season}
            className="px-5 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Closing season…' : 'End season'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EndSeasonModal;
