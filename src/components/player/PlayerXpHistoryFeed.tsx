// PlayerXpHistoryFeed — Duolingo-style recent XP scroll for the
// player profile. Reads player_xp_events (worker-written, immutable)
// and renders "+N XP [source] [reason] [when]" rows so kids + parents
// see a concrete accounting of every grant instead of a mystery
// number ticking up on the card above.
//
// Query: playerId==id, orderBy createdAt desc, limit 20. Progressive
// disclosure — collapsed to 5 rows when there are more than 8, with a
// "See all N" toggle up to a 20-row cap. Handles Firestore Timestamp
// / Date / seconds-map / ISO-string coercion for createdAt.

import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { PlayerXpEvent } from '../../types';
import { toMillis, relativeTime } from '../../utils/timestamps';
import { SOURCE_LABEL, dotClassForSource } from '../../utils/xpSourceLabels';

interface Props {
  playerId: string;
}

interface FeedRow {
  id: string;
  xp: number;
  source: PlayerXpEvent['source'];
  reason: string;
  createdAtMs: number;
}

const HARD_CAP = 20;
const COLLAPSED_ROWS = 5;
const COLLAPSE_THRESHOLD = 8;

const PlayerXpHistoryFeed: React.FC<Props> = ({ playerId }) => {
  const [rows, setRows] = useState<FeedRow[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!playerId) return;
    const q = query(
      collection(db, 'player_xp_events'),
      where('playerId', '==', playerId),
      orderBy('createdAt', 'desc'),
      fsLimit(HARD_CAP),
    );
    const unsub = onSnapshot(q, (snap) => {
      const next: FeedRow[] = snap.docs.map((d) => {
        const data: any = d.data();
        return {
          id: d.id,
          xp: Number(data.xp) || 0,
          source: (data.source as PlayerXpEvent['source']) || 'coach_recognition',
          reason: String(data.note || '').trim(),
          createdAtMs: toMillis(data.createdAt),
        };
      });
      setRows(next);
    }, (err) => {
      console.warn('player xp history feed listener failed', err);
      setRows([]);
    });
    return () => unsub();
  }, [playerId]);

  const totalCount = rows?.length ?? 0;
  const shouldCollapse = totalCount > COLLAPSE_THRESHOLD;
  const visibleRows = useMemo(() => {
    if (!rows) return [];
    if (!shouldCollapse || expanded) return rows;
    return rows.slice(0, COLLAPSED_ROWS);
  }, [rows, shouldCollapse, expanded]);

  // Loading vs empty vs populated. During the initial load we render
  // nothing (per atomic-render pattern — no skeleton flicker). Once
  // the snapshot resolves with zero rows we show the empty state.
  if (rows === null) return null;

  return (
    <section className="px-4 sm:px-6 pt-3">
      <div className="max-w-3xl mx-auto">
        <div className="rounded-2xl bg-surface-elevated ring-1 ring-line-default/25 overflow-hidden">
          <div className="px-4 sm:px-5 pt-3 pb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-black uppercase tracking-[0.22em] text-ink-primary/60">
              Recent XP
            </h3>
            {totalCount > 0 && (
              <span className="text-[11px] font-semibold text-ink-secondary tabular-nums">
                {totalCount === HARD_CAP ? '20+' : totalCount}
              </span>
            )}
          </div>

          {totalCount === 0 ? (
            <p className="px-4 sm:px-5 pb-4 text-[13px] text-ink-secondary">
              No XP earned yet.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-line-default/15">
                {visibleRows.map((row) => (
                  // Two-line row: metadata (XP + source + relative
                  // time) on line 1, full reason wrapping on line 2.
                  // Prior single-line layout truncated the reason,
                  // which Patrick caught 2026-07-12: "the players
                  // can't see the full reason for the xp." Reason is
                  // the emotional payload — never truncate it.
                  <li
                    key={row.id}
                    className="px-4 sm:px-5 py-2.5 flex items-start gap-3"
                  >
                    <span
                      className={`shrink-0 mt-1.5 w-2 h-2 rounded-full ${dotClassForSource(row.source)}`}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[13px] font-black text-ink-primary tabular-nums">
                          +{row.xp} XP
                        </span>
                        <span className="shrink-0 text-[12px] font-semibold text-ink-primary/80">
                          {SOURCE_LABEL[row.source] || 'XP grant'}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] text-ink-secondary tabular-nums">
                          {relativeTime(row.createdAtMs)}
                        </span>
                      </div>
                      {row.reason && (
                        <p className="mt-0.5 text-[12px] italic text-ink-secondary leading-snug whitespace-pre-wrap break-words">
                          {row.reason}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              {shouldCollapse && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="w-full px-4 sm:px-5 py-2.5 text-[12px] font-bold uppercase tracking-wider text-brand-primary hover:bg-surface-input/50 active:bg-surface-input transition border-t border-line-default/15"
                >
                  {expanded ? 'Show less' : `See all ${totalCount}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
};

export default PlayerXpHistoryFeed;

