import React, { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { WallPost } from '../../types';

interface Props {
  poll: NonNullable<WallPost['poll']>;
  currentUserId: string;
  /** Tap an option → toggle this user's vote on that option. Returns
   *  the new poll shape so the parent can persist it via updateDoc. */
  onVote: (optionId: string) => void;
  /** Coach / admin gate. When true, "See voters" button opens a
   *  per-option voter list. Hidden for parents. */
  canSeeVoters?: boolean;
  /** Optional uid → display name fast-path. The component will still
   *  look up any missing names from Firestore when the voter sheet
   *  opens, so passing this is purely a latency optimization. */
  getUserName?: (uid: string) => string | undefined;
}

// Standalone poll card for wall posts. Same look + feel as the chat's
// PollCard but operates on the wall's poll shape (no ChatMessage
// wrapper). Tap an option to vote / unvote; coaches can open a sheet
// showing who voted for what.
const WallPollCard: React.FC<Props> = ({ poll, currentUserId, onVote, canSeeVoters, getUserName }) => {
  const [votersOpen, setVotersOpen] = useState(false);
  // Name cache for the voter sheet. Seeded from the fast-path
  // getUserName prop; misses are fetched once when the sheet opens.
  const [names, setNames] = useState<Record<string, string>>({});
  const resolveName = (uid: string): string => {
    if (names[uid]) return names[uid];
    const hit = getUserName?.(uid);
    return hit || 'Member';
  };

  const totalVoters = new Set<string>();
  for (const o of poll.options) for (const u of o.voters) totalVoters.add(u);
  const totalVotes = poll.multi
    ? poll.options.reduce((s, o) => s + o.voters.length, 0)
    : totalVoters.size;

  // Lazy-fetch user names when the voter sheet opens. Polls store
  // only uids on each option, so without this lookup the list shows
  // uid prefixes ("NFLDIfrn"). One getDoc per missing voter; cached
  // in component state so a re-open doesn't re-fetch.
  useEffect(() => {
    if (!votersOpen) return;
    const missing = Array.from(totalVoters).filter(uid => !names[uid] && !getUserName?.(uid));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(missing.map(async (uid) => {
        try {
          const snap = await getDoc(doc(db, 'users', uid));
          if (!snap.exists()) return [uid, 'Member'] as const;
          const data = snap.data() as any;
          return [uid, (data?.name as string) || 'Member'] as const;
        } catch {
          return [uid, 'Member'] as const;
        }
      }));
      if (cancelled) return;
      setNames(prev => {
        const next = { ...prev };
        for (const [uid, name] of entries) next[uid] = name;
        return next;
      });
    })();
    return () => { cancelled = true; };
    // totalVoters is a fresh Set each render — depend on its size
    // and the open flag to re-run when needed without infinite loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [votersOpen, totalVoters.size]);

  return (
    <div className="mx-4 mb-3 rounded-2xl ring-1 ring-crimson-200 bg-crimson-50/40 px-3.5 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <svg className="w-4 h-4 text-crimson-700" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <rect x="3" y="12" width="4" height="9" rx="1" />
          <rect x="10" y="7" width="4" height="14" rx="1" />
          <rect x="17" y="3" width="4" height="18" rx="1" />
        </svg>
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-crimson-800">Poll</span>
      </div>
      <p className="font-bold text-[15px] leading-snug text-slate-900 mb-2.5">{poll.question}</p>

      <div className="space-y-1.5">
        {poll.options.map(opt => {
          const mine = !!currentUserId && opt.voters.includes(currentUserId);
          const denom = poll.multi
            ? Math.max(1, totalVotes)
            : Math.max(1, totalVoters.size);
          const pct = Math.round((opt.voters.length / denom) * 100);
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onVote(opt.id)}
              className={`relative w-full text-left rounded-xl px-3 py-2 ring-1 transition overflow-hidden ${
                mine
                  ? 'bg-white text-crimson-900 ring-crimson-400'
                  : 'bg-white text-slate-800 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {/* Fill bar — represents this option's share of total votes. */}
              <span
                aria-hidden
                className={`absolute inset-y-0 left-0 ${mine ? 'bg-crimson-100' : 'bg-crimson-50'} transition-all`}
                style={{ width: `${pct}%` }}
              />
              <span className="relative flex items-start justify-between gap-3">
                <span className="font-semibold text-[14.5px] leading-snug break-words min-w-0">{opt.text}</span>
                <span className="text-[12px] font-bold tabular-nums text-slate-600 shrink-0 pt-0.5">
                  {pct}% · {opt.voters.length}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>{totalVoters.size} {totalVoters.size === 1 ? 'voter' : 'voters'}</span>
        {canSeeVoters && totalVoters.size > 0 && (
          <button
            type="button"
            onClick={() => setVotersOpen(true)}
            className="text-crimson-700 font-bold uppercase tracking-widest hover:text-crimson-900"
          >
            See voters →
          </button>
        )}
      </div>

      {votersOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={() => setVotersOpen(false)}
        >
          <div
            className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden animate-sheet-up sm:animate-pop-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 py-3 flex items-center justify-between flex-shrink-0">
              <button onClick={() => setVotersOpen(false)} className="text-[11px] font-extrabold tracking-widest uppercase text-slate-400 hover:text-white">
                Close
              </button>
              <div className="text-xs font-extrabold tracking-widest uppercase text-crimson-400">Voters</div>
              <span className="w-12" />
            </div>
            <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
              {poll.options.map(opt => (
                <div key={opt.id} className="border-b border-slate-100 last:border-b-0">
                  <div className="px-4 py-2 bg-slate-50 flex items-start justify-between gap-3">
                    <span className="font-bold text-[14px] text-slate-900 leading-snug break-words min-w-0">{opt.text}</span>
                    <span className="text-[12px] text-slate-500 font-semibold shrink-0 pt-0.5">{opt.voters.length}</span>
                  </div>
                  {opt.voters.length === 0 ? (
                    <div className="px-4 py-2 text-[12px] text-slate-400 italic">No votes</div>
                  ) : (
                    <ul>
                      {opt.voters.map(uid => (
                        <li key={uid} className="px-4 py-2 text-[14px] text-slate-700">
                          {resolveName(uid)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WallPollCard;
