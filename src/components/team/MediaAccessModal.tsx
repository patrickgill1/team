// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  teamId: string;
}

interface ParentRow {
  uid: string;
  name: string;
  email?: string;
  /** Names of this parent's kids on this team — shown so the coach can
   *  tell "John Smith (Tracking-cam dad of Hunter)" from "John Smith". */
  childNames: string[];
}

/**
 * "Media access" — coach-only roster of which parents are allowed to
 * upload + edit + tag clips for this team. Staff (coach / team manager
 * / club admin) are always implicitly allowed; this modal only exists
 * to grant exceptions, typically for a parent running a tracking cam.
 *
 * Reads `team.mediaUploaders[]` and writes the diff on Save.
 */
const MediaAccessModal: React.FC<Props> = ({ isOpen, onClose, teamId }) => {
  const [loading, setLoading] = useState(true);
  const [parents, setParents] = useState<ParentRow[]>([]);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [original, setOriginal] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !teamId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // 1) Current allowlist on the team
        const teamSnap = await getDoc(doc(db, 'teams', teamId));
        const current: string[] = Array.isArray(teamSnap.data()?.mediaUploaders)
          ? teamSnap.data()!.mediaUploaders
          : [];

        // 2) All active players on this team — collect their parentIds + names
        const playersSnap = await getDocs(query(
          collection(db, 'players'),
          where('teamIds', 'array-contains', teamId),
        ));
        const parentToKids: Record<string, string[]> = {};
        playersSnap.docs.forEach((d) => {
          const data: any = d.data();
          if (data.isActive === false) return;
          const kidName = data.name || 'Player';
          (data.parentIds || []).forEach((pid: string) => {
            if (!parentToKids[pid]) parentToKids[pid] = [];
            parentToKids[pid].push(kidName);
          });
        });

        // Legacy `teamId` (single) path — back-compat with players that
        // never got migrated to teamIds[].
        const legacyPlayersSnap = await getDocs(query(
          collection(db, 'players'),
          where('teamId', '==', teamId),
        ));
        legacyPlayersSnap.docs.forEach((d) => {
          const data: any = d.data();
          if (data.isActive === false) return;
          const kidName = data.name || 'Player';
          (data.parentIds || []).forEach((pid: string) => {
            if (!parentToKids[pid]) parentToKids[pid] = [];
            if (!parentToKids[pid].includes(kidName)) parentToKids[pid].push(kidName);
          });
        });

        const parentUids = Object.keys(parentToKids);

        // 3) Resolve parent uid → display name. Firestore `in` is capped
        // at 30, so chunk it.
        const rows: ParentRow[] = [];
        for (let i = 0; i < parentUids.length; i += 30) {
          const chunk = parentUids.slice(i, i + 30);
          if (chunk.length === 0) continue;
          const usersSnap = await getDocs(query(
            collection(db, 'users'),
            where('uid', 'in', chunk),
          ));
          usersSnap.docs.forEach((d) => {
            const u: any = d.data();
            rows.push({
              uid: u.uid,
              name: u.name || u.email || 'Parent',
              email: u.email,
              childNames: parentToKids[u.uid] || [],
            });
          });
        }

        // Any allowlisted uid that no longer maps to a parent on this
        // team (e.g. their kid left) — still show, so the coach can
        // revoke them.
        const seen = new Set(rows.map(r => r.uid));
        for (const uid of current) {
          if (!seen.has(uid)) {
            rows.push({ uid, name: 'Former parent', childNames: [] });
          }
        }

        rows.sort((a, b) => a.name.localeCompare(b.name));

        if (cancelled) return;
        setParents(rows);
        const setCur = new Set(current);
        setGranted(setCur);
        setOriginal(new Set(setCur));
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load parents.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, teamId]);

  const dirty = useMemo(() => {
    if (granted.size !== original.size) return true;
    for (const uid of granted) if (!original.has(uid)) return true;
    return false;
  }, [granted, original]);

  const toggle = (uid: string) => {
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'teams', teamId), {
        mediaUploaders: Array.from(granted),
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      style={{
        zIndex: 200,
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={saving ? undefined : onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-brand-primary-soft to-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Media access</h3>
            <p className="text-xs text-gray-500">Pick which parents can upload + tag clips for this team.</p>
          </div>
          <button onClick={onClose} disabled={saving} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 disabled:opacity-50" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-3 bg-amber-50 border-b border-amber-100 text-xs text-amber-800">
          Coaches and team managers can always upload. Add parents here only when you want them to (e.g. a tracking-cam parent).
        </div>

        <div className="overflow-y-auto p-4 space-y-2 flex-1">
          {loading ? (
            <p className="text-sm text-gray-500 text-center py-6">Loading parents…</p>
          ) : parents.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">No parents linked to players on this team yet.</p>
          ) : (
            parents.map((p) => {
              const isOn = granted.has(p.uid);
              return (
                <label
                  key={p.uid}
                  className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 cursor-pointer ring-1 transition ${
                    isOn ? 'bg-brand-primary-soft ring-brand-primary-soft' : 'bg-white ring-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{p.name}</p>
                    {p.childNames.length > 0 && (
                      <p className="text-[11px] text-gray-500 truncate">Parent of {p.childNames.join(', ')}</p>
                    )}
                    {p.email && (
                      <p className="text-[11px] text-gray-400 truncate">{p.email}</p>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => toggle(p.uid)}
                    className="w-5 h-5 accent-brand-primary shrink-0"
                  />
                </label>
              );
            })
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="border-t border-gray-100 p-4 flex items-center justify-end gap-2 bg-gray-50">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-semibold text-gray-700 hover:text-gray-900 disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="bg-gradient-to-br from-brand-primary to-brand-primary hover:from-brand-primary hover:to-brand-primary disabled:from-gray-300 disabled:to-gray-300 text-white font-semibold rounded-xl px-5 py-2 text-sm transition active:scale-95"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default MediaAccessModal;
