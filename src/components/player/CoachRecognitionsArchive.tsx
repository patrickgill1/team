// CoachRecognitionsArchive — the coach's voice, isolated from the
// mixed XP scroll. Every "I saw you do this" moment a coach has ever
// written for this kid, with coach attribution and date. Emotional
// density on purpose: a wall of validation the family can scroll.
//
// Data: player_xp_events filtered to source == 'coach_recognition',
// live via onSnapshot. Coach names + avatars are pulled from the
// users collection on demand and cached in-component so we don't
// re-fetch the same coach twice per snapshot. Missed / denied lookups
// cache as null and render as "Coach" fallback so a permission gap
// never blanks the row.
//
// Render obeys the profile gate: !xpEnabled returns null before any
// hooks fire (this component is only mounted from a place that
// already respects the gate, but the guard costs nothing and keeps
// the contract explicit at the call site).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { toMillis, relativeTime } from '../../utils/timestamps';
import { debugWarn } from '../../utils/debug';

interface Props {
  playerId: string;
  teamId: string;
  xpEnabled: boolean;
}

interface Row {
  id: string;
  xp: number;
  note: string;
  createdAtMs: number;
  awardedBy: string;
}

interface CoachInfo {
  name: string;
  avatarUrl?: string;
}

const COLLAPSED_ROWS = 3;

const CoachRecognitionsArchive: React.FC<Props> = ({ playerId, teamId, xpEnabled }) => {
  // teamId is accepted for future scoping (e.g. filter to just this
  // team's recognitions if the archive ever splits per-team). Kept in
  // the signature so callers don't have to change when we do.
  void teamId;

  const [rows, setRows] = useState<Row[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Coach cache. `null` sentinel means "we tried and failed" so we
  // don't hammer Firestore on the next snapshot for a denied uid.
  const [coachCache, setCoachCache] = useState<Record<string, CoachInfo | null>>({});
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!xpEnabled || !playerId) return;
    const q = query(
      collection(db, 'player_xp_events'),
      where('playerId', '==', playerId),
      where('source', '==', 'coach_recognition'),
      orderBy('createdAt', 'desc'),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: Row[] = snap.docs.map((d) => {
          const data: any = d.data();
          return {
            id: d.id,
            xp: Number(data.xp) || 0,
            note: String(data.note || '').trim(),
            createdAtMs: toMillis(data.createdAt),
            awardedBy: String(data.awardedBy || ''),
          };
        });
        setRows(next);
      },
      (err: any) => {
        if (err?.code === 'permission-denied' || err?.code === 'unauthenticated') {
          debugWarn('coach recognitions archive: access denied', err?.code);
        } else {
          console.error('coach recognitions archive listener failed', err);
        }
        setRows([]);
      },
    );
    return () => unsub();
  }, [playerId, xpEnabled]);

  // Hydrate coach attribution. On every rows change, collect uids we
  // haven't looked up or requested yet, then fire off parallel getDocs
  // and merge the results into the cache. Denied/missing uids land as
  // `null` so the row falls back to "Coach".
  useEffect(() => {
    if (!rows || rows.length === 0) return;
    const missing: string[] = [];
    for (const r of rows) {
      const uid = r.awardedBy;
      if (!uid) continue;
      if (uid in coachCache) continue;
      if (inFlightRef.current.has(uid)) continue;
      missing.push(uid);
    }
    if (missing.length === 0) return;
    missing.forEach((uid) => inFlightRef.current.add(uid));
    let cancelled = false;
    Promise.all(
      missing.map(async (uid) => {
        try {
          const snap = await getDoc(doc(db, 'users', uid));
          if (!snap.exists()) return [uid, null] as const;
          const data: any = snap.data();
          const info: CoachInfo = {
            name: (data?.name && String(data.name).trim()) || 'Coach',
            avatarUrl: data?.userAvatarUrl || data?.profilePhotoUrl || undefined,
          };
          return [uid, info] as const;
        } catch (err: any) {
          if (err?.code === 'permission-denied' || err?.code === 'unauthenticated') {
            debugWarn('coach recognitions archive: user lookup denied', uid);
          } else {
            console.error('coach recognitions archive user lookup failed', uid, err);
          }
          return [uid, null] as const;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setCoachCache((prev) => {
        const next = { ...prev };
        for (const [uid, info] of results) {
          next[uid] = info;
        }
        return next;
      });
      missing.forEach((uid) => inFlightRef.current.delete(uid));
    });
    return () => {
      cancelled = true;
      missing.forEach((uid) => inFlightRef.current.delete(uid));
    };
  }, [rows, coachCache]);

  const visibleRows = useMemo(() => {
    if (!rows) return [];
    if (expanded || rows.length <= COLLAPSED_ROWS) return rows;
    return rows.slice(0, COLLAPSED_ROWS);
  }, [rows, expanded]);

  // Profile-level gate. Hooks above still run so the ordering rule
  // (all hooks before any conditional return) holds.
  if (!xpEnabled) return null;
  if (rows === null) return null;
  if (rows.length === 0) return null;

  const hiddenCount = rows.length - visibleRows.length;

  return (
    <section className="relative overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-line-default/20 shadow-lg animate-in fade-in duration-300">
      <div className="px-4 py-4 sm:px-5 sm:py-5 flex items-center justify-between gap-3">
        <h3 className="text-[10px] font-black tracking-[0.3em] uppercase text-ink-primary/60">
          Coach Recognitions
        </h3>
        <span className="text-[11px] font-semibold text-ink-primary/60 tabular-nums">
          {rows.length} {rows.length === 1 ? 'moment' : 'moments'}
        </span>
      </div>

      <ul className="divide-y divide-line-default/10">
        {visibleRows.map((row) => {
          const info = row.awardedBy ? coachCache[row.awardedBy] : null;
          const coachName = info?.name || 'Coach';
          const avatarUrl = info?.avatarUrl;
          const initial = (coachName.trim().charAt(0) || 'C').toUpperCase();
          return (
            <li key={row.id} className="px-4 py-3 flex items-start gap-3">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="shrink-0 w-10 h-10 rounded-full object-cover ring-1 ring-line-default/20"
                />
              ) : (
                <div
                  className="shrink-0 w-10 h-10 rounded-full bg-brand-primary text-white flex items-center justify-center text-sm font-black"
                  aria-hidden
                >
                  {initial}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-black text-ink-primary truncate">
                    {coachName}
                  </span>
                  <span className="text-[11px] text-ink-primary/50 shrink-0">
                    {relativeTime(row.createdAtMs)}
                  </span>
                </div>
                {row.note && (
                  <p className="text-sm text-ink-primary/85 leading-snug whitespace-pre-wrap">
                    {row.note}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {hiddenCount > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full px-4 py-3 text-[12px] font-bold text-brand-primary-soft hover:bg-surface-input/50 active:bg-surface-input transition border-t border-line-default/10"
        >
          See all {rows.length} recognitions
        </button>
      )}
      {expanded && rows.length > COLLAPSED_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full px-4 py-3 text-[12px] font-bold text-brand-primary-soft hover:bg-surface-input/50 active:bg-surface-input transition border-t border-line-default/10"
        >
          Show less
        </button>
      )}
    </section>
  );
};

export default CoachRecognitionsArchive;
