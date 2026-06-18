// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { collection, addDoc, doc, updateDoc, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { clearActiveSeasonCache } from '../../utils/seasons';
import { useAuth } from '../../hooks/useAuth';
import { isClubAdmin } from '../../utils/helpers';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  teamId: string;
  /** Called after a successful save so the parent can refresh. */
  onCreated?: () => void;
}

/**
 * Standalone "Create a season" modal. Unlike EndSeasonModal which
 * requires an existing active season to end first, this one lets a
 * coach create a season from scratch (first-time team setup, or a
 * coach who's never used the season feature before).
 *
 * If there's already an active season for this team and the coach
 * marks this one Active, we automatically demote the old one — the
 * "active" flag is single-tenant per team.
 */
const NewSeasonModal: React.FC<Props> = ({ isOpen, onClose, teamId, onCreated }) => {
  const { userData } = useAuth();
  const userIsClubAdmin = isClubAdmin(userData);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [makeActive, setMakeActive] = useState(true);
  const [applyToAll, setApplyToAll] = useState(false);
  const [clubTeams, setClubTeams] = useState<{ id: string; name: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingActive, setExistingActive] = useState<{ id: string; name: string } | null>(null);

  // Pre-fill with a sensible default for AYSO (Fall = Aug–Nov, Spring = Mar–May)
  // based on today's date. Coaches can override.
  useEffect(() => {
    if (!isOpen) return;
    const now = new Date();
    const month = now.getMonth(); // 0-indexed
    const year = now.getFullYear();
    if (month >= 6 && month <= 11) {
      // Jul–Dec → suggest Fall
      setName(`Fall ${year}`);
      setStartDate(`${year}-08-01`);
      setEndDate(`${year}-11-30`);
    } else {
      // Jan–Jun → suggest Spring (this year)
      setName(`Spring ${year}`);
      setStartDate(`${year}-03-01`);
      setEndDate(`${year}-05-31`);
    }
    setMakeActive(true);
    setApplyToAll(false);
    setError(null);
  }, [isOpen]);

  // Load all teams in the club when the user is an admin — needed for
  // the "apply to all teams" bulk path.
  useEffect(() => {
    if (!isOpen || !userIsClubAdmin) { setClubTeams([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'teams'));
        if (cancelled) return;
        const ts = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as any) }))
          .filter((t: any) => t.isActive !== false)
          .map((t: any) => ({ id: t.id, name: t.name || 'Untitled' }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name));
        setClubTeams(ts);
      } catch (err) {
        console.error('Club teams lookup failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, userIsClubAdmin]);

  // Look up the current active season so the coach knows if making this
  // one active will demote it.
  useEffect(() => {
    if (!isOpen || !teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'seasons'),
          where('teamId', '==', teamId),
          where('isActive', '==', true),
        ));
        if (cancelled) return;
        if (!snap.empty) {
          const d = snap.docs[0];
          setExistingActive({ id: d.id, name: (d.data() as any).name || 'Current season' });
        } else {
          setExistingActive(null);
        }
      } catch {
        if (!cancelled) setExistingActive(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, teamId]);

  if (!isOpen) return null;

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const handleSubmit = async () => {
    if (!name.trim() || !startDate || !endDate) {
      setError('Name, start date and end date are all required.');
      return;
    }
    const s = new Date(startDate);
    const e = new Date(endDate);
    if (e <= s) {
      setError('End date has to be after start date.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Resolve target team set: single (current) or every active team
      // in the club (admin bulk mode).
      const targetTeamIds = applyToAll && userIsClubAdmin
        ? clubTeams.map((t) => t.id)
        : [teamId];

      // For each target team, if making active and an existing active
      // season exists, demote it first.
      if (makeActive) {
        for (const tid of targetTeamIds) {
          const activeSnap = await getDocs(query(
            collection(db, 'seasons'),
            where('teamId', '==', tid),
            where('isActive', '==', true),
          ));
          for (const d of activeSnap.docs) {
            await updateDoc(doc(db, 'seasons', d.id), { isActive: false });
          }
        }
      }

      // Create the new season doc(s).
      for (const tid of targetTeamIds) {
        await addDoc(collection(db, 'seasons'), {
          teamId: tid,
          name: name.trim(),
          startDate: s,
          endDate: e,
          isActive: !!makeActive,
          createdAt: serverTimestamp(),
        });
        clearActiveSeasonCache(tid);
      }
      onCreated?.();
      onClose();
    } catch (err: any) {
      console.error('Create season failed:', err);
      setError(err?.message || 'Could not create the season. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      style={{
        zIndex: 200,
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={handleClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-cyan-50 to-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">New season</h3>
            <p className="text-xs text-gray-500">For AYSO: Fall (Aug–Nov) and Spring (Mar–May).</p>
          </div>
          <button onClick={handleClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Season name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Fall 2026"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
              style={{ fontSize: '16px' }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Starts</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
                style={{ fontSize: '16px' }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ends</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
                style={{ fontSize: '16px' }}
              />
            </div>
          </div>

          {userIsClubAdmin && clubTeams.length > 1 && (
            <label className="flex items-start gap-2 text-sm text-gray-700 select-none cursor-pointer bg-violet-50 ring-1 ring-violet-200 rounded-xl p-3">
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-violet-600"
              />
              <span>
                <span className="font-semibold text-violet-900">Apply to all {clubTeams.length} teams in the club</span>
                <span className="block text-xs text-violet-700 mt-0.5">
                  {applyToAll
                    ? `Creates "${name || 'season'}" as a season doc on every active team in the club.`
                    : 'Creates this season only on the currently selected team.'}
                </span>
              </span>
            </label>
          )}

          <label className="flex items-start gap-2 text-sm text-gray-700 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={makeActive}
              onChange={(e) => setMakeActive(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-cyan-600"
            />
            <span>
              Make this the active season{applyToAll && userIsClubAdmin ? ' (for every team)' : ''}
              {existingActive && makeActive && !applyToAll && (
                <span className="block text-xs text-amber-700 mt-0.5">
                  ⚠️ Will archive <b>{existingActive.name}</b> (stats and history preserved).
                </span>
              )}
              {applyToAll && makeActive && userIsClubAdmin && (
                <span className="block text-xs text-amber-700 mt-0.5">
                  ⚠️ Any existing active seasons on those teams will be archived first.
                </span>
              )}
            </span>
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="border-t border-gray-100 p-4 flex items-center justify-end gap-2 bg-gray-50">
          <button onClick={handleClose} disabled={submitting} className="px-4 py-2 text-sm font-semibold text-gray-700 hover:text-gray-900 disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !name.trim() || !startDate || !endDate}
            className="bg-gradient-to-br from-cyan-500 to-cyan-600 hover:from-cyan-600 hover:to-cyan-700 disabled:from-gray-300 disabled:to-gray-300 text-white font-semibold rounded-xl px-5 py-2 text-sm transition active:scale-95"
          >
            {submitting ? 'Saving…' : 'Create season'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default NewSeasonModal;
