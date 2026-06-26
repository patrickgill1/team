// @ts-nocheck
import React, { useEffect, useMemo, useState } from 'react';
import { Sheet, Button } from '../ui';
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

  return (
    <Sheet
      open={isOpen}
      onClose={() => { if (!saving) onClose(); }}
      kicker="Media access"
      title="Who can upload clips for this team"
      subtitle="Coaches and team managers can always upload. Add parents here only when you want them to (e.g. a tracking-cam parent)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={!dirty} loading={saving}>Save</Button>
        </>
      }
    >
      <div className="space-y-2">
        {loading ? (
          <p className="text-sm text-bone/55 text-center py-6">Loading parents…</p>
        ) : parents.length === 0 ? (
          <p className="text-sm text-bone/55 text-center py-6">No parents linked to players on this team yet.</p>
        ) : (
          parents.map((p) => {
            const isOn = granted.has(p.uid);
            return (
              <label
                key={p.uid}
                className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 cursor-pointer ring-1 transition ${
                  isOn ? 'bg-brand-primary/15 ring-brand-primary/40' : 'bg-charcoal-950 ring-white/10 hover:bg-white/5'
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-bone truncate">{p.name}</p>
                  {p.childNames.length > 0 && (
                    <p className="text-[11px] text-bone/55 truncate">Parent of {p.childNames.join(', ')}</p>
                  )}
                  {p.email && (
                    <p className="text-[11px] text-bone/40 truncate">{p.email}</p>
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
        {error && <p className="text-sm text-rose-300">{error}</p>}
      </div>
    </Sheet>
  );
};

export default MediaAccessModal;
