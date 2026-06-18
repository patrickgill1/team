import React, { useState } from 'react';
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { logActivity } from '../../utils/activityLog';
import type { Household, Registration } from '../../types';

// Link a second parent email into the current household. If neither
// email has a Household yet we create one and bind both sides. If
// one side already has a Household, we add the other email to it and
// backfill the related Player/Registration docs. If BOTH sides
// already have Households (rare), we surface a merge confirmation —
// merging means folding the smaller one into the larger.

interface Props {
  clubId: string;
  currentEmail: string;
  /** Existing household for currentEmail, if any. */
  currentHousehold: Household | null;
  actorUid: string;
  actorName: string;
  onClose: () => void;
  onLinked: (householdId: string) => void;
}

const HouseholdLinkModal: React.FC<Props> = ({ clubId, currentEmail, currentHousehold, actorUid, actorName, onClose, onLinked }) => {
  const [otherEmail, setOtherEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalize = (e: string) => e.trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(otherEmail) && normalize(otherEmail) !== normalize(currentEmail);

  const handleLink = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const otherLower = normalize(otherEmail);

      // See if the OTHER email already has a household.
      const otherSnap = await getDocs(query(
        collection(db, 'households'),
        where('clubId', '==', clubId),
        where('parentEmails', 'array-contains', otherLower),
      ));
      const otherHousehold = otherSnap.docs[0]
        ? ({ id: otherSnap.docs[0].id, ...(otherSnap.docs[0].data() as any) } as Household)
        : null;

      // Decide target household.
      let target: Household;
      if (currentHousehold && otherHousehold && currentHousehold.id !== otherHousehold.id) {
        // Both sides have separate households — merge the smaller into
        // the larger by member count. Confirm with the admin first.
        const merge = window.confirm(
          `Both emails already have households. Merge "${otherHousehold.name || otherHousehold.id}" into "${currentHousehold.name || currentHousehold.id}"?`
        );
        if (!merge) { setBusy(false); return; }
        const mergedEmails = Array.from(new Set([...(currentHousehold.parentEmails || []), ...(otherHousehold.parentEmails || [])]));
        const mergedPlayers = Array.from(new Set([...(currentHousehold.playerIds || []), ...(otherHousehold.playerIds || [])]));
        await updateDoc(doc(db, 'households', currentHousehold.id), {
          parentEmails: mergedEmails,
          playerIds: mergedPlayers,
          updatedAt: serverTimestamp(),
        });
        // Backfill all the OTHER household's players + registrations to
        // point at the kept household id.
        await backfillHouseholdId(clubId, otherLower, currentHousehold.id);
        // Mark the absorbed household as merged (soft-delete) so it
        // doesn't show up in later lookups.
        await updateDoc(doc(db, 'households', otherHousehold.id), {
          mergedIntoHouseholdId: currentHousehold.id,
          parentEmails: [],
          playerIds: [],
          updatedAt: serverTimestamp(),
        });
        target = { ...currentHousehold, parentEmails: mergedEmails, playerIds: mergedPlayers };
      } else if (currentHousehold || otherHousehold) {
        // Extend the existing household with the new email.
        const existing = (currentHousehold || otherHousehold) as Household;
        const nextEmails = Array.from(new Set([...(existing.parentEmails || []), normalize(currentEmail), otherLower]));
        await updateDoc(doc(db, 'households', existing.id), {
          parentEmails: nextEmails,
          updatedAt: serverTimestamp(),
        });
        // Backfill the newly added email's data.
        const newEmail = currentHousehold ? otherLower : normalize(currentEmail);
        await backfillHouseholdId(clubId, newEmail, existing.id);
        target = { ...existing, parentEmails: nextEmails };
      } else {
        // Neither side has a household — create one.
        const id = `hh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const newHousehold: Household = {
          id,
          clubId,
          parentEmails: [normalize(currentEmail), otherLower],
          playerIds: [],
          createdAt: new Date(),
          createdByUid: actorUid,
          createdByName: actorName,
        };
        await setDoc(doc(db, 'households', id), {
          ...newHousehold,
          createdAt: serverTimestamp(),
        });
        await backfillHouseholdId(clubId, normalize(currentEmail), id);
        await backfillHouseholdId(clubId, otherLower, id);
        target = newHousehold;
      }

      await logActivity({
        clubId,
        kind: 'household_linked',
        parentEmail: normalize(currentEmail),
        actorUid,
        actorName,
        payload: {
          householdId: target.id,
          linkedEmail: otherLower,
          emails: target.parentEmails,
        },
      });

      onLinked(target.id);
    } catch (err: any) {
      console.error('household link failed', err);
      setError(err?.message || 'Link failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-black text-charcoal-950">Link another email</h2>
            <p className="text-[11px] text-slate-500">to {currentEmail}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-600">
            Use this when two parents in the same family used different emails. Their kids, registrations, payments, and timeline all roll up under one household.
          </p>
          {currentHousehold && (currentHousehold.parentEmails || []).length > 0 && (
            <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2 text-[11px] text-slate-700">
              Already linked: <b>{currentHousehold.parentEmails.join(', ')}</b>
            </div>
          )}
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Other parent's email</span>
            <input
              type="email"
              value={otherEmail}
              onChange={(e) => setOtherEmail(e.target.value)}
              placeholder="dad.work@example.com"
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
            />
          </label>
          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button type="button" disabled={!valid || busy} onClick={handleLink} className="px-4 py-2 rounded-lg bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50 text-white text-sm font-bold">
            {busy ? 'Linking…' : 'Link households'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Backfill helper — sets householdId on every Player + Registration
// whose parent email matches. Best-effort: failures are logged and
// don't roll back the household creation.
async function backfillHouseholdId(clubId: string, email: string, householdId: string) {
  try {
    const regs = await getDocs(query(collection(db, 'registrations'), where('clubId', '==', clubId)));
    const matchingRegs: Registration[] = regs.docs
      .map(d => ({ id: d.id, ...(d.data() as any) } as Registration))
      .filter(r => (r.parents || []).some(p => p.email?.toLowerCase() === email));
    await Promise.all(matchingRegs.map(r => updateDoc(doc(db, 'registrations', r.id), { householdId })));

    const players = await getDocs(query(collection(db, 'players'), where('parentEmails', 'array-contains', email)));
    await Promise.all(players.docs.map(p => updateDoc(doc(db, 'players', p.id), { householdId })));

    // Also push player IDs onto the household doc for fast member lookups.
    const playerIds = players.docs.map(p => p.id);
    if (playerIds.length > 0) {
      const hhSnap = await getDocs(query(collection(db, 'households'), where('clubId', '==', clubId)));
      const hhDoc = hhSnap.docs.find(d => d.id === householdId);
      if (hhDoc) {
        const existing: string[] = (hhDoc.data() as any).playerIds || [];
        const next = Array.from(new Set([...existing, ...playerIds]));
        if (next.length !== existing.length) {
          await updateDoc(doc(db, 'households', householdId), { playerIds: next });
        }
      }
    }
  } catch (err) {
    console.warn('backfillHouseholdId failed', err);
  }
}

export default HouseholdLinkModal;
